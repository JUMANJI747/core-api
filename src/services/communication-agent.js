'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.COMMUNICATION_AGENT_MODEL || 'claude-sonnet-4-5-20250929';

const SYSTEM_PROMPT = `Jesteś sub-agentem KOMUNIKACJA SurfStickBell. Plain text, krótko.

ZADANIA:
- Szukanie maili (po nazwie/temacie/nadawcy)
- Pokazywanie treści maili z załącznikami
- Tworzenie draftów odpowiedzi (zatwierdzane przez user)
- Wysyłka ofert PDF
- Wysyłka FV mailem do klienta
- Parsowanie załączników (zamówienia z PDF/imagi)

SZUKANIE MAILI:
- "pokaż maila od X", "znajdź mail" → recent_emails (offset=0, limit=50). Dopasuj po fromName/fromEmail/subject. Toleruj literówki.
- Jeśli nie ma w 50 → offset=50, potem 100. Max 3 strony.
- Gdy pokazujesz znaleziony mail → na końcu DOPISZ: [ctx: emailId=<id>, from=<email>, lang=<en/pl/fr/es/pt>]

ZAŁĄCZNIKI:
- mail.attachmentCount > 0 → AUTOMATYCZNIE parse_attachments z emailId.
- Wykryto zamówienie → pokaż pozycje z cenami + zapytaj "Wystawić fakturę?"
- ZAWSZE pokazuj cenę netto z zamówienia (Master/Księgowość będzie potrzebowała do FV).

ODPOWIADANIE NA MAIL:
1. Znajdź najnowszy [ctx:] w query (Master powinien przekazać emailId, lang).
2. Brak [ctx:] → "pokaż mi najpierw maila".
3. ZAWSZE rozwiń skrót user-a w naturalną treść:
   - Powitanie: "Dzień dobry," / "Bonjour," / "Hello," / "Hola," / "Olá,"
   - Nawiąż do kontekstu, rozwiń skróty w pełne zdania (biznesowo)
   - Zakończ: "Pozdrawiam,\\nMichał Pałyska\\nSurf Stick Bell" (lub w lang)
   - 3-6 zdań
   - WYJĄTEK: "wyślij dosłownie:" → kopiuj 1:1
4. send_email z {emailId, body, draft:true} (BEZ to/subject/from — system wypełnia z oryginału).
5. Pokaż user-owi: Od, Do, Temat, Treść, "Wysłać?"

Język = lang z [ctx:]. User pisze po polsku, ty tłumaczysz na lang.

NOWY MAIL (nie odpowiedź):
- send_email z {to, subject, body, draft:true}
- Domyślnie PL, zagraniczny adres → EN.

OFERTY:
- "wyślij ofertę do X" → send_offer (contractorSearch + opcjonalnie language).

WYSYŁKA FAKTURY:
- "wyślij fakturę N do klienta" → send_invoice_email z {invoiceId}.
- toEmail OPCJONALNY: jeśli NIE znasz prawdziwego adresu, POMIŃ to pole — backend sam pobierze z Contractor.email albo z historii korespondencji (Email model).
- toEmail MUSI być formatem 'local@domena.tld'. NIE wpisuj tam:
  · nazwy firmy ("Delart Ochnik sp.k." → ŹLE)
  · placeholderów ("example.com", "test.com" → ŹLE)
  · "z bazy", "domyślny" itp. (puste pole zamiast tego)
- Jeśli odpowiadasz na konkretny mail → dopisz emailId (reply-in-thread).
- response.confirmation pokaż DOSŁOWNIE z polami: invoiceNumber, to, from, subject, attachmentSizeKB, messageId, toSource (request/contractor/email_history_*), backfilled.

POTWIERDZENIE DRAFTU:
- "tak"/"ok" po pokazaniu draftu → confirm_draft (bez argumentów — bierze najnowszy DRAFT z bazy do 30 min).

ZASADY:
- ZAWSZE wywołuj tool przy nowym żądaniu — nie kopiuj z historii.
- response.error → pokaż DOSŁOWNIE.
- NIGDY nie mów "wysłane" bez potwierdzenia z API (sent:true / messageId).
- Plain text, listy z "-", krótko.`;

