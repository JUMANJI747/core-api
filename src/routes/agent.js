'use strict';

const router = require('express').Router();
const asyncHandler = require('../asyncHandler');
const { processLogisticsQuery } = require('../services/logistics-agent');
const { processAccountingQuery } = require('../services/accounting-agent');
const { processAccountingEsQuery } = require('../services/accounting-agent-es');
const { processCommunicationQuery } = require('../services/communication-agent');
const { processCommunicationEsQuery } = require('../services/communication-agent-es');
const { processOperationsQuery } = require('../services/operations-agent');
const { processSudoQuery } = require('../services/sudo-agent');

router.post('/agent/logistics', asyncHandler(async (req, res) => {
  const { query, chatId } = req.body || {};
  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query (string) required' });
  const result = await processLogisticsQuery(query, { chatId });
  res.json(result);
}));

router.post('/agent/accounting', asyncHandler(async (req, res) => {
  const { query, chatId } = req.body || {};
  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query (string) required' });
  const result = await processAccountingQuery(query, { chatId });
  res.json(result);
}));

router.post('/agent/accounting-es', asyncHandler(async (req, res) => {
  const { query, chatId } = req.body || {};
  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query (string) required' });
  const result = await processAccountingEsQuery(query, { chatId });
  res.json(result);
}));

router.post('/agent/communication', asyncHandler(async (req, res) => {
  const { query, chatId } = req.body || {};
  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query (string) required' });
  const result = await processCommunicationQuery(query, { chatId });
  res.json(result);
}));

router.post('/agent/communication-es', asyncHandler(async (req, res) => {
  const { query, chatId } = req.body || {};
  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query (string) required' });
  const result = await processCommunicationEsQuery(query, { chatId });
  res.json(result);
}));

router.post('/agent/operations', asyncHandler(async (req, res) => {
  const { query, chatId } = req.body || {};
  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query (string) required' });
  const result = await processOperationsQuery(query, { chatId });
  res.json(result);
}));

router.post('/agent/sudo', asyncHandler(async (req, res) => {
  const { query, chatId } = req.body || {};
  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query (string) required' });
  const result = await processSudoQuery(query, { chatId });
  res.json(result);
}));

