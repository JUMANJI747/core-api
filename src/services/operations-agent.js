'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.OPERATIONS_AGENT_MODEL || 'claude-sonnet-4-5-20250929';

const SYSTEM_PROMPT = `Jesteś sub-agentem OPERACJE SurfStickBell. Plain text PL, krótko.

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
];

const ENDPOINT_MAP = {
  list_transactions: ['GET', '/api/transactions'],
  merge_transactions: ['POST', '/api/transactions/merge'],
  split_transaction: ['POST', '/api/transactions/:id/split'],
  add_manual_entry: ['POST', '/api/transactions/manual'],
  bootstrap_transactions: ['POST', '/api/transactions/bootstrap'],
};

function selfCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const port = process.env.PORT || 3000;
    const apiKey = (process.env.API_KEY || '').trim();
    const data = body && method !== 'GET' ? JSON.stringify(body) : '';
    const finalPath = method === 'GET' && body
      ? `${path}?${new URLSearchParams(Object.entries(body).filter(([_, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)])).toString()}`
      : path;
    const options = {
      hostname: '127.0.0.1', port, path: finalPath, method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
    };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch (e) { resolve({ status: res.statusCode, body: text }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function executeTool(name, input) {
  const ep = ENDPOINT_MAP[name];
  if (!ep) return { error: `Unknown tool: ${name}` };
  const [method, pathTemplate] = ep;
  let path = pathTemplate;
  const body = { ...(input || {}) };
  path = path.replace(/:([a-zA-Z]+)/g, (_, key) => {
    const val = body[key]; delete body[key];
    return encodeURIComponent(val || '_');
  });
  try {
    const resp = await selfCall(method, path, body);
    return resp.body;
  } catch (err) {
    console.error(`[operations-agent] tool ${name} error:`, err.message);
    return { error: err.message };
  }
}

async function processOperationsQuery(query) {
  if (!process.env.ANTHROPIC_API_KEY) return { text: 'ANTHROPIC_API_KEY nie skonfigurowany.', error: 'no_api_key' };
  if (!query || typeof query !== 'string') return { text: 'Brak query.', error: 'no_query' };

  const messages = [{ role: 'user', content: query }];
  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools,
    messages,
  });

  const MAX_ITER = 6;   // listing + decyzja + ewentualne merge / split — daje agentowi luźne 6 rund
  let iterations = 0;
  while (response.stop_reason === 'tool_use' && iterations < MAX_ITER) {
    iterations++;
    const toolUse = response.content.find(b => b.type === 'tool_use');
    const result = await executeTool(toolUse.name, toolUse.input);
    console.log(`[operations-agent] tool_use: ${toolUse.name}`, JSON.stringify(toolUse.input).slice(0, 200));

    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) }],
    });

    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
  }

  const finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { text: finalText, iterations, stopReason: response.stop_reason };
}

module.exports = { processOperationsQuery };
