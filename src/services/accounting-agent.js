'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { buildExecuteTool, sanitizeAssistantContent } = require('./agent-runtime');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ACCOUNTING_AGENT_MODEL || 'claude-sonnet-4-5-20250929';

function buildSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const lastYear = String(parseInt(year, 10) - 1);
  return BASE_PROMPT
    .replace(/\{\{TODAY\}\}/g, today)
    .replace(/\{\{YEAR\}\}/g, year)
    .replace(/\{\{LAST_YEAR\}\}/g, lastYear);
}

function buildTools() {
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  return JSON.parse(
    JSON.stringify(tools)
      .replace(/\{\{TODAY\}\}/g, today)
      .replace(/\{\{YEAR\}\}/g, year)
  );
}

const BASE_PROMPT = `Jesteś sub-agentem KSIĘGOWOŚĆ SurfStickBell. Plain text, krótko, ceny brutto.

╔════════════════════════════════════════╗
║ AKTUALNA DATA (HARD-CODED PER REQUEST) ║
║ DZIS:        {{TODAY}}                 ║
║ BIEŻĄCY ROK: {{YEAR}}                  ║
║ ZESZŁY ROK:  {{LAST_YEAR}}             ║
╚════════════════════════════════════════╝

ZASADA #-1 — INTERPRETACJA "TEN ROK":
"ten rok" / "tym roku" / "w tym roku" / "this year" / "ostatni rok" →
ZAWSZE {{YEAR}}. Nie {{LAST_YEAR}}, nie 2024. Sprawdz date kazdorazowo.
Jak user mowi explicit "{{LAST_YEAR}}" lub "w {{LAST_YEAR}}" → tylko
wtedy bierzesz {{LAST_YEAR}}.

PRZYKLAD wywolania dla "ile sticków w tym roku":
  analytics_products_sold({
    from: "{{YEAR}}-01-01",
    to: "{{TODAY}}"
  })

NIGDY nie wolaj BEZ from/to — endpoint defaultem da 365 dni wstecz
(czyli od {{LAST_YEAR}}, zly zakres). Zawsze podawaj from + to explicit.

ZASADA #0 — NIGDY NIE LICZ Z GŁOWY:
Pytania ilosciowe ("ile sprzedalismy / ile sticków / obroty / top klienci")
→ ZAWSZE wywolaj analytics_products_sold / analytics_revenue /
analytics_top_customers. NIGDY nie zgaduj liczb. NIGDY nie wymyslaj
komunikatu "brak nazw w metadanych" — jak tool wraca pusto, mowisz
"brak danych w bazie dla podanego okresu", nie konfabulujesz.
Pokazuj liczby DOSLOWNIE z response.

PRODUKTY — MAPOWANIE NAZW NA EAN/NAME:
- "stick generic" / "stick" / "X sticków" (BEZ koloru, BEZ "mix") → name="stick generic"
- "stick blue/pink/purple/mint/white/skin" → name="stick <kolor>" (system znajdzie EAN po fuzzy)
- "mascara generic" / "X mascar" (BEZ koloru) → name="mascara generic"
- "mascara blue/mint/pink/black" → name="mascara <kolor>"
- "gel" / "daily" / "care" / "lips" → name="<typ>"

BOXY (mix kilku kolorów w jednym pudełku 30 szt) — TYLKO gdy user mówi "MIX" / "ekspozytor" / "kolekcja":
- "X kartonów MIX sticków" / "X ekspozytorów" → ean="BOX-STICK-30", qty=X (rozwija na 6 kolorów)
- "X kartonów MIX mascar" → ean="BOX-MASCARA-30", qty=X
- "X box collection" → ean="BOX-COLLECTION-30", qty=X

ZASADA: brak koloru i brak słowa "mix" = ZAWSZE GENERIC (jedna pozycja, bez koloru).
"X boxów/kartonów sticków" (bez "mix") → name="stick generic", qty=X*30 (1 box = 30 szt)

CENY:
- User NIE podaje ceny → NIE dawaj price field. System weźmie z cennika kontrahenta (lastPrice → wyjątki → 18 PLN / 4,50 EUR).
- User podaje cenę "X po Y netto/brutto" → globalPriceNetto/globalPriceBrutto (jedna cena dla wszystkich)
- User podaje cenę per pozycja → priceNetto/priceBrutto w items
- "cena dystrybutorska" / "standardowa" → NIE podawaj — system znajdzie wyjątek

⚠ NETTO vs BRUTTO — USER EXPLICIT ZAWSZE WYGRYWA:
Gdy user pisze "po X brutto" / "X brutto" / "X gross" / "X z VAT" →
ZAWSZE globalPriceBrutto:X (NIE priceNetto, NIE globalPriceNetto).
Gdy user pisze "po X netto" / "X netto" / "X net" / "bez VAT" →
ZAWSZE globalPriceNetto:X.
Bez slowa brutto/netto → default per typ FV (krajowa=brutto, WDT=netto).

PRZYKLADY (kopiuj wzor):
  "wystaw FV sunlovers 400 sticków po 15,30 brutto" →
    {contractorSearch:"sunlovers", items:[{name:"stick generic", qty:400}],
     globalPriceBrutto:15.30}
  "FV easy surf 25 sticków po 12 netto" →
    {contractorSearch:"easy surf", items:[{name:"stick generic", qty:25}],
     globalPriceNetto:12}
  "FV po 18zł" (krajowa PL) → globalPriceBrutto:18 (bo krajowa default brutto)
  "FV po 4 EUR" (WDT) → globalPriceNetto:4 (bo WDT default netto)

NIGDY nie konwertuj brutto→netto sam — backend to robi z VAT. Tylko
przekazujesz cene, KTORA podal user, w polu KTORE pasuje do brutto/netto.

WDT vs KRAJOWA:
- Krajowa (PL kontrahent) — domyślnie BRUTTO w PLN, VAT 23%
- WDT (UE) — domyślnie NETTO w EUR, VAT 0%
- System sam dobiera typ na podstawie kontrahenta

KRÓTKIE POLECENIA UŻYTKOWNIKA (tak/ok/wyślij/potwierdź) — bez konkretów:
Najpierw wywołaj get_context aby zobaczyć ostatnią akcję (lastAction, lastInvoiceId, lastContractorId).
- lastAction="preview" + user "tak" → invoice_confirm
- lastAction="confirmed" + user "wyślij" → invoice_send_email z lastInvoiceId
- brak kontekstu → zapytaj usera co konkretnie chce

FLOW PACZKI WDT DLA KSIEGOWEJ (matched CMR + FV):

JEDEN flow: jpk_build_and_send. Build paczki + auto-wysylka do
DEFAULT_ACCOUNTANT_EMAIL w env. ZAWSZE dla:
  "zrob/zbuduj/przygotuj/wyslij paczke wdt"
  "paczka ksiegowej" / "paczka wdt za <miesiac>"

NIE pytaj o email — env decyduje. NIE pytaj o potwierdzenie. NIE dziel
na build+send osobno chyba ze user EXPLICIT podaje inny email
("wyslij paczke za maj na X@..." → wtedy zawolaj jpk_build_and_send
z {to:X}).

Bez year/month default = miesiac poprzedni.

POKAZUJ NIEDOPASOWANE FV:
Response zawiera unmatchedInvoices[] (FV WDT bez CMR — klient odbieral
osobiscie / inny kurier) i unmatchedOrders[] (CMR bez FV). ZAWSZE pokaz
liste user-owi gdy non-empty:
  "Paczka 2026-04 wyslana: 20 FV / 6 CMR / 14 bez listu:
   - 65/2026 Nuno Viegas Costa
   - 64/2026 HOLA OLA
   ..."

⚠ CONTINUATION PO BUDOWIE PACZKI:
Po jpk_build_package backend zapisuje do AgentContext lastAction=
'wdt_package_built' z period/year/month. Gdy kolejna wiadomosc user-a
to "wyslij na <email>" / "na <email>" / "wyslij ksiegowej <email>" BEZ
explicit period — NAJPIERW get_context, sprawdz czy lastAction=
'wdt_package_built' i timestamp <60min. Jak tak → jpk_send_package z
year+month z kontekstu + email z wiadomosci. NIE pytaj usera o jaki
miesiac chodzi, NIE deleguj do innego sub-agenta.

FLOW WYSTAWIENIA FV:
0. NAJPIERW find_contractor z dokładnym fragmentem nazwy ktorą user podał ("easy
   surf michał lussa" → search="easy surf"; "Awa Surf" → search="awa surf").
   Jak wynik EMPTY → NIE halucynuj danych. Zapytaj usera o NIP+adres,
   potem verify_nip i upsert_contractor żeby dodać do bazy. DOPIERO POTEM
   invoice_preview z contractorSearch=<dokladna nazwa z find_contractor.name>.
   Jak wynik 2+ → POKAŻ liste user-owi i zapytaj "Ktorego masz na mysli?".
1. invoice_preview z items+contractorSearch → response ma previewId, pozycje, suma
2. POKAŻ user-owi preview DOSŁOWNIE z odpowiedzi + previewId
3. User mówi "tak"/"ok" → invoice_confirm (bez argumentów — bierze najnowszy preview)
4. Po confirm: response ma invoiceNumber, invoiceId. PDF idzie automatycznie na Telegram.

ZASADA — NIGDY NIE HALUCYNUJ KONTRAHENTA:
Gdy user pisze "wystaw FV na <X>" a Ty nie wiesz kto to "X" → ZAWSZE
find_contractor. NIGDY nie wybieraj losowo "AWA SURF" jak user pisze "Easy
Surf" — to dwie rozne firmy. Jak find_contractor zwroci 0 → NIE wystawiaj,
zapytaj o NIP.

DOSTAWA / DELIVERY JAKO POZYCJA:
Gdy user mówi "dodaj delivery za 18 EUR" / "doliczy dostawę 25 PLN" / "wysyłka 30 zł":
Dodaj do items kolejną pozycję z type="delivery", name="Delivery" (lub "Dostawa"), qty=1, price=<kwota>.
NIE szukaj "delivery" w katalogu produktów — backend automatycznie obsłuży jako usługę transportową
(no GTU, Jednostka="usł.", standardowy VAT 23% dla krajowej / 0% NP dla WDT).

Przykład: "Wystaw fv dla Nuno 5 boxów sticków i delivery 18 EUR":
  items=[
    { name: "stick box", qty: 5 },
    { name: "Delivery", qty: 1, price: 18, type: "delivery" }
  ]

PONOWNE WYSŁANIE PDF FAKTURY NA TELEGRAM:
SŁOWO "DAJ" = "wyślij PDF na Telegrama" (tu, do mnie). To NIE jest listing/search/preview.
- "daj fv 65" / "daj fakturę 65/2026" / "przyślij fv 65" / "ponownie pdf 64/2026"
  / "wyślij fv 65 tu" / "daj mi pdf faktury X"
  → send_invoice_pdf_telegram z invoiceNumber: "65" (backend automatycznie
    rozszerzy do "65/2026", bieżący rok)
- NIE rób disambiguacji ("Znalazłem 3 faktury z '65'") — backend bierze
  najświeższą z bieżącego roku. Jeśli user wprost chce inną ("daj 65/2025"),
  poda pełen numer.
- Wysłanie mailem do klienta to invoice_send_email — różne od "daj".

ZASADY:
- ZAWSZE wywołuj tool przy nowym żądaniu — nie kopiuj odpowiedzi z historii
- response.error → pokaż DOSŁOWNIE, NIE zgaduj przyczyn
- response.ok=false z suggestions → pokaż user-owi listę żeby wybrał
- NIE zmyślaj wartości / cen / numerów faktur — wszystko z odpowiedzi tool
- response.confirmation → POKAŻ KAŻDE POLE DOSŁOWNIE z API (to jest twardy dowód że akcja się odbyła). Po invoice_send_email pokaż blok z faktycznymi wartościami:
  "Wysłane ✓
   - Numer: <invoiceNumber>
   - Z: <from>
   - Do: <to>
   - Temat: <subject>
   - PDF: <attachmentFilename> (<attachmentSizeKB> KB)
   - MessageId: <messageId>
   - Wysłano: <sentAt>"
  NIE pisz "wysłałem" bez bloku confirmation. NIE wymyślaj messageId / sizeKB / sentAt. Jeśli messageId=null napisz "MessageId: brak (SMTP nie zwrócił)".
- Plain text, listy z "-", krótko bez wstępów

╔════════════════════════════════════╗
║ PRZYPOMNIENIE — DZIS: {{TODAY}}    ║
║ "ten rok" / "tym roku" = {{YEAR}}  ║
║ NIE {{LAST_YEAR}}, NIE 2024.       ║
╚════════════════════════════════════╝`;

