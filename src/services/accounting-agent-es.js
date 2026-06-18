'use strict';

// Sub-agent for the Canary Islands company (Contasimple, IGIC). Mirrors the
// PL `accounting-agent.js` structure: forced-tool intent detection on top of
// Anthropic tool calling, every tool maps to one of the /api/contasimple/*
// HTTP endpoints invoked over self-loop. Stateless from n8n's perspective —
// it gets a free-text query, does its work, returns text. Lives behind
// POST /api/agent/accounting-es.

const Anthropic = require('@anthropic-ai/sdk');
const { buildExecuteTool, makeTemplaters, buildHistoryMessages } = require('./agent-runtime');
const { runAgentLoop } = require('./agent-loop-base');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL =
  process.env.ACCOUNTING_AGENT_ES_MODEL ||
  process.env.ACCOUNTING_AGENT_MODEL ||
  'claude-sonnet-4-5-20250929';

const BASE_PROMPT = `Jesteś sub-agentem KSIĘGOWOŚĆ KANARY (Contasimple, Hiszpania, IGIC).

╔════════════════════════════════════════╗
║ AKTUALNA DATA (HARD-CODED PER REQUEST) ║
║ DZIS:        {{TODAY}}                 ║
║ BIEŻĄCY ROK: {{YEAR}}                  ║
║ ZESZŁY ROK:  {{LAST_YEAR}}             ║
╚════════════════════════════════════════╝

ZASADA #-1 — INTERPRETACJA "TEN ROK":
"ten rok" / "tym roku" / "w tym roku" → ZAWSZE {{YEAR}}.
"zeszly rok" / "rok temu" → {{LAST_YEAR}}.

PRZYKLAD wywolania dla "ile sticków w tym roku":
  analytics_products_sold({
    from: "{{YEAR}}-01-01",
    to: "{{TODAY}}",
    source: "es"
  })

NIGDY nie wolaj BEZ from/to (endpoint defaultem da 365 dni wstecz, czyli
od {{LAST_YEAR}}-XX-XX, wybiera zly rok).
NIGDY tylko jeden kwartal jak user pyta "tym roku" — caly rok do dzis.
Dla cs_list_invoices (specyficzna FV) — TYLKO jeden period naraz, NIGDY
loop po wszystkich kwartalach (token overflow).

ZASADA #0 — NIGDY NIE LICZ Z GŁOWY, NIGDY NIE ZAGINAJ TOKENÓW:
Pytania ilosciowe ("ile sticków / ile sprzedalismy / obroty / top klienci")
→ ZAWSZE wywolaj analytics_products_sold / analytics_revenue /
analytics_top_customers. To sa pre-agregowane SQL queries, zwracaja
~1KB.
NIGDY nie wolaj cs_list_invoices dla pytan ilosciowych — to zwraca pelne
FV z pozycjami (kilkadziesiat KB per page) i wybucha kontekstem (200k+
tokens overflow → 400 error → "Bad request" do n8n).
cs_list_invoices uzywaj TYLKO dla konkretnej FV ("pokaz FV 0057",
"znajdz fakture dla X") — z explicitnym filtrem number/customerNif/limit.
Plain text, krótko, kwoty w EUR, ceny netto (Contasimple oczekuje netto).
Wszystkie produkty 7% IGIC domyślnie.

PRODUKTY (Surf Stick Bell Canarias) — pojedyncze sztuki:
- "stick" / "X sticków" → name="stick"
- "lip balm" / "lips" → name="lip balm"
- "daily" → name="daily"
- "care" → name="care"
- "gel extreme" / "gel" → name="gel"
- "mascara" → name="mascara"

BOXY (każdy = 30 sztuk po 4,50 € = 135 € netto + 9,45 € IGIC = 144,45 € brutto):
- "X box stick" → name="box stick" (30× SURF STICK)
- "X box mascar" → name="box mascar" (30× SURF GIRL waterproof mascara)
- "X box collection" → name="box collection" (12 lips + 6 daily + 6 gel + 6 care)

Synonimy box: pudełko = kartonik = pudło = box (to samo).

KONTRAHENT — TYLKO B2B Z CIF:
- Nikodem wystawia FV wyłącznie firmom (NIF/CIF/NIE wymagany).
- Nowy kontrahent: cs_create_customer (mandatory: nif + organization + adres).
- Walidacja CIF: cs_verify_cif (sprawdza lokalna baza + Contasimple search).
- Jeśli kontrahent nie istnieje → najpierw cs_create_customer, potem cs_invoice_preview.

CENY:
- User NIE podaje ceny → NIE dawaj price field. Catalog: 4,50 € netto / sztuka.
- "X po Y €" → globalPriceNetto (Contasimple ES = netto).
- "X po Y € brutto" → globalPriceBrutto.

KRÓTKIE POLECENIA UŻYTKOWNIKA (tak/ok/wyślij/potwierdź) — bez konkretów:
KROK 1: cs_get_context (ZAWSZE pierwszy, BEZ pytania użytkownika "co potwierdzasz?").
KROK 2: WYKONAJ akcję ZGODNIE Z lastAction z wyniku cs_get_context — NIE pytaj ponownie:
- lastAction="preview" + "tak"/"ok" → NATYCHMIAST cs_invoice_confirm. NIE pokazuj preview ponownie, NIE pytaj "co potwierdzasz".
- lastAction="albaran-preview" + "tak"/"ok" → NATYCHMIAST cs_albaran_confirm. NIE pokazuj preview WZ ponownie, NIE pytaj.
- lastAction="albaran-confirmed" + jakikolwiek confirm/wystaw intent → ZWRÓĆ "WZ {albaranNumber} został już wystawiony ~Xs temu. Co dalej?". NIE rób cs_albaran_preview ani cs_albaran_confirm.
- lastAction="confirmed" + jakikolwiek confirm/wystaw intent → ZWRÓĆ "FV {lastInvoiceNumber} została już wystawiona ~Xs temu. Nie wystawiam duplikatu. Co dalej?". NIE rób cs_invoice_preview ani cs_invoice_confirm.
- lastAction="confirmed" + "wyślij mailem do X" → cs_invoice_send_email
- lastAction="delete-preview" + "tak" → cs_delete_confirm

ANTI-DUPLIKAT (twarda zasada):
- Każde "wystaw fakturę" gdy lastAction="confirmed" w ostatnich 2 min → ZAPYTAJ "Ostatnia FV {numer} wystawiona ~Xs temu dla {kontrahent}. To DRUGA faktura dla tego samego klienta? (tak/nie)". Dopiero po wyraźnym "tak" przekaż confirmDuplicate:true do cs_invoice_preview.
- Backend cs_invoice_preview może zwrócić HTTP 409 z error="DUPLICATE_RECENT_INVOICE". Wtedy NIE retry — pokaż message z odpowiedzi i czekaj na wyraźną decyzję użytkownika.

FLOW WYSTAWIENIA FV:
1. cs_invoice_preview z items + contractorSearch (lub contractorCif) → response: previewId, previewText, telegramPushed, preview.lines[], preview.totals{netto,igic,brutto}, preview.period
   KONTRAHENT WYMAGANY: cs_invoice_preview MUSI dostać contractorSearch lub contractorCif lub contractorId. Jeśli w żądaniu NIE MA nazwy/CIF kontrahenta (np. samo "wystaw fakturę na 30 sticków") → NIE wywołuj cs_invoice_preview bez kontrahenta. Zapytaj "Dla kogo? (nazwa lub CIF)". Bez kontrahenta backend zwróci 404 i NIE MA previewa.
   TERMIN PŁATNOŚCI: gdy user poda termin (np. "30 dni", "termin 14 dni") → przekaż paymentDays=<liczba> do cs_invoice_preview. Bez wzmianki → pomiń (backend da 7).
2. POKAZANIE PREVIEW — zależnie od response.telegramPushed (UNIKAJ DUBLOWANIA):
   - telegramPushed=true → backend JUŻ wypchnął cały blok na Telegram. Odpowiedz TYLKO jedną krótką linią: "Podgląd FV ⬆️ — potwierdź: tak/ok". NIE powtarzaj bloku, NIE pisz liczb (user już je widzi wyżej).
   - telegramPushed=false (lub brak) → backend NIE wypchnął. Pokaż wtedy DOSŁOWNIE cały response.previewText (1:1), bo inaczej user nic nie zobaczy.
   W ŻADNYM wypadku NIE pisz liczb z głowy — wyłącznie z response.
3. JEŚLI response.ok=false LUB response.error (np. 404 contractor not found, 409 duplikat) → pokaż błąd DOSŁOWNIE i NIE twierdź że preview istnieje. Faktura NIE jest w toku dopóki nie masz response.previewId + response.previewText.
4. ZASADA TWARDA: wszystkie liczby (qty, unitNetto, lineNetto, netto/igic/brutto) muszą pochodzić DOSŁOWNIE z response.preview/previewText. Każda inna liczba = błąd. NIE przeliczaj sam, NIE zaokrąglaj, NIE rekonstruuj z pamięci.
5. User "tak"/"ok" → cs_invoice_confirm (bez argumentów)
6. Po confirm: response = invoiceNumber (np. "2026-0058"), invoiceId, pdfSent. PDF + caption idzie na Telegram automatycznie z backendu.

USUWANIE FV (preview → confirm):
- "skasuj ostatnią fv" → cs_delete_preview {latest:true}
- "skasuj ostatnią fv dla X" → cs_delete_preview {contractorSearch:"X", latest:true}
- "skasuj fv 2026-0056" → cs_delete_preview {number:"2026-0056"}
- "skasuj 3 ostatnie fv dla X" → cs_delete_preview {contractorSearch:"X", limit:3}
Pokaż listę DOSŁOWNIE (numery, kwoty, klient). Czekaj na "tak". Po confirm wysyła komunikat tekstowy na Telegram.
NIGDY nie kasuj bez preview-confirm — to nieodwracalne w księgowości.

DAJ FV NA TELEGRAM (recovery, reprint):
- "daj fv 2026-0056" / "pdf 0056" / "wyślij fv tu" → cs_send_invoice_pdf_telegram {invoiceNumber}.

WYSYŁKA FV MAILEM DO KLIENTA:
- "wyślij fv 0056 mailem do X" → cs_invoice_send_email {invoiceNumber, toEmail}.
- Contasimple wysyła z adresu firmy Nikodema (skonfigurowany w UI).

ALBARÁN (WZ — DOKUMENT WYDANIA):
- "wystaw wz dla X 30 sticków", "wystaw albaran X", "wydaj towar do X" → cs_albaran_preview z items+contractor.
- WZ to dokument wydania bez cen i bez podatku — tylko qty + nazwa produktu. Numerator inny niż FV (prefix 'AL-', np. AL-2026-0002).
- Po cs_albaran_preview (UNIKAJ DUBLOWANIA): telegramPushed=true → backend już wypchnął blok, odpowiedz JEDNĄ krótką linią "Podgląd WZ ⬆️ — potwierdź: tak/ok". telegramPushed=false → pokaż DOSŁOWNIE response.previewText (1:1). response.error/ok=false → pokaż błąd, WZ NIE jest w toku.
- "tak/ok" po preview → cs_albaran_confirm. Po confirm PDF idzie automatycznie na Telegrama.
- "daj wz AL-2026-0002" / "wyślij wz tu" → cs_albaran_send_pdf_telegram {albaranNumber}.
- "wyślij wz mailem do X" → cs_albaran_send_email {albaranNumber}. toEmail OPCJONALNY (backend pobierze z bazy).
- "skasuj wz X" → cs_albaran_delete {albaranNumber}.
- "lista wz" → cs_list_albarans.
- WAŻNE: WZ ≠ FV. NIGDY nie używaj cs_invoice_* przy słowie "wz" / "albaran" / "albarán".

ZASADY:
- ZAWSZE wywołaj tool przy nowym żądaniu — nie kopiuj odpowiedzi z historii.
- response.error → pokaż DOSŁOWNIE.
- response.ok=false z suggestions → pokaż listę.
- Po confirm pokaż blok z faktycznymi wartościami (numer, total, pdfSent, pdfError).
- Po delete-confirm pokaż summary (totalDeleted, totalFailed, lista numerów).
- Plain text, listy "-", krótko bez wstępów.
- NIE zmyślaj kwot/numerów/CIF.`;

