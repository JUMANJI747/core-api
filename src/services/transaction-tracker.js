'use strict';

const { scoreContractor } = require('./contractor-match');

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
const HARD_AMOUNT_TOLERANCE = 0.01;   // ±1%
const HARD_DATE_WINDOW_DAYS = 30;     // ±30 days (sanity)
const DATE_DECAY_TAU = 5;             // exp(-days/5): 0d→1.0, 5d→0.37, 14d→0.06
const SCORE_THRESHOLD = 0.30;         // below this we don't link, we open a new tx
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
    const s = combinedScore(invoice.issueDate, c.occurredAt, invoice.grossAmount, c.amount);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  if (bestScore < SCORE_THRESHOLD) return null;
  return { transaction: best, score: bestScore, reason: describeMatch(invoice.issueDate, best.occurredAt, invoice.grossAmount, best.amount) };
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

  const amount = (gkOrder.pricing && gkOrder.pricing.priceGross) || gkOrder.priceGross || null;
  let best = null, bestScore = 0;
  for (const c of candidates) {
    const s = combinedScore(occurredAt, c.occurredAt, amount, c.amount);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  if (bestScore < SCORE_THRESHOLD) return null;
  return { transaction: best, score: bestScore, reason: describeMatch(occurredAt, best.occurredAt, amount, best.amount) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

async function trackInvoice(prisma, invoice, opts = {}) {
  if (!invoice) return null;
  const source = opts.source || 'invoice';

  const match = await findOpenTransactionForInvoice(prisma, invoice);
  if (match) {
    return prisma.transaction.update({
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
  }

  // No match — open a new transaction anchored on this invoice.
  return prisma.transaction.create({
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
    return prisma.transaction.update({
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
  }

  return prisma.transaction.create({
    data: {
      contractorId: contractor ? contractor.id : null,
      contractorName: contractor ? contractor.name : recvName,
      shipmentHash: gkOrder.hash || gkOrder.orderHash,
      shipmentNumber: gkOrder.number || gkOrder.orderNumber,
      trackingNumber,
      amount,
      currency,
      occurredAt,
      hasShipped: true,
      hasDelivered: status === 'DELIVERED',
      deliveredAt: status === 'DELIVERED' && gkOrder.deliveryDate ? new Date(gkOrder.deliveryDate) : null,
      itemsSummary: opts.itemsSummary || null,
      itemsDetails: opts.itemsDetails || null,
      source,
      matchScore: null,
      matchReason: contractor ? 'opened from shipment (no matching invoice yet)' : 'orphan: contractor not resolved from receiver',
    },
  });
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
  return prisma.transaction.update({
    where: { id: best.id },
    data: { emailId: email.id, hasOrder: true },
  });
}

async function addManualEntry(prisma, data) {
  return prisma.transaction.create({
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