// POST /api/agent/email-context
//
// Wrapper ktory prefixuje email-context (metadata + body) + historia maili
// kontrahenta (10 ostatnich INBOUND, najnowsze pierwsze) + previousTurns
// (rozmowa z UI panelu AI) jako stringu do query, potem deleguje do
// wybranego sub-agenta.
//
// previousTurns sluzy zeby agent pamietal ostatni preview / draft / quote
// gdy user mowi "tak" / "potwierdz" / "wystaw" - inaczej kazda tura jest
// fresh i agent generuje nowy preview zamiast confirm'owac.
//
// Body:
//   {
//     query: string,
//     emailContext: { from, to, subject, date, body, ... },
//     target?: 'accounting' (default) | ...,
//     previousTurns?: Array<{ role: 'user'|'assistant', text: string }>,
//     chatId?: string
//   }
router.post('/agent/email-context', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { query, emailContext, target = 'accounting', chatId, previousTurns } = req.body || {};
  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query (string) required' });
  if (!emailContext || typeof emailContext !== 'object') return res.status(400).json({ error: 'emailContext (object) required' });

  const processors = {
    sudo: processSudoQuery,
    accounting: processAccountingQuery,
    'accounting-es': processAccountingEsQuery,
    communication: processCommunicationQuery,
    'communication-es': processCommunicationEsQuery,
    operations: processOperationsQuery,
    logistics: processLogisticsQuery,
  };
  const fn = processors[target];
  if (!fn) return res.status(400).json({ error: 'unknown target', allowed: Object.keys(processors) });

  const lines = ['[KONTEKST MAILA]'];
  if (emailContext.from) lines.push(`Od: ${emailContext.from}`);
  if (emailContext.to) lines.push(`Do: ${emailContext.to}`);
  if (emailContext.subject) lines.push(`Temat: ${emailContext.subject}`);
  if (emailContext.date) lines.push(`Data: ${emailContext.date}`);
  if (emailContext.contractorName || emailContext.contractorNip) {
    const nipPart = emailContext.contractorNip ? ` (NIP ${emailContext.contractorNip})` : '';
    lines.push(`Kontrahent: ${emailContext.contractorName || '?'}${nipPart}`);
  }
  if (emailContext.contractorId) lines.push(`ContractorId: ${emailContext.contractorId}`);
  if (emailContext.language) lines.push(`Jezyk maila: ${emailContext.language}`);
  if (Array.isArray(emailContext.attachments) && emailContext.attachments.length) {
    const att = emailContext.attachments.map(a => `${a.filename || '?'} (${a.contentType || '?'}, ${a.size || 0}B)`).join(', ');
    lines.push(`Zalaczniki: ${att}`);
  }
  if (emailContext.body) {
    lines.push('Tresc maila:');
    lines.push(String(emailContext.body).slice(0, 2000));
  }

  if (emailContext.contractorId) {
    try {
      const history = await prisma.email.findMany({
        where: { contractorId: emailContext.contractorId, direction: 'INBOUND' },
        orderBy: { createdAt: 'desc' },
        take: 11,
        select: { id: true, fromEmail: true, subject: true, bodyPreview: true, bodyFull: true, createdAt: true, tags: true },
      });
      const openBodyHead = emailContext.body ? String(emailContext.body).slice(0, 80) : null;
      const others = history
        .filter(e => !openBodyHead || (e.bodyFull || e.bodyPreview || '').slice(0, 80) !== openBodyHead)
        .slice(0, 10);
      if (others.length) {
        lines.push('');
        lines.push(`HISTORIA MAILI KONTRAHENTA (${others.length}, najnowsze pierwsze):`);
        for (const e of others) {
          const date = e.createdAt.toISOString().slice(0, 10);
          const subj = (e.subject || '(brak tematu)').slice(0, 80);
          const preview = ((e.bodyFull || e.bodyPreview || '').replace(/\s+/g, ' ').trim()).slice(0, 250);
          lines.push(`- [${date}] "${subj}"`);
          if (preview) lines.push(`  ${preview}`);
        }
        lines.push('');
        lines.push('Powyzsza historia jest dostepna od razu — uzyj jak user prosi o FV/order na podstawie zamowienia ktore klient wczesniej wyslal. NAJNOWSZE sa pierwsze.');
      }
    } catch (e) {
      console.error('[agent/email-context] history fetch failed:', e.message);
    }
  }

  // POPRZEDNIE TURY — kluczowe zeby agent pamietal preview/draft/quote.
  // Bez tego "tak" na potwierdzenie generuje nowy preview zamiast confirm.
  if (Array.isArray(previousTurns) && previousTurns.length) {
    const recent = previousTurns.slice(-10);
    lines.push('');
    lines.push(`POPRZEDNIE TURY ROZMOWY (${recent.length}, najstarsze pierwsze):`);
    for (const t of recent) {
      const who = t.role === 'user' ? '[USER]' : '[AGENT]';
      const txt = String(t.text || '').slice(0, 1500);
      lines.push(`${who} ${txt}`);
    }
    lines.push('');
    lines.push('WAZNE: jak user mowi "tak"/"potwierdz"/"wystaw"/"ok" - odnosi sie do OSTATNIEGO twojego previewId/draftId/quoteId z poprzedniej tury [AGENT]. Wywolaj odpowiedni confirm tool (invoice_confirm/send_draft/order_shipment) z tym ID. NIE generuj nowego preview.');
  }

  const prefix = lines.join('\n') + '\n\n[POLECENIE USER]\n';

  const result = await fn(prefix + query, { chatId });
  res.json(result);
}));

