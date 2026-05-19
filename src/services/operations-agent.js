'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { buildExecuteTool, sanitizeAssistantContent } = require('./agent-runtime');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.OPERATIONS_AGENT_MODEL || 'claude-sonnet-4-5-20250929';

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

const BASE_PROMPT = `Jesteś sub-agentem OPERACJE SurfStickBell. Plain text PL, krótko.

╔════════════════════════════════════════╗
║ AKTUALNA DATA (HARD-CODED PER REQUEST) ║
║ DZIS:        {{TODAY}}                 ║
║ BIEŻĄCY ROK: {{YEAR}}                  ║
║ ZESZŁY ROK:  {{LAST_YEAR}}             ║
╚════════════════════════════════════════╝

"ten rok" / "tym roku" / "this year" → ZAWSZE {{YEAR}}, NIE {{LAST_YEAR}}.
"ostatnio" = 30 dni od {{TODAY}}.
"w zeszłym tygodniu" = 7-14 dni wstecz od {{TODAY}}.

ZASADA #0 — NIGDY NIE LICZ Z GŁOWY:
Pytania "ile sprzedaliśmy / ile obroty / top klienci / ile sztuk" → ZAWSZE
wywolaj analytics_* tool. NIGDY nie podawaj liczb bez wczesniejszego call.
NIGDY nie zgaduj ani nie ekstrapoluj. Jak tool wraca pusto → mowisz "brak
danych w bazie", nie wymyslasz. Liczby pokazujesz DOSLOWNIE z response.

ZASADA SAMPLE FOLLOWUP:
Pytania "do kogo wyslalismy sample / kto dostal sample / komu trzeba
napisac follow-up po sample / ktore sample doszly" → ZAWSZE
sample_followups (deterministyczny tool: SQL sprawdza ze contractor NIE
mial wczesniej FV — to definicja sample u nas). NIGDY nie skanuj maili
list i nie zgaduj komu wyslano sample na podstawie tresci. Mail moze
mowic o czymkolwiek — tylko brak wczesniejszej FV daje pewnosc.

═══ ROZKŁADANIE ZŁOŻONYCH POLECEŃ NA KROKI ═══

Jak dostaniesz zlozone polecenie (kilka cele, "i ... i ...", wymaga
porownania danych z roznych zrodel) — NIE probuj zgadywac odpowiedzi
od razu. Rozloz na KROKI w glowie:

  Plan:
  1. <co zrobic najpierw — jaki tool, jakie dane>
  2. <potem — co laczyc, co filtrowac>
  3. <agregacja / odpowiedz>

Wykonuj KROK PO KROKU przez tool calls. Po kazdym zbierasz dane do
kontekstu. Jak step zwroci pustke / nie to czego oczekiwales →
zatrzymaj sie, powiedz user-owi co znalazles i dopytaj, NIE konfabuluj
brakujace.

PRZYKLAD: "Sprawdz ktore sample wyslane przed 7 dniami sa juz dostarczone
ale klient nie odpisal na nasz maili tracking":
  1. sample_followups({minDaysSinceDelivery: 7, windowDays: 30}) → lista
     sample-ow z trackingiem
  2. query_db SELECT id, "contractorId", subject, "createdAt" FROM "Email"
     WHERE direction='INBOUND' AND "createdAt" > <data wysylki>
     AND "contractorId" IN (<lista z #1>) → kto odpisal
  3. Per sample z #1: jak BRAK matchujacego email z #2 → kandydat do
     follow-upu. Pokaz user-owi.

DOSTĘPNE narzędzia do "thinking":
  - query_db: read-only SELECT na bazie. Modele dostepne: Email,
    Contractor, Invoice, EsInvoice, Transaction, Consignment, Deal,
    ActivityEvent, Memory, EsContractor.
  - call_endpoint: dowolny /api/* endpoint (sample_followups,
    analytics_*, /api/transactions, /api/contractors, etc).
  - gk_raw: bezposrednio GlobKurier API (gdy potrzebujesz danych
    spoza naszej bazy).
  - search_activity: timeline z ActivityEvent (mail/invoice/shipment/
    tracking) z filtrami.

Tych 4 narzedzi WYSTARCZA na 90% zlozonych pytan — laczysz wyniki w
kontekscie, nie wymagasz nowych endpointow.

ZADANIA:
- Łączenie / rozdzielanie transakcji (gdy auto-matcher nie skleił mail+FV+paczka+płatność)
- Pokazywanie listy transakcji (otwarte / zamknięte / orphany)
- Dodawanie ręcznych wpisów ("mam do wysłania X do Y")
- Bootstrap (zassocjowanie ostatnich FV i paczek)
- Inspekcja co spakować dziś / co zostało otwarte

INTERPRETACJA REFERENCJI USERA (klucz!):
User mówi po ludzku, ty rozszyfrowujesz na konkretne id-ki:

- "wiersz 3" / "row 3" / "trzeci" → list_transactions, znajdź sheetRowId=3, weź jej id
- "ostatnia FV" / "ostatnia faktura" → list_transactions z filter, najnowsza z hasInvoice=true
- "ostatnia wysyłka" / "ostatnia paczka" → analogicznie hasShipped=true
- "FV 64" / "faktura 64/2026" → list_transactions z filter "64", weź transakcję z invoiceNumber matchującym
- "dla Nuno" / "dla S-Tream" — to filter po contractorName (nie cała query)
- "ostatnia paczka do Nuno" — łączy: filter Nuno + hasShipped=true + sortuj po occurredAt DESC, weź pierwszą
- "transakcja z 28 kwietnia" → filter po dacie

Kombinacje: "ostatnia wysyłka dla Nuno z fakturą 64" = jedna transakcja (filter nuno + matchuje numer 64) — szukasz tego ZAMÓWIENIA jako całość.

ŁĄCZENIE:
1. WYWOŁAJ list_transactions z odpowiednim filtrem (kontrahent / numer FV / data) — bierz kontekst
2. ZNAJDŹ dwie transakcje które user chce skleić — wybierz po contractorName / invoiceNumber / shipmentNumber
3. POKAŻ user-owi: "Łączę: tx A (FV 64/2026, Nuno) + tx B (paczka GK260..., Nuno) → potwierdzasz?"
4. Po "tak" → wywołaj merge_transactions z primaryId/secondaryId (UUID z list_transactions)

Primary: ten z FAKTURĄ (bo zwykle ma więcej info). Secondary: paczka. Merge zachowuje primary, kopiuje shipment z secondary.

ROZDZIELANIE (split):
"odłącz fakturę od tej transakcji" → split_transaction z detach="invoice".

DODAWANIE MANUAL:
"mam do wysłania 30 sticków do Karola" → add_manual_entry z contractorSearch="Karola", itemsSummary="30× stick", okazj=null (nie znamy kwoty).

ZASADY:
- ZAWSZE list_transactions PIERWSZE gdy user mówi o referencji ("ostatnia X", "dla Y", "wiersz Z"). NIE ZGADUJ id-ków.
- Po list_transactions weź id z konkretnego rekordu. NIGDY nie wymyślaj UUID.
- response.error → POKAŻ DOSŁOWNIE
- Po merge pokaż user-owi listę pól które zostały skopiowane (response.copied).`;

