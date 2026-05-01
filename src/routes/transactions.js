'use strict';

const router = require('express').Router();
const { trackInvoice, trackShipment, addManualEntry, resolveContractorFromShipment } = require('../services/transaction-tracker');
const sheetsSync = require('../services/sheets-sync');
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

// POST /api/transactions/merge — manual merge two transactions into one.
// Body accepts EITHER UUIDs (primaryId/secondaryId) OR Sheet row numbers
// (primaryRow/secondaryRow). The "primary" survives and adopts every
// non-empty field from the secondary that it didn't already have.
// Stage flags are OR-ed together. Items summary/details from secondary
// merge in only if primary had none. Notes are concatenated. Secondary
// is deleted. Returns the merged transaction + a list of fields actually
// copied so the user can sanity-check.
router.post('/transactions/merge', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    let { primaryId, secondaryId, primaryRow, secondaryRow } = req.body || {};

    async function resolve(id, row) {
      if (id) return prisma.transaction.findUnique({ where: { id } });
      if (row != null) return prisma.transaction.findFirst({ where: { sheetRowId: parseInt(row) } });
      return null;
    }
    const primary = await resolve(primaryId, primaryRow);
    const secondary = await resolve(secondaryId, secondaryRow);
    if (!primary) return res.status(404).json({ ok: false, error: 'primary transaction not found (provide primaryId or primaryRow)' });
    if (!secondary) return res.status(404).json({ ok: false, error: 'secondary transaction not found' });
    if (primary.id === secondary.id) return res.status(400).json({ ok: false, error: 'primary and secondary are the same transaction' });

    // Adopt fields the primary doesn't have
    const copied = [];
    const update = {};
    const adoptIfEmpty = (key) => {
      if (primary[key] == null && secondary[key] != null) { update[key] = secondary[key]; copied.push(key); }
    };
    [
      'contractorId', 'contractorName', 'emailId',
      'invoiceId', 'invoiceNumber',
      'shipmentHash', 'shipmentNumber', 'trackingNumber',
      'paymentRef', 'amount', 'currency',
      'itemsSummary', 'itemsDetails', 'deliveredAt', 'paidAt',
    ].forEach(adoptIfEmpty);

    // Earliest occurredAt wins (deal "happened" at first event)
    if (secondary.occurredAt && (!primary.occurredAt || new Date(secondary.occurredAt) < new Date(primary.occurredAt))) {
      update.occurredAt = secondary.occurredAt;
      copied.push('occurredAt');
    }

    // Stage flags: OR-merge
    ['hasOrder', 'hasInvoice', 'hasShipped', 'hasDelivered', 'hasPayment'].forEach((k) => {
      if (!primary[k] && secondary[k]) { update[k] = true; copied.push(k); }
    });

    // Notes concatenation (preserve user-edited text from both)
    if (secondary.notes) {
      const combined = [primary.notes, secondary.notes].filter(Boolean).join(' | ');
      if (combined !== primary.notes) { update.notes = combined; copied.push('notes'); }
    }

    update.matchReason = `manual merge: adopted [${copied.join(',') || 'none'}] from ${secondaryId ? 'tx ' + secondary.id.slice(0, 8) : 'row ' + secondary.sheetRowId}`;

    const merged = await prisma.transaction.update({ where: { id: primary.id }, data: update });
    await prisma.transaction.delete({ where: { id: secondary.id } });

    // Sheets: drop secondary's row, refresh primary's row in place
    if (sheetsSync.isConfigured()) {
      try {
        if (secondary.sheetRowId) await sheetsSync.deleteRowById(secondary.sheetRowId);
        // Adjust sheetRowId of every tx after the deleted row (-1)
        if (secondary.sheetRowId) {
          await prisma.$executeRawUnsafe(
            `UPDATE "Transaction" SET "sheetRowId" = "sheetRowId" - 1 WHERE "sheetRowId" IS NOT NULL AND "sheetRowId" > ${secondary.sheetRowId}`
          );
        }
        // Re-fetch merged to get current sheetRowId after shifts
        const fresh = await prisma.transaction.findUnique({ where: { id: merged.id } });
        if (fresh && fresh.sheetRowId) await sheetsSync.updateRowById(fresh);
      } catch (e) {
        console.error('[transactions/merge] sheets sync failed:', e.message);
      }
    }

    res.json({
      ok: true,
      merged,
      copied,
      removedSecondary: { id: secondary.id, sheetRowId: secondary.sheetRowId, contractorName: secondary.contractorName },
    });
  } catch (e) {
    console.error('[transactions/merge]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/transactions/:id/split — undo a wrong merge by detaching one
// of the linked records (e.g. unlink invoice that shouldn't have been
// matched). Doesn't delete data — just clears the linkage so a new
// auto-match can happen.
router.post('/transactions/:id/split', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { detach } = req.body || {};   // 'invoice' | 'shipment' | 'order' | 'payment'
    const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!tx) return res.status(404).json({ ok: false, error: 'transaction not found' });

    const data = {};
    if (detach === 'invoice') { data.invoiceId = null; data.invoiceNumber = null; data.hasInvoice = false; }
    if (detach === 'shipment') { data.shipmentHash = null; data.shipmentNumber = null; data.trackingNumber = null; data.hasShipped = false; data.hasDelivered = false; data.deliveredAt = null; }
    if (detach === 'order') { data.emailId = null; data.hasOrder = false; }
    if (detach === 'payment') { data.paymentRef = null; data.hasPayment = false; data.paidAt = null; }
    if (Object.keys(data).length === 0) return res.status(400).json({ ok: false, error: 'detach must be one of: invoice, shipment, order, payment' });

    const updated = await prisma.transaction.update({ where: { id: tx.id }, data });
    res.json({ ok: true, detached: detach, transaction: updated });
  } catch (e) {
    console.error('[transactions/split]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// One-time setup: write headers, freeze header row, mark reserved rows
// (yellow), hide id/gs_modified columns. Call once after the spreadsheet
// is created and shared with the Service Account.
router.post('/transactions/sync-sheets/init', async (req, res) => {
  try {
    if (!sheetsSync.isConfigured()) return res.status(400).json({ ok: false, error: 'Google Sheets not configured (missing GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SHEETS_SPREADSHEET_ID)' });
    const result = await sheetsSync.initSheet();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[sync-sheets/init]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Bulk sync — push every transaction in DB to the spreadsheet, oldest at
// the bottom. CLEARS the data area first so duplicate rows from earlier
// runs (or hooks that already inserted while bootstrapping) don't pile
// up. Resets sheetRowId on every tx before inserting fresh.
router.post('/transactions/sync-sheets/all', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    if (!sheetsSync.isConfigured()) return res.status(400).json({ ok: false, error: 'Google Sheets not configured' });

    // 1. Wipe the data area + drop every sheetRowId in DB
    await sheetsSync.clearDataRows();
    await prisma.$executeRawUnsafe(`UPDATE "Transaction" SET "sheetRowId" = NULL, "sheetSyncedAt" = NULL`);

    // 2. Insert oldest first → newest ends up on top
    const transactions = await prisma.transaction.findMany({
      orderBy: { occurredAt: 'asc' },
    });
    let inserted = 0;
    for (const tx of transactions) {
      const rowId = await sheetsSync.insertTopRow(tx);
      if (rowId) {
        await prisma.$executeRawUnsafe(
          `UPDATE "Transaction" SET "sheetRowId" = "sheetRowId" + 1 WHERE "sheetRowId" IS NOT NULL AND "sheetRowId" >= ${rowId} AND id != $1`,
          tx.id
        );
        await prisma.transaction.update({ where: { id: tx.id }, data: { sheetRowId: rowId, sheetSyncedAt: new Date() } });
        inserted++;
      }
    }
    res.json({ ok: true, inserted, total: transactions.length });
  } catch (e) {
    console.error('[sync-sheets/all]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Wipe everything — all DB transactions + sheet data rows. Headers and
// reserved rows on the sheet are preserved. Requires {confirm: true} in
// body to avoid accidental triggering. Use before re-running bootstrap
// to test the matcher from a clean slate.
router.post('/transactions/reset', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    if (!req.body || req.body.confirm !== true) {
      return res.status(400).json({ ok: false, error: 'destructive — pass { "confirm": true } to proceed' });
    }
    const { count: deleted } = await prisma.transaction.deleteMany({});
    let sheetCleared = false;
    if (sheetsSync.isConfigured()) {
      try { await sheetsSync.clearDataRows(); sheetCleared = true; }
      catch (e) { console.error('[transactions/reset] sheets clear failed:', e.message); }
    }
    res.json({ ok: true, deletedFromDb: deleted, sheetCleared });
  } catch (e) {
    console.error('[transactions/reset]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
