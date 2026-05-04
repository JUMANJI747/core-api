'use strict';

// Sub-agent for the Canary Islands company (Contasimple, IGIC). Mirrors the
// PL `accounting-agent.js` structure: forced-tool intent detection on top of
// Anthropic tool calling, every tool maps to one of the /api/contasimple/*
// HTTP endpoints invoked over self-loop. Stateless from n8n's perspective —
// it gets a free-text query, does its work, returns text. Lives behind
// POST /api/agent/accounting-es.

const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL =
  process.env.ACCOUNTING_AGENT_ES_MODEL ||
  process.env.ACCOUNTING_AGENT_MODEL ||
  'claude-sonnet-4-5-20250929';

const SYSTEM_PROMPT = `Jesteś sub-agentem KSIĘGOWOŚĆ KANARY (Contasimple, Hiszpania, IGIC).
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
Najpierw cs_get_context aby zobaczyć ostatnią akcję (lastAction).
- lastAction="preview" + "tak" → cs_invoice_confirm
- lastAction="confirmed" + "wyślij mailem do X" → cs_invoice_send_email
- lastAction="delete-preview" + "tak" → cs_delete_confirm

FLOW WYSTAWIENIA FV:
1. cs_invoice_preview z items + contractorSearch (lub contractorCif) → response: previewId, lines, totals, period
2. POKAŻ user-owi DOSŁOWNIE listę pozycji + sumy + previewId
3. User "tak"/"ok" → cs_invoice_confirm (bez argumentów)
4. Po confirm: response = invoiceNumber (np. "2026-0058"), invoiceId, pdfSent. PDF idzie na Telegram automatycznie.

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
};

function selfCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const port = process.env.PORT || 3000;
    const apiKey = (process.env.API_KEY || '').trim();
    const data = body && method !== 'GET' ? JSON.stringify(body) : '';
    const finalPath =
      method === 'GET' && body ? `${path}?${new URLSearchParams(body).toString()}` : path;
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
    const req = http.request(options, res => {
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

async function executeTool(name, input, ctx = {}) {
  const ep = ENDPOINT_MAP[name];
  if (!ep) return { error: `Unknown tool: ${name}` };
  const [method, path] = ep;
  // Inject ctx.chatId on every body so endpoints that send Telegram (confirm,
  // delete-confirm, resend-pdf-telegram) deliver to the user who actually
  // initiated the request, not the global telegram_chat_id_es from Config.
  const body = method === 'GET' ? input : { ...(input || {}), ...(ctx.chatId ? { chatId: ctx.chatId } : {}) };
  try {
    const resp = await selfCall(method, path, body);
    return resp.body;
  } catch (err) {
    console.error(`[accounting-agent-es] tool ${name} error:`, err.message);
    return { error: err.message };
  }
}

// Force tool choice on unambiguous intents to suppress LLM detours.
const PREVIEW_INTENT = /\b(wystaw|zr[oó]b|przygotuj) (fakt|fv|factura)|\b(faktur|fv|factura) (dla|na|para)/i;
const CONFIRM_INTENT = /^\s*(tak|ok|si|sí|potwierdz|akceptu|zgadzam|jasne|dobra|emite|emitir)\b/i;
const SEND_EMAIL_INTENT = /\bwy[sś]lij (fakt|fv|factura) (mailem|mejlem|por mail|por correo|por email)|\bfakt\w* mailem\b|\benv[ií]a\b.*\b(factura|fv)\b/i;
const PDF_TELEGRAM_INTENT_RE = new RegExp(
  /\btelegram\w*\b[\s\S]*\b(pdf|fakt\w*|fv|factura)\b/i.source + '|' +
  /\b(pdf|fakt\w*|fv|factura)\b[\s\S]*\btelegram\w*\b/i.source + '|' +
  /\bdaj\s+(?:mi\s+)?(?:pdf\s+)?(?:fv|fakt\w*|factura)\b/i.source,
  'i'
);
const DELETE_INTENT = /\b(skasuj|usu[nń]|skasowa[ćc]|elimina|borra|cancela)\b/i;
const SYNC_INTENT = /\bsynchron|\bsync\b|sincroniz/i;

async function processAccountingEsQuery(query, opts = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { text: 'ANTHROPIC_API_KEY nie skonfigurowany.', error: 'no_api_key' };
  }
  if (!query || typeof query !== 'string') {
    return { text: 'Brak query.', error: 'no_query' };
  }

  const ctx = { chatId: opts.chatId || null };
  const messages = [{ role: 'user', content: query }];
  let forcedTool = null;
  if (CONFIRM_INTENT.test(query) && !PREVIEW_INTENT.test(query) && !DELETE_INTENT.test(query)) {
    // "tak" alone — let agent decide via cs_get_context whether to confirm
    // an invoice or a delete; don't force a single tool here.
    forcedTool = 'cs_get_context';
  } else if (DELETE_INTENT.test(query)) {
    forcedTool = 'cs_delete_preview';
  } else if (PDF_TELEGRAM_INTENT_RE.test(query)) {
    forcedTool = 'cs_send_invoice_pdf_telegram';
  } else if (SEND_EMAIL_INTENT.test(query)) {
    forcedTool = 'cs_invoice_send_email';
  } else if (SYNC_INTENT.test(query)) {
    forcedTool = 'cs_sync_customers';
  } else if (PREVIEW_INTENT.test(query)) {
    forcedTool = 'cs_invoice_preview';
  }

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
      console.log(`[accounting-agent-es] tool_use: ${tu.name}`, JSON.stringify(tu.input).slice(0, 300));
      const result = await executeTool(tu.name, tu.input, ctx);
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

module.exports = { processAccountingEsQuery };
