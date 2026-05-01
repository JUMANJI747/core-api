'use strict';

const { scoreContractor } = require('./contractor-match');
const sheetsSync = require('./sheets-sync');

// Best-effort GS sync after a tracker write. Never throws — sheets being
// down should not break invoice / shipment flow. Updates sheetRowId in DB
// when a new row was inserted so future updates target the right cell.
async function maybeSyncToSheet(prisma, tx, action) {
  if (!sheetsSync.isConfigured()) return;
  try {
    if (action === 'create') {
      const rowId = await sheetsSync.insertTopRow(tx);
      if (rowId) {
        // Other rows shifted down; bump sheetRowId on every existing tx.
        await prisma.$executeRawUnsafe(
          `UPDATE "Transaction" SET "sheetRowId" = "sheetRowId" + 1 WHERE "sheetRowId" IS NOT NULL AND "sheetRowId" >= ${rowId} AND id != $1`,
          tx.id
        );
        await prisma.transaction.update({ where: { id: tx.id }, data: { sheetRowId: rowId, sheetSyncedAt: new Date() } });
      }
    } else if (action === 'update') {
      const result = await sheetsSync.updateRowById(tx);
      if (result && result.drifted) {
        // Row moved — reinsert at top
        const rowId = await sheetsSync.insertTopRow(tx);
        if (rowId) {
          await prisma.$executeRawUnsafe(
            `UPDATE "Transaction" SET "sheetRowId" = "sheetRowId" + 1 WHERE "sheetRowId" IS NOT NULL AND "sheetRowId" >= ${rowId} AND id != $1`,
            tx.id
          );
          await prisma.transaction.update({ where: { id: tx.id }, data: { sheetRowId: rowId, sheetSyncedAt: new Date() } });
        }
      } else if (result) {
        await prisma.transaction.update({ where: { id: tx.id }, data: { sheetSyncedAt: new Date() } });
      }
    } else if (action === 'delete') {
      if (tx.sheetRowId) await sheetsSync.deleteRowById(tx.sheetRowId);
    }
  } catch (e) {
    console.error('[transaction-tracker] sheets sync failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction tracker — glues order email → invoice → shipment → delivery →
// payment into a single Transaction row, used by the Operations module
// (Google Sheets sync + daily briefing + stale alerts).
//
// Matching strategy (per user spec):
//   1. CONTRACTOR is the anchor — must be the same record in our DB.
//   2. Among same-contractor candidates, score by date (exponential decay,
//      shorter = stronger) and amount (linear within ±1% hard filter).
//   3. Below threshold or no contractor → create new Transaction (orphan
//      until merged manually).
// ─────────────────────────────────────────────────────────────────────────────

// Matching constants
const HARD_AMOUNT_TOLERANCE = 0.01;   // ±1% — used only when comparing
                                      // amounts from the SAME domain
                                      // (e.g. invoice gross to invoice gross
                                      // on a manual merge). NOT used for
                                      // invoice↔shipment matching because:
                                      //   • invoice.grossAmount = goods value
                                      //   • shipment.pricing.priceGross = freight cost
                                      // These never align (270 EUR goods vs
                                      // 56,88 PLN freight) so we'd reject
                                      // every legitimate pair.
const HARD_DATE_WINDOW_DAYS = 30;     // ±30 days (sanity)
const DATE_DECAY_TAU = 5;             // exp(-days/5): 0d→1.0, 5d→0.37, 14d→0.06
const SCORE_THRESHOLD = 0.05;         // ≈14 days; below this we open a new tx
const SCORE_DATE_WEIGHT = 0.7;
const SCORE_AMOUNT_WEIGHT = 0.3;

function dateScore(dateA, dateB) {
  if (!dateA || !dateB) return 0;
  const days = Math.abs(new Date(dateA) - new Date(dateB)) / 86400000;
  return Math.exp(-days / DATE_DECAY_TAU);
}

function amountScore(a, b) {
  if (a == null || b == null) return 0;
  const av = Number(a), bv = Number(b);
  if (av === 0 || bv === 0) return 0;
  const delta = Math.abs(av - bv) / Math.max(av, bv);
  if (delta > HARD_AMOUNT_TOLERANCE) return 0;
  return 1 - (delta / HARD_AMOUNT_TOLERANCE);
}

// Cross-domain score for invoice↔shipment matching: date only.
// (See HARD_AMOUNT_TOLERANCE comment for why we don't include amount.)
function shipmentInvoiceScore(dateA, dateB) {
  return dateScore(dateA, dateB);
}

function describeShipmentInvoiceMatch(dateA, dateB) {
  const days = Math.round(Math.abs(new Date(dateA) - new Date(dateB)) / 86400000);
  return `${days}d apart (date-only match — different amount domains)`;
}

function combinedScore(dateA, dateB, amountA, amountB) {
  const ds = dateScore(dateA, dateB);
  const as = amountScore(amountA, amountB);
  if (as === 0) return 0;       // amount hard-filter
  if (ds === 0) return 0;
  return SCORE_DATE_WEIGHT * ds + SCORE_AMOUNT_WEIGHT * as;
}

function describeMatch(dateA, dateB, amountA, amountB) {
  const days = Math.round(Math.abs(new Date(dateA) - new Date(dateB)) / 86400000);
  const av = Number(amountA), bv = Number(amountB);
  const deltaPct = av && bv ? Math.round((Math.abs(av - bv) / Math.max(av, bv)) * 1000) / 10 : 0;
  return `${days}d, ${deltaPct}% Δ`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve a GK shipment to a contractor in our DB.
//   1. fuzzy name match against contractor.name + extras.aliases
//   2. street+city+postCode match against extras.locations[]
//   3. give up — caller treats as orphan (contractorId=null)
// ─────────────────────────────────────────────────────────────────────────────
async function resolveContractorFromShipment(prisma, gkOrder) {
  const recv = (gkOrder && (gkOrder.receiverAddress || gkOrder.receiver)) || {};
  const recvName = (recv.name || recv.companyName || recv.contactPerson || '').trim();
  if (!recvName && !recv.street && !recv.city) return null;

  const all = await prisma.contractor.findMany({
    select: { id: true, name: true, nip: true, country: true, email: true, address: true, city: true, extras: true },
  });

  // 1. fuzzy by name
  if (recvName) {
    const scored = all
      .map(c => ({ contractor: c, score: scoreContractor(c, recvName) }))
      .filter(x => x.score >= 50)
      .sort((a, b) => b.score - a.score);
    if (scored.length > 0) return scored[0].contractor;
  }

  // 2. exact match against saved delivery locations
  if (recv.street || recv.city) {
    const norm = (s) => (s || '').toString().toLowerCase().trim();
    for (const c of all) {
      const locs = Array.isArray(c.extras && c.extras.locations) ? c.extras.locations : [];
      if (locs.some(l =>
        l.street && norm(l.street) === norm(recv.street) &&
        l.city && norm(l.city) === norm(recv.city) &&
        (!l.postCode || !recv.postCode || norm(l.postCode) === norm(recv.postCode))
      )) return c;
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Find an existing Transaction we should attach this invoice to, or null.
// Strategy: same contractor, occurredAt within HARD_DATE_WINDOW_DAYS, score
// above SCORE_THRESHOLD, NOT already having an invoiceId set.
// ─────────────────────────────────────────────────────────────────────────────
async function findOpenTransactionForInvoice(prisma, invoice) {
  if (!invoice.contractorId) return null;
  const since = new Date(invoice.issueDate);
  since.setDate(since.getDate() - HARD_DATE_WINDOW_DAYS);
  const until = new Date(invoice.issueDate);
  until.setDate(until.getDate() + HARD_DATE_WINDOW_DAYS);

  const candidates = await prisma.transaction.findMany({
    where: {
      contractorId: invoice.contractorId,
      invoiceId: null,
      occurredAt: { gte: since, lte: until },
    },
  });
  if (candidates.length === 0) return null;

  let best = null, bestScore = 0;
  for (const c of candidates) {
    const s = shipmentInvoiceScore(invoice.issueDate, c.occurredAt);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  if (bestScore < SCORE_THRESHOLD) return null;
  return { transaction: best, score: bestScore, reason: describeShipmentInvoiceMatch(invoice.issueDate, best.occurredAt) };
}

async function findOpenTransactionForShipment(prisma, gkOrder, contractor) {
  if (!contractor) return null;
  const occurredAt = new Date(gkOrder.creationDate || gkOrder.created_at || gkOrder.createdAt || Date.now());
  const since = new Date(occurredAt); since.setDate(since.getDate() - HARD_DATE_WINDOW_DAYS);
  const until = new Date(occurredAt); until.setDate(until.getDate() + HARD_DATE_WINDOW_DAYS);

  const candidates = await prisma.transaction.findMany({
    where: {
      contractorId: contractor.id,
      shipmentHash: null,
      occurredAt: { gte: since, lte: until },
    },
  });
  if (candidates.length === 0) return null;

  let best = null, bestScore = 0;
  for (const c of candidates) {
    const s = shipmentInvoiceScore(occurredAt, c.occurredAt);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  if (bestScore < SCORE_THRESHOLD) return null;
  return { transaction: best, score: bestScore, reason: describeShipmentInvoiceMatch(occurredAt, best.occurredAt) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

async function trackInvoice(prisma, invoice, opts = {}) {
  if (!invoice) return null;
  const source = opts.source || 'invoice';

  const match = await findOpenTransactionForInvoice(prisma, invoice);
  if (match) {
    const updated = await prisma.transaction.update({
      where: { id: match.transaction.id },
      data: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        amount: invoice.grossAmount,
        currency: invoice.currency,
        hasInvoice: true,
        hasPayment: invoice.status === 'paid' ? true : undefined,
        matchScore: match.score,
        matchReason: 'merged with shipment: ' + match.reason,
      },
    });
    await maybeSyncToSheet(prisma, updated, 'update');
    return updated;
  }

  // No match — open a new transaction anchored on this invoice.
  const created = await prisma.transaction.create({
    data: {
      contractorId: invoice.contractorId,
      contractorName: opts.contractorName || null,
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      amount: invoice.grossAmount,
      currency: invoice.currency,
      occurredAt: invoice.issueDate,
      hasInvoice: true,
      hasPayment: invoice.status === 'paid',
      paidAt: invoice.status === 'paid' ? new Date() : null,
      itemsSummary: opts.itemsSummary || null,
      itemsDetails: opts.itemsDetails || null,
      source,
      matchScore: null,
      matchReason: 'opened from invoice (no matching shipment yet)',
    },
  });
  await maybeSyncToSheet(prisma, created, 'create');
  return created;
}

async function trackShipment(prisma, gkOrder, opts = {}) {
  if (!gkOrder) return null;
  const source = opts.source || 'shipment';
  const contractor = opts.contractor || await resolveContractorFromShipment(prisma, gkOrder);
  const occurredAt = new Date(gkOrder.creationDate || gkOrder.created_at || gkOrder.createdAt || Date.now());
  const recvName = (gkOrder.receiverAddress && (gkOrder.receiverAddress.name || gkOrder.receiverAddress.companyName)) || null;
  const amount = (gkOrder.pricing && gkOrder.pricing.priceGross) || gkOrder.priceGross || null;
  const currency = (gkOrder.pricing && gkOrder.pricing.currency) || gkOrder.currency || 'PLN';
  const trackingNumber = gkOrder.trackingNumber || gkOrder.tracking || null;
  const status = (gkOrder.status || '').toUpperCase();

  const match = contractor ? await findOpenTransactionForShipment(prisma, gkOrder, contractor) : null;
  if (match) {
    const updated = await prisma.transaction.update({
      where: { id: match.transaction.id },
      data: {
        shipmentHash: gkOrder.hash || gkOrder.orderHash,
        shipmentNumber: gkOrder.number || gkOrder.orderNumber,
        trackingNumber,
        hasShipped: true,
        hasDelivered: status === 'DELIVERED',
        deliveredAt: status === 'DELIVERED' ? (gkOrder.deliveryDate ? new Date(gkOrder.deliveryDate) : new Date()) : undefined,
        matchScore: match.score,
        matchReason: 'merged with invoice: ' + match.reason,
      },
    });
    await maybeSyncToSheet(prisma, updated, 'update');
    return updated;
  }

  const createdShipment = await prisma.transaction.create({
    data: {
      contractorId: contractor ? contractor.id : null,
      contractorName: contractor ? contractor.name : recvName,
      shipmentHash: gkOrder.hash || gkOrder.orderHash,
      shipmentNumber: gkOrder.number || gkOrder.orderNumber,
      trackingNumber,
      // Don't write freight cost into the goods-value column. amount is
      // expected to mean "what the customer pays for the order" (which we
      // only know once an invoice is matched). Freight goes into notes.
      amount: null,
      currency: null,
      occurredAt,
      hasShipped: true,
      hasDelivered: status === 'DELIVERED',
      deliveredAt: status === 'DELIVERED' && gkOrder.deliveryDate ? new Date(gkOrder.deliveryDate) : null,
      itemsSummary: opts.itemsSummary || (gkOrder.productName ? `(paczka: ${gkOrder.productName})` : null),
      itemsDetails: opts.itemsDetails || null,
      notes: amount ? `Koszt wysyłki: ${Number(amount).toFixed(2)} ${currency}` : null,
      source,
      matchScore: null,
      matchReason: contractor ? 'opened from shipment (no matching invoice yet)' : 'orphan: contractor not resolved from receiver',
    },
  });
  await maybeSyncToSheet(prisma, createdShipment, 'create');
  return createdShipment;
}

async function trackOrderEmail(prisma, email, opts = {}) {
  if (!email) return null;
  // Only attach to existing transaction; don't open a new one from a bare
  // email (we'd have no amount to match on yet).
  if (!email.contractorId) return null;
  const since = new Date(email.createdAt);
  since.setDate(since.getDate() - HARD_DATE_WINDOW_DAYS);
  const until = new Date(email.createdAt);
  until.setDate(until.getDate() + HARD_DATE_WINDOW_DAYS);
  const candidates = await prisma.transaction.findMany({
    where: {
      contractorId: email.contractorId,
      emailId: null,
      occurredAt: { gte: since, lte: until },
    },
    take: 5,
    orderBy: { occurredAt: 'desc' },
  });
  if (candidates.length === 0) return null;
  // Best by date proximity (no amount on email).
  let best = candidates[0], bestScore = dateScore(email.createdAt, candidates[0].occurredAt);
  for (const c of candidates.slice(1)) {
    const s = dateScore(email.createdAt, c.occurredAt);
    if (s > bestScore) { best = c; bestScore = s; }
  }
  const updatedEmail = await prisma.transaction.update({
    where: { id: best.id },
    data: { emailId: email.id, hasOrder: true },
  });
  await maybeSyncToSheet(prisma, updatedEmail, 'update');
  return updatedEmail;
}

async function addManualEntry(prisma, data) {
  const createdManual = await prisma.transaction.create({
    data: {
      contractorId: data.contractorId || null,
      contractorName: data.contractorName || null,
      amount: data.amount || null,
      currency: data.currency || null,
      occurredAt: data.occurredAt ? new Date(data.occurredAt) : new Date(),
      hasOrder: data.hasOrder !== false,
      itemsSummary: data.itemsSummary || null,
      itemsDetails: data.itemsDetails || null,
      notes: data.notes || null,
      source: 'manual',
      matchReason: 'manual entry',
    },
  });
  await maybeSyncToSheet(prisma, createdManual, 'create');
  return createdManual;
}

module.exports = {
  trackInvoice,
  trackShipment,
  trackOrderEmail,
  addManualEntry,
  resolveContractorFromShipment,
  // exposed for tests / debug
  combinedScore,
  dateScore,
  amountScore,
  HARD_DATE_WINDOW_DAYS,
  HARD_AMOUNT_TOLERANCE,
};
