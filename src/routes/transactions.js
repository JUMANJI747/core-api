'use strict';

const router = require('express').Router();
const { trackInvoice, trackShipment, addManualEntry, resolveContractorFromShipment } = require('../services/transaction-tracker');
const { getOrders } = require('../glob-client');

// ─────────────────────────────────────────────────────────────────────────────
// Public, read-only browsing of the Operations transactions view.
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/transactions?status=open|complete|stale|orphan&limit=50&offset=0
router.get('/transactions', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const lim = Math.min(parseInt(limit) || 50, 200);
    const off = parseInt(offset) || 0;

    const where = {};
    if (status === 'open') {
      // anything not fully closed (missing one of the 5 boxes)
      where.OR = [
        { hasOrder: false }, { hasInvoice: false },
        { hasShipped: false }, { hasDelivered: false }, { hasPayment: false },
      ];
    } else if (status === 'complete') {
      where.AND = [
        { hasOrder: true }, { hasInvoice: true },
        { hasShipped: true }, { hasDelivered: true }, { hasPayment: true },
      ];
    } else if (status === 'stale') {
      // shipped > 14 days ago, still not delivered or not paid
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 14);
      where.AND = [
        { hasShipped: true },
        { occurredAt: { lt: cutoff } },
        { OR: [{ hasDelivered: false }, { hasPayment: false }] },
      ];
    } else if (status === 'orphan') {
      where.contractorId = null;
    }

    const [items, total] = await Promise.all([
      prisma.transaction.findMany({ where, orderBy: { occurredAt: 'desc' }, take: lim, skip: off }),
      prisma.transaction.count({ where }),
    ]);

    res.json({ ok: true, total, returned: items.length, transactions: items });
  } catch (e) {
    console.error('[transactions]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/transactions/bootstrap
// Pulls last 10 invoices from DB and last 10 shipments from GK, runs the
// tracker on each (creating or merging transactions). Returns a summary
// the user can sanity-check before turning on Google Sheets sync.
router.post('/transactions/bootstrap', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const limit = Math.min(parseInt((req.body && req.body.limit) || req.query.limit) || 10, 50);
    const report = { invoices: { processed: 0, merged: 0, opened: 0 }, shipments: { processed: 0, merged: 0, opened: 0, orphans: 0 }, transactions: [] };

    // 1. Recent invoices
    const invoices = await prisma.invoice.findMany({
      orderBy: { issueDate: 'desc' },
      take: limit,
      include: { contractor: { select: { name: true } } },
    });
    for (const inv of invoices) {
      const before = await prisma.transaction.findFirst({ where: { invoiceId: inv.id } });
      if (before) { report.invoices.processed++; continue; }
      const tx = await trackInvoice(prisma, inv, {
        source: 'bootstrap',
        contractorName: inv.contractor && inv.contractor.name,
        itemsSummary: inv.extras && Array.isArray(inv.extras.items) && inv.extras.items.length
          ? inv.extras.items.map(it => `${it.qty}× ${it.name || it.ean || '?'}`).slice(0, 3).join(', ') + (inv.extras.items.length > 3 ? `, +${inv.extras.items.length - 3}` : '')
          : null,
        itemsDetails: inv.extras && inv.extras.items ? inv.extras.items : null,
      });
      report.invoices.processed++;
      if (tx.shipmentHash) report.invoices.merged++; else report.invoices.opened++;
    }

    // 2. Recent shipments from GK
    let gkOrders = [];
    try {
      const data = await getOrders({ limit: 100 });
      const list = (data && (data.results || data.items || data.data)) || (Array.isArray(data) ? data : []);
      const unwrapped = Array.isArray(list) && list.length === 1 && list[0] && Array.isArray(list[0].results) ? list[0].results : list;
      gkOrders = (unwrapped || []).slice(0, limit);
    } catch (e) {
      console.log('[bootstrap] getOrders failed:', e.message);
    }

    for (const gk of gkOrders) {
      const existing = await prisma.transaction.findFirst({ where: { shipmentHash: gk.hash || gk.orderHash } });
      if (existing) { report.shipments.processed++; continue; }
      const contractor = await resolveContractorFromShipment(prisma, gk);
      if (!contractor) report.shipments.orphans++;
      const tx = await trackShipment(prisma, gk, { source: 'bootstrap', contractor });
      report.shipments.processed++;
      if (tx.invoiceId) report.shipments.merged++; else report.shipments.opened++;
    }

    // 3. Sample of resulting transactions for review
    const sample = await prisma.transaction.findMany({
      orderBy: { occurredAt: 'desc' }, take: 30,
      select: {
        id: true, contractorName: true, occurredAt: true, amount: true, currency: true,
        invoiceNumber: true, shipmentNumber: true,
        hasOrder: true, hasInvoice: true, hasShipped: true, hasDelivered: true, hasPayment: true,
        matchScore: true, matchReason: true, itemsSummary: true,
      },
    });
    report.transactions = sample;

    res.json({ ok: true, ...report });
  } catch (e) {
    console.error('[bootstrap]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/transactions/manual — user adds something they're going to ship
// without a formal order email
// body: { contractorSearch | contractorId, amount?, currency?, itemsSummary, notes? }
router.post('/transactions/manual', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { contractorSearch, contractorId, amount, currency, itemsSummary, itemsDetails, notes, occurredAt } = req.body || {};
    let contractor = null;
    if (contractorId) contractor = await prisma.contractor.findUnique({ where: { id: contractorId } });
    if (!contractor && contractorSearch) {
      const { scoreContractor } = require('../services/contractor-match');
      const all = await prisma.contractor.findMany({ select: { id: true, name: true, nip: true, country: true, email: true, address: true, city: true, extras: true } });
      const scored = all.map(c => ({ contractor: c, score: scoreContractor(c, contractorSearch) }))
        .filter(x => x.score >= 50).sort((a, b) => b.score - a.score);
      if (scored.length > 0) contractor = await prisma.contractor.findUnique({ where: { id: scored[0].contractor.id } });
    }
    if (!contractor && (contractorSearch || contractorId)) {
      return res.status(404).json({ ok: false, error: 'Contractor not found by search/id' });
    }

    const tx = await addManualEntry(prisma, {
      contractorId: contractor ? contractor.id : null,
      contractorName: contractor ? contractor.name : (contractorSearch || null),
      amount, currency, itemsSummary, itemsDetails, notes, occurredAt,
    });
    res.json({ ok: true, transaction: tx });
  } catch (e) {
    console.error('[manual]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