router.get('/agent/recent-activity', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const minutes = Math.max(1, Math.min(1440, Number(req.query.minutes) || 60));
  const since = new Date(Date.now() - minutes * 60 * 1000);

  const [recentInvoices, recentTransactions, recentEmailsOut, recentEmailsIn, recentContractors] = await Promise.all([
    prisma.invoice.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, number: true, grossAmount: true, currency: true, createdAt: true,
        contractor: { select: { name: true, country: true } } },
    }),
    prisma.transaction.findMany({
      where: { updatedAt: { gte: since } },
      orderBy: { updatedAt: 'desc' },
      take: 15,
      select: { id: true, contractorName: true, invoiceNumber: true, shipmentNumber: true,
        hasOrder: true, hasInvoice: true, hasShipped: true, hasDelivered: true, hasPayment: true,
        amount: true, currency: true, occurredAt: true, updatedAt: true },
    }),
    prisma.email.findMany({
      where: { direction: 'OUTBOUND', createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, toEmail: true, subject: true, createdAt: true,
        contractor: { select: { name: true } } },
    }),
    prisma.email.findMany({
      where: { direction: 'INBOUND', createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, fromEmail: true, fromName: true, subject: true, createdAt: true,
        contractor: { select: { name: true } } },
    }),
    prisma.contractor.findMany({
      where: { updatedAt: { gte: since } },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: { id: true, name: true, country: true, city: true, nip: true, phone: true, updatedAt: true },
    }),
  ]);

  const lines = [];
  lines.push(`Aktywność z ostatnich ${minutes} minut:`);
  if (recentInvoices.length) {
    lines.push('FV:');
    for (const i of recentInvoices.slice(0, 5)) {
      const who = i.contractor ? i.contractor.name : '?';
      lines.push(`  - ${i.number} → ${who} (${i.grossAmount} ${i.currency})`);
    }
  }
  if (recentTransactions.length) {
    lines.push('Transakcje (deal cycle):');
    for (const t of recentTransactions.slice(0, 8)) {
      const stages = [t.hasOrder && 'order', t.hasInvoice && 'FV', t.hasShipped && 'wysłane', t.hasDelivered && 'dostarczone', t.hasPayment && 'zapłacone'].filter(Boolean).join('+');
      const who = t.contractorName || '?';
      const fv = t.invoiceNumber ? ` FV${t.invoiceNumber}` : '';
      const gk = t.shipmentNumber ? ` ${t.shipmentNumber}` : '';
      lines.push(`  - ${who}${fv}${gk} [${stages || 'pending'}]`);
    }
  }
  if (recentEmailsOut.length) {
    lines.push('Wysłane maile:');
    for (const m of recentEmailsOut.slice(0, 5)) {
      lines.push(`  - do ${m.toEmail}: "${(m.subject || '').slice(0, 60)}"`);
    }
  }
  if (recentEmailsIn.length) {
    lines.push('Nowe maile:');
    for (const m of recentEmailsIn.slice(0, 5)) {
      lines.push(`  - od ${m.fromName || m.fromEmail}: "${(m.subject || '').slice(0, 60)}"`);
    }
  }
  if (recentContractors.length) {
    lines.push('Edytowani kontrahenci:');
    for (const c of recentContractors.slice(0, 5)) {
      const where = [c.city, c.country].filter(Boolean).join(', ');
      lines.push(`  - ${c.name}${where ? ` (${where})` : ''}`);
    }
  }
  const summary = lines.join('\n');

  res.json({
    ok: true,
    windowMinutes: minutes,
    summary,
    counts: {
      invoices: recentInvoices.length,
      transactions: recentTransactions.length,
      emailsOut: recentEmailsOut.length,
      emailsIn: recentEmailsIn.length,
      contractors: recentContractors.length,
    },
    invoices: recentInvoices,
    transactions: recentTransactions,
    emailsOut: recentEmailsOut,
    emailsIn: recentEmailsIn,
    contractors: recentContractors,
  });
}));