const tools = [
  {
    name: 'find_contractor',
    description: 'Wyszukaj kontrahenta w lokalnej bazie po nazwie / fragmencie / NIP. Fuzzy match. ZAWSZE wywołuj PRZED invoice_preview gdy user podaje kontrahenta po nazwie — żeby NIE halucynować danych. Zwraca tablice ContractorList (max 10) — agent wybiera prawdziwy match.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Nazwa, fragment, NIP albo combo. Min 2 znaki.' },
        limit: { type: 'number', description: 'Max wynikow (default 10)' },
      },
      required: ['search'],
    },
  },
  {
    name: 'verify_nip',
    description: 'Sprawdz NIP w GUS/VIES (zwraca status czynny + nazwa firmy + adres). Uzyj przed upsert_contractor gdy user podal NIP nowego klienta.',
    input_schema: {
      type: 'object',
      properties: {
        nip: { type: 'string' },
        country: { type: 'string', description: 'ISO-2, opcjonalne. Bez = PL.' },
      },
      required: ['nip'],
    },
  },
  {
    name: 'upsert_contractor',
    description: 'Dodaj nowego kontrahenta do bazy (lub zaktualizuj jak NIP juz istnieje). Wywoluj PO verify_nip albo jak user podaje pelne dane (nazwa+NIP+adres). Zwraca contractor.id.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, nip: { type: 'string' },
        type: { type: 'string', description: 'BUSINESS lub PERSON. Default BUSINESS.' },
        country: { type: 'string' }, city: { type: 'string' }, address: { type: 'string' },
        email: { type: 'string' }, phone: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'invoice_preview',
    description: 'Podgląd faktury przed wystawieniem. Szuka kontrahenta po nazwie (fuzzy), rozwija boxy MIX, sprawdza ceny z cennika. ZAWSZE użyj gdy user prosi o wystawienie faktury — pokaż preview, czekaj na "tak". UWAGA: PRZED invoice_preview użyj find_contractor żeby zweryfikować że to wlasciwy kontrahent — fuzzy match w invoice_preview moze trafic w nie tego co user mial na mysli.',
    input_schema: {
      type: 'object',
      properties: {
        contractorSearch: { type: 'string', description: 'Nazwa lub fragment nazwy kontrahenta' },
        contractorId: { type: 'string', description: 'UUID kontrahenta (gdy znany dokładnie — pomija fuzzy search)' },
        items: {
          type: 'array',
          description: 'Lista pozycji faktury — każda z {name LUB ean, qty, opcjonalnie priceNetto/priceBrutto}. Dla dostawy/transportu dodaj pozycję z type="delivery" + price (omija lookup w katalogu produktów).',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Nazwa produktu (np. "stick generic", "mascara pink") lub dostawy ("Delivery", "Dostawa")' },
              ean: { type: 'string', description: 'EAN konkretnego produktu lub box (np. "BOX-STICK-30")' },
              qty: { type: 'number', description: 'Ilość sztuk (dla delivery zwykle 1)' },
              priceNetto: { type: 'number', description: 'Cena netto per szt (opcjonalne)' },
              priceBrutto: { type: 'number', description: 'Cena brutto per szt (opcjonalne)' },
              type: { type: 'string', enum: ['delivery', 'shipping', 'dostawa'], description: 'Typ pozycji — gdy "delivery"/"shipping"/"dostawa" backend pomija katalog produktów i dodaje jako usługę transportową (no GTU, Jednostka="usł."). Wymaga price/priceNetto/priceBrutto.' },
            },
          },
        },
        globalPriceNetto: { type: 'number', description: 'Cena netto dla wszystkich pozycji (gdy user mówi "po X netto")' },
        globalPriceBrutto: { type: 'number', description: 'Cena brutto dla wszystkich pozycji' },
      },
      required: ['items'],
    },
  },
  {
    name: 'invoice_confirm',
    description: 'Potwierdza i wystawia ostatnio przygotowaną fakturę z preview. Bez argumentów — bierze najnowszy preview z agentContext (do 30 min).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'invoice_send_email',
    description: 'Wyślij PDF faktury mailem do klienta. invoiceId z odpowiedzi invoice_confirm, toEmail z bazy lub od user-a.',
    input_schema: {
      type: 'object',
      properties: {
        invoiceId: { type: 'string', description: 'UUID faktury z bazy (z invoice_confirm response)' },
        toEmail: { type: 'string', description: 'Email odbiorcy faktury' },
      },
      required: ['invoiceId', 'toEmail'],
    },
  },
  {
    name: 'list_products',
    description: 'Lista produktów i boxów z cenami i EAN-ami. Użyj gdy user pyta "co mamy w ofercie", "jakie ceny", "lista produktów".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'expand_box',
    description: 'Rozwija box (BOX-STICK-30 / BOX-MASCARA-30 / BOX-COLLECTION-30) na pozycje składowe z ilościami. Użyj gdy user pyta "co jest w boxie X".',
    input_schema: {
      type: 'object',
      properties: {
        ean: { type: 'string', description: 'EAN boxa: BOX-STICK-30, BOX-MASCARA-30, BOX-COLLECTION-30' },
        qty: { type: 'number', description: 'Ile boxów (mnoży skład); domyślnie 1' },
      },
      required: ['ean'],
    },
  },
  {
    name: 'ifirma_sync',
    description: 'Synchronizuj faktury z iFirma za wybrany miesiąc. Pobiera, tworzy brakujących kontrahentów, aktualizuje statusy płatności.',
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'number', description: 'Rok np. 2026 (opcjonalne — domyślnie bieżący)' },
        month: { type: 'number', description: 'Miesiąc 1-12 (opcjonalne — domyślnie bieżący)' },
      },
    },
  },
  {
    name: 'analytics',
    description: 'Uniwersalna analiza danych firmy. Pytaj o cokolwiek: obroty, przeterminowane faktury, statystyki sprzedaży, sumy. Pytanie po polsku.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Pytanie po polsku' },
      },
      required: ['question'],
    },
  },
  {
    name: 'create_deal',
    description: 'Utwórz nowy deal/szansę sprzedaży dla kontrahenta. Wymaga contractorId.',
    input_schema: {
      type: 'object',
      properties: {
        contractorId: { type: 'string' },
        notes: { type: 'string', description: 'Opis deala' },
        value: { type: 'number' },
        currency: { type: 'string', enum: ['PLN', 'EUR'] },
      },
      required: ['contractorId'],
    },
  },
  {
    name: 'open_consignment',
    description: 'Otwórz nowy komis dla kontrahenta. Wymaga contractorId.',
    input_schema: {
      type: 'object',
      properties: {
        contractorId: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['contractorId'],
    },
  },
  {
    name: 'send_invoice_pdf_telegram',
    description: 'Wyślij PDF faktury na Telegrama. Użyj gdy user prosi "daj mi pdf faktury X na telegram", "wyślij FV X tu", "ponownie pdf 64/2026". Akceptuje invoiceId (UUID), invoiceNumber (np. "64/2026") albo ifirmaId (numer iFirma).',
    input_schema: {
      type: 'object',
      properties: {
        invoiceId: { type: 'string', description: 'UUID faktury w naszej bazie' },
        invoiceNumber: { type: 'string', description: 'Pełny numer faktury, np. "64/2026"' },
        ifirmaId: { type: 'number', description: 'ID faktury w iFirma (gdy znamy)' },
      },
    },
  },
  {
    name: 'get_context',
    description: 'Pobierz kontekst poprzedniej operacji księgowej (lastAction, lastInvoiceId, lastContractorId itp.). Wywołaj gdy dostajesz krótkie polecenie bez konkretu (tak/ok/wyślij/potwierdź) — żeby wiedzieć do czego się odnosi. Wraca {lastAction, savedAt, ...szczegóły}.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'analytics_products_sold',
    description: 'Sprzedaz per produkt w okresie. Bez ean -> top-N EANow w okresie (sort po qty desc). Z ean -> time series. ZAWSZE wywolaj dla pytan "ile sztuk", "ile sprzedalismy X", "top produkty". Currency split PL/ES osobno.',
    input_schema: {
      type: 'object',
      properties: {
        ean: { type: 'string' },
        from: { type: 'string', description: 'YYYY-MM-DD. Bez = rok temu.' },
        to: { type: 'string', description: 'YYYY-MM-DD. Bez = dzisiaj.' },
        country: { type: 'string' }, limit: { type: 'number' },
        source: { type: 'string', description: 'pl|es lub pomin dla obu' },
        granularity: { type: 'string', description: 'day|week|month|quarter|year (tylko z ean)' },
      },
    },
  },
  {
    name: 'analytics_revenue',
    description: 'Obroty per okres+currency+source. ZAWSZE dla "ile zarobilismy / obroty / przychod".',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string' }, to: { type: 'string' },
        country: { type: 'string' }, currency: { type: 'string' },
        source: { type: 'string' },
        granularity: { type: 'string' },
      },
    },
  },
  {
    name: 'analytics_top_customers',
    description: 'Top N klientow po total_revenue (sortowanie numeryczne desc). ZAWSZE dla "top klienci / ranking / kto najwiecej".',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string' }, to: { type: 'string' },
        year: { type: 'number' },
        country: { type: 'string' }, limit: { type: 'number' }, source: { type: 'string' },
      },
    },
  },
  {
    name: 'jpk_build_and_send',
    description: 'Paczka WDT za miesiac: matchuje FV WDT z listami GK (CMR), nazwany numerami FV, zbiorczy PDF, wysyla mailem do ksiegowej (DEFAULT_ACCOUNTANT_EMAIL z env). JEDEN call. ZAWSZE uzywaj dla: "zrob/zbuduj/przygotuj/wyslij paczke wdt", "paczka ksiegowej", "paczka wdt za maj/kwiecien". Bez year/month = poprzedni miesiac. BEZ pytania user-a o email — env decyduje.',
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'number', description: 'Default: rok poprzedniego miesiaca.' },
        month: { type: 'number', description: 'Default: poprzedni miesiac (1-12).' },
        to: { type: 'string', description: 'Override domyslnej ksiegowej (rzadko — user explicit "wyslij na X").' },
      },
    },
  },
  {
    name: 'jpk_list_packages',
    description: 'Lista wszystkich miesiecznych paczek WDT (status: building/ready/sent). Dla "pokaz paczki ksiegowej", "jakie sa paczki".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'jpk_package_details',
    description: 'Szczegoly konkretnej paczki za miesiac (lista FV, lista CMR, dopasowania, unmatched). period format YYYY-MM np. "2026-04".',
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', description: 'YYYY-MM format' },
      },
      required: ['period'],
    },
  },
];

