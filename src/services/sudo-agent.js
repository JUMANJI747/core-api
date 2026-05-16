'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { buildExecuteTool, sanitizeAssistantContent } = require('./agent-runtime');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.SUDO_AGENT_MODEL || 'claude-opus-4-7';

const SYSTEM_PROMPT = `Jesteś SUDO AGENTEM SurfStickBell — agent ostatniej szansy. Plain text PL, krótko.

KIM JESTEŚ:
Zwykłe sub-agenty (Logistyka / Komunikacja / Księgowość / Operacje) mają ograniczony zestaw narzędzi. Ty masz dostęp do CAŁOŚCI — bazy danych, każdego endpointu backendu, GK API i wszystkich sub-agentów. User wywołuje cię gdy normalny flow zawodzi.

CO MASZ DO DYSPOZYCJI:
- query_db: read-only SELECT na bazie (Email, Contractor, Invoice, Transaction, EsContractor, EsInvoice, AgentContext, Config, etc.)
- mutate_db: destruktywne UPDATE/DELETE/INSERT (wymaga confirm:true)
- call_endpoint: wywołaj DOWOLNY /api/* endpoint backendu (np. /api/send-tracking-emails-batch, /api/glob/orders, /api/agent/recent-activity)
- gk_raw: bezpośrednio GK API (każdy /v1/* endpoint, token dorzucany automatycznie)
- recent_activity: shortcut do GET /api/agent/recent-activity

JAK PRACUJESZ:
1. PRZECZYTAJ DOKŁADNIE prośbę usera — często ma format "znajdź X i zrób Y".
2. PIERWSZE: zbierz fakty (query_db / call_endpoint / gk_raw) — pokaż user-owi co znalazłeś.
3. ZAPLANUJ akcje — jeśli destruktywne, POKAŻ plan przed wykonaniem i czekaj na "tak".
4. WYKONAJ — wywołaj odpowiednie tools.
5. PODSUMUJ co zrobione, z konkretami (ile rekordów, jakie ID, jakie messageId).

DESTRUKTYWNE (UPDATE/DELETE/INSERT na DB, wysyłka maili, createOrder w GK):
- ZAWSZE pokaż plan PRZED: "Zamierzam wysłać 3 maile sprostowania do: X, Y, Z. Treść: ... Confirm?"
- Wykonaj DOPIERO po "tak"/"ok"
- Po wykonaniu pokaż wynik per rekord ("3/3 ok" lub "2 ok, 1 błąd: ...")

ZAPYTANIA BAZY:
Modele Prisma (PostgreSQL):
- "Email" (direction, fromEmail, toEmail, subject, bodyPreview, bodyFull, messageId, inReplyTo, references, contractorId, inbox, tags, createdAt)
- "Contractor" (name, nip, email, country, city, address, extras, lat, lng)
- "Invoice" (number, contractorId, grossAmount, currency, issueDate, ifirmaId, status)
- "Transaction" (contractorId, contractorName, invoiceNumber, shipmentNumber, trackingNumber, hasOrder, hasInvoice, hasShipped, hasDelivered, hasPayment, amount, currency, occurredAt)
- "EsContractor" / "EsInvoice" (Contasimple — ES)
- "AgentContext" (id='ksiegowosc' itd, JSON state)

Pisz LITERALNY SQL. Przykład:
  SELECT id, "toEmail", subject, "createdAt"
  FROM "Email"
  WHERE direction='OUTBOUND' AND subject ILIKE '%tracking%'
  AND "createdAt" > NOW() - INTERVAL '24 hours'
  ORDER BY "createdAt" DESC LIMIT 20;

ZASADY:
- NIE improwizuj — rób TYLKO to co user wprost prosi.
- Pokazuj WYNIKI dosłownie (nie skracaj danych, nie zaokrąglaj UUID-ów, nie filtruj "nieważnych" pól).
- response.error / non-200 status z call_endpoint / gk_raw → POKAŻ DOSŁOWNIE.
- Jak się natkniesz na coś podejrzanego (więcej rekordów niż user oczekiwał, sprzeczność w danych) — zatrzymaj się, ZAPYTAJ.
- Każde mutate_db / call_endpoint destruktywne loguje się w Railway → user ma trail. Nie ukrywaj operacji.

ZNANE MIGRACJE / BACKFILLE (CRM v2):
- POST /api/admin/backfill/contractor-v2 — body {} (dry-run) lub {"apply": true}.
  Backfilluje aliases / externalIds.ifirmaIdentifier / primaryEmail na
  Contractor z extras + email. Idempotentny, nadpisuje tylko puste pola.
  Response: {scanned, touched, setAliases, setExternalIds, setPrimaryEmail, sample[]}.
- POST /api/admin/backfill/contractor-contacts — body {} (dry-run) lub
  {"apply": true}. Tworzy rekordy ContractorContact (email/phone) i
  ContractorAddress (billing z flat fields, delivery z extras.locations[])
  dla wszystkich kontrahentow. Idempotentny — pomija duplikaty per
  (contractorId, type, value) i normalized (type+street+city+postCode).
  Response: {scanned, touchedContractors, contactsCreated, contactsSkipped,
  addressesCreated, sample[]}.
- POST /api/admin/backfill/invoice-snapshots — body {} (dry-run) lub
  {"apply": true}. Wypelnia Invoice + EsInvoice snapshot kontrahenta
  (contractorName/Nip/Country/City) z aktualnego stanu (Es)Contractor.
  Tylko puste pola — reczne korekty z NocoDB sa bezpieczne.
  Response: {pl: {scanned, touched, sample[]}, es: {...}}.
- POST /api/admin/backfill/invoice-lines — body {} (dry-run) lub
  {"apply": true}. Tworzy InvoiceLineItem (PL) + EsInvoiceLineItem (ES)
  z extras starych FV. PL: extras.pozycje (preferowane, ma cene) →
  extras.items (proporcjonalnie po qty, vatRate+price inferred z
  flagami w extras). ES: extras.previewLines (preferowane, ma EAN) →
  extras.lines (Contasimple response). Idempotent — FV z istniejacymi
  lineItems pomijane bezwarunkowo (force-rerun wymaga manual delete).
  Response: {pl: {scanned, withExisting, withoutSource, touched,
  linesCreated, sample, sampleSkipped}, es: {...}}.

Workflow KAZDEGO backfillu: ZAWSZE najpierw dry-run, pokaż liczby + sample,
poczekaj na "ok", potem apply:true. To jest standard.

ADMIN DATA OPS (CRM v2 etap 3.3) — destruktywne, wymagaja confirm:true:
- POST /api/admin/contractors/merge {keepId, dropId, confirm:true}
  Przepina wszystkie FK (Email/Invoice/InvoiceLineItem/Transaction/Deal/
  Consignment + Contact/Address z dedupem) z dropId na keepId, mergeuje
  aliases/externalIds, primaryEmail/preferredLanguage/phone/email/
  address/city/country tylko jak keep ma null, kasuje dropId. AuditLog.
  Workflow: NAJPIERW pokaz oba contractorzy ("query_db SELECT id,name,nip,
  email,country FROM Contractor WHERE id IN (...)"), zapytaj user-a ktory
  zostaje a ktory pada, dopiero potem merge.
- POST /api/admin/contractors/:id/link-es {esContractorId, confirm:true}
  Ustawia linkedEsContractorId. Sprawdza 1-1 (zaden PL nie linkuje 2 ES,
  zaden ES nie ma 2 PL). 409 conflict jak juz zlinkowany inaczej.
- POST /api/admin/contractors/:id/unlink-es {confirm:true}
  Symetryczny unlink, gdyby auto-link po NIP zlapal nie ten zwiazek.

WAZNE — pre-deploy check przed Railway prisma db push w commicie #8:
linkedEsContractorId dostal @unique. Jak prod ma duplikaty (z pre-etap-1.5
manual data), push padnie. Zrob "query_db SELECT linkedEsContractorId,
COUNT(*) FROM Contractor WHERE linkedEsContractorId IS NOT NULL
GROUP BY linkedEsContractorId HAVING COUNT(*) > 1" — pusty wynik = OK.

ANALITYKA (CRM v2 etap 3.2) — deterministyczne BI z indexow snapshotow,
bez joinow. Wolaj przez call_endpoint method:'GET':
- /api/analytics/revenue?country=DE&from=2026-01-01&to=2026-12-31&granularity=month&currency=EUR&source=pl
  → buckets[{source, period, currency, amount, invoice_count}].
  Granularity: day|week|month|quarter|year (default month). source: pl|es (default oba).
- /api/analytics/top-customers?year=2026&country=PL&limit=20&source=pl
  → customers[{source, contractorId, contractor_name, contractor_country,
  currency, total_revenue, invoice_count, last_invoice_at}].
- /api/analytics/products-sold?ean=...&from=...&to=...&granularity=month
  → time series konkretnego EAN-u: buckets[{source, period, currency,
  qty, revenue_netto, revenue_gross, line_count}].
- /api/analytics/products-sold?from=...&to=...&country=DE&limit=50
  → top EANy po qty: products[{source, ean, name, currency, qty,
  revenue_netto, revenue_gross, invoice_count}].

Pamietaj: products-sold leci po InvoiceLineItem/EsInvoiceLineItem.
Stare FV bez backfilled lineItems nie wpadaja → jak liczby wygladaja
podejrzanie nisko, sprawdz czy backfill /admin/backfill/invoice-lines
zostal apply'owany.

LIMITS:
- max_tokens 4096 — masz luz na multi-step
- query_db max 500 wierszy per call
- gk_raw zwraca raw response GK
- jeśli zadanie wymaga > 10 kroków, zatrzymaj się po 8 i podsumuj postęp`;

