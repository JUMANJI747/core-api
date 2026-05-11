'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { buildExecuteTool } = require('./agent-runtime');

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
1. Master MUSI ci podać emailId świeżej notyfikacji w query (np. "Odpisz na mail emailId=abc123 od X, lang=Y: <treść>"). Jeśli tego nie ma — odpowiedz "Brak emailId w query — Master powinien przekazać świeży [ctx:] z notyfikacji."
2. NIGDY nie zgaduj/wybieraj emailId z innych miejsc niż query. Nie używaj recent_emails do "znalezienia" maila do odpowiedzi.
3. ZAWSZE rozwiń skrót user-a w naturalną treść:
   - Powitanie: "Dzień dobry," / "Bonjour," / "Hello," / "Hola," / "Olá,"
   - Nawiąż do kontekstu, rozwiń skróty w pełne zdania (biznesowo)
   - Zakończ: "Pozdrawiam,\\nMichał Pałyska\\nSurf Stick Bell" (lub w lang)
   - 3-6 zdań
   - WYJĄTEK: "wyślij dosłownie:" / "minimalistyczna treść" → kopiuj 1:1
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

ANALIZA LEADÓW (cold maile, follow-upy):
- "przeanalizuj maile", "status leadów", "kto czeka", "zaległe wątki", "kto dostał sample" → analyze_leads {daysBack}.
- daysBack: domyślnie 7. "z dziś" → 1. "z tygodnia" → 7. "z miesiąca" → 30. "z 3 dni" → 3.
- Tool zwraca gotową tabelę markdown — pokaż userowi DOSŁOWNIE z analysis pole. Nie dodawaj nic od siebie poza krótkim wstępem.

ZNAJDOWANIE NIP / DANYCH KONTRAHENTA W MAILACH:
- "znajdź NIP", "wyciągnij dane kontrahenta z maili", "dane do FV z maili od X" → extract_nip.
- User może podać sam fragment nazwy zamiast pełnego maila: "ostatnie maile od pro shop" / "po nazwie ferret" → extract_nip {search:"pro shop"}.
- ZAWSZE używaj extract_nip ZANIM powiesz "brak NIP w mailach" — bodyPreview (recent_emails) ma tylko 300 znaków, NIP często jest w stopce dalej. extract_nip skanuje całe bodyFull.
- Response zwraca też pełną treść maila (firstSeenIn.bodyFull) — wyciągnij z niej adres / telefon / nazwę firmy do utworzenia kontrahenta (delegacja do Księgowość PL "Dodaj kontrahenta").

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
  {
    name: 'analyze_leads',
    description: 'Przeanalizuj wątki mailowe z ostatnich N dni — klasyfikuje każdy (czy czeka na nasza/ich odpowiedź, świeży/martwy) i zwraca tabelę z sugerowanymi akcjami. Trigger: "przeanalizuj maile", "status leadów", "kto czeka na odpowiedź", "co wymaga akcji", "zaległe wątki", "kto dostał sample". Output to gotowa tabela do skopiowania userowi.',
    input_schema: {
      type: 'object',
      properties: {
        daysBack: { type: 'number', description: 'Ilu dni wstecz analizować (default 7, dziś=1)' },
        inbox: { type: 'string', description: 'Konkretny inbox (info / sales / michal_fr...) — opcjonalne, default wszystkie' },
        minThreadSize: { type: 'number', description: 'Min wymian żeby uwzględnić (default 1 — pokazuje też single-shot)' },
      },
    },
  },
  {
    name: 'extract_nip',
    description: 'Przeszukuje TREŚĆ (bodyFull) wszystkich maili od konkretnego nadawcy/domeny po regex NIP-ów UE (DE/FR/IT/ES/NL/AT/CZ/PL etc.). Używaj GDY agent musi wystawić FV WDT i nie widzi Ust-IdNr w bodyPreview. Zwraca listę znalezionych NIP-ów z odniesieniem do konkretnego maila.',
    input_schema: {
      type: 'object',
      properties: {
        fromEmail: { type: 'string', description: 'Adres email nadawcy (lub fragment, np. "fone-pro-shop")' },
        fromDomain: { type: 'string', description: 'Domena nadawcy (np. "fone-pro-shop.de") — alternatywnie do fromEmail' },
        search: { type: 'string', description: 'Fragment nazwy nadawcy / firmy do szerszego przeszukiwania (gdy fromEmail nieznany)' },
      },
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
  analyze_leads: ['POST', '/api/leads/analyze'],
  extract_nip: ['POST', '/api/emails/extract-nip'],
};

const executeTool = buildExecuteTool({
  endpointMap: ENDPOINT_MAP,
  logPrefix: '[communication-agent]',
});

// Force tool choice for unambiguous intents.
const SEARCH_INTENT = /\b(poka[zż] mail|znajd[zź] mail|szukaj mail|ostatnie mail|jakie mail|maile od)/iu;
const ANALYZE_LEADS_INTENT = /\b(przeanaliz\w*\s+mail|status\s+lead|kto\s+czeka|co\s+wymaga|zaleg[lł]\w*\s+w[ąa]tk|kto\s+dosta[lł]\s+sample|martw\w*\s+w[ąa]tk|niedoko[nń]czon|wymaga\w*\s+akcj|do\s+odpis)/iu;
const EXTRACT_NIP_INTENT = /\b(znajd[zź]\s+nip|wyci[ąa]gnij\s+nip|nip\s+w\s+mail|dane\s+kontrahenta\s+(po|z)\s+mail|znajd[zź]\s+ust[\s\-]?idnr|szukaj\s+nip|extract\s+vat)/iu;
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
  else if (EXTRACT_NIP_INTENT.test(query)) forcedTool = 'extract_nip';
  else if (ANALYZE_LEADS_INTENT.test(query)) forcedTool = 'analyze_leads';
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
