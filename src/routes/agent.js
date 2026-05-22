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

// Stateless agent endpoints. Master agent (n8n) sends a self-contained query
// (with any context it wants the sub-agent to see), gets back a text reply.

router.post('/agent/logistics', asyncHandler(async (req, res) => {
  const { query, chatId } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query (string) required' });
  }
  const result = await processLogisticsQuery(query, { chatId });
  res.json(result);
}));

router.post('/agent/accounting', asyncHandler(async (req, res) => {
  const { query, chatId } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query (string) required' });
  }
  const result = await processAccountingQuery(query, { chatId });
  res.json(result);
}));

router.post('/agent/accounting-es', asyncHandler(async (req, res) => {
  const { query, chatId } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query (string) required' });
  }
  const result = await processAccountingEsQuery(query, { chatId });
  res.json(result);
}));

router.post('/agent/communication', asyncHandler(async (req, res) => {
  const { query, chatId } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query (string) required' });
  }
  const result = await processCommunicationQuery(query, { chatId });
  res.json(result);
}));

router.post('/agent/communication-es', asyncHandler(async (req, res) => {
  const { query, chatId } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query (string) required' });
  }
  const result = await processCommunicationEsQuery(query, { chatId });
  res.json(result);
}));

router.post('/agent/operations', asyncHandler(async (req, res) => {
  const { query, chatId } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query (string) required' });
  }
  const result = await processOperationsQuery(query, { chatId });
  res.json(result);
}));

// Sudo / power agent — pełen dostęp do bazy + każdego endpointu backendu
// + GK API. Wywoływane gdy zwykły flow zawodzi albo user chce wprost
// wymuszenie ("sudo X" / "wymuś Y" / "@admin Z" w prompcie Master).
router.post('/agent/sudo', asyncHandler(async (req, res) => {
  const { query, chatId } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query (string) required' });
  }
  const result = await processSudoQuery(query, { chatId });
  res.json(result);
}));

// POST /api/agent/email-context
//
// Wrapper ktory prefixuje email-context (metadata + body) + HISTORIA MAILI
// kontrahenta (10 ostatnich INBOUND, najnowsze pierwsze) jako stringu do
// query, potem deleguje do wybranego sub-agenta. Uzywane przez UI panel
// AI w widoku maila — quick-prompt "Wystaw FV" / "Zamow paczke" / "Dodaj
// kontrahenta" + free text.
//
// Default target = 'accounting' (Sonnet, najczestszy use case z mail-context).
// 'sudo' (Opus) celowo NIE jest domyslnym targetem — drogi.
//
// Historia maili: pobierana z prisma.email po contractorId. Sluzy agentowi
// do "wystaw FV na podstawie najswiezszego zamowienia" bez ekstra tool
// call. Pomijamy aktualnie otwarty mail (po body match) — chodzi o tlo.
//
// Body:
//   {
//     query: string,
//     emailContext: { from, to, subject, date, body, language?,
//                     contractorId?, contractorName?, contractorNip?,
//                     attachments? },
//     target?: 'accounting' (default) | 'accounting-es' | 'communication' |
//              'communication-es' | 'operations' | 'logistics' | 'sudo',
//     chatId?: string
//   }
router.post('/agent/email-context', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { query, emailContext, target = 'accounting', chatId } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query (string) required' });
  }
  if (!emailContext || typeof emailContext !== 'object') {
    return res.status(400).json({ error: 'emailContext (object) required' });
  }

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
  if (!fn) {
    return res.status(400).json({ error: 'unknown target', allowed: Object.keys(processors) });
  }

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
    // Limit do 2000 znakow zeby nie blow-upowac kontekstu
    lines.push(String(emailContext.body).slice(0, 2000));
  }

  // Dorzuc HISTORIA MAILI KONTRAHENTA (10 ostatnich INBOUND, najnowsze pierwsze).
  // Cel: pozwala agentowi wystawic FV "z najswiezszego zamowienia" bez
  // ekstra tool call. Pomijamy mail ktory jest aktualnie otwarty (po body
  // match) — chodzi o starsze tlo.
  if (emailContext.contractorId) {
    try {
      const history = await prisma.email.findMany({
        where: {
          contractorId: emailContext.contractorId,
          direction: 'INBOUND',
        },
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

  const prefix = lines.join('\n') + '\n\n[POLECENIE USER]\n';

  const result = await fn(prefix + query, { chatId });
  res.json(result);
}));

// Context recovery: surfaces last N minutes of activity so the Master
// agent can re-orient itself after a context-window pause. Called when
// user says ambiguous things like "następny", "tak", "dalej" without
// naming a contractor — Master fetches this and reads "we just created
// FV 78/2026 for Dani, and earlier we did 3 shipments to DE".
//
// Returns a compact human-readable summary + structured arrays. Window
// defaults to 60min — pass ?minutes=N to widen.
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

module.exports = router;
