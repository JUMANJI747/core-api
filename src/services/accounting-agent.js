'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ACCOUNTING_AGENT_MODEL || 'claude-sonnet-4-5-20250929';

const SYSTEM_PROMPT = `Jesteś sub-agentem KSIĘGOWOŚĆ SurfStickBell. Plain text, krótko, ceny brutto.

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

WDT vs KRAJOWA:
- Krajowa (PL kontrahent) — domyślnie BRUTTO w PLN, VAT 23%
- WDT (UE) — domyślnie NETTO w EUR, VAT 0%
- System sam dobiera typ na podstawie kontrahenta

FLOW WYSTAWIENIA FV:
1. invoice_preview z items+contractorSearch → response ma previewId, pozycje, suma
2. POKAŻ user-owi preview DOSŁOWNIE z odpowiedzi + previewId
3. User mówi "tak"/"ok" → invoice_confirm (bez argumentów — bierze najnowszy preview)
4. Po confirm: response ma invoiceNumber, invoiceId. PDF idzie automatycznie na Telegram.

PONOWNE WYSŁANIE PDF FAKTURY NA TELEGRAM:
- "daj mi pdf faktury 64/2026 na telegram" / "ponownie pdf FV X" / "przyślij tu fakturę X"
  → send_invoice_pdf_telegram z invoiceNumber: "64/2026" (lub invoiceId / ifirmaId jak znamy)
- Wysłanie mailem (do klienta) to invoice_send_email — nie myl ich.

ZASADY:
- ZAWSZE wywołuj tool przy nowym żądaniu — nie kopiuj odpowiedzi z historii
- response.error → pokaż DOSŁOWNIE, NIE zgaduj przyczyn
- response.ok=false z suggestions → pokaż user-owi listę żeby wybrał
- NIE zmyślaj wartości / cen / numerów faktur — wszystko z odpowiedzi tool
- Plain text, listy z "-", krótko bez wstępów`;

const tools = [
  {
    name: 'invoice_preview',
    description: 'Podgląd faktury przed wystawieniem. Szuka kontrahenta po nazwie (fuzzy), rozwija boxy MIX, sprawdza ceny z cennika. ZAWSZE użyj gdy user prosi o wystawienie faktury — pokaż preview, czekaj na "tak".',
    input_schema: {
      type: 'object',
      properties: {
        contractorSearch: { type: 'string', description: 'Nazwa lub fragment nazwy kontrahenta' },
        contractorId: { type: 'string', description: 'UUID kontrahenta (gdy znany dokładnie — pomija fuzzy search)' },
        items: {
          type: 'array',
          description: 'Lista pozycji faktury — każda z {name LUB ean, qty, opcjonalnie priceNetto/priceBrutto}',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Nazwa produktu (np. "stick generic", "mascara pink")' },
              ean: { type: 'string', description: 'EAN konkretnego produktu lub box (np. "BOX-STICK-30")' },
              qty: { type: 'number', description: 'Ilość sztuk' },
              priceNetto: { type: 'number', description: 'Cena netto per szt (opcjonalne)' },
              priceBrutto: { type: 'number', description: 'Cena brutto per szt (opcjonalne)' },
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
};

function selfCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const port = process.env.PORT || 3000;
    const apiKey = (process.env.API_KEY || '').trim();
    const data = body && method !== 'GET' ? JSON.stringify(body) : '';
    const finalPath = method === 'GET' && body ? `${path}?${new URLSearchParams(body).toString()}` : path;
    const options = {
      hostname: '127.0.0.1',
      port,
      path: finalPath,
      method,
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
  const [method, path] = ep;
  try {
    const resp = await selfCall(method, path, input);
    return resp.body;
  } catch (err) {
    console.error(`[accounting-agent] tool ${name} error:`, err.message);
    return { error: err.message };
  }
}

// Force tool choice when intent is unambiguous to suppress LLM hallucination.
const PREVIEW_INTENT = /\b(wystaw|zr[oó]b|przygotuj) (fakt|fv)|\b(faktur|fv) (dla|na)/i;
const CONFIRM_INTENT = /^\s*(tak|ok|potwierdz|akceptu|zgadzam|jasne|dobra)\b|\bpotwierd[zź] fakt/i;
const SEND_INVOICE_INTENT = /\bwy[sś]lij (fakt|fv) (mailem|mejlem|do)|\bfakt\w* mailem\b/i;
const PDF_TELEGRAM_INTENT = /\btelegram\w*\b[\s\S]*\b(pdf|fakt\w*|fv)\b|\b(pdf|fakt\w*|fv)\b[\s\S]*\btelegram\w*\b/i;
const SYNC_INTENT = /\bsynchron|\bsync\b|zsynchronizuj/i;
const ANALYTICS_INTENT = /\bobr[oó]t|przetermin|statystyk|raport|ile (mam|jest|wystawiono)|suma fakt/i;

async function processAccountingQuery(query) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { text: 'ANTHROPIC_API_KEY nie skonfigurowany.', error: 'no_api_key' };
  }
  if (!query || typeof query !== 'string') {
    return { text: 'Brak query.', error: 'no_query' };
  }

  const messages = [{ role: 'user', content: query }];
  let forcedTool = null;
  // Order matters: confirm beats preview when both could match (e.g. "tak wystaw fakturę"
  // is rare; but typical "tak" alone is confirm).
  if (CONFIRM_INTENT.test(query) && !PREVIEW_INTENT.test(query)) forcedTool = 'invoice_confirm';
  else if (PDF_TELEGRAM_INTENT.test(query)) forcedTool = 'send_invoice_pdf_telegram';
  else if (SEND_INVOICE_INTENT.test(query)) forcedTool = 'invoice_send_email';
  else if (SYNC_INTENT.test(query)) forcedTool = 'ifirma_sync';
  else if (ANALYTICS_INTENT.test(query)) forcedTool = 'analytics';
  else if (PREVIEW_INTENT.test(query)) forcedTool = 'invoice_preview';

  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools,
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
      const result = await executeTool(tu.name, tu.input);
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResultBlocks });

    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools,
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
