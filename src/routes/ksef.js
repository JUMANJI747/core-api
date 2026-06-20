'use strict';

const router = require('express').Router();
const asyncHandler = require('../asyncHandler');
const ksef = require('../ksef-client');

const P = ksef._pick;

// Diagnostyka: sprawdza konfigurację + pełny handshake auth (bez ujawniania
// tokenów). Najpierw odpal to po ustawieniu KSEF_TOKEN/KSEF_NIP w env.
router.post('/ksef/auth-test', asyncHandler(async (req, res) => {
  if (!ksef.isConfigured()) {
    return res.status(400).json({ ok: false, error: 'Brak KSEF_TOKEN lub KSEF_NIP w env.', base: ksef.BASE });
  }
  try {
    await ksef.getTokenEncryptionPublicKey(); // test pobrania certyfikatu
    const { accessToken, refreshToken } = await ksef.authenticate();
    res.json({ ok: true, base: ksef.BASE, gotAccessToken: !!accessToken, gotRefreshToken: !!refreshToken });
  } catch (e) {
    res.status(502).json({ ok: false, base: ksef.BASE, error: e.message, status: e.status, body: e.body });
  }
}));

// Parsowanie metadanych faktury (tolerancyjne — mapowanie doprecyzujemy po
// pierwszym realnym wywołaniu, dlatego raw metadata wraca w response).
function fromMetadata(m, buyerNip) {
  return {
    ksefNumber: P(m, 'ksefReferenceNumber', 'ksefNumber', 'referenceNumber'),
    invoiceNumber: P(m, 'invoiceNumber', 'number', 'invoiceReferenceNumber'),
    issueDate: P(m, 'issueDate', 'invoicingDate', 'invoicingDate', 'acquisitionTimestamp', 'date'),
    sellerName: P(m, 'sellerName', 'subjectByName', 'issuedByName') || P(P(m, 'seller') || {}, 'name'),
    sellerNip: P(m, 'sellerNip', 'subjectByIdentifier') || P(P(m, 'seller') || {}, 'nip', 'identifier'),
    buyerNip,
    netAmount: num(P(m, 'netAmount', 'net', 'totalNetAmount')),
    vatAmount: num(P(m, 'vatAmount', 'vat', 'totalVatAmount')),
    grossAmount: num(P(m, 'grossAmount', 'gross', 'totalGrossAmount', 'amount')),
    currency: P(m, 'currency') || 'PLN',
  };
}
function num(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// POBRANIE faktur kosztowych za zakres dat → zapis do bazy.
// body: { from: "2026-05-01", to: "2026-05-31", dateType?: "Issue", withXml?: true, limit?: number }
router.post('/ksef/pull-cost-invoices', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const buyerNip = String(process.env.KSEF_NIP || '');
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ ok: false, error: 'Podaj from i to (YYYY-MM-DD).' });
  const dateType = (req.body && req.body.dateType) || 'Issue';
  const withXml = !(req.body && req.body.withXml === false); // domyślnie pobieramy XML
  const limit = Math.min(parseInt(req.body && req.body.limit, 10) || 500, 2000);

  let accessToken;
  try {
    ({ accessToken } = await ksef.authenticate());
  } catch (e) {
    return res.status(502).json({ ok: false, stage: 'auth', error: e.message, status: e.status, body: e.body });
  }

  let metadata;
  try {
    const fromIso = new Date(from).toISOString();
    const toIso = new Date(new Date(to).getTime() + 24 * 3600 * 1000 - 1).toISOString();
    metadata = await ksef.queryCostInvoiceMetadata(accessToken, { from: fromIso, to: toIso, dateType });
  } catch (e) {
    return res.status(502).json({ ok: false, stage: 'query', error: e.message, status: e.status, body: e.body });
  }

  metadata = metadata.slice(0, limit);
  let saved = 0; let xmlFetched = 0; const errors = [];
  for (const m of metadata) {
    const d = fromMetadata(m, buyerNip);
    if (!d.ksefNumber) { errors.push({ err: 'brak ksefNumber w metadanych', meta: m }); continue; }
    let xml = null;
    if (withXml) {
      try { xml = await ksef.getInvoiceXml(accessToken, d.ksefNumber); xmlFetched++; }
      catch (e) { errors.push({ ksefNumber: d.ksefNumber, err: e.message }); }
    }
    try {
      const data = {
        ksefNumber: d.ksefNumber,
        invoiceNumber: d.invoiceNumber || null,
        issueDate: d.issueDate ? new Date(d.issueDate) : null,
        sellerName: d.sellerName || null,
        sellerNip: d.sellerNip ? String(d.sellerNip) : null,
        buyerNip,
        netAmount: d.netAmount, vatAmount: d.vatAmount, grossAmount: d.grossAmount,
        currency: d.currency || 'PLN',
        xml, raw: m, fetchedAt: new Date(),
      };
      await prisma.ksefCostInvoice.upsert({ where: { ksefNumber: d.ksefNumber }, update: data, create: data });
      saved++;
    } catch (e) {
      errors.push({ ksefNumber: d.ksefNumber, err: 'zapis: ' + e.message });
    }
  }

  res.json({
    ok: true,
    base: ksef.BASE,
    range: { from, to, dateType },
    found: metadata.length,
    saved, xmlFetched,
    errorsCount: errors.length,
    errors: errors.slice(0, 10),
    // Surowy pierwszy rekord metadanych — do domapowania pól (jednorazowo).
    sampleMetadata: metadata[0] || null,
  });
}));