const ENDPOINT_MAP = {
  invoice_preview: ['POST', '/api/ifirma/invoice-preview'],
  invoice_confirm: ['POST', '/api/ifirma/invoice-confirm-latest'],
  invoice_send_email: ['POST', '/api/ifirma/send-invoice-email'],
  list_products: ['GET', '/api/products'],
  expand_box: ['GET', '/api/products/expand-box'], // qty/ean as query
  ifirma_sync: ['POST', '/api/ifirma/sync'],
  analytics: ['POST', '/api/analytics'],
  create_deal: ['POST', '/api/deals'],
  open_consignment: ['POST', '/api/consignments/open'],
  send_invoice_pdf_telegram: ['POST', '/api/ifirma/resend-pdf-telegram'],
  get_context: ['GET', '/api/agent-context/ksiegowosc'],
  find_contractor: ['GET', '/api/contractors'],
  verify_nip: ['POST', '/api/contractors/verify-nip'],
  upsert_contractor: ['POST', '/api/contractors/upsert'],
  analytics_products_sold: ['GET', '/api/analytics/products-sold'],
  analytics_revenue: ['GET', '/api/analytics/revenue'],
  analytics_top_customers: ['GET', '/api/analytics/top-customers'],
  jpk_build_and_send: ['POST', '/api/jpk/build-and-send'],
  jpk_list_packages: ['GET', '/api/jpk/packages'],
  jpk_package_details: ['GET', '/api/jpk/package/:period'],
};