const tools = [
  {
    name: 'list_transactions',
    description: 'Lista transakcji z filtrami. Użyj ZAWSZE gdy user odnosi się do "ostatniej X" / "dla Y" / "wiersza Z" — żeby pobrać id-ki. Zwraca id, contractorName, invoiceNumber, shipmentNumber, occurredAt, hasFlags, sheetRowId.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'complete', 'stale', 'orphan'], description: 'Filtr statusu (opcjonalne)' },
        limit: { type: 'number', description: 'Ile zwrócić, default 50, max 200' },
      },
    },
  },
  {
    name: 'merge_transactions',
    description: 'Połącz dwie transakcje w jedną. Primary zachowuje swoje pola, sekundary znika ale przekazuje brakujące pola (contractor / invoice / shipment / items / notes). Stage flags OR-merged. Wymaga UUID obu transakcji (z list_transactions).',
    input_schema: {
      type: 'object',
      properties: {
        primaryId: { type: 'string', description: 'UUID transakcji która zostaje (zwykle ta z fakturą)' },
        secondaryId: { type: 'string', description: 'UUID transakcji która znika (zwykle ta z paczką)' },
      },
      required: ['primaryId', 'secondaryId'],
    },
  },
  {
    name: 'split_transaction',
    description: 'Odłącz jeden etap z transakcji (gdy matcher błędnie skleił). detach="invoice"|"shipment"|"order"|"payment". Dane nie znikają, tylko linkage.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'UUID transakcji' },
        detach: { type: 'string', enum: ['invoice', 'shipment', 'order', 'payment'] },
      },
      required: ['id', 'detach'],
    },
  },
  {
    name: 'add_manual_entry',
    description: 'Dodaj ręczny wpis transakcji ("mam do wysłania X do Y", "wystaw fakturę za pakowanie"). Bez automatycznego matchingu — będzie czekała aż system dopasuje paczkę/fakturę.',
    input_schema: {
      type: 'object',
      properties: {
        contractorSearch: { type: 'string', description: 'Nazwa kontrahenta (fuzzy)' },
        amount: { type: 'number', description: 'Kwota (opcjonalne)' },
        currency: { type: 'string', enum: ['PLN', 'EUR'], description: 'Waluta (opcjonalne)' },
        itemsSummary: { type: 'string', description: 'Krótki opis np. "30× stick generic"' },
        notes: { type: 'string', description: 'Notatka' },
      },
    },
  },
  {
    name: 'bootstrap_transactions',
    description: 'Inicjalne wczytanie ostatnich N faktur i N paczek do tracker-a (jednorazowo na start, albo dla nadrobienia). Domyślnie 10 + 10. Zwraca raport orphans + sample.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Ile FV i ile paczek (default 10)' },
      },
    },
  },
  {
    name: 'analytics_products_sold',
    description: 'Sprzedaz per produkt w okresie. Bez ean -> top-N EANow w okresie (sortowane po qty desc). Z ean -> time series tego konkretnego produktu. ZAWSZE wywolaj dla pytan "ile sztuk", "ile sprzedalismy", "top produkty". Domyslnie limit 50, cap 500. Currency split PL/ES osobno.',
    input_schema: {
      type: 'object',
      properties: {
        ean: { type: 'string', description: 'Konkretny EAN — wtedy time series po granularity. Bez = top N.' },
        from: { type: 'string', description: 'YYYY-MM-DD. Default: rok temu od dzisiejszej daty.' },
        to: { type: 'string', description: 'YYYY-MM-DD. Default: dzisiejsza data.' },
        country: { type: 'string', description: 'ISO-2 filter np. PL, DE, ES' },
        limit: { type: 'number' },
        source: { type: 'string', description: '"pl" lub "es" lub pomin dla obu' },
        granularity: { type: 'string', description: 'day|week|month|quarter|year (tylko z ean)' },
      },
    },
  },
  {
    name: 'analytics_revenue',
    description: 'Obroty per okres (group by period+currency+source). Currency wraca jako string, suma jako Decimal-text. ZAWSZE dla pytan "ile zarobilismy", "obroty", "przychod".',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string' }, to: { type: 'string' },
        country: { type: 'string' }, currency: { type: 'string' },
        source: { type: 'string' },
        granularity: { type: 'string', description: 'day|week|month|quarter|year' },
      },
    },
  },
  {
    name: 'analytics_top_customers',
    description: 'Top N klientow po total_revenue (sortowanie desc po faktycznej liczbie, nie tekstowo). ZAWSZE dla pytan "top klienci", "kto najwiecej kupil", "ranking".',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string' }, to: { type: 'string' },
        year: { type: 'number', description: 'Zamiast from/to — od 1 stycznia do 31 grudnia roku.' },
        country: { type: 'string' }, limit: { type: 'number' }, source: { type: 'string' },
      },
    },
  },
  {
    name: 'query_db',
    description: 'Read-only SELECT na PostgreSQL przez Prisma raw. Tylko SELECT/WITH. Max 500 wierszy. Modele: Email, Contractor, ContractorContact, ContractorAddress, Invoice, EsInvoice, EsContractor, Transaction, Consignment, Deal, Activity, ActivityEvent, Memory, Product, EsProduct, AuditLog. Cudzyslowy dla nazw modeli/kolumn (camelCase quoted). Uzywaj do KAZDEGO custom pytania ktore wymaga laczenia danych roznych modeli — rozlozeniu polecenia user-a na kroki SQL.',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SELECT statement, np. SELECT id, name FROM "Contractor" WHERE country=$1' },
        params: { type: 'array', description: 'Parametry $1,$2,... (zapobiega SQL injection)', items: {} },
      },
      required: ['sql'],
    },
  },
  {
    name: 'call_endpoint',
    description: 'Wywolaj dowolny /api/* endpoint backendu. Dla danych, ktore juz mamy pre-agregowane (analytics, sample_followups, transactions, contractors) — szybciej niz query_db.',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        path: { type: 'string', description: 'Pelna sciezka od /api/' },
        body: { type: 'object', description: 'Body request albo query params dla GET' },
      },
      required: ['path'],
    },
  },
  {
    name: 'gk_raw',
    description: 'Bezposrednie wywolanie GlobKurier API (api.globkurier.pl/v1/*). Token automatycznie. Uzyj gdy potrzebujesz danych ktorych nie mamy w naszej bazie (live status paczki, lista zamowien GK, etc).',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
        path: { type: 'string', description: 'np. /v1/order/tracking?orderNumber=GK260...' },
        body: { type: 'object' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_activity',
    description: 'Timeline ActivityEvent z filtrami: contractorId, type ("mail.*" wildcard), tags ("country:de,carrier:dpd"), q (ILIKE na searchText), since/until.',
    input_schema: {
      type: 'object',
      properties: {
        contractorId: { type: 'string' },
        type: { type: 'string' },
        types: { type: 'string' },
        tags: { type: 'string' },
        tagsAny: { type: 'string' },
        source: { type: 'string' },
        q: { type: 'string' },
        since: { type: 'string' },
        until: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'sample_followups',
    description: 'Deterministyczna lista sample-recipientow do follow-upu. DEFINICJA SAMPLE: kontrahent NIE mial wczesniej zadnej FV w bazie (PL ani ES) — sprawdzane bezposrednio w SQL, NIE zgadujemy ze rozmowy. Bierze pod uwage paczki wyslane w ostatnich {windowDays} dni, ktore SA delivered >{minDaysSinceDelivery} dni temu (default 3) ALBO wyslane >{undeliveredAfterDays} dni temu (default 4) bez statusu (GK czesto pomija update). Zwraca: contractorName, email, preferredLanguage, shipmentNumber, trackingNumber, daysSinceDelivery. ZAWSZE wywoluj dla pytan "do kogo wyslalismy sample / komu trzeba napisac follow-up / ktore sample doszly".',
    input_schema: {
      type: 'object',
      properties: {
        minDaysSinceDelivery: { type: 'number', description: 'Default 3' },
        windowDays: { type: 'number', description: 'Default 60' },
        includeUndelivered: { type: 'boolean', description: 'Default true — wlacz tez paczki bez GK delivered update jak shipped >4 dni temu' },
        undeliveredAfterDays: { type: 'number', description: 'Default 4' },
      },
    },
  },
];

const ENDPOINT_MAP = {
  list_transactions: ['GET', '/api/transactions'],
  merge_transactions: ['POST', '/api/transactions/merge'],
  split_transaction: ['POST', '/api/transactions/:id/split'],
  add_manual_entry: ['POST', '/api/transactions/manual'],
  bootstrap_transactions: ['POST', '/api/transactions/bootstrap'],
  analytics_products_sold: ['GET', '/api/analytics/products-sold'],
  analytics_revenue: ['GET', '/api/analytics/revenue'],
  analytics_top_customers: ['GET', '/api/analytics/top-customers'],
  sample_followups: ['GET', '/api/operations/sample-followups'],
  query_db: ['POST', '/api/admin/query'],
  call_endpoint: ['POST', '/api/admin/call-endpoint'],
  gk_raw: ['POST', '/api/admin/gk-raw'],
  search_activity: ['GET', '/api/activity'],
};

const executeTool = buildExecuteTool({
  endpointMap: ENDPOINT_MAP,
  logPrefix: '[operations-agent]',
});

async function processOperationsQuery(query, ctx = {}) {
  if (!process.env.ANTHROPIC_API_KEY) return { text: 'ANTHROPIC_API_KEY nie skonfigurowany.', error: 'no_api_key' };
  if (!query || typeof query !== 'string') return { text: 'Brak query.', error: 'no_query' };

  const todayStr = new Date().toISOString().slice(0, 10);
  const yearStr = todayStr.slice(0, 4);
  const dateContextPrefix = `[KONTEKST: Dzisiejsza data: ${todayStr}. Biezacy rok: ${yearStr}. "Tym roku" / "Ten rok" = ${yearStr}.]\n\n`;
  const messages = [{ role: 'user', content: dateContextPrefix + query }];
  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: buildSystemPrompt(),
    tools: buildTools(),
    messages,
  });

  const MAX_ITER = 6;   // listing + decyzja + ewentualne merge / split — daje agentowi luźne 6 rund
  let iterations = 0;
  while (response.stop_reason === 'tool_use' && iterations < MAX_ITER) {
    iterations++;
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResultBlocks = [];
    for (const tu of toolUseBlocks) {
      console.log(`[operations-agent] tool_use: ${tu.name}`, JSON.stringify(tu.input).slice(0, 200));
      const result = await executeTool(tu.name, tu.input, ctx);
      toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
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

  const finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { text: finalText, iterations, stopReason: response.stop_reason };
}

module.exports = { processOperationsQuery };