// Rdzeń: pyta KSeF o NASZE faktury sprzedażowe (Subject1) i ustawia
// Invoice.ksefNumber po numerze FV — żeby lista pokazała zielony znaczek „KSeF".
async function runSalesStatusSync(prisma, { from, to, dateType = 'Issue' }) {
  const { accessToken } = await ksef.authenticate();
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(new Date(to).getTime() + 24 * 3600 * 1000 - 1).toISOString();
  const metadata = await ksef.queryInvoiceMetadata(accessToken, { subjectType: 'Subject1', from: fromIso, to: toIso, dateType });
  let matched = 0; const unmatched = [];
  for (const m of metadata) {
    const number = P(m, 'invoiceNumber', 'number');
    const ksefNumber = P(m, 'ksefNumber', 'ksefReferenceNumber', 'referenceNumber');
    if (!number || !ksefNumber) continue;
    const upd = await prisma.invoice.updateMany({ where: { number: String(number), ksefNumber: null }, data: { ksefNumber: String(ksefNumber) } }).catch(() => ({ count: 0 }));
    if (upd.count) matched += upd.count; else unmatched.push(number);
  }
  return { found: metadata.length, matched, unmatched, sample: metadata[0] || null };
}

// Ręczna synchronizacja statusu KSeF (Subject1). body: { from, to, dateType? }.
router.post('/ksef/sync-sales-status', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const now = new Date();
  const from = (req.body && req.body.from) || new Date(now.getTime() - 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const to = (req.body && req.body.to) || now.toISOString().slice(0, 10);
  const dateType = (req.body && req.body.dateType) || 'Issue';
  try {
    const r = await runSalesStatusSync(prisma, { from, to, dateType });
    res.json({ ok: true, range: { from, to, dateType }, ...r, unmatchedCount: r.unmatched.length, unmatched: r.unmatched.slice(0, 20) });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, status: e.status, body: e.body });
  }
}));

// Auto-sync statusu KSeF — wołany w tle z listy Faktur. Throttle 10 min, zawsze
// 200 (błąd nie psuje strony). Zakres: ostatnie 45 dni.
router.post('/ksef/autosync-sales', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  if (!ksef.isConfigured()) return res.json({ ok: false, configured: false });
  const KEY = 'autosync:ksef:salesStatus';
  const THROTTLE_MS = 10 * 60 * 1000;
  const cfg = await prisma.config.findUnique({ where: { key: KEY } }).catch(() => null);
  const ageMs = cfg ? Date.now() - new Date(cfg.value).getTime() : Infinity;
  if (ageMs < THROTTLE_MS) return res.json({ ok: true, throttled: true, ageMs });
  const nowIso = new Date().toISOString();
  await prisma.config.upsert({ where: { key: KEY }, update: { value: nowIso }, create: { key: KEY, value: nowIso } }).catch(() => {});
  try {
    const now = new Date();
    // Od 1. dnia poprzedniego miesiąca (z zapasem) — pokrywa cały bieżący miesiąc
    // i poprzedni, więc świeże faktury (np. od 1 czerwca) są łapane.
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const from = start.toISOString().slice(0, 10);
    const to = now.toISOString().slice(0, 10);
    const r = await runSalesStatusSync(prisma, { from, to, dateType: 'Issue' });
    res.json({ ok: true, throttled: false, matched: r.matched, found: r.found });
  } catch (e) {
    res.json({ ok: false, throttled: false, error: e.message });
  }
}));