const tools = [
  {
    name: 'recent_emails',
    description: 'Pobierz ostatnie maile z paginacją. Użyj do szukania konkretnego maila po nazwie/temacie. Zwraca id, fromEmail, fromName, subject, bodyPreview, attachmentCount, hasOrder.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Ile pobrać (default 50, max 100)' },
        offset: { type: 'number', description: 'Przesunięcie (0=najnowsze, 50=kolejne 50 starszych)' },
      },
    },
  },
  {
    name: 'list_drafts',
    description: 'Pokaż listę niewysłanych draftów maili.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'send_email',
    description: 'Utwórz draft maila. Wymaga zatwierdzenia (confirm_draft) przed wysłaniem. Zawsze draft:true.',
    input_schema: {
      type: 'object',
      properties: {
        emailId: { type: 'string', description: 'ID oryginalnego maila gdy odpowiadasz (auto-fill from/to/subject z reply-in-thread)' },
        to: { type: 'string', description: 'Email odbiorcy (gdy nowy mail, bez emailId)' },
        subject: { type: 'string', description: 'Temat (gdy nowy mail)' },
        body: { type: 'string', description: 'Treść maila' },
      },
      required: ['body'],
    },
  },
  {
    name: 'confirm_draft',
    description: 'Wyślij ostatni draft maila (utworzony do 30 min temu). Bez argumentów — system bierze najnowszy DRAFT.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'send_offer',
    description: 'Wyślij ofertę handlową HTML+PDF. System dobiera język z kraju kontrahenta. Podaj to (email) LUB contractorSearch (nazwa).',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Email odbiorcy' },
        contractorSearch: { type: 'string', description: 'Nazwa kontrahenta' },
        language: { type: 'string', description: 'FR/PT/ES/EN/PL (opcjonalne — system dobiera)' },
        from: { type: 'string', description: 'Adres nadawcy (opcjonalne, domyślnie info@)' },
      },
    },
  },
  {
    name: 'send_invoice_email',
    description: 'Wyślij PDF faktury mailem do klienta. Podaj invoiceId. toEmail OPCJONALNY — jak pominiesz, backend pobierze z Contractor.email albo z historii Email (najświeższa korespondencja z tym kontrahentem). NIE wpisuj nazwy firmy ani placeholderów ("example.com") jako toEmail — pomiń pole.',
    input_schema: {
      type: 'object',
      properties: {
        invoiceId: { type: 'string', description: 'Numer faktury (np. "69/2026") lub UUID z bazy' },
        toEmail: { type: 'string', description: 'OPCJONALNY: prawdziwy adres email odbiorcy (format local@domena.tld). Pomiń jeśli nie znasz — backend sam dobierze.' },
        emailId: { type: 'string', description: 'OPCJONALNY: ID oryginalnego maila do reply-in-thread' },
      },
      required: ['invoiceId'],
    },
  },
  {
    name: 'parse_attachments',
    description: 'Parsuj załączniki maila (PDF/image). Wykrywa zamówienia, zwraca pozycje. Użyj gdy mail ma attachmentCount > 0.',
    input_schema: {
      type: 'object',
      properties: {
        emailId: { type: 'string' },
      },
      required: ['emailId'],
    },
  },
  {
    name: 'check_sent',
    description: 'Sprawdź czy faktura była już wysyłana mailem (np. żeby uniknąć duplikatu).',
    input_schema: {
      type: 'object',
      properties: {
        invoiceNumber: { type: 'string' },
        to: { type: 'string', description: 'Email odbiorcy (opcjonalne — zawęża)' },
      },
      required: ['invoiceNumber'],
    },
  },
];

const ENDPOINT_MAP = {
  recent_emails: ['GET', '/api/emails/recent'],
  list_drafts: ['GET', '/api/send-email/drafts'],
  send_email: ['POST', '/api/send-email'],
  confirm_draft: ['POST', '/api/send-email/confirm-latest'],
  send_offer: ['POST', '/api/send-offer'],
  send_invoice_email: ['POST', '/api/ifirma/send-invoice-email'],
  parse_attachments: ['POST_PATH', '/api/emails/:emailId/parse-attachments'],
  check_sent: ['GET', '/api/emails/check-sent'],
};

function selfCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const port = process.env.PORT || 3000;
    const apiKey = (process.env.API_KEY || '').trim();
    const data = body && method === 'POST' ? JSON.stringify(body) : '';
    const finalPath = method === 'GET' && body
      ? `${path}?${new URLSearchParams(Object.entries(body).filter(([, v]) => v != null && v !== '')).toString()}`
      : path;
    const options = {
      hostname: '127.0.0.1',
      port,
      path: finalPath,
      method: method === 'POST' ? 'POST' : 'GET',
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

async function executeTool(name, input, ctx = {}) {
  const ep = ENDPOINT_MAP[name];
  if (!ep) return { error: `Unknown tool: ${name}` };
  // Propagacja chatId z konwersacji (Master → sub-agent) żeby backend
  // odpowiadał Telegramem do tego kto pisał, nie do Config statycznego.
  const fullInput = { ...input, ...(ctx.chatId ? { chatId: ctx.chatId } : {}) };
  try {
    if (ep[0] === 'POST_PATH') {
      const path = ep[1].replace(':emailId', encodeURIComponent(fullInput.emailId || ''));
      const { emailId, ...rest } = fullInput;
      const resp = await selfCall('POST', path, Object.keys(rest).length ? rest : null);
      return resp.body;
    }
    const [method, path] = ep;
    const resp = await selfCall(method, path, fullInput);
    return resp.body;
  } catch (err) {
    console.error(`[communication-agent] tool ${name} error:`, err.message);
    return { error: err.message };
  }
}

// Force tool choice for unambiguous intents.
const SEARCH_INTENT = /\b(poka[zż] mail|znajd[zź] mail|szukaj mail|ostatnie mail|jakie mail|maile od)/iu;
const REPLY_INTENT = /\b(odpisz|odpowiedz|napisz odpowied|odpowied[zź])/iu;
const NEW_MAIL_INTENT = /\b(napisz (nowy )?mail|wy[sś]lij wiadomo[sś][cć])/iu;
const OFFER_INTENT = /\bwy[sś]lij ofert/iu;
const SEND_INVOICE_INTENT = /\bwy[sś]lij (fakt|fv)/iu;
const PARSE_INTENT = /\bparsuj zal|otw[oó]rz zal|sprawd[zź] zal/iu;
const CHECK_SENT_INTENT = /\bczy (fakt|fv).{0,40}(wysy[lł]ana|wys[lł]aliśmy|by[lł]a wys)/iu;
const CONFIRM_INTENT = /^\s*(tak|ok|potwierd|akceptu|wy[sś]lij( go| j[ąa])?)\b/iu;

async function processCommunicationQuery(query, ctx = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { text: 'ANTHROPIC_API_KEY nie skonfigurowany.', error: 'no_api_key' };
  }
  if (!query || typeof query !== 'string') {
    return { text: 'Brak query.', error: 'no_query' };
  }

  const messages = [{ role: 'user', content: query }];
  let forcedTool = null;
  if (CONFIRM_INTENT.test(query)) forcedTool = 'confirm_draft';
  else if (CHECK_SENT_INTENT.test(query)) forcedTool = 'check_sent';
  else if (PARSE_INTENT.test(query)) forcedTool = 'parse_attachments';
  else if (SEND_INVOICE_INTENT.test(query)) forcedTool = 'send_invoice_email';
  else if (OFFER_INTENT.test(query)) forcedTool = 'send_offer';
  else if (REPLY_INTENT.test(query) || NEW_MAIL_INTENT.test(query)) forcedTool = 'send_email';
  else if (SEARCH_INTENT.test(query)) forcedTool = 'recent_emails';

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
      console.log(`[communication-agent] tool_use: ${tu.name}`, JSON.stringify(tu.input).slice(0, 300));
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

module.exports = { processCommunicationQuery };