const executeTool = buildExecuteTool({
  endpointMap: ENDPOINT_MAP,
  logPrefix: '[accounting-agent]',
});

// Force tool choice when intent is unambiguous to suppress LLM hallucination.
const PREVIEW_INTENT = /\b(wystaw|zr[oó]b|przygotuj) (fakt|fv)|\b(faktur|fv) (dla|na)/i;
const CONFIRM_INTENT = /^\s*(tak|ok|potwierdz|akceptu|zgadzam|jasne|dobra)\b|\bpotwierd[zź]\s+(fakt|fv|ostatni|preview)/i;
const SEND_INVOICE_INTENT = /\bwy[sś]lij (fakt|fv) (mailem|mejlem|do)|\bfakt\w* mailem\b/i;
const PDF_TELEGRAM_INTENT =
  /\btelegram\w*\b[\s\S]*\b(pdf|fakt\w*|fv)\b/i      // explicit "telegram" + invoice keyword
  .source + '|' +
  /\b(pdf|fakt\w*|fv)\b[\s\S]*\btelegram\w*\b/i.source + '|' +
  // "daj fv X" / "daj fakturę X" / "daj mi fv X" — short user phrase meaning
  // "send the invoice PDF here on Telegram" (NOT search, NOT email).
  /\bdaj\s+(?:mi\s+)?(?:pdf\s+)?(?:fv|fakt\w*)\b/i.source;