router.post('/agent/resolve-confirmation', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  const candidates = [];

  try {
    const draft = await prisma.email.findFirst({
      where: { direction: 'DRAFT', createdAt: { gte: cutoff } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, fromEmail: true, toEmail: true, subject: true, tags: true, extras: true, createdAt: true, inReplyTo: true },
    });
    if (draft) {
      const isTracking = Array.isArray(draft.tags) && draft.tags.includes('tracking_notify');
      candidates.push({
        action: 'send_draft',
        ts: draft.createdAt,
        subtype: isTracking ? 'tracking' : (draft.inReplyTo ? 'mail_reply' : 'mail'),
        draftId: draft.id,
        to: draft.toEmail,
        from: draft.fromEmail,
        subject: draft.subject,
        trackingUrl: draft.extras && draft.extras.trackingUrl ? draft.extras.trackingUrl : null,
      });
    }
  } catch (e) { console.error('[resolve-confirmation] draft probe error:', e.message); }

  try {
    const acct = await prisma.agentContext.findUnique({ where: { id: 'ksiegowosc' } });
    const d = acct && acct.data;
    if (d && d.lastAction === 'preview' && d.timestamp && Date.now() - d.timestamp < 30 * 60 * 1000) {
      candidates.push({
        action: 'issue_invoice',
        ts: new Date(d.timestamp),
        previewId: d.previewId || null,
        contractor: d.contractor || null,
        suma: d.suma || null,
        waluta: d.waluta || null,
      });
    }
  } catch (e) { console.error('[resolve-confirmation] preview probe error:', e.message); }

  try {
    const quoteStore = req.app.locals.quoteStore || {};
    const keys = Object.keys(quoteStore);
    let newest = null;
    for (const k of keys) {
      const q = quoteStore[k];
      if (!q || !q.createdAt) continue;
      if (Date.now() - new Date(q.createdAt).getTime() >= 30 * 60 * 1000) continue;
      if (!newest || new Date(q.createdAt) > new Date(newest.createdAt)) newest = { id: k, q };
    }
    // DB fallback — pamiec procesu bywa pusta (restart / inna instancja), a
    // wycena jest trwale zapisana. Bez tego "tak" po wycenie nie znajdowalo
    // zamowienia i Master wpadal w petle re-wyceny.
    if (!newest) {
      const row = await prisma.quote.findFirst({ where: { createdAt: { gte: cutoff } }, orderBy: { createdAt: 'desc' } });
      if (row && row.data) newest = { id: row.id, q: row.data };
    }
    if (newest) {
      const offers = newest.q.offers || [];
      const cheapest = offers.length ? offers.slice().sort((a, b) => (a.price || 0) - (b.price || 0))[0] : null;
      candidates.push({
        action: 'order_shipment',
        ts: newest.q.createdAt,
        quoteId: newest.id,
        receiver: newest.q.receiver && { name: newest.q.receiver.name, city: newest.q.receiver.city, country: newest.q.receiver.country },
        cheapestCarrier: cheapest && cheapest.carrier,
        cheapestPrice: cheapest && cheapest.price,
        offerCount: offers.length,
      });
    }
  } catch (e) { console.error('[resolve-confirmation] quote probe error:', e.message); }

  if (candidates.length === 0) {
    return res.json({
      action: 'ambiguous',
      hint: 'no pending DRAFT / FV preview / GK quote in last 30 min — user "tak" probably answers a different question (e.g. "zapisać adres?", "szukać dalej?"). Handle from conversation context.',
    });
  }

  candidates.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const winner = candidates[0];
  const others = candidates.slice(1).map(c => ({ action: c.action, ts: c.ts }));
  res.json({ ...winner, ...(others.length ? { alternatives: others } : {}) });
}));