const tools = [
  {
    name: 'cs_invoice_preview',
    description:
      'Podgląd FV ES (Contasimple) przed wystawieniem. Fuzzy contractor lookup, expand boxów (box stick / box collection / box mascar), kalkulacja IGIC 7%. Default cena 4,50 € netto/szt.',
    input_schema: {
      type: 'object',
      properties: {
        contractorSearch: { type: 'string' },
        contractorCif: { type: 'string', description: 'CIF/NIF/NIE — preferowane gdy znane' },
        contractorId: { type: 'string', description: 'UUID lokalnego EsContractor' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '"stick"/"box stick"/"box collection"/"box mascar"/"lip balm"/...' },
              ean: { type: 'string' },
              qty: { type: 'number' },
              priceNetto: { type: 'number' },
              priceBrutto: { type: 'number' },
            },
          },
        },
        globalPriceNetto: { type: 'number' },
        globalPriceBrutto: { type: 'number' },
        invoiceDate: { type: 'string', description: 'ISO date; default = teraz' },
        paymentDays: { type: 'number', description: 'Termin płatności w dniach. Default 7. User mówi "30 dni" → 30, "termin 14 dni" → 14. Bez wzmianki — pomiń (backend da 7).' },
      },
      required: ['items'],
    },
  },
  {
    name: 'cs_invoice_confirm',
    description: 'Potwierdza najnowszy ES preview i wystawia FV w Contasimple. Bez argumentów.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cs_delete_preview',
    description:
      'Lista FV ES do usunięcia. Filtry opcjonalne: contractor (search/cif), number (np. "2026-0056"), fromDate/toDate (dd/MM/yyyy HH:mm:ss), latest:true (1 najnowsza), limit:N (N najnowszych). Domyślnie wszystkie pasujące w bieżącym kwartale.',
    input_schema: {
      type: 'object',
      properties: {
        contractorSearch: { type: 'string' },
        contractorCif: { type: 'string' },
        number: { type: 'string' },
        fromDate: { type: 'string' },
        toDate: { type: 'string' },
        period: { type: 'string', description: 'YYYY-NT' },
        latest: { type: 'boolean' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'cs_delete_confirm',
    description: 'Potwierdza ostatni delete-preview. Wykonuje DELETE per FV i wysyła komunikat na Telegram. Bez argumentów.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cs_invoice_send_email',
    description:
      'Wyślij FV mailem do klienta przez Contasimple. From = adres firmy Nikodema (skonfigurowany w UI Contasimple). Akceptuje invoiceNumber lub contasimpleId. **toEmail OPCJONALNY** — backend automatycznie znajdzie adres klienta w bazie EsContractor (synced z Contasimple). Tylko jak user explicit podaje inny adres — przekaż w toEmail.',
    input_schema: {
      type: 'object',
      properties: {
        invoiceNumber: { type: 'string', description: 'Pełny numer FV np. "2026-0056"' },
        contasimpleId: { type: 'number' },
        toEmail: { type: 'string', description: 'Opcjonalne — backend znajdzie w bazie klienta jeśli pusty' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
    },
  },
  {
    name: 'cs_send_invoice_pdf_telegram',
    description: 'Pobierz PDF FV i wyślij na Telegrama (recovery/reprint). Akceptuje invoiceNumber lub contasimpleId.',
    input_schema: {
      type: 'object',
      properties: {
        invoiceNumber: { type: 'string' },
        contasimpleId: { type: 'number' },
      },
    },
  },
  {
    name: 'cs_create_customer',
    description: 'Utwórz nowego kontrahenta ES w Contasimple. CIF (nif) MANDATORY — Nikodem wystawia tylko B2B.',
    input_schema: {
      type: 'object',
      properties: {
        nif: { type: 'string' },
        organization: { type: 'string' },
        firstname: { type: 'string' },
        lastname: { type: 'string' },
        address: { type: 'string' },
        province: { type: 'string' },
        city: { type: 'string' },
        postalCode: { type: 'string' },
        country: { type: 'string' },
        countryId: { type: 'number' },
        email: { type: 'string' },
        phone: { type: 'string' },
        documentCulture: { type: 'string', description: 'es-ES | en-US | ca-ES' },
      },
      required: ['nif'],
    },
  },
  {
    name: 'cs_verify_cif',
    description: 'Sprawdź CIF — szuka w lokalnej EsContractor + Contasimple search/nif. Zwraca dane gdy znaleziony.',
    input_schema: {
      type: 'object',
      properties: { cif: { type: 'string' } },
      required: ['cif'],
    },
  },
  {
    name: 'cs_list_invoices',
    description: 'Listing FV ES za okres. period default = bieżący kwartał. Filtry: nif, number, fromDate/toDate, status.',
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string' },
        nif: { type: 'string' },
        number: { type: 'string' },
        fromDate: { type: 'string' },
        toDate: { type: 'string' },
        status: { type: 'string', enum: ['Pending', 'Incomplete', 'Payed', 'PendingIncomplete'] },
      },
    },
  },
  {
    name: 'cs_sync_customers',
    description: 'Synchronizuj bazę klientów ES z Contasimple do lokalnego EsContractor (idempotent upsert).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cs_get_context',
    description:
      'Pobierz kontekst poprzedniej operacji ES (lastAction, lastInvoiceContasimpleId, lastInvoiceNumber, deletePreviewId itp.). Wywołaj gdy user pisze krótkie polecenie bez konkretu (tak/ok/wyślij).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cs_set_email',
    description:
      'Ustaw adres email kontrahenta w lokalnej bazie EsContractor. Używaj gdy user mówi "ustaw email Folkertsa na X" / "zapisz mail klienta Y: Z" / "email do X to Y". Identyfikuje kontrahenta po NIF, organization (fragment nazwy) lub contasimpleId. Gdy fragment nazwy pasuje do >1 firmy, zwraca matches[] do wybrania.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Nowy adres email (wymagane)' },
        nif: { type: 'string', description: 'NIF/CIF kontrahenta (najpewniejsze)' },
        contasimpleId: { type: 'number', description: 'ID kontrahenta w Contasimple' },
        organization: { type: 'string', description: 'Fragment nazwy firmy (fuzzy match)' },
      },
      required: ['email'],
    },
  },
  {
    name: 'cs_albaran_preview',
    description:
      'Podgląd ALBARÁN (WZ — dokument wydania, bez cen, bez podatku) przed wystawieniem. Trigger: "wz", "albaran", "albarán", "wystaw wz dla X", "wydaj towar do X". Argumenty jak cs_invoice_preview ale w wynik bez total/IGIC — tylko qty+nazwa pozycji.',
    input_schema: {
      type: 'object',
      properties: {
        contractorSearch: { type: 'string', description: 'Fragment nazwy kontrahenta (fuzzy)' },
        contractorCif: { type: 'string', description: 'NIF/CIF/NIE klienta — najpewniejsze' },
        contractorId: { type: 'string', description: 'UUID lokalnego EsContractor (gdy znany)' },
        items: {
          type: 'array',
          description: 'Lista pozycji [{name?|ean?, qty}]',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              ean: { type: 'string' },
              qty: { type: 'number' },
            },
          },
        },
        deliveryNoteDate: { type: 'string', description: 'Data wydania ISO (opcjonalna, default dzisiaj)' },
      },
      required: ['items'],
    },
  },
  {
    name: 'cs_albaran_confirm',
    description: 'Potwierdza i wystawia ostatnio przygotowany albarán (WZ). Bez argumentów — bierze najnowszy preview.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cs_albaran_send_pdf_telegram',
    description: 'Wyślij PDF wystawionego albaranu na Telegrama. Argumenty: albaranNumber LUB albaranId.',
    input_schema: {
      type: 'object',
      properties: {
        albaranNumber: { type: 'string' },
        albaranId: { type: 'number' },
      },
    },
  },
  {
    name: 'cs_albaran_send_email',
    description: 'Wyślij PDF albaranu mailem do klienta. Argumenty: albaranNumber LUB albaranId. toEmail OPCJONALNY — backend pobierze z EsContractor.email.',
    input_schema: {
      type: 'object',
      properties: {
        albaranNumber: { type: 'string' },
        albaranId: { type: 'number' },
        toEmail: { type: 'string', description: 'OPCJONALNY: prawdziwy adres. Pomiń jeśli nie znasz.' },
      },
    },
  },
  {
    name: 'cs_albaran_delete',
    description: 'Usuwa albarán z Contasimple. Argumenty: albaranNumber LUB albaranId.',
    input_schema: {
      type: 'object',
      properties: {
        albaranNumber: { type: 'string' },
        albaranId: { type: 'number' },
      },
    },
  },
  {
    name: 'cs_list_albarans',
    description: 'Lista albaranów. Opcjonalnie filter targetEntityId (per klient).',
    input_schema: {
      type: 'object',
      properties: {
        page: { type: 'number' },
        itemsPerPage: { type: 'number' },
        targetEntityId: { type: 'number' },
      },
    },
  },
  {
    name: 'analytics_products_sold',
    description: 'Sprzedaz per produkt w okresie z naszej znormalizowanej bazy (Invoice/EsInvoice lineItems). Bez ean -> top-N. Z ean -> time series. ZAWSZE wywolaj dla pytan "ile sticków / ile sprzedalismy". NIGDY zamiast tego nie wolaj cs_list_invoices bo overflow. WAZNE: ZAWSZE podawaj from + to explicit z biezacym rokiem; bez parametrow endpoint domyslnie bierze 365 dni wstecz, co dla pytania "ten rok" daje zly zakres.',
    input_schema: {
      type: 'object',
      properties: {
        ean: { type: 'string' },
        from: { type: 'string', description: 'YYYY-MM-DD WYMAGANE dla pytan ilosciowych. Dla "tym roku" → {{YEAR}}-01-01.' },
        to: { type: 'string', description: 'YYYY-MM-DD. Dla "tym roku" / "do dzis" → {{TODAY}}.' },
        country: { type: 'string' }, limit: { type: 'number' },
        source: { type: 'string', description: 'pl|es lub pomin dla obu. Dla Kanary pytan → es.' },
        granularity: { type: 'string' },
      },
    },
  },
  {
    name: 'analytics_revenue',
    description: 'Obroty per period+currency+source. ZAWSZE dla "ile zarobilismy / obroty".',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string' }, to: { type: 'string' },
        country: { type: 'string' }, currency: { type: 'string' },
        source: { type: 'string' }, granularity: { type: 'string' },
      },
    },
  },
  {
    name: 'analytics_top_customers',
    description: 'Top N klientow po total_revenue (numerycznie desc). ZAWSZE dla "top klienci / ranking".',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string' }, to: { type: 'string' },
        year: { type: 'number' },
        country: { type: 'string' }, limit: { type: 'number' }, source: { type: 'string' },
      },
    },
  },
];