// Rdzeń: pobiera faktury KOSZTOWE (Subject2) za zakres → upsert do bazy.
// Tylko metadane (bez XML) gdy withXml=false — szybkie i idempotentne.
async function runCostPull(prisma, { from, to, dateType = 'Issue', withXml = false, limit = 2000 }) {
  const buyerNip = String(process.env.KSEF_NIP || '');
  const { accessToken } = await ksef.authenticate();
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(new Date(to).getTime() + 24 * 3600 * 1000 - 1).toISOString();
  let metadata = await ksef.queryCostInvoiceMetadata(accessToken, { from: fromIso, to: toIso, dateType });
  metadata = metadata.slice(0, limit);
  let saved = 0; let xmlFetched = 0;
  for (const m of metadata) {
    const d = fromMetadata(m, buyerNip);
    if (!d.ksefNumber) continue;
    let xml = null;
    if (withXml) {
      try { xml = await ksef.getInvoiceXml(accessToken, d.ksefNumber); xmlFetched++; } catch { /* pomiń XML */ }
    }
    const data = {
      ksefNumber: d.ksefNumber,
      invoiceNumber: d.invoiceNumber || null,
      issueDate: d.issueDate ? new Date(d.issueDate) : null,
      sellerName: d.sellerName || null,
      sellerNip: d.sellerNip ? String(d.sellerNip) : null,
      buyerNip,
      netAmount: d.netAmount, vatAmount: d.vatAmount, grossAmount: d.grossAmount,
      currency: d.currency || 'PLN',
      raw: m, fetchedAt: new Date(),
      ...(withXml ? { xml } : {}),
    };
    try {
      await prisma.ksefCostInvoice.upsert({ where: { ksefNumber: d.ksefNumber }, update: data, create: data });
      saved++;
    } catch { /* pojedynczy błąd nie psuje całości */ }
  }
  return { found: metadata.length, saved, xmlFetched };
}

// Auto-pull faktur kosztowych — wołany w tle (np. z Dashboardu). Throttle 6h,
// zawsze 200. Zakres: od początku bieżącego roku do dziś (metadane, bez XML).
router.post('/ksef/autosync-costs', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  if (!ksef.isConfigured()) return res.json({ ok: false, configured: false });
  const KEY = 'autosync:ksef:costs';
  const THROTTLE_MS = 6 * 60 * 60 * 1000;
  const cfg = await prisma.config.findUnique({ where: { key: KEY } }).catch(() => null);
  const ageMs = cfg ? Date.now() - new Date(cfg.value).getTime() : Infinity;
  if (ageMs < THROTTLE_MS) return res.json({ ok: true, throttled: true, ageMs });
  const nowIso = new Date().toISOString();
  await prisma.config.upsert({ where: { key: KEY }, update: { value: nowIso }, create: { key: KEY, value: nowIso } }).catch(() => {});
  // Odpowiadamy od razu — pobranie z KSeF (auth + query) leci w tle, żeby nie
  // blokować renderu Dashboardu. Koszty pojawią się przy następnym wejściu.
  res.json({ ok: true, throttled: false, started: true });
  const now = new Date();
  const from = `${now.getFullYear()}-01-01`;
  const to = now.toISOString().slice(0, 10);
  runCostPull(prisma, { from, to, dateType: 'Issue', withXml: false })
    .then(r => console.log('[ksef/autosync-costs] done:', JSON.stringify(r)))
    .catch(e => console.error('[ksef/autosync-costs] error:', e.message));
}));

// Lista pobranych faktur kosztowych (dla CRM).
router.get('/ksef/cost-invoices', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { search, from, to, limit } = req.query;
  const where = {};
  if (search) where.OR = [
    { sellerName: { contains: search, mode: 'insensitive' } },
    { sellerNip: { contains: search } },
    { invoiceNumber: { contains: search, mode: 'insensitive' } },
  ];
  if (from || to) {
    where.issueDate = {};
    if (from) where.issueDate.gte = new Date(from);
    if (to) where.issueDate.lte = new Date(to);
  }
  const take = Math.min(parseInt(limit, 10) || 200, 5000);
  const list = await prisma.ksefCostInvoice.findMany({
    where, orderBy: { issueDate: 'desc' }, take,
    select: { id: true, ksefNumber: true, invoiceNumber: true, issueDate: true, sellerName: true, sellerNip: true, netAmount: true, vatAmount: true, grossAmount: true, currency: true, fetchedAt: true },
  });
  res.json({ count: list.length, data: list });
}));

module.exports = router;
