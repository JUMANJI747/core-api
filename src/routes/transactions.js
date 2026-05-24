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
      prisma.transaction.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        take: lim,
        skip: off,
        include: {
          contractor: { select: { id: true, name: true, country: true, nip: true } },
        },
      }),
      prisma.transaction.count({ where }),
    ]);

    // Enrich with Invoice details (fetched in one batch for transactions with invoiceId)
    const invoiceIds = items.map(t => t.invoiceId).filter(Boolean);
    let invoiceMap = new Map();
    if (invoiceIds.length) {
      const invoices = await prisma.invoice.findMany({
        where: { id: { in: invoiceIds } },
        select: { id: true, contractorCountry: true, currency: true, status: true, paidAmount: true, grossAmount: true, issueDate: true, ifirmaType: true, type: true },
      });
      invoiceMap = new Map(invoices.map(inv => [inv.id, inv]));
    }

    const transactions = items.map(t => ({
      ...t,
      invoice: t.invoiceId ? (invoiceMap.get(t.invoiceId) || null) : null,
    }));

    res.json({ ok: true, total, returned: transactions.length, transactions });
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

// POST /api/transactions/rematch
// Przelatuje WSZYSTKIE istniejące Transaction i próbuje sparować te które
// mają luki (brak invoiceId mimo istnienia FV w bazie, brak shipmentHash
// mimo istnienia GK Order). Plus: przelatuje wszystkie Invoice które nie
// mają jeszcze Transaction i odpala trackInvoice. Same dla GK Orders.
//
// dryRun=true zwraca plan bez modyfikacji.
router.post('/transactions/rematch', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { dryRun = false } = req.body || {};
  const report = {
    invoicesScanned: 0,
    invoicesAdded: 0,
    invoicesAlreadyTracked: 0,
    shipmentsScanned: 0,
    shipmentsAdded: 0,
    shipmentsAlreadyTracked: 0,
    txMerged: 0,
    samples: [],
  };
  try {
    // 1. Invoices bez Transaction → trackInvoice (to też próbuje merge z open shipment)
    const invoices = await prisma.invoice.findMany({
      orderBy: { issueDate: 'desc' },
      take: 500,
      include: { contractor: { select: { name: true } } },
    });
    report.invoicesScanned = invoices.length;
    for (const inv of invoices) {
      const existing = await prisma.transaction.findFirst({ where: { invoiceId: inv.id } });
      if (existing) { report.invoicesAlreadyTracked++; continue; }
      if (dryRun) { report.invoicesAdded++; continue; }
      const tx = await trackInvoice(prisma, inv, {
        source: 'rematch',
        contractorName: inv.contractor && inv.contractor.name,
        itemsSummary: inv.extras && Array.isArray(inv.extras.items) && inv.extras.items.length
          ? inv.extras.items.map(it => `${it.qty}× ${it.name || it.ean || '?'}`).slice(0, 3).join(', ') + (inv.extras.items.length > 3 ? `, +${inv.extras.items.length - 3}` : '')
          : null,
        itemsDetails: inv.extras && inv.extras.items ? inv.extras.items : null,
      });
      report.invoicesAdded++;
      if (tx.shipmentHash) report.txMerged++;
    }

    // 2. GK Orders ostatnie 100 → trackShipment dla każdego co nie istnieje
    let gkOrders = [];
    try {
      const data = await getOrders({ limit: 100 });
      const list = (data && (data.results || data.items || data.data)) || (Array.isArray(data) ? data : []);
      const unwrapped = Array.isArray(list) && list.length === 1 && list[0] && Array.isArray(list[0].results) ? list[0].results : list;
      gkOrders = unwrapped || [];
    } catch (e) {
      console.error('[rematch] getOrders failed:', e.message);
    }
    report.shipmentsScanned = gkOrders.length;
    for (const gk of gkOrders) {
      const hash = gk.hash || gk.orderHash;
      if (hash) {
        const existing = await prisma.transaction.findFirst({ where: { shipmentHash: hash } });
        if (existing) { report.shipmentsAlreadyTracked++; continue; }
      }
      if (dryRun) { report.shipmentsAdded++; continue; }
      const contractor = await resolveContractorFromShipment(prisma, gk);
      const tx = await trackShipment(prisma, gk, { source: 'rematch', contractor });
      report.shipmentsAdded++;
      if (tx.invoiceId) report.txMerged++;
    }

    // 3. Próba domknięcia luk w open Transaction — dla każdej z hasInvoice=false
    //    z contractorId, szukaj invoice pasującej po dacie+amount; analogicznie
    //    hasShipped=false → szukaj GK ordera z bazy GK po contractor+date.
    const openInvoiceless = await prisma.transaction.findMany({
      where: { invoiceId: null, contractorId: { not: null } },
    });
    for (const tx of openInvoiceless) {
      // Szukaj invoice tej samej contractorId w ±30 dni od tx.occurredAt z amountem ±5%.
      const since = new Date(tx.occurredAt); since.setDate(since.getDate() - 30);
      const until = new Date(tx.occurredAt); until.setDate(until.getDate() + 30);
      const candidates = await prisma.invoice.findMany({
        where: { contractorId: tx.contractorId, issueDate: { gte: since, lte: until } },
      });
      for (const inv of candidates) {
        // Sprawdź czy ta invoice nie jest już w innej Transaction
        const taken = await prisma.transaction.findFirst({ where: { invoiceId: inv.id } });
        if (taken) continue;
        const amountMatch = !tx.amount || !inv.grossAmount ||
          Math.abs(Number(tx.amount) - Number(inv.grossAmount)) / Number(inv.grossAmount) < 0.05;
        if (!amountMatch) continue;
        if (!dryRun) {
          await prisma.transaction.update({
            where: { id: tx.id },
            data: {
              invoiceId: inv.id, invoiceNumber: inv.number,
              hasInvoice: true,
              amount: tx.amount || inv.grossAmount, currency: tx.currency || inv.currency,
              matchReason: (tx.matchReason || '') + ' | rematch: paired with invoice ' + inv.number,
            },
          });
        }
        report.txMerged++;
        report.samples.push({ txId: tx.id, contractorName: tx.contractorName, paired: 'invoice ' + inv.number });
        break;
      }
    }

    res.json({ ok: true, dryRun, ...report });
  } catch (e) {
    console.error('[transactions/rematch]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Sample-followups — deterministyczny raport "ktorym sample-klientom
// trzeba napisac follow-up bo paczka dotarla >N dni temu". Sample
// definiujemy biznesowo: kontrahent NIE mial wczesniej FV od nas.
// (User: "sample jak sa wysylane to dany kontrahent na pewno nie mial
// faktury wczesniej").
//
// Query params:
//   minDaysSinceDelivery (int, default 3)  — od kiedy follow-up due
//   windowDays (int, default 60)            — jak daleko wstecz szukamy
//   includeUndelivered (bool, default true) — wlaczy tez paczki bez
//      hasDelivered=true ale wyslane >X dni temu (GK czesto pomija
//      update statusu — DPD/DHL doszly, GK nie zaktualizowal)
//   undeliveredAfterDays (int, default 4)   — po ilu dniach od wyslania
//      traktujemy "shipped ale GK nie wie" jako "pewnie doszlo"
router.get('/operations/sample-followups', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const minDaysSinceDelivery = parseInt(req.query.minDaysSinceDelivery, 10) || 3;
  const windowDays = parseInt(req.query.windowDays, 10) || 60;
  const includeUndelivered = req.query.includeUndelivered !== 'false';
  const undeliveredAfterDays = parseInt(req.query.undeliveredAfterDays, 10) || 4;
  const now = Date.now();
  const windowStart = new Date(now - windowDays * 24 * 60 * 60 * 1000);
  const deliveredThreshold = new Date(now - minDaysSinceDelivery * 24 * 60 * 60 * 1000);
  const shippedThreshold = new Date(now - undeliveredAfterDays * 24 * 60 * 60 * 1000);

  try {
    // Bierz wszystkie shipped transactions w oknie z contractorId.
    const shipments = await prisma.transaction.findMany({
      where: {
        hasShipped: true,
        contractorId: { not: null },
        occurredAt: { gte: windowStart },
        OR: [
          { hasDelivered: true, deliveredAt: { lte: deliveredThreshold } },
          ...(includeUndelivered ? [{ hasDelivered: false, occurredAt: { lte: shippedThreshold } }] : []),
        ],
      },
      select: {
        id: true, contractorId: true, contractorName: true,
        occurredAt: true, deliveredAt: true, hasDelivered: true,
        shipmentNumber: true, trackingNumber: true, amount: true, currency: true,
        extras: true,
        contractor: { select: { name: true, email: true, primaryEmail: true, country: true, preferredLanguage: true } },
      },
      orderBy: { deliveredAt: 'desc' },
    });

    if (!shipments.length) return res.json({ ok: true, count: 0, followups: [] });

    // Per shipment sprawdz czy contractor mial wczesniejsza FV.
    const contractorIds = [...new Set(shipments.map(s => s.contractorId))];
    const earliestInvoiceByContractor = new Map();
    const invs = await prisma.invoice.findMany({
      where: { contractorId: { in: contractorIds } },
      select: { contractorId: true, issueDate: true, number: true },
      orderBy: { issueDate: 'asc' },
    });
    for (const inv of invs) {
      if (!earliestInvoiceByContractor.has(inv.contractorId)) {
        earliestInvoiceByContractor.set(inv.contractorId, inv);
      }
    }
    // To samo dla EsInvoice — przez linkedEsContractorId.
    const plToEsLink = new Map();
    const linked = await prisma.contractor.findMany({
      where: { id: { in: contractorIds }, linkedEsContractorId: { not: null } },
      select: { id: true, linkedEsContractorId: true },
    });
    for (const l of linked) plToEsLink.set(l.id, l.linkedEsContractorId);
    if (plToEsLink.size) {
      const esInvs = await prisma.esInvoice.findMany({
        where: { contractorId: { in: [...plToEsLink.values()] } },
        select: { contractorId: true, invoiceDate: true, number: true },
        orderBy: { invoiceDate: 'asc' },
      });
      for (const inv of esInvs) {
        // znajdz PL contractor po linked ES
        for (const [plId, esId] of plToEsLink) {
          if (esId === inv.contractorId) {
            const existing = earliestInvoiceByContractor.get(plId);
            if (!existing || new Date(inv.invoiceDate) < new Date(existing.issueDate || existing.invoiceDate)) {
              earliestInvoiceByContractor.set(plId, { contractorId: plId, issueDate: inv.invoiceDate, number: inv.number });
            }
          }
        }
      }
    }

    // Filter — sample = brak FV PRZED wysylka.
    const followups = [];
    for (const s of shipments) {
      const firstInv = earliestInvoiceByContractor.get(s.contractorId);
      if (firstInv && new Date(firstInv.issueDate || firstInv.invoiceDate) < new Date(s.occurredAt)) {
        // Mial FV przed wysylka — to nie sample, klient z historia. Skip.
        continue;
      }
      const daysSinceDelivery = s.hasDelivered && s.deliveredAt
        ? Math.floor((now - new Date(s.deliveredAt).getTime()) / (24 * 60 * 60 * 1000))
        : Math.floor((now - new Date(s.occurredAt).getTime()) / (24 * 60 * 60 * 1000));
      followups.push({
        transactionId: s.id,
        contractorId: s.contractorId,
        contractorName: s.contractorName || (s.contractor && s.contractor.name),
        contractorEmail: (s.contractor && (s.contractor.primaryEmail || s.contractor.email)) || null,
        contractorCountry: s.contractor && s.contractor.country,
        preferredLanguage: s.contractor && s.contractor.preferredLanguage,
        shipmentNumber: s.shipmentNumber,
        trackingNumber: s.trackingNumber,
        shippedAt: s.occurredAt,
        deliveredAt: s.deliveredAt,
        hasDeliveredConfirmed: s.hasDelivered,
        daysSinceDelivery,
        sampleConfirmed: !firstInv, // 100% pewne — zero FV w bazie
        followupUrgent: daysSinceDelivery >= minDaysSinceDelivery,
      });
    }

    res.json({
      ok: true,
      params: { minDaysSinceDelivery, windowDays, includeUndelivered, undeliveredAfterDays },
      count: followups.length,
      followups,
    });
  } catch (e) {
    console.error('[operations/sample-followups] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/transactions/:id — update notes, checkboxes, items summary
router.patch('/transactions/:id', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { id } = req.params;
    const allowed = ['notes', 'hasOrder', 'hasInvoice', 'hasShipped', 'hasDelivered', 'hasPayment', 'itemsSummary'];
    const data = {};
    for (const k of allowed) {
      if (k in req.body) data[k] = req.body[k];
    }
    // auto-set timestamps when toggling on
    if (data.hasDelivered === true && req.body.deliveredAt !== undefined) {
      data.deliveredAt = req.body.deliveredAt ? new Date(req.body.deliveredAt) : new Date();
    }
    if (data.hasPayment === true && req.body.paidAt !== undefined) {
      data.paidAt = req.body.paidAt ? new Date(req.body.paidAt) : new Date();
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ ok: false, error: 'no allowed fields in body' });
    }
    const updated = await prisma.transaction.update({ where: { id }, data });
    res.json({ ok: true, transaction: updated });
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ ok: false, error: 'transaction not found' });
    console.error('[transactions PATCH]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