const ENDPOINT_MAP = {
  cs_invoice_preview: ['POST', '/api/contasimple/invoice-preview'],
  cs_invoice_confirm: ['POST', '/api/contasimple/invoice-confirm-latest'],
  cs_delete_preview: ['POST', '/api/contasimple/delete-preview'],
  cs_delete_confirm: ['POST', '/api/contasimple/delete-confirm-latest'],
  cs_invoice_send_email: ['POST', '/api/contasimple/send-invoice-email'],
  cs_send_invoice_pdf_telegram: ['POST', '/api/contasimple/resend-pdf-telegram'],
  cs_create_customer: ['POST', '/api/contasimple/customers'],
  cs_verify_cif: ['POST', '/api/contasimple/customer-verify-cif'],
  cs_list_invoices: ['GET', '/api/contasimple/invoices'],
  cs_sync_customers: ['POST', '/api/contasimple/sync-customers'],
  cs_get_context: ['GET', '/api/agent-context/ksiegowosc-es'],
  cs_set_email: ['POST', '/api/contasimple/set-customer-email'],
  cs_albaran_preview: ['POST', '/api/contasimple/albaran-preview'],
  cs_albaran_confirm: ['POST', '/api/contasimple/albaran-confirm-latest'],
  cs_albaran_send_pdf_telegram: ['POST', '/api/contasimple/albaran-resend-pdf-telegram'],
  cs_albaran_send_email: ['POST', '/api/contasimple/albaran-send-email'],
  cs_albaran_delete: ['POST', '/api/contasimple/albaran-delete'],
  cs_list_albarans: ['GET', '/api/contasimple/albarans'],
  analytics_products_sold: ['GET', '/api/analytics/products-sold'],
  analytics_revenue: ['GET', '/api/analytics/revenue'],
  analytics_top_customers: ['GET', '/api/analytics/top-customers'],
};