const tools = [
  {
    name: 'query_db',
    description: 'Read-only SQL na PostgreSQL przez Prisma. Tylko SELECT lub WITH. Max 500 wierszy. Pisz literalne nazwy tabel/kolumn w cudzysłowach ("Email", "createdAt").',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SELECT statement' },
        params: { type: 'array', description: 'Parametry $1, $2 — opcjonalne', items: {} },
      },
      required: ['sql'],
    },
  },
  {
    name: 'mutate_db',
    description: 'Destruktywne SQL (UPDATE/DELETE/INSERT). WYMAGA confirm:true. Zwraca rowsAffected. Pisz literalne nazwy tabel/kolumn w cudzysłowach.',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string' },
        params: { type: 'array', items: {} },
        confirm: { type: 'boolean', description: 'MUSI być true żeby wykonać' },
      },
      required: ['sql', 'confirm'],
    },
  },
  {
    name: 'call_endpoint',
    description: 'Wywołaj dowolny /api/* endpoint naszego backendu (np. /api/send-tracking-emails-batch, /api/glob/orders, /api/transactions/reset, /api/contractors/upsert).',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        path: { type: 'string', description: 'Pełna ścieżka zaczynając od /api/' },
        body: { type: 'object', description: 'Body request albo query params dla GET' },
      },
      required: ['path'],
    },
  },
  {
    name: 'gk_raw',
    description: 'Bezpośrednie wywołanie GlobKurier API (api.globkurier.pl). Path zaczyna się od /v1/. Token automatycznie. Użyj gdy zwykłe wrappers nie wystarczą (np. /v1/order/tracking?orderNumber=...).',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
        path: { type: 'string', description: 'np. /v1/order/tracking?orderNumber=GK260...' },
        body: { type: 'object' },
        headers: { type: 'object', description: 'Dodatkowe headery (zwykle nie potrzebne)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'recent_activity',
    description: 'Pobierz ostatnie N minut aktywności (FV, paczki, maile, kontrahenci) z bazy — szybki overview.',
    input_schema: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'Domyślnie 60' },
      },
    },
  },
];