const PDF_TELEGRAM_INTENT_RE = new RegExp(PDF_TELEGRAM_INTENT, 'i');
const SYNC_INTENT = /\bsynchron|\bsync\b|zsynchronizuj/i;
const ANALYTICS_INTENT = /\bobr[oó]t|przetermin|statystyk|raport|ile (mam|jest|wystawiono)|suma fakt/i;

async function processAccountingQuery(query, ctx = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { text: 'ANTHROPIC_API_KEY nie skonfigurowany.', error: 'no_api_key' };
  }
  if (!query || typeof query !== 'string') {
    return { text: 'Brak query.', error: 'no_query' };
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const yearStr = todayStr.slice(0, 4);
  const dateContextPrefix = `[KONTEKST: Dzisiejsza data: ${todayStr}. Biezacy rok: ${yearStr}. "Tym roku" / "Ten rok" / "This year" = ${yearStr}. Dla analytics ZAWSZE uzyj from=${yearStr}-01-01 to=${todayStr} jak user pyta "tym roku" / "this year".]\n\n`;
  const messages = [{ role: 'user', content: dateContextPrefix + query }];
  let forcedTool = null;
  // Order matters: confirm beats preview when both could match (e.g. "tak wystaw fakturę"
  // is rare; but typical "tak" alone is confirm).
  if (CONFIRM_INTENT.test(query) && !PREVIEW_INTENT.test(query)) forcedTool = 'invoice_confirm';
  else if (PDF_TELEGRAM_INTENT_RE.test(query)) forcedTool = 'send_invoice_pdf_telegram';
  else if (SEND_INVOICE_INTENT.test(query)) forcedTool = 'invoice_send_email';
  else if (SYNC_INTENT.test(query)) forcedTool = 'ifirma_sync';
  else if (ANALYTICS_INTENT.test(query)) forcedTool = 'analytics';
  else if (PREVIEW_INTENT.test(query)) forcedTool = 'invoice_preview';

  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: buildSystemPrompt(),
    tools: buildTools(),
    tool_choice: forcedTool ? { type: 'tool', name: forcedTool } : { type: 'auto' },
    messages,
  });

  let iterations = 0;
  const MAX_ITER = 5;
  while (response.stop_reason === 'tool_use' && iterations < MAX_ITER) {
    iterations++;
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResultBlocks = [];
    for (const tu of toolUseBlocks) {
      console.log(`[accounting-agent] tool_use: ${tu.name}`, JSON.stringify(tu.input).slice(0, 300));
      const result = await executeTool(tu.name, tu.input, ctx);
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: 'assistant', content: sanitizeAssistantContent(response.content) });
    messages.push({ role: 'user', content: toolResultBlocks });

    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: buildSystemPrompt(),
      tools: buildTools(),
      messages,
    });
  }

  const textBlock = response.content.find(b => b.type === 'text');
  return {
    text: textBlock ? textBlock.text : '',
    iterations,
    stopReason: response.stop_reason,
  };
}

module.exports = { processAccountingQuery };