const executeTool = buildExecuteTool({
  endpointMap: ENDPOINT_MAP,
  logPrefix: '[accounting-agent-es]',
});

const { buildSystemPrompt, buildTools } = makeTemplaters(BASE_PROMPT, tools);

// Force tool choice on unambiguous intents to suppress LLM detours.
const PREVIEW_INTENT = /\b(wystaw|zr[oó]b|przygotuj) (fakt|fv|factura)|\b(faktur|fv|factura) (dla|na|para)/i;
const CONFIRM_INTENT = /^\s*(tak|ok|si|sí|potwierdz|akceptu|zgadzam|jasne|dobra|emite|emitir)\b|\bpotwierd[zź]\s+(fakt|fv|factura|ostatni|preview|albaran|albarán|wz)/i;
const SEND_EMAIL_INTENT = /\bwy[sś]lij (fakt|fv|factura) (mailem|mejlem|por mail|por correo|por email)|\bfakt\w* mailem\b|\benv[ií]a\b.*\b(factura|fv)\b/i;
const PDF_TELEGRAM_INTENT_RE = new RegExp(
  /\btelegram\w*\b[\s\S]*\b(pdf|fakt\w*|fv|factura)\b/i.source + '|' +
  /\b(pdf|fakt\w*|fv|factura)\b[\s\S]*\btelegram\w*\b/i.source + '|' +
  /\bdaj\s+(?:mi\s+)?(?:pdf\s+)?(?:fv|fakt\w*|factura)\b/i.source,
  'i'
);
const DELETE_INTENT = /\b(skasuj|usu[nń]|skasowa[ćc]|elimina|borra|cancela)\b/i;
const SYNC_INTENT = /\bsynchron|\bsync\b|sincroniz/i;
// Albarán (WZ) — trigger words po PL i ES.
const ALBARAN_PREVIEW_INTENT = /\b(wystaw|zr[oó]b|przygotuj|wydaj|zr[oó]b)\s+(wz|albaran|albarán|delivery)\b|\b(wz|albaran|albarán)\s+(dla|do|para)\b|^(wz|albaran|albarán)\b/i;
const ALBARAN_DELETE_INTENT = /\b(skasuj|usu[nń]|elimina|borra|cancela)\s+(wz|albaran|albarán)\b/i;