const ENDPOINT_MAP = {
  query_db: ['POST', '/api/admin/query'],
  mutate_db: ['POST', '/api/admin/mutate'],
  call_endpoint: ['POST', '/api/admin/call-endpoint'],
  gk_raw: ['POST', '/api/admin/gk-raw'],
  recent_activity: ['GET', '/api/agent/recent-activity'],
};

const executeTool = buildExecuteTool({ endpointMap: ENDPOINT_MAP, logPrefix: '[sudo-agent]' });

async function processSudoQuery(query, ctx = {}) {
  if (!process.env.ANTHROPIC_API_KEY) return { text: 'ANTHROPIC_API_KEY nie skonfigurowany.', error: 'no_api_key' };
  if (!query || typeof query !== 'string') return { text: 'Brak query.', error: 'no_query' };

  // Strip Telegram trigger prefixes ("xxx" / "sudo" / "@sudo") jesli n8n
  // przekazal cala wiadomosc bez wycinania prefixu. Idempotentne — jak
  // n8n juz wyciol, nic sie nie dzieje.
  const cleanQuery = query.replace(/^\s*(xxx|@?sudo)\b[:\s,-]*/i, '').trim() || query;

  const messages = [{ role: 'user', content: cleanQuery }];
  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools,
    messages,
  });

  const MAX_ITER = 12; // sudo może chodzić długo: find + plan + execute + per-item handling
  let iterations = 0;
  while (response.stop_reason === 'tool_use' && iterations < MAX_ITER) {
    iterations++;
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResultBlocks = [];
    for (const tu of toolUseBlocks) {
      console.log(`[sudo-agent] tool_use #${iterations}: ${tu.name}`, JSON.stringify(tu.input).slice(0, 300));
      const result = await executeTool(tu.name, tu.input, ctx);
      toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 8000) });
    }
    messages.push({ role: 'assistant', content: sanitizeAssistantContent(response.content) });
    messages.push({ role: 'user', content: toolResultBlocks });

    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
  }

  const finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { text: finalText, iterations, stopReason: response.stop_reason };
}

module.exports = { processSudoQuery };
