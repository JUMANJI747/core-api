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

  // Pull everything in parallel — these are independent queries.
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

  // Build a human-readable summary the Master can shove into prompt.
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

// Resolve what "tak"/"ok"/"1"/"wyślij" should confirm. Master agent calls
// this whenever the user types a bare confirmation, so it doesn't have to
// pattern-match across 7 different scenarios in its prompt. Backend looks
// at three persistence layers and picks the most recent active item:
//
//   1) Email DRAFT (direction='DRAFT', created < 30 min) — covers mail
//      replies AND auto-tracking-notify drafts.
//   2) AgentContext id='ksiegowosc' lastAction='preview' (PL FV preview).
//   3) quoteStore (in-memory) — recent GK courier quote.
//
// Returns { action, ...metadata } or { action: 'ambiguous', hint } when
// nothing pending — in that case the "tak" likely answers a different
// kind of yes/no question (e.g. "zapisać adres?") and the Master should
// continue the conversation naturally.
router.post('/agent/resolve-confirmation', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  const candidates = [];

  // 1) DRAFT mail
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

  // 2) PL FV preview via AgentContext
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

  // 3) GK courier quote (in-memory)
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

  // Pick newest. Surface others so the Master can warn user if there's
  // overlap ("masz 2 rzeczy do potwierdzenia, którą?").
  candidates.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const winner = candidates[0];
  const others = candidates.slice(1).map(c => ({ action: c.action, ts: c.ts }));
  res.json({ ...winner, ...(others.length ? { alternatives: others } : {}) });
}));

module.exports = router;