// POST /api/agent/assistant — tani router (Haiku) który decyduje którego
// agenta (Sonnet) wywołać i łączy wyniki. Dla frontu — zero Opus.
// Body: { query, context: { contractorId?, ... }, previousTurns? }
router.post('/agent/assistant', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { query, context = {}, previousTurns = [], lastAgent = null, target = null } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query required' });

  // Buduje query z prefixem kontekstu: dane kontrahenta + CALY WATEK rozmowy
  // (zamowienie bywa w starszym mailu niz otwarty) + historia maili kontrahenta
  // z bazy (gdy czegos brak w watku — inne watki/zamowienia). Async, bo dociaga
  // historie z DB.
  const buildFullQuery = async () => {
    const ctxLines = [];
    if (context.contractorId) ctxLines.push(`ContractorId: ${context.contractorId}`);
    if (context.contractorName) ctxLines.push(`Kontrahent: ${context.contractorName}`);
    if (context.contractorNip) ctxLines.push(`NIP: ${context.contractorNip}`);
    if (context.contractorEmail) ctxLines.push(`Email: ${context.contractorEmail}`);
    // Caly watek ma priorytet nad pojedynczym otwartym mailem.
    if (context.thread) ctxLines.push(`WATEK ROZMOWY (chronologicznie, najstarszy pierwszy):\n${String(context.thread).slice(0, 8000)}`);
    else if (context.emailBody) ctxLines.push(`Tresc maila:\n${String(context.emailBody).slice(0, 1500)}`);
    // Historia z bazy — agent ma "szukac w bazie kontrahenta" jak czegos brak.
    if (context.contractorId) {
      try {
        const hist = await prisma.email.findMany({
          where: { contractorId: context.contractorId },
          orderBy: { createdAt: 'desc' },
          take: 8,
          select: { direction: true, createdAt: true, subject: true, bodyPreview: true, fromEmail: true, toEmail: true },
        });
        if (hist.length) {
          const lines = hist.map(e => {
            const who = e.direction === 'INBOUND' ? `od ${e.fromEmail}` : `do ${e.toEmail}`;
            const d = e.createdAt ? new Date(e.createdAt).toISOString().slice(0, 10) : '';
            return `- [${d}] ${who}: ${e.subject || ''} — ${(e.bodyPreview || '').slice(0, 160)}`;
          }).join('\n');
          ctxLines.push(`HISTORIA MAILI KONTRAHENTA (z bazy, ostatnie ${hist.length}):\n${lines}`);
        }
      } catch (_) { /* best-effort */ }
    }
    const ctxStr = ctxLines.join('\n\n');
    return ctxStr ? `${ctxStr}\n\n${query}` : query;
  };

  const ALL_PROCESSORS = {
    accounting: processAccountingQuery,
    'accounting-es': processAccountingEsQuery,
    communication: processCommunicationQuery,
    'communication-es': processCommunicationEsQuery,
    operations: processOperationsQuery,
    logistics: processLogisticsQuery,
  };

  // Wyciaga ZAWSZE string z wyniku sub-agenta. r.text bywal pusty (agent skonczyl
  // po tool-callu bez podsumowania) albo nie-string -> wczesniej leciało jako
  // obiekt i front renderowal "[object Object]". Tu gwarantujemy string.
  const pickText = (r) => {
    if (r && typeof r.text === 'string' && r.text.trim()) return r.text;
    if (r && r.error != null) return typeof r.error === 'string' ? r.error : JSON.stringify(r.error);
    if (r && r.text && typeof r.text === 'object') return JSON.stringify(r.text);
    return r ? JSON.stringify(r).slice(0, 500) : '';
  };

  // EXPLICIT TARGET z quick-action frontu (np. "Dodaj kontrahenta" -> accounting).
  // Pomijamy router: woła wskazanego sub-agenta deterministycznie. Router bywal
  // misroutowal "dodaj kontrahenta przez upsert_contractor" jako 'direct' i
  // odpowiadal instrukcja "zrob to przyciskiem Edytuj" zamiast wykonac akcje.
  if (target && ALL_PROCESSORS[target]) {
    try {
      const r = await ALL_PROCESSORS[target](await buildFullQuery(), { prisma, chatId: null, previousTurns: previousTurns.slice(-6) });
      console.log(`[agent/assistant] target=${target} reply: text=${typeof r.text} len=${(r.text || '').length} stop=${r.stopReason || '?'} iter=${r.iterations}`);
      return res.json({ ok: true, text: pickText(r), agents: [target], source: 'target' });
    } catch (e) {
      return res.json({ ok: true, text: `Blad ${target}: ${e.message}`, agents: [target], source: 'target-error' });
    }
  }

  // Jeśli jest lastAgent i query to krótka odpowiedź (1-2 słowa, numer, "tak/ok/1/2/3")
  // → kontynuuj z tym samym agentem bez pytania routera
  const isShortReply = query.length < 50 && /^(tak|ok|nie|1|2|3|opcja|wybierz|dalej|potwierdz)/i.test(query.trim());
  if (lastAgent && isShortReply) {
    const processors = {
      accounting: processAccountingQuery,
      'accounting-es': processAccountingEsQuery,
      communication: processCommunicationQuery,
      'communication-es': processCommunicationEsQuery,
      operations: processOperationsQuery,
      logistics: processLogisticsQuery,
    };
    const fn = processors[lastAgent];
    if (fn) {
      try {
        const ctxLines = [];
        if (context.contractorId) ctxLines.push(`ContractorId: ${context.contractorId}`);
        if (context.contractorName) ctxLines.push(`Kontrahent: ${context.contractorName}`);
        if (context.contractorNip) ctxLines.push(`NIP: ${context.contractorNip}`);
        if (context.contractorEmail) ctxLines.push(`Email: ${context.contractorEmail}`);
        if (context.emailBody) ctxLines.push(`Tresc maila:\n${String(context.emailBody).slice(0, 1500)}`);
        const ctxStr = ctxLines.join('\n');
        const fullQuery = ctxStr ? `${ctxStr}\n\n${query}` : query;
        const r = await fn(fullQuery, { prisma, chatId: null, previousTurns: previousTurns.slice(-8) });
        return res.json({ ok: true, text: pickText(r), agents: [lastAgent], source: 'continue' });
      } catch (e) {
        return res.json({ ok: true, text: `Blad ${lastAgent}: ${e.message}`, agents: [lastAgent], source: 'continue-error' });
      }
    }
  }

  // Haiku router — decyduje którego agenta wywołać
  const routerPrompt = `Jestes routerem. Na podstawie zapytania usera zdecyduj ktory agent powinien je obsluzyc.

Dostepni agenci:
- accounting: faktura PL (iFirma), NIP, VIES, preview/confirm faktury
- accounting-es: faktura ES (Contasimple/Kanary)
- communication: email, odpowiedzi, tlumaczenia, kontakt z klientem PL
- communication-es: email ES/Kanary
- logistics: paczki, GlobKurier, tracking, wysylki
- operations: deale, transakcje, matching FV-shipment, Google Sheets

Jesli zapytanie wymaga WIELU agentow, podaj ich w kolejnosci.
"direct" TYLKO gdy user pyta JAK recznie zmienic jedno pole (np. "jak zmienic NIP?"). UWAGA: "dodaj/zapisz/utworz kontrahenta", "wyciagnij dane i dodaj do bazy", "upsert_contractor" = AKCJA agenta "accounting" (NIE direct).

Kontekst: ${JSON.stringify(context).slice(0, 500)}

Odpowiedz TYLKO JSON: {"agents":["accounting"],"reason":"..."} lub {"agents":["direct"],"reason":"..."}`;

  const tTurn = Date.now();
  try {
    const tRouter = Date.now();
    const routerResp = await anthropic.messages.create({
      model: process.env.ASSISTANT_ROUTER_MODEL || 'claude-sonnet-4-5-20250929',
      max_tokens: 200,
      messages: [
        ...previousTurns.slice(-4).map(t => ({ role: t.role, content: t.text })),
        { role: 'user', content: `${routerPrompt}\n\nZapytanie: ${query}` },
      ],
    });
    console.log(`[agent/assistant] [timing] router → ${Date.now() - tRouter}ms (in=${routerResp.usage && routerResp.usage.input_tokens}, out=${routerResp.usage && routerResp.usage.output_tokens})`);
    const routerText = routerResp.content.map(b => b.text || '').join('');
    let routing;
    try {
      const match = routerText.match(/\{[\s\S]*\}/);
      routing = match ? JSON.parse(match[0]) : { agents: ['accounting'], reason: 'parse fallback' };
    } catch (_) {
      routing = { agents: ['accounting'], reason: 'parse error: ' + routerText.slice(0, 100) };
    }

    if (routing.agents[0] === 'direct') {
      return res.json({ ok: true, text: 'To mozesz zrobic przyciskiem "Edytuj" — zmien pole i kliknij Zapisz.', routing, source: 'router' });
    }

    // Wywołaj agentów po kolei
    const processors = {
      accounting: processAccountingQuery,
      'accounting-es': processAccountingEsQuery,
      communication: processCommunicationQuery,
      'communication-es': processCommunicationEsQuery,
      operations: processOperationsQuery,
      logistics: processLogisticsQuery,
    };

    const results = [];
    for (const agentName of (routing.agents || ['accounting']).slice(0, 3)) {
      const fn = processors[agentName];
      if (!fn) continue;

      // Build context string
      const ctxLines = [];
      if (context.contractorId) ctxLines.push(`ContractorId: ${context.contractorId}`);
      if (context.contractorName) ctxLines.push(`Kontrahent: ${context.contractorName}`);
      if (context.contractorNip) ctxLines.push(`NIP: ${context.contractorNip}`);
      if (context.contractorEmail) ctxLines.push(`Email: ${context.contractorEmail}`);
      if (context.emailBody) ctxLines.push(`Tresc maila:\n${String(context.emailBody).slice(0, 1500)}`);
      const ctxStr = ctxLines.join('\n');

      const fullQuery = ctxStr ? `${ctxStr}\n\n${query}` : query;
      const tAgent = Date.now();
      try {
        const r = await fn(fullQuery, { prisma, chatId: null, previousTurns: previousTurns.slice(-6) });
        console.log(`[agent/assistant] [timing] agent ${agentName} → ${Date.now() - tAgent}ms (${r.iterations != null ? r.iterations + ' rund' : '?'})`);
        results.push({ agent: agentName, text: pickText(r) });
      } catch (e) {
        console.log(`[agent/assistant] [timing] agent ${agentName} ERROR → ${Date.now() - tAgent}ms`);
        results.push({ agent: agentName, text: `Blad ${agentName}: ${e.message}` });
      }
    }

    console.log(`[agent/assistant] [timing] CALA TURA → ${Date.now() - tTurn}ms (agenci: ${results.map(r => r.agent).join('+') || 'brak'})`);
    const combined = results.map(r => r.text).join('\n\n---\n\n');
    res.json({ ok: true, text: combined, routing, agents: results.map(r => r.agent), source: 'assistant' });
  } catch (e) {
    console.error('[agent/assistant]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
}));

module.exports = router;