async function processAccountingEsQuery(query, opts = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { text: 'ANTHROPIC_API_KEY nie skonfigurowany.', error: 'no_api_key' };
  }
  if (!query || typeof query !== 'string') {
    return { text: 'Brak query.', error: 'no_query' };
  }

  const ctx = { chatId: opts.chatId || null };
  // Wstrzyk daty do user content — LLM ignoruje system prompt date,
  // wiec wstawiamy do messages bezposrednio. Trudniej zignorowac niz
  // system prompt fragment.
  const todayStr = new Date().toISOString().slice(0, 10);
  const yearStr = todayStr.slice(0, 4);
  const dateContextPrefix = `[KONTEKST: Dzisiejsza data: ${todayStr}. Biezacy rok: ${yearStr}. "Tym roku" / "Ten rok" / "This year" = ${yearStr}. Dla analytics ZAWSZE uzyj from=${yearStr}-01-01 to=${todayStr} jak user pyta "tym roku" / "this year".]\n\n`;
  const messages = buildHistoryMessages(opts.previousTurns, dateContextPrefix + query);
  // Intencję oceniamy na OSTATNIEJ NIEPUSTEJ LINII (realna komenda), bo master/
  // asystent doklejają kontekst PRZED nią, a CONFIRM_INTENT ma kotwicę '^tak' —
  // z prefiksem nie łapał i "tak" nie wymuszało confirm. Fallback: cały query.
  const cmd = (query.trim().split('\n').map(s => s.trim()).filter(Boolean).pop()) || query;
  const isPureConfirm = (text) =>
    CONFIRM_INTENT.test(text) && !PREVIEW_INTENT.test(text) &&
    !ALBARAN_PREVIEW_INTENT.test(text) && !DELETE_INTENT.test(text) &&
    !ALBARAN_DELETE_INTENT.test(text);
  const detectEsIntent = (text) => {
    if (isPureConfirm(text)) return 'cs_get_context';
    if (ALBARAN_DELETE_INTENT.test(text)) return 'cs_albaran_delete';
    if (DELETE_INTENT.test(text)) return 'cs_delete_preview';
    if (PDF_TELEGRAM_INTENT_RE.test(text)) return 'cs_send_invoice_pdf_telegram';
    if (SEND_EMAIL_INTENT.test(text)) return 'cs_invoice_send_email';
    if (SYNC_INTENT.test(text)) return 'cs_sync_customers';
    if (ALBARAN_PREVIEW_INTENT.test(text)) return 'cs_albaran_preview';
    if (PREVIEW_INTENT.test(text)) return 'cs_invoice_preview';
    return null;
  };
  const forcedTool = detectEsIntent(cmd) || detectEsIntent(query);
  // pureConfirmIntent (do onToolResult): czysta intencja "tak/ok" wykryta na
  // komendzie → po cs_get_context wymusi cs_invoice_confirm gdy świeży preview.
  const pureConfirmIntent = forcedTool === 'cs_get_context';

  // ROOT-CAUSE FIX: po cs_get_context przy czystej intencji potwierdzenia,
  // jesli ostatnia akcja to swiezy 'preview' → wymus cs_invoice_confirm na
  // nastepnej iteracji (LLM inaczej czasem pyta "co potwierdzasz?").
  // Jesli lastAction='confirmed' → NIE wymuszaj nic (anti-duplikat: prompt
  // + backend 409 zatrzymaja kolejna FV).
  const onToolResult = (name, result) => {
    if (pureConfirmIntent && name === 'cs_get_context' && result && typeof result === 'object') {
      const FRESH_MS = 10 * 60 * 1000;
      const fresh = result.timestamp ? (Date.now() - Number(result.timestamp) < FRESH_MS) : true;
      if (result.lastAction === 'preview' && fresh) return 'cs_invoice_confirm';
      if (result.lastAction === 'albaran-preview' && fresh) return 'cs_albaran_confirm';
      if (result.lastAction === 'delete-preview' && fresh) return 'cs_delete_confirm';
    }
    return null;
  };

  return runAgentLoop({
    anthropic,
    model: MODEL,
    messages,
    getSystem: buildSystemPrompt,
    getTools: buildTools,
    firstToolChoice: forcedTool,
    executeTool,
    ctx,
    logPrefix: '[accounting-agent-es]',
    logResult: true,
    onToolResult,
  });
}

module.exports = { processAccountingEsQuery };
