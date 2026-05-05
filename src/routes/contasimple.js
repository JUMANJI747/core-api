'use strict';

const router = require('express').Router();
const crypto = require('crypto');
const prisma = require('../db');
const asyncHandler = require('../asyncHandler');
const cs = require('../contasimple-client');
const {
  saveEsPreview,
  getEsPreview,
  deleteEsPreview,
  getLatestEsPreview,
  saveEsDeletePreview,
  getEsDeletePreview,
  deleteEsDeletePreview,
  getLatestEsDeletePreview,
} = require('../es-stores');
const {
  findEsContractor,
  expandEsLines,
  buildEsTotals,
  buildContasimplePayload,
  IGIC_DEFAULT_PCT,
  NIKODEM_DEFAULTS,
} = require('../services/contasimple-helpers');
const { sendTelegram, sendTelegramDocument } = require('../telegram-utils');

// Bot Telegrama dla firmy kanaryjskiej (osobny od bota PL). Kolejność:
// 1. env TELEGRAM_BOT_TOKEN_ES (preferowane — single source of truth na Railway)
// 2. Config key 'telegram_bot_token_es' (gdy chcesz override z UI)
// 3. fallback Config 'telegram_bot_token' (token bota PL — jednobotowy setup, kompatybilność wsteczna)
async function getEsTelegramToken(prismaClient) {
  if (process.env.TELEGRAM_BOT_TOKEN_ES && process.env.TELEGRAM_BOT_TOKEN_ES.trim()) {
    return process.env.TELEGRAM_BOT_TOKEN_ES.trim();
  }
  const esCfg = await prismaClient.config.findUnique({ where: { key: 'telegram_bot_token_es' } });
  if (esCfg && esCfg.value) return esCfg.value;
  const plCfg = await prismaClient.config.findUnique({ where: { key: 'telegram_bot_token' } });
  return plCfg && plCfg.value;
}

// ============ SMOKE TEST ============
//
// After deploy, run:
//   curl https://<host>/api/contasimple/_test -H "x-api-key: <KEY>"
// Verifies that CONTASIMPLE_API_KEY is set, OAuth token exchange works, and
// /me/companies returns the expected current-company data (country,
// fiscalRegion, currency).
router.get('/_test', asyncHandler(async (req, res) => {
  if (!cs.isConfigured()) {
    return res.status(503).json({ ok: false, error: 'CONTASIMPLE_API_KEY not configured' });
  }
  try {
    const companies = await cs.getMyCompanies();
    res.json({ ok: true, companies });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, status: e.status, body: e.body });
  }
}));

// ============ CUSTOMERS ============

router.get('/customers/search-nif', asyncHandler(async (req, res) => {
  const { nif, exactMatch } = req.query;
  if (!nif) return res.status(400).json({ error: 'nif required' });
  const result = await cs.searchCustomerByNif(nif, exactMatch !== 'false');
  res.json(result);
}));

router.get('/customers/search', asyncHandler(async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'query required' });
  const result = await cs.searchCustomers(query);
  res.json(result);
}));

router.get('/customers', asyncHandler(async (req, res) => {
  const { startIndex, numRows, organization, nif, email } = req.query;
  const result = await cs.listCustomers({
    startIndex: startIndex ? Number(startIndex) : undefined,
    numRows: numRows ? Number(numRows) : undefined,
    organization,
    nif,
    email,
  });
  res.json(result);
}));

router.get('/customers/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'numeric id required' });
  const result = await cs.getCustomer(id);
  res.json(result);
}));

router.post('/customers', asyncHandler(async (req, res) => {
  const data = req.body || {};
  if (!data.nif) {
    return res.status(400).json({ error: 'nif (CIF) required — Nikodem invoices only B2B' });
  }
  if (!data.organization && !(data.firstname || data.lastname)) {
    return res.status(400).json({ error: 'organization or firstname/lastname required' });
  }
  const result = await cs.createCustomer(data);
  res.json(result);
}));

// Bulk import: pull every customer from Contasimple, upsert into EsContractor.
// Idempotent — run anytime. Maps Contasimple `id` to local `contasimpleId`
// (unique key) so re-runs update existing rows instead of duplicating.
router.post('/sync-customers', asyncHandler(async (req, res) => {
  if (!cs.isConfigured()) {
    return res.status(503).json({ ok: false, error: 'CONTASIMPLE_API_KEY not configured' });
  }
  const remote = await cs.listAllCustomers();
  const list = (remote && remote.data) || [];

  let created = 0;
  let updated = 0;
  for (const c of list) {
    const name =
      c.organization ||
      [c.firstname, c.lastname].filter(Boolean).join(' ').trim() ||
      c.name ||
      `Customer ${c.id}`;

    const data = {
      contasimpleId: c.id,
      type: c.type || 'Issuer',
      organization: c.organization || null,
      firstname: c.firstname || null,
      lastname: c.lastname || null,
      name,
      nif: c.nif || null,
      email: c.email || null,
      phone: c.phone || null,
      mobile: c.mobile || null,
      address: c.address || null,
      city: c.city || null,
      province: c.province || null,
      country: c.country || null,
      countryId: c.countryId || null,
      postalCode: c.postalCode || null,
      documentCulture: c.documentCulture || null,
      notes: c.notes || null,
      extras: {
        customField1: c.customField1 || null,
        customField2: c.customField2 || null,
        latitude: c.latitude || 0,
        longitude: c.longitude || 0,
        discountPercentage: c.discountPercentage || 0,
        url: c.url || null,
        bankAccounts: c.bankAccounts || [],
      },
    };

    const existing = await prisma.esContractor.findUnique({
      where: { contasimpleId: c.id },
    });
    if (existing) {
      await prisma.esContractor.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.esContractor.create({ data });
      created++;
    }
  }

  res.json({ ok: true, total: list.length, created, updated });
}));

router.get('/contractors', asyncHandler(async (req, res) => {
  const { search } = req.query;
  const where = search
    ? {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { organization: { contains: search, mode: 'insensitive' } },
          { nif: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      }
    : {};
  const list = await prisma.esContractor.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: 200,
  });
  res.json({ count: list.length, data: list });
}));

// ============ INVOICES ============

router.get('/invoices', asyncHandler(async (req, res) => {
  const period =
    req.query.period || cs.dateToPeriod(new Date());
  const filters = {
    startIndex: req.query.startIndex ? Number(req.query.startIndex) : undefined,
    numRows: req.query.numRows ? Number(req.query.numRows) : undefined,
    number: req.query.number,
    nif: req.query.nif,
    status: req.query.status,
    fromDate: req.query.fromDate,
    toDate: req.query.toDate,
    customerOrganizationName: req.query.customerOrganizationName,
    sort: req.query.sort,
  };
  const result = await cs.listInvoices(period, filters);
  res.json({ period, ...result });
}));

router.get('/invoices/search-number', asyncHandler(async (req, res) => {
  const { period, query } = req.query;
  if (!query) return res.status(400).json({ error: 'query required' });
  const p = period || cs.dateToPeriod(new Date());
  const result = await cs.searchInvoiceByNumber(p, query);
  res.json({ period: p, ...result });
}));

router.get('/invoices/:id', asyncHandler(async (req, res) => {
  const period = req.query.period;
  if (!period) return res.status(400).json({ error: 'period query param required (e.g. 2026-2T)' });
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'numeric id required' });
  const result = await cs.getInvoice(period, id);
  res.json(result);
}));

router.get('/invoices/:id/pdf', asyncHandler(async (req, res) => {
  const period = req.query.period;
  if (!period) return res.status(400).json({ error: 'period query param required (e.g. 2026-2T)' });
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'numeric id required' });
  const { buffer, contentType } = await cs.fetchInvoicePdf(period, id);
  res.set('Content-Type', contentType);
  res.set('Content-Disposition', `inline; filename="invoice-${id}.pdf"`);
  res.send(buffer);
}));

router.post('/invoices/:id/send', asyncHandler(async (req, res) => {
  const period = req.query.period;
  if (!period) return res.status(400).json({ error: 'period query param required (e.g. 2026-2T)' });
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'numeric id required' });
  const { to, replyTo, blindCopy, subject, body } = req.body || {};
  if (!to) return res.status(400).json({ error: 'to (email) required' });
  const result = await cs.sendInvoiceEmail(period, id, { to, replyTo, blindCopy, subject, body });
  res.json(result);
}));

// Create an issued invoice. Body shape:
//   { customerCif?, customerId?, lines: [{concept, quantity, unitAmount, vatPercentage?}],
//     date?, expirationDate?, numberingFormatId?, notes?, footer?, uiCulture? }
//
// Resolves the customer either by Contasimple `customerId` (preferred when
// known) or by `customerCif` — in the latter case we look it up via Contasimple
// search/nif. Always fails if no CIF/customerId match found — Nikodem invoices
// only B2B.
router.post('/invoices', asyncHandler(async (req, res) => {
  const body = req.body || {};
  let targetEntityId = body.customerId || body.targetEntityId;

  if (!targetEntityId && body.customerCif) {
    const search = await cs.searchCustomerByNif(body.customerCif, true);
    const matches = (search && search.data) || [];
    if (matches.length === 0) {
      return res.status(404).json({
        error: 'customer not found by CIF in Contasimple',
        cif: body.customerCif,
        hint: 'Create the customer first via POST /api/contasimple/customers',
      });
    }
    if (matches.length > 1) {
      return res.status(409).json({
        error: 'multiple customers match this CIF — disambiguate by customerId',
        candidates: matches.map(m => ({ id: m.id, organization: m.organization, nif: m.nif })),
      });
    }
    targetEntityId = matches[0].id;
  }

  if (!targetEntityId) {
    return res.status(400).json({
      error: 'customerId or customerCif required (Nikodem invoices only B2B with CIF)',
    });
  }

  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return res.status(400).json({ error: 'lines[] required and non-empty' });
  }

  const date = body.date || new Date().toISOString();
  const period = body.period || cs.dateToPeriod(date);

  const result = await cs.createInvoice(period, {
    targetEntityId,
    lines: body.lines,
    date,
    expirationDate: body.expirationDate,
    numberingFormatId: body.numberingFormatId,
    notes: body.notes,
    footer: body.footer,
    uiCulture: body.uiCulture,
    operationType: body.operationType,
  });

  // Cache a thin record locally for fast listings + future GS sync.
  // Best-effort — don't fail the request if local persistence fails.
  try {
    if (result && result.data) {
      const inv = result.data;
      const local = await prisma.esContractor.findUnique({
        where: { contasimpleId: targetEntityId },
      });
      await prisma.esInvoice.create({
        data: {
          contasimpleId: inv.id,
          contractorId: local ? local.id : null,
          period,
          number: inv.number || null,
          status: inv.status || 'Pending',
          invoiceDate: new Date(inv.invoiceDate || date),
          expirationDate: inv.expirationDate ? new Date(inv.expirationDate) : null,
          totalAmount: inv.totalAmount || 0,
          totalTaxableAmount: inv.totalTaxableAmount || 0,
          totalVatAmount: inv.totalVatAmount || 0,
          totalPayedAmount: inv.totalPayedAmount || 0,
          uiCulture: inv.uiCulture || null,
          numberingFormatId: inv.numberingFormatId || null,
          operationType: inv.operationType || null,
          extras: { lines: inv.lines || [], payments: inv.payments || [] },
        },
      });
    }
  } catch (persistErr) {
    console.error('[contasimple] local invoice persist failed:', persistErr.message);
  }

  res.json({ ok: true, period, invoice: result && result.data });
}));

router.delete('/invoices/:id', asyncHandler(async (req, res) => {
  const period = req.query.period;
  if (!period) return res.status(400).json({ error: 'period query param required (e.g. 2026-2T)' });
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'numeric id required' });
  const result = await cs.deleteInvoice(period, id);
  // Mirror the deletion locally if we have a record for it
  try {
    await prisma.esInvoice.deleteMany({ where: { contasimpleId: id } });
  } catch (e) {
    console.error('[contasimple] local invoice delete mirror failed:', e.message);
  }
  res.json(result);
}));

// ============ PRODUCTS (local catalog mirror) ============

router.post('/sync-products', asyncHandler(async (req, res) => {
  if (!cs.isConfigured()) {
    return res.status(503).json({ ok: false, error: 'CONTASIMPLE_API_KEY not configured' });
  }

  // Paginate /products (max 300/page per Contasimple limit). /products/all
  // is not available for this resource (only for entities/customers).
  const PAGE_SIZE = 300;
  const list = [];
  let startIndex = 0;
  while (true) {
    const page = await cs.listProducts({ startIndex, numRows: PAGE_SIZE });
    const chunk = (page && page.data) || [];
    list.push(...chunk);
    if (chunk.length < PAGE_SIZE) break;
    startIndex += PAGE_SIZE;
    if (startIndex > 5000) break; // safety stop, Nikodem has ~6 products
  }

  let created = 0;
  let updated = 0;
  for (const p of list) {
    const data = {
      contasimpleId: p.id,
      name: p.name || `Product ${p.id}`,
      category: 'product',
      variant: p.variant || null,
      priceEUR: p.unitTaxableAmount || p.unitAmount || p.price || 0,
      unit: p.unit || 'szt',
      active: p.active !== false,
      extras: { sku: p.sku || null, raw: p },
    };
    const existing = await prisma.esProduct.findUnique({ where: { contasimpleId: p.id } });
    if (existing) {
      await prisma.esProduct.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.esProduct.create({ data });
      created++;
    }
  }
  res.json({ ok: true, total: list.length, created, updated });
}));

router.get('/products', asyncHandler(async (req, res) => {
  const list = await prisma.esProduct.findMany({
    where: { active: true },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  });
  res.json({ count: list.length, data: list });
}));

// One-shot bootstrap: ensures the three template "boxes" exist (BOX-STICK-ES,
// BOX-COLLECTION-ES, BOX-MASCARA-ES) with the right composition. Idempotent —
// safe to call repeatedly. Uses contasimpleId from the existing products table
// (must run AFTER /sync-products at least once).
router.post('/seed-boxes', asyncHandler(async (req, res) => {
  // Resolve Nikodem's product IDs from the local mirror by short, distinctive
  // name fragments. Tolerant to naming variations ("SURF MASCARA", "MASCARA
  // BELL SPF 30", etc.) — only the keyword needs to match.
  const findIdByFragment = async (fragment) => {
    const p = await prisma.esProduct.findFirst({
      where: { name: { contains: fragment, mode: 'insensitive' }, category: 'product' },
    });
    return p ? { id: p.contasimpleId, name: p.name } : null;
  };

  const stick = await findIdByFragment('STICK');
  const lip = await findIdByFragment('LIP');
  const daily = await findIdByFragment('DAILY');
  const care = await findIdByFragment('CARE');
  const gel = await findIdByFragment('GEL'); // post-rename name "SURF GEL extreme waterproof gel spf 50+" — "EXTREME GEL" no longer adjacent
  const mascara = await findIdByFragment('MASCARA');

  const missing = [];
  for (const [k, v] of Object.entries({ stick, lip, daily, care, gel, mascara })) {
    if (!v) missing.push(k);
  }

  const boxes = [
    {
      ean: 'BOX-STICK-ES',
      name: 'BOX SURF STICK',
      composition: [{ name: stick && stick.name, contasimpleId: stick && stick.id, qty: 30 }],
    },
    {
      ean: 'BOX-COLLECTION-ES',
      name: 'BOX COLLECTION',
      composition: [
        { name: lip && lip.name, contasimpleId: lip && lip.id, qty: 12 },
        { name: daily && daily.name, contasimpleId: daily && daily.id, qty: 6 },
        { name: gel && gel.name, contasimpleId: gel && gel.id, qty: 6 },
        { name: care && care.name, contasimpleId: care && care.id, qty: 6 },
      ],
    },
    {
      ean: 'BOX-MASCARA-ES',
      name: 'BOX SURF MASCARA',
      composition: [{ name: mascara && mascara.name, contasimpleId: mascara && mascara.id, qty: 30 }],
    },
  ];

  const results = [];
  for (const b of boxes) {
    const totalQty = b.composition.reduce((s, c) => s + c.qty, 0);
    const data = {
      ean: b.ean,
      name: b.name,
      category: 'template',
      priceEUR: 0,
      active: true,
      extras: { isTemplate: true, composition: b.composition, totalQty },
    };
    const existing = await prisma.esProduct.findUnique({ where: { ean: b.ean } });
    if (existing) {
      await prisma.esProduct.update({ where: { id: existing.id }, data });
      results.push({ ean: b.ean, action: 'updated', totalQty, composition: b.composition });
    } else {
      await prisma.esProduct.create({ data });
      results.push({ ean: b.ean, action: 'created', totalQty, composition: b.composition });
    }
  }
  res.json({ ok: true, boxes: results, missingProducts: missing });
}));

// ============ PRODUCT RENAME (sync names from PL catalog) ============
//
// For each EsProduct (synced from Contasimple), find the matching PL Product
// by a deterministic name fragment, take its `name`, and PUT it on
// Contasimple. Idempotent. Run with ?dryRun=true first to preview the plan.
//
// Mapping (most-specific-first to avoid "GEL" matching "EXTREME GEL" rows):
//   EXTREME GEL → PL ean 5902082579021  ("SURF GEL extreme waterproof gel spf 50+")
//   LIP BALM    → PL ean 5902082579052  ("SURF LIPS lip balm spf 50+")
//   LIP         → PL ean 5902082579052
//   MASCARA     → PL ean MASCARA-GENERIC ("SURF GIRL waterproof mascara")
//   DAILY       → PL ean 5902082579045  ("SURF DAILY protection spf 50")
//   CARE        → PL ean 5902082579014  ("SURF CARE hydrating cream")
//   STICK       → PL ean STICK-GENERIC  ("SURF STICK zinc stick spf 50+")
//
// After running this, re-run /seed-boxes to refresh composition.name labels.

// Order matters: most-specific-first. "LIP BALM" before "LIP" so "SURF LIPS"
// doesn't accidentally trigger LIP-BALM logic. "GEL" is short but unique in
// Nikodem's catalog (only one gel product exists, post-rename or pre-rename).
const PL_NAME_MAP = [
  ['LIP BALM', '5902082579052'],
  ['LIP', '5902082579052'],
  ['MASCARA', 'MASCARA-GENERIC'],
  ['DAILY', '5902082579045'],
  ['CARE', '5902082579014'],
  ['GEL', '5902082579021'],
  ['STICK', 'STICK-GENERIC'],
];

router.post('/products/rename-from-pl', asyncHandler(async (req, res) => {
  const dryRun = req.query.dryRun === 'true';

  const esProducts = await prisma.esProduct.findMany({
    where: { category: 'product', contasimpleId: { not: null } },
  });

  const plan = [];
  for (const es of esProducts) {
    const upper = (es.name || '').toUpperCase();
    let matched = null;
    for (const [fragment, plEan] of PL_NAME_MAP) {
      if (upper.includes(fragment)) {
        matched = { fragment, plEan };
        break;
      }
    }

    if (!matched) {
      plan.push({
        contasimpleId: es.contasimpleId,
        oldName: es.name,
        newName: null,
        action: 'skip',
        reason: 'no PL fragment match',
      });
      continue;
    }

    const plProduct = await prisma.product.findUnique({ where: { ean: matched.plEan } });
    if (!plProduct) {
      plan.push({
        contasimpleId: es.contasimpleId,
        oldName: es.name,
        newName: null,
        action: 'skip',
        reason: `PL product not found by ean=${matched.plEan}`,
        matchedFragment: matched.fragment,
      });
      continue;
    }

    if (plProduct.name === es.name) {
      plan.push({
        contasimpleId: es.contasimpleId,
        oldName: es.name,
        newName: plProduct.name,
        action: 'noop',
        matchedFragment: matched.fragment,
        plEan: matched.plEan,
      });
      continue;
    }

    plan.push({
      contasimpleId: es.contasimpleId,
      oldName: es.name,
      newName: plProduct.name,
      action: 'rename',
      matchedFragment: matched.fragment,
      plEan: matched.plEan,
    });
  }

  if (dryRun) {
    return res.json({ ok: true, dryRun: true, plan });
  }

  // Apply: for each rename, fetch full Contasimple product, PUT with new
  // name (preserving every other field), mirror locally.
  const results = [];
  for (const item of plan) {
    if (item.action !== 'rename') {
      results.push(item);
      continue;
    }
    try {
      const remote = await cs.getProduct(item.contasimpleId);
      const remoteData = remote && remote.data ? remote.data : remote;

      const updateBody = { ...remoteData, name: item.newName };
      await cs.updateProduct(item.contasimpleId, updateBody);

      const local = await prisma.esProduct.findUnique({ where: { contasimpleId: item.contasimpleId } });
      if (local) {
        const prev = (local.extras && local.extras.previousNames) || [];
        await prisma.esProduct.update({
          where: { id: local.id },
          data: {
            name: item.newName,
            extras: { ...(local.extras || {}), previousNames: [...prev, item.oldName] },
          },
        });
      }

      results.push({ ...item, status: 'success' });
    } catch (e) {
      results.push({ ...item, status: 'failed', error: e.message, statusCode: e.status });
    }
  }

  res.json({ ok: true, dryRun: false, results });
}));

// ============ CUSTOMER VERIFY-CIF ============
//
// Resolves a CIF/NIF to canonical customer data. Tries (in order): local
// EsContractor, Contasimple search/nif. External AEAT/VIES integrations
// (Contasimple "Integrations - Entities fiscal data" / "Integrations - Vies")
// will be added in a follow-up once we map their request/response shapes.
router.post('/customer-verify-cif', asyncHandler(async (req, res) => {
  const { cif } = req.body || {};
  if (!cif) return res.status(400).json({ error: 'cif required' });

  const local = await prisma.esContractor.findFirst({ where: { nif: cif } });

  let remote = null;
  try {
    const r = await cs.searchCustomerByNif(cif, true);
    if (r && r.data && r.data.length === 1) remote = r.data[0];
  } catch (e) {
    console.error('[contasimple] verify-cif Contasimple lookup failed:', e.message);
  }

  res.json({
    ok: true,
    cif,
    foundIn: { local: Boolean(local), contasimple: Boolean(remote) },
    local,
    contasimple: remote,
  });
}));

// ============ INVOICE PREVIEW ============
//
// Body: {
//   contractorId? | contractorCif? | contractorSearch?,   // pick one
//   items: [ { name? | ean?, qty, priceNetto?, priceBrutto? }, ... ],
//   globalPriceNetto? | globalPriceBrutto?,
//   invoiceDate?, expirationDate?
// }
//
// Returns: { ok: true, preview, previewId } or { ok: false, suggestions[] }
router.post('/invoice-preview', asyncHandler(async (req, res) => {
  const body = req.body || {};
  let parsedItems = body.items;
  if (typeof parsedItems === 'string') {
    try { parsedItems = JSON.parse(parsedItems); }
    catch (e) { return res.status(400).json({ error: 'items must be valid JSON array' }); }
  }
  if (!parsedItems || !parsedItems.length) {
    return res.status(400).json({ error: 'items required' });
  }

  // Resolve contractor: id > cif > fuzzy search.
  let contractor = null;
  if (body.contractorId) {
    contractor = await prisma.esContractor.findUnique({ where: { id: body.contractorId } });
  } else if (body.contractorCif) {
    contractor = await prisma.esContractor.findFirst({ where: { nif: body.contractorCif } });
  } else if (body.contractorSearch) {
    const result = await findEsContractor(prisma, body.contractorSearch);
    if (!result.contractor) {
      return res.json({ ok: false, suggestions: result.suggestions, hint: 'Add the customer first via POST /api/contasimple/customers' });
    }
    contractor = result.contractor;
  }
  if (!contractor) {
    return res.status(404).json({ error: 'contractor not found — provide contractorId, contractorCif, or contractorSearch' });
  }
  if (!contractor.nif) {
    return res.status(400).json({ error: 'contractor missing CIF/NIF — Nikodem invoices only B2B' });
  }
  if (!contractor.contasimpleId) {
    return res.status(400).json({ error: 'contractor exists locally but has no contasimpleId — re-run /sync-customers or create in Contasimple first' });
  }

  // Expand items into positions (resolving templates / fuzzy product lookup).
  let positions;
  try {
    positions = await expandEsLines(prisma, parsedItems, {
      globalPriceNetto: body.globalPriceNetto,
      globalPriceBrutto: body.globalPriceBrutto,
    });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }

  if (!positions.length) {
    return res.status(400).json({ error: 'no positions resolved from items' });
  }

  const { lines, totals, priceMode } = buildEsTotals(positions, {
    igicPct: IGIC_DEFAULT_PCT,
    globalPriceNetto: body.globalPriceNetto,
    globalPriceBrutto: body.globalPriceBrutto,
  });

  const invoiceDate = body.invoiceDate || new Date().toISOString();

  const preview = {
    contractor: {
      id: contractor.id,
      contasimpleId: contractor.contasimpleId,
      name: contractor.name,
      organization: contractor.organization,
      nif: contractor.nif,
      country: contractor.country,
      city: contractor.city,
      postalCode: contractor.postalCode,
      address: contractor.address,
      email: contractor.email,
    },
    currency: 'EUR',
    igicPct: IGIC_DEFAULT_PCT,
    priceMode,
    lines,
    totals,
    invoiceDate,
    period: cs.dateToPeriod(invoiceDate),
  };

  const previewId = crypto.randomUUID();
  saveEsPreview(previewId, { preview, contractor, lines, invoiceDate, body, chatId: body.chatId || null });

  prisma.agentContext
    .upsert({
      where: { id: 'ksiegowosc-es' },
      update: {
        data: {
          lastAction: 'preview',
          previewId,
          contractor: { name: contractor.name, nif: contractor.nif },
          totals,
          period: preview.period,
          timestamp: Date.now(),
        },
      },
      create: {
        id: 'ksiegowosc-es',
        data: {
          lastAction: 'preview',
          previewId,
          contractor: { name: contractor.name, nif: contractor.nif },
          totals,
          period: preview.period,
          timestamp: Date.now(),
        },
      },
    })
    .catch(e => console.error('[cs invoice-preview] AgentContext save error:', e.message));

  res.json({ ok: true, preview, previewId });
}));

// ============ INVOICE CONFIRM ============

async function confirmEsPreview(stored) {
  const { preview, contractor, lines, invoiceDate, chatId: storedChatId } = stored;
  const period = preview.period;

  // Optional footer override from Config (lets Nikodem change IBAN without
  // a deploy by setting Config key `contasimple_invoice_footer`).
  let footerOverride = null;
  try {
    const cfg = await prisma.config.findUnique({ where: { key: 'contasimple_invoice_footer' } });
    if (cfg && cfg.value) footerOverride = cfg.value;
  } catch (_) {}

  // Contasimple requires `number` in POST body — UI auto-generates it but
  // the API does not, so we fetch the next available one from the configured
  // series first.
  let nextNumber = '';
  try {
    const r = await cs.getNextInvoiceNumber(period, NIKODEM_DEFAULTS.numberingFormatId);
    nextNumber = (r && r.data) || '';
  } catch (e) {
    console.error('[cs invoice-confirm] getNextInvoiceNumber failed:', e.message);
  }
  if (!nextNumber) {
    throw new Error('Failed to fetch next invoice number from Contasimple');
  }

  const csPayload = buildContasimplePayload({
    targetEntityId: contractor.contasimpleId,
    lines,
    invoiceDate,
    overrides: {
      number: nextNumber,
      ...(footerOverride != null ? { footer: footerOverride } : {}),
    },
  });
  console.log('[cs invoice-confirm] payload:', JSON.stringify(csPayload));

  let csResult;
  try {
    csResult = await cs.createInvoice(period, csPayload);
  } catch (e) {
    e.attemptedPayload = csPayload;
    throw e;
  }
  const invoice = csResult && csResult.data;
  if (!invoice || !invoice.id) {
    throw new Error('Contasimple createInvoice returned no data');
  }

  // Mirror locally — best-effort.
  let localInvoice = null;
  try {
    localInvoice = await prisma.esInvoice.create({
      data: {
        contasimpleId: invoice.id,
        contractorId: contractor.id,
        period,
        number: invoice.number || null,
        status: invoice.status || 'Pending',
        invoiceDate: new Date(invoice.invoiceDate || invoiceDate),
        expirationDate: invoice.expirationDate ? new Date(invoice.expirationDate) : null,
        totalAmount: invoice.totalAmount || preview.totals.brutto,
        totalTaxableAmount: invoice.totalTaxableAmount || preview.totals.netto,
        totalVatAmount: invoice.totalVatAmount || preview.totals.igic,
        totalPayedAmount: invoice.totalPayedAmount || 0,
        uiCulture: invoice.uiCulture || 'es-ES',
        numberingFormatId: invoice.numberingFormatId || null,
        operationType: invoice.operationType || null,
        extras: { lines: invoice.lines || [], payments: invoice.payments || [], previewLines: lines },
      },
    });
  } catch (e) {
    console.error('[cs invoice-confirm] local persist failed:', e.message);
  }

  // PDF → Telegram (best-effort, but report truthfully whether it actually
  // landed). Telegram API returns 200 with {ok:false, description:"..."} for
  // recoverable failures (chat not found, bot blocked, file too big), so we
  // must inspect the response body rather than trust the await resolving.
  let pdfSent = false;
  let pdfError = null;
  try {
    const tgChatCfg = storedChatId
      ? { value: String(storedChatId) }
      : await prisma.config.findUnique({ where: { key: 'telegram_chat_id_es' } })
        || await prisma.config.findUnique({ where: { key: 'telegram_chat_id' } });
    const tgToken = await getEsTelegramToken(prisma);
    const tgChat = tgChatCfg && tgChatCfg.value;
    if (!tgToken) pdfError = 'telegram bot token (ES/PL) missing — set TELEGRAM_BOT_TOKEN_ES';
    else if (!tgChat) pdfError = 'telegram_chat_id_es and telegram_chat_id both missing in Config';
    else {
      const { buffer } = await cs.fetchInvoicePdf(period, invoice.id);
      const filename = `factura_${(invoice.number || invoice.id).toString().replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`;
      const caption = `Factura ${invoice.number || invoice.id} — ${contractor.name} (${preview.totals.brutto} €)`;
      const tgResp = await sendTelegramDocument(tgToken, tgChat, buffer, filename, caption);
      if (tgResp && tgResp.ok) {
        pdfSent = true;
      } else {
        pdfError = `telegram api: ${(tgResp && tgResp.description) || 'unknown'} (chat=${tgChat})`;
        console.error('[cs invoice-confirm] Telegram returned not-ok:', JSON.stringify(tgResp));
      }
    }
  } catch (tgErr) {
    pdfError = tgErr.message;
    console.error('[cs invoice-confirm] Telegram PDF send threw:', tgErr.message);
  }

  prisma.agentContext
    .upsert({
      where: { id: 'ksiegowosc-es' },
      update: {
        data: {
          lastAction: 'confirmed',
          invoiceContasimpleId: invoice.id,
          invoiceNumber: invoice.number || null,
          invoiceLocalId: localInvoice ? localInvoice.id : null,
          contractor: { name: contractor.name, nif: contractor.nif },
          period,
          totals: preview.totals,
          timestamp: Date.now(),
        },
      },
      create: {
        id: 'ksiegowosc-es',
        data: {
          lastAction: 'confirmed',
          invoiceContasimpleId: invoice.id,
          invoiceNumber: invoice.number || null,
          invoiceLocalId: localInvoice ? localInvoice.id : null,
          contractor: { name: contractor.name, nif: contractor.nif },
          period,
          totals: preview.totals,
          timestamp: Date.now(),
        },
      },
    })
    .catch(e => console.error('[cs invoice-confirm] AgentContext save error:', e.message));

  return { invoice, localInvoice, pdfSent, pdfError, period };
}

router.post('/invoice-confirm-latest', asyncHandler(async (req, res) => {
  const latest = getLatestEsPreview();
  if (!latest) return res.status(404).json({ error: 'Brak aktywnego podglądu ES. Utwórz nowy.' });
  try {
    const result = await confirmEsPreview(latest.data);
    deleteEsPreview(latest.id);
    res.json({
      ok: true,
      invoiceNumber: result.invoice.number,
      invoiceId: result.invoice.id,
      period: result.period,
      pdfSent: result.pdfSent,
      pdfError: result.pdfError,
      contasimpleResponse: result.invoice,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, status: e.status, body: e.body, attemptedPayload: e.attemptedPayload });
  }
}));

router.post('/invoice-confirm', asyncHandler(async (req, res) => {
  const { previewId } = req.body || {};
  if (!previewId) return res.status(400).json({ error: 'previewId required' });
  const stored = getEsPreview(previewId);
  if (!stored) return res.status(404).json({ error: 'preview not found or expired' });
  try {
    const result = await confirmEsPreview(stored);
    deleteEsPreview(previewId);
    res.json({
      ok: true,
      invoiceNumber: result.invoice.number,
      invoiceId: result.invoice.id,
      period: result.period,
      pdfSent: result.pdfSent,
      pdfError: result.pdfError,
      contasimpleResponse: result.invoice,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, status: e.status, body: e.body, attemptedPayload: e.attemptedPayload });
  }
}));

// ============ DELETE PREVIEW / CONFIRM ============
//
// Two-step delete flow (mirrors invoice-preview/confirm):
//   1. POST /delete-preview  — search invoices matching filter, return list,
//                              cache it under previewId. Nothing deleted.
//   2. POST /delete-confirm-latest  — actually fire DELETE per invoice from
//                              the most-recent preview, return raw
//                              Contasimple responses so the agent can quote
//                              them verbatim instead of hallucinating.
//
// Body for delete-preview:
//   { contractorSearch? | contractorCif? | contractorId?,
//     number?, fromDate?, toDate?, period? }
// Date format follows Contasimple convention: dd/MM/yyyy HH:mm:ss.

router.post('/delete-preview', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const period = body.period || cs.dateToPeriod(new Date());

  let contractorInfo = null;
  let nifFilter = null;
  if (body.contractorCif) {
    nifFilter = body.contractorCif;
    contractorInfo = await prisma.esContractor.findFirst({ where: { nif: body.contractorCif } });
  } else if (body.contractorId) {
    contractorInfo = await prisma.esContractor.findUnique({ where: { id: body.contractorId } });
    if (contractorInfo) nifFilter = contractorInfo.nif;
  } else if (body.contractorSearch) {
    const r = await findEsContractor(prisma, body.contractorSearch);
    if (!r.contractor) {
      return res.json({ ok: false, error: 'contractor not found', suggestions: r.suggestions });
    }
    contractorInfo = r.contractor;
    nifFilter = r.contractor.nif;
  }

  const filters = {
    numRows: 300,
    number: body.number,
    nif: nifFilter,
    fromDate: body.fromDate,
    toDate: body.toDate,
    sort: '-date', // newest first server-side
  };
  const remote = await cs.listInvoices(period, filters);
  let found = (remote && remote.data) || [];

  // Defensive: sort newest-first locally too in case Contasimple ignores `sort`.
  found.sort((a, b) => new Date(b.invoiceDate) - new Date(a.invoiceDate));

  // "latest: true" → only newest one. "limit: N" → N newest. Without either,
  // returns everything matching the filter.
  const totalMatched = found.length;
  let limit = null;
  if (body.latest === true) limit = 1;
  else if (typeof body.limit === 'number' && body.limit > 0) limit = body.limit;
  if (limit !== null && found.length > limit) {
    found = found.slice(0, limit);
  }

  if (!found.length) {
    return res.json({
      ok: false,
      period,
      filters,
      contractor: contractorInfo ? { name: contractorInfo.name, nif: contractorInfo.nif } : null,
      error: 'no invoices match filter',
    });
  }

  const summary = found.map(inv => ({
    id: inv.id,
    number: inv.number,
    invoiceDate: inv.invoiceDate,
    customerName: inv.target && inv.target.organization,
    customerNif: inv.target && inv.target.nif,
    totalAmount: inv.totalAmount,
    status: inv.status,
  }));

  const previewId = crypto.randomUUID();
  saveEsDeletePreview(previewId, { period, invoices: found, summary, contractor: contractorInfo, chatId: body.chatId || null });

  prisma.agentContext
    .upsert({
      where: { id: 'ksiegowosc-es' },
      update: {
        data: {
          lastAction: 'delete-preview',
          deletePreviewId: previewId,
          period,
          count: found.length,
          totalMatched,
          contractor: contractorInfo ? { name: contractorInfo.name, nif: contractorInfo.nif } : null,
          timestamp: Date.now(),
        },
      },
      create: {
        id: 'ksiegowosc-es',
        data: {
          lastAction: 'delete-preview',
          deletePreviewId: previewId,
          period,
          count: found.length,
          totalMatched,
          contractor: contractorInfo ? { name: contractorInfo.name, nif: contractorInfo.nif } : null,
          timestamp: Date.now(),
        },
      },
    })
    .catch(e => console.error('[cs delete-preview] AgentContext save error:', e.message));

  res.json({
    ok: true,
    period,
    totalMatched,
    selectedCount: found.length,
    invoices: summary,
    contractor: contractorInfo ? { id: contractorInfo.id, name: contractorInfo.name, nif: contractorInfo.nif } : null,
    previewId,
    hint: limit === 1
      ? `Wybrano najnowszą z ${totalMatched} pasujących. Wykonaj POST /api/contasimple/delete-confirm-latest aby skasować.`
      : `${found.length} z ${totalMatched} FV. Wykonaj POST /api/contasimple/delete-confirm-latest aby skasować WSZYSTKIE z tej listy.`,
  });
}));

async function executeDeleteForPreview(stored) {
  const { period, invoices, contractor, chatId: storedChatId } = stored;
  const results = [];
  for (const inv of invoices) {
    try {
      const apiResp = await cs.deleteInvoice(period, inv.id);
      try {
        await prisma.esInvoice.deleteMany({ where: { contasimpleId: inv.id } });
      } catch (mirrorErr) {
        console.error('[cs delete-confirm] local mirror delete failed:', mirrorErr.message);
      }
      results.push({
        id: inv.id,
        number: inv.number,
        customerName: inv.target && inv.target.organization,
        totalAmount: inv.totalAmount,
        status: 'deleted',
        contasimpleResponse: apiResp,
      });
    } catch (e) {
      results.push({
        id: inv.id,
        number: inv.number,
        customerName: inv.target && inv.target.organization,
        totalAmount: inv.totalAmount,
        status: 'failed',
        error: e.message,
        contasimpleStatus: e.status,
        contasimpleBody: e.body,
      });
    }
  }

  const deleted = results.filter(r => r.status === 'deleted');
  const failed = results.filter(r => r.status === 'failed');

  // Telegram notification (text, not PDF — confirms what was actually deleted
  // verbatim per Contasimple's own response). Same telegram_chat_id_es →
  // telegram_chat_id fallback chain as the create flow.
  let tgSent = false;
  let tgError = null;
  try {
    const tgTokenCfg = await prisma.config.findUnique({ where: { key: 'telegram_bot_token' } });
    const tgChatCfg = storedChatId
      ? { value: String(storedChatId) }
      : await prisma.config.findUnique({ where: { key: 'telegram_chat_id_es' } })
        || await prisma.config.findUnique({ where: { key: 'telegram_chat_id' } });
    const tgToken = tgTokenCfg && tgTokenCfg.value;
    const tgChat = tgChatCfg && tgChatCfg.value;
    if (!tgToken) tgError = 'telegram_bot_token missing in Config';
    else if (!tgChat) tgError = 'telegram_chat_id_es and telegram_chat_id both missing in Config';
    else {
      const lines = [];
      if (deleted.length) {
        const header = contractor && contractor.name
          ? `Skasowano ${deleted.length} FV dla ${contractor.name}:`
          : `Skasowano ${deleted.length} FV:`;
        lines.push(header);
        for (const d of deleted) {
          lines.push(`- ${d.number} (${d.totalAmount} €)`);
        }
        const totalSum = deleted.reduce((s, d) => s + (Number(d.totalAmount) || 0), 0);
        lines.push(`Razem: ${totalSum.toFixed(2)} €`);
      }
      if (failed.length) {
        if (deleted.length) lines.push('');
        lines.push(`Nie udało się skasować ${failed.length}:`);
        for (const f of failed) {
          lines.push(`- ${f.number}: ${f.error || 'unknown'}`);
        }
      }
      const text = lines.join('\n');
      const tgResp = await sendTelegram(tgToken, tgChat, text);
      if (tgResp && tgResp.ok) {
        tgSent = true;
      } else {
        tgError = `telegram api: ${(tgResp && tgResp.description) || 'unknown'} (chat=${tgChat})`;
        console.error('[cs delete-confirm] Telegram returned not-ok:', JSON.stringify(tgResp));
      }
    }
  } catch (tgErr) {
    tgError = tgErr.message;
    console.error('[cs delete-confirm] Telegram notify threw:', tgErr.message);
  }

  return { period, totalRequested: invoices.length, results, tgSent, tgError };
}

router.post('/delete-confirm-latest', asyncHandler(async (req, res) => {
  const latest = getLatestEsDeletePreview();
  if (!latest) return res.status(404).json({ error: 'Brak aktywnego delete-preview ES. Utwórz nowy przez /delete-preview.' });

  const out = await executeDeleteForPreview(latest.data);
  deleteEsDeletePreview(latest.id);

  const deleted = out.results.filter(r => r.status === 'deleted');
  const failed = out.results.filter(r => r.status === 'failed');

  prisma.agentContext
    .upsert({
      where: { id: 'ksiegowosc-es' },
      update: {
        data: {
          lastAction: 'delete-confirmed',
          period: out.period,
          deletedCount: deleted.length,
          failedCount: failed.length,
          deletedNumbers: deleted.map(d => d.number),
          timestamp: Date.now(),
        },
      },
      create: {
        id: 'ksiegowosc-es',
        data: {
          lastAction: 'delete-confirmed',
          period: out.period,
          deletedCount: deleted.length,
          failedCount: failed.length,
          deletedNumbers: deleted.map(d => d.number),
          timestamp: Date.now(),
        },
      },
    })
    .catch(e => console.error('[cs delete-confirm] AgentContext save error:', e.message));

  res.json({
    ok: failed.length === 0,
    period: out.period,
    totalRequested: out.totalRequested,
    totalDeleted: deleted.length,
    totalFailed: failed.length,
    tgSent: out.tgSent,
    tgError: out.tgError,
    results: out.results,
  });
}));

router.post('/delete-confirm', asyncHandler(async (req, res) => {
  const { previewId } = req.body || {};
  if (!previewId) return res.status(400).json({ error: 'previewId required' });
  const stored = getEsDeletePreview(previewId);
  if (!stored) return res.status(404).json({ error: 'preview not found or expired' });

  const out = await executeDeleteForPreview(stored);
  deleteEsDeletePreview(previewId);

  const deleted = out.results.filter(r => r.status === 'deleted');
  const failed = out.results.filter(r => r.status === 'failed');

  res.json({
    ok: failed.length === 0,
    period: out.period,
    totalRequested: out.totalRequested,
    totalDeleted: deleted.length,
    totalFailed: failed.length,
    tgSent: out.tgSent,
    tgError: out.tgError,
    results: out.results,
  });
}));

// ============ CONVENIENCE ENDPOINTS FOR AGENT ============
//
// The raw API exposes /invoices/:id/send and /invoices/:id/pdf, both keyed
// by Contasimple's numeric id and requiring an explicit ?period=. The agent
// usually only knows a human-readable invoice number ("2026-0056") at the
// moment of the request, so these wrappers resolve the rest.

async function resolveInvoiceByNumberOrId({ invoiceNumber, contasimpleId, period }) {
  if (contasimpleId) {
    const p = period || cs.dateToPeriod(new Date());
    try {
      const r = await cs.getInvoice(p, contasimpleId);
      const data = r && r.data ? r.data : r;
      return { id: data.id, period: data.period || p, data };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }
  if (invoiceNumber) {
    // Try current quarter first, then fall back to a few prior quarters.
    const today = new Date();
    const candidates = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() - i * 3, 1);
      candidates.push(cs.dateToPeriod(d));
    }
    if (period) candidates.unshift(period);
    const seen = new Set();
    for (const p of candidates) {
      if (seen.has(p)) continue;
      seen.add(p);
      try {
        const r = await cs.searchInvoiceByNumber(p, invoiceNumber);
        const list = (r && r.data) || [];
        if (list.length) {
          const inv = list[0];
          return { id: inv.id, period: inv.period || p, data: inv };
        }
      } catch (_) {}
    }
    return null;
  }
  return null;
}

// Email templates per documentCulture. The customer's culture is read from
// EsContractor.documentCulture (synced from Contasimple, values like es-ES /
// ca-ES / en-US). Override globally via Config keys:
//   contasimple_email_template_<culture>  (JSON: {subject, body})
//   contasimple_email_signature           (text, default "Nikodem")
// Placeholders: {number}, {customerName}, {totalAmount}, {senderName}.
const ES_EMAIL_TEMPLATES = {
  'es-ES': {
    subject: 'Factura {number} – Surf Stick Bell',
    body:
      'Hola {customerName},\n\n' +
      'Adjunto la factura {number} por importe de {totalAmount} €.\n' +
      'Si tienes cualquier duda, no dudes en contactarme.\n\n' +
      'Saludos,\n{senderName}',
  },
  'ca-ES': {
    subject: 'Factura {number} – Surf Stick Bell',
    body:
      'Hola {customerName},\n\n' +
      'T\'adjunto la factura {number} per import de {totalAmount} €.\n' +
      'Si tens qualsevol dubte, no dubtis a contactar-me.\n\n' +
      'Salutacions,\n{senderName}',
  },
  'en-US': {
    subject: 'Invoice {number} – Surf Stick Bell',
    body:
      'Hello {customerName},\n\n' +
      'Please find attached invoice {number} for €{totalAmount}.\n' +
      'Let me know if you have any questions.\n\n' +
      'Best regards,\n{senderName}',
  },
};

function fillTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

async function buildEsEmailFromTemplate({ culture, customer, invoice, signature }) {
  // Allow Config override per culture (lets Nikodem tweak wording without redeploy).
  let template = null;
  try {
    const row = await prisma.config.findUnique({
      where: { key: `contasimple_email_template_${culture}` },
    });
    if (row && row.value) {
      try { template = JSON.parse(row.value); } catch (_) {}
    }
  } catch (_) {}
  if (!template) template = ES_EMAIL_TEMPLATES[culture] || ES_EMAIL_TEMPLATES['es-ES'];

  const customerName =
    (customer && (customer.organization || [customer.firstname, customer.lastname].filter(Boolean).join(' ') || customer.name)) || '';
  const totalAmount =
    invoice.totalAmount != null
      ? Number(invoice.totalAmount).toFixed(2).replace('.', ',')
      : '';

  const vars = {
    number: invoice.number || '',
    customerName,
    totalAmount,
    senderName: signature,
  };

  return {
    subject: fillTemplate(template.subject, vars),
    body: fillTemplate(template.body, vars),
  };
}

router.post('/send-invoice-email', asyncHandler(async (req, res) => {
  const { invoiceNumber, contasimpleId, period: bodyPeriod, toEmail: bodyToEmail, replyTo, blindCopy, subject, body: emailBody, language } = req.body || {};
  const resolved = await resolveInvoiceByNumberOrId({ invoiceNumber, contasimpleId, period: bodyPeriod });
  if (!resolved) {
    return res.status(404).json({ error: 'invoice not found', invoiceNumber, contasimpleId });
  }

  // Auto-fetch email from local EsContractor (synced from Contasimple) if
  // caller didn't supply it. Lets the agent say "wyślij fv 2026-0058 mailem
  // do Folkertsa" without having to memorize email addresses.
  let toEmail = bodyToEmail;
  let emailSource = 'request';
  if (!toEmail) {
    const targetEntity = resolved.data.target || {};
    let customer = null;
    if (targetEntity.id) {
      customer = await prisma.esContractor.findUnique({ where: { contasimpleId: targetEntity.id } });
    }
    if (!customer && targetEntity.nif) {
      customer = await prisma.esContractor.findFirst({ where: { nif: targetEntity.nif } });
    }
    if (customer && customer.email) {
      toEmail = customer.email;
      emailSource = 'contractor';
    } else if (targetEntity.email) {
      toEmail = targetEntity.email;
      emailSource = 'invoice';
    }
  }
  if (!toEmail) {
    return res.status(400).json({
      error: 'no email available',
      hint: 'Klient nie ma maila w bazie. Podaj toEmail explicit albo uzupełnij EsContractor.email.',
      customer: resolved.data.target && {
        id: resolved.data.target.id,
        organization: resolved.data.target.organization,
        nif: resolved.data.target.nif,
      },
    });
  }

  // If caller didn't provide subject/body — generate from template using
  // customer's documentCulture (synced from Contasimple).
  let finalSubject = subject;
  let finalBody = emailBody;
  let templateUsed = null;
  if (!finalSubject || !finalBody) {
    // Find local EsContractor record matching the invoice's target customer.
    const targetEntity = resolved.data.target || {};
    let customer = null;
    if (targetEntity.id) {
      customer = await prisma.esContractor.findUnique({ where: { contasimpleId: targetEntity.id } });
    }
    if (!customer && targetEntity.nif) {
      customer = await prisma.esContractor.findFirst({ where: { nif: targetEntity.nif } });
    }
    // Fallback to data already on the invoice (Contasimple snapshots customer).
    const customerForTemplate = customer || {
      organization: targetEntity.organization,
      firstname: targetEntity.firstname,
      lastname: targetEntity.lastname,
    };
    const culture =
      language ||
      (customer && customer.documentCulture) ||
      'es-ES';

    const sigCfg = await prisma.config.findUnique({ where: { key: 'contasimple_email_signature' } });
    const signature = (sigCfg && sigCfg.value) || 'Nikodem';

    const generated = await buildEsEmailFromTemplate({
      culture,
      customer: customerForTemplate,
      invoice: resolved.data,
      signature,
    });
    if (!finalSubject) finalSubject = generated.subject;
    if (!finalBody) finalBody = generated.body;
    templateUsed = culture;
  }

  const apiResp = await cs.sendInvoiceEmail(resolved.period, resolved.id, {
    to: toEmail, replyTo, blindCopy, subject: finalSubject, body: finalBody,
  });

  // Auto-backfill: jak user podał email ręcznie a kontrahent miał pusty
  // → zapisz na EsContractor (uczy się z każdego ręcznego wpisu).
  let backfilled = false;
  if (emailSource === 'request' && bodyToEmail) {
    const targetEntity = resolved.data.target || {};
    let customer = null;
    if (targetEntity.id) {
      customer = await prisma.esContractor.findUnique({ where: { contasimpleId: targetEntity.id } });
    }
    if (!customer && targetEntity.nif) {
      customer = await prisma.esContractor.findFirst({ where: { nif: targetEntity.nif } });
    }
    if (customer && (!customer.email || customer.email.trim() === '')) {
      try {
        await prisma.esContractor.update({
          where: { id: customer.id },
          data: { email: toEmail.toLowerCase().trim() },
        });
        backfilled = true;
        console.log(`[cs send-invoice-email] auto-backfilled email for ${customer.organization || customer.name}: ${toEmail}`);
      } catch (e) {
        console.error('[cs send-invoice-email] backfill failed:', e.message);
      }
    }
  }

  res.json({
    ok: true,
    invoiceNumber: resolved.data.number || invoiceNumber,
    invoiceId: resolved.id,
    period: resolved.period,
    to: toEmail,
    emailSource,
    backfilled,
    subject: finalSubject,
    body: finalBody,
    templateUsed,
    contasimpleResponse: apiResp,
  });
}));

// Bezpośrednie ustawienie maila kontrahenta — agent woła np. gdy user
// powie "ustaw email Folkertsa na folkerts@gmail.com". Identyfikacja
// kontrahenta po NIF, contasimpleId albo fragmentcie nazwy (organization).
router.post('/set-customer-email', asyncHandler(async (req, res) => {
  const { nif, contasimpleId, organization, email } = req.body || {};
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'email (valid format) required' });
  }
  let customer = null;
  if (contasimpleId) {
    customer = await prisma.esContractor.findUnique({ where: { contasimpleId } });
  }
  if (!customer && nif) {
    customer = await prisma.esContractor.findFirst({ where: { nif } });
  }
  if (!customer && organization) {
    const norm = organization.toLowerCase();
    const all = await prisma.esContractor.findMany({
      select: { id: true, organization: true, name: true, nif: true, email: true },
    });
    const hits = all.filter(c => {
      const display = (c.organization || c.name || '').toLowerCase();
      return display.includes(norm) || norm.includes(display.split(' ')[0]);
    });
    if (hits.length === 1) {
      customer = await prisma.esContractor.findUnique({ where: { id: hits[0].id } });
    } else if (hits.length > 1) {
      return res.json({
        ok: false,
        error: 'ambiguous organization match',
        matches: hits.map(h => ({ id: h.id, organization: h.organization || h.name, nif: h.nif, email: h.email })),
      });
    }
  }
  if (!customer) {
    return res.status(404).json({ error: 'EsContractor not found by nif/contasimpleId/organization' });
  }
  const previousEmail = customer.email;
  await prisma.esContractor.update({
    where: { id: customer.id },
    data: { email: email.toLowerCase().trim() },
  });
  res.json({
    ok: true,
    contractor: { id: customer.id, organization: customer.organization || customer.name, nif: customer.nif },
    previousEmail,
    newEmail: email.toLowerCase().trim(),
  });
}));

router.post('/resend-pdf-telegram', asyncHandler(async (req, res) => {
  const { invoiceNumber, contasimpleId, period: bodyPeriod } = req.body || {};
  const resolved = await resolveInvoiceByNumberOrId({ invoiceNumber, contasimpleId, period: bodyPeriod });
  if (!resolved) {
    return res.status(404).json({ error: 'invoice not found', invoiceNumber, contasimpleId });
  }
  const tgChatCfg = req.body && req.body.chatId
    ? { value: String(req.body.chatId) }
    : await prisma.config.findUnique({ where: { key: 'telegram_chat_id_es' } })
      || await prisma.config.findUnique({ where: { key: 'telegram_chat_id' } });
  const tgToken = await getEsTelegramToken(prisma);
  const tgChat = tgChatCfg && tgChatCfg.value;
  if (!tgToken) return res.status(503).json({ error: 'telegram bot token (ES/PL) missing — set TELEGRAM_BOT_TOKEN_ES' });
  if (!tgChat) return res.status(503).json({ error: 'telegram_chat_id missing' });

  const { buffer } = await cs.fetchInvoicePdf(resolved.period, resolved.id);
  const number = resolved.data.number || String(resolved.id);
  const customer = (resolved.data.target && resolved.data.target.organization) || '';
  const total = resolved.data.totalAmount;
  const filename = `factura_${number.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`;
  const caption = `Factura ${number}${customer ? ` — ${customer}` : ''}${total != null ? ` (${total} €)` : ''}`;
  const tgResp = await sendTelegramDocument(tgToken, tgChat, buffer, filename, caption);
  if (!tgResp || !tgResp.ok) {
    return res.status(502).json({
      ok: false,
      error: `telegram api: ${(tgResp && tgResp.description) || 'unknown'}`,
      invoiceNumber: number,
    });
  }
  res.json({ ok: true, invoiceNumber: number, invoiceId: resolved.id, period: resolved.period, pdfSent: true });
}));

// ============ EMAIL BACKFILL FROM INBOX HISTORY ============
//
// Nikodem rarely fills the customer email field in Contasimple (only ~5% of
// 121 customers have one). This endpoint scans an IMAP-synced inbox (e.g.
// "nikodem") and matches incoming emails to EsContractor rows by company
// name in the sender's display name or email domain. Confident matches are
// upserted onto EsContractor.email; ambiguous matches (multiple distinct
// emails for the same customer) are reported but skipped.

function normalizeNameForMatch(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/ñ/g, 'n')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(sl|slu|sa|sas|lda|gmbh|ltd|llc|inc|corp|bv|nv|ab|as|oy|srl|spz|spzoo)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

router.get('/_inbox-stats', asyncHandler(async (req, res) => {
  const stats = await prisma.email.groupBy({
    by: ['inbox', 'direction'],
    _count: { _all: true },
    orderBy: [{ inbox: 'asc' }, { direction: 'asc' }],
  });
  res.json({ stats });
}));

router.post('/sync-emails-from-inbox', asyncHandler(async (req, res) => {
  const { inbox = 'nikodem', dryRun = false, includeOutbound = true } = req.body || {};

  const emailWhere = { inbox };
  // Inbound: fromEmail is the customer. Outbound: toEmail is the customer.
  // We pull both and key on the right side per record.
  const emails = await prisma.email.findMany({
    where: emailWhere,
    select: {
      id: true,
      direction: true,
      fromEmail: true,
      fromName: true,
      toEmail: true,
      subject: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  const contractors = await prisma.esContractor.findMany({
    where: { OR: [{ email: null }, { email: '' }] },
    select: { id: true, name: true, organization: true, firstname: true, lastname: true, nif: true },
  });

  // For each contractor, find candidate customer emails from inbox by
  // matching the contractor's distinct words against fromName / domain
  // (inbound) or subject / toEmail (outbound).
  const plan = [];
  for (const c of contractors) {
    const fullName =
      c.organization ||
      [c.firstname, c.lastname].filter(Boolean).join(' ') ||
      c.name ||
      '';
    const cName = normalizeNameForMatch(fullName);
    if (!cName) continue;
    const cWords = cName.split(' ').filter(w => w.length >= 4);
    if (!cWords.length) continue;

    const candidateEmails = new Map(); // email → match count
    for (const em of emails) {
      const isInbound = em.direction === 'INBOUND';
      const isOutbound = em.direction === 'OUTBOUND';
      if (!isInbound && !(isOutbound && includeOutbound)) continue;

      let customerEmail = null;
      let haystack = '';
      if (isInbound) {
        customerEmail = em.fromEmail;
        const fromDomain = ((em.fromEmail || '').split('@')[1] || '').replace(/\./g, ' ');
        haystack = normalizeNameForMatch(`${em.fromName || ''} ${fromDomain} ${em.subject || ''}`);
      } else {
        customerEmail = em.toEmail;
        const toDomain = ((em.toEmail || '').split('@')[1] || '').replace(/\./g, ' ');
        haystack = normalizeNameForMatch(`${toDomain} ${em.subject || ''}`);
      }
      if (!customerEmail || !haystack) continue;

      const allWordsMatch = cWords.every(w => haystack.includes(w));
      if (!allWordsMatch) continue;

      candidateEmails.set(customerEmail, (candidateEmails.get(customerEmail) || 0) + 1);
    }

    if (candidateEmails.size === 0) continue;

    // Pick the most-frequent match. Tie-break: prefer non-noreply / non-info.
    const sorted = [...candidateEmails.entries()].sort((a, b) => {
      const aIsGeneric = /noreply|no-reply|info@|admin@|postmaster/i.test(a[0]);
      const bIsGeneric = /noreply|no-reply|info@|admin@|postmaster/i.test(b[0]);
      if (aIsGeneric !== bIsGeneric) return aIsGeneric ? 1 : -1;
      return b[1] - a[1];
    });

    if (sorted.length === 1) {
      plan.push({
        contractorId: c.id,
        contractorName: fullName,
        nif: c.nif,
        email: sorted[0][0],
        hits: sorted[0][1],
        action: 'update',
      });
    } else {
      // Multiple distinct emails — keep the top one but flag.
      plan.push({
        contractorId: c.id,
        contractorName: fullName,
        nif: c.nif,
        email: sorted[0][0],
        hits: sorted[0][1],
        candidates: sorted.map(([em, n]) => ({ email: em, hits: n })),
        action: 'update_top_pick',
      });
    }
  }

  if (dryRun) {
    return res.json({
      ok: true,
      dryRun: true,
      inbox,
      emailsScanned: emails.length,
      contractorsWithoutEmail: contractors.length,
      planSize: plan.length,
      plan,
    });
  }

  let updated = 0;
  for (const item of plan) {
    try {
      await prisma.esContractor.update({
        where: { id: item.contractorId },
        data: { email: item.email },
      });
      updated++;
    } catch (e) {
      console.error('[cs sync-emails] update failed for', item.contractorId, e.message);
    }
  }
  res.json({
    ok: true,
    dryRun: false,
    inbox,
    emailsScanned: emails.length,
    contractorsWithoutEmail: contractors.length,
    updated,
    ambiguous: plan.filter(p => p.action === 'update_top_pick').length,
  });
}));

// AI-driven email→contractor matcher. Uses Claude to fuzzy-match each
// EsContractor (without email) against every unique sender/recipient seen
// in the inbox, returning a confidence score. Only matches at or above
// minConfidence get persisted. Single-shot, scoped to one Anthropic call;
// works for ~150 contractors × ~500 unique emails per batch comfortably.
router.post('/ai-match-emails', asyncHandler(async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }
  const {
    inbox,
    dryRun = false,
    minConfidence = 0.75,
    model = process.env.ACCOUNTING_AGENT_MODEL || 'claude-sonnet-4-5-20250929',
  } = req.body || {};
  if (!inbox) return res.status(400).json({ error: 'inbox (string) required — e.g. "nikodem"' });

  const emails = await prisma.email.findMany({
    where: { inbox },
    select: { fromEmail: true, fromName: true, toEmail: true, subject: true, direction: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!emails.length) {
    return res.json({ ok: false, error: `no emails in inbox "${inbox}"` });
  }

  // Aggregate unique customer addresses with their best display name + a few
  // recent subjects for context.
  const emailMap = new Map();
  for (const em of emails) {
    const key = em.direction === 'INBOUND' ? em.fromEmail : em.toEmail;
    if (!key) continue;
    const lower = key.toLowerCase();
    if (/noreply|no-reply|mailer-daemon|postmaster/i.test(lower)) continue;
    if (!emailMap.has(lower)) emailMap.set(lower, { name: '', subjects: [], count: 0 });
    const entry = emailMap.get(lower);
    entry.count++;
    if (em.fromName && (!entry.name || em.fromName.length > entry.name.length)) entry.name = em.fromName;
    if (em.subject && entry.subjects.length < 3 && !entry.subjects.includes(em.subject)) {
      entry.subjects.push(em.subject);
    }
  }
  const uniqueEmails = [...emailMap.entries()]
    .map(([email, d]) => ({ email, name: d.name || '', subjects: d.subjects, count: d.count }))
    .sort((a, b) => b.count - a.count);

  const contractors = await prisma.esContractor.findMany({
    where: { OR: [{ email: null }, { email: '' }] },
    select: { id: true, organization: true, firstname: true, lastname: true, name: true, nif: true, city: true, postalCode: true },
  });

  if (!contractors.length) {
    return res.json({ ok: true, message: 'all EsContractor rows already have email', updated: 0 });
  }

  // Build prompt. Indexes are 1-based in the prompt for readability; we map
  // back to UUIDs server-side.
  const customerLines = contractors.map((c, i) => {
    const display = c.organization || [c.firstname, c.lastname].filter(Boolean).join(' ') || c.name;
    return `${i + 1}. ${display}${c.nif ? ' [' + c.nif + ']' : ''}${c.city ? ' (' + c.city + ')' : ''}`;
  });
  const contactLines = uniqueEmails.map(e => {
    const subjs = e.subjects.length ? ' | ' + e.subjects.join(' / ') : '';
    return `${e.email}  —  "${e.name}"${subjs}  (×${e.count})`;
  });

  const prompt =
    'Match each Spanish/Canary Islands B2B customer below to its most likely email contact. Customers are companies (SL/SA/SLU/etc.) or sole traders. Use fuzzy matching on company name vs sender display name AND email domain.\n\n' +
    'CUSTOMERS (no email yet):\n' +
    customerLines.join('\n') +
    '\n\nCONTACTS FROM INBOX (email — display name — recent subjects — frequency):\n' +
    contactLines.join('\n') +
    '\n\nReturn a JSON array of matches. Only include matches you are confident about (skip ambiguous ones). Schema:\n' +
    '[{"customerIndex": <number from CUSTOMERS list>, "email": "<email from CONTACTS list>", "confidence": <0.0-1.0>, "reasoning": "<short>"}]\n\n' +
    'Rules:\n' +
    '- One email per customer (if multiple plausible, pick the highest-confidence).\n' +
    '- Same email can match multiple customers only if they are clearly the same business under different rows.\n' +
    `- Skip matches below ${minConfidence} confidence — leave them out of the array entirely.\n` +
    '- Respond with ONLY the JSON array, no markdown fences, no commentary.';

  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const llm = await anthropic.messages.create({
    model,
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  });
  const textBlock = llm.content.find(b => b.type === 'text');
  const text = textBlock ? textBlock.text : '';

  let matches;
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const arrStart = cleaned.indexOf('[');
    const arrEnd = cleaned.lastIndexOf(']');
    matches = JSON.parse(cleaned.slice(arrStart, arrEnd + 1));
  } catch (e) {
    return res.status(502).json({
      error: 'AI returned non-JSON',
      rawResponse: text.slice(0, 2000),
    });
  }

  // ============ SANITY GUARDS ============
  // AI lubi halucynować dopasowanie po fragmencie nazwy ("PARA..." w trzech
  // różnych firmach → ten sam mail). Filtrujemy:
  // 1. Blocklist domen logistycznych/kurierskich/operatorskich.
  // 2. Wymagamy że jakiś token z nazwy klienta (≥4 znaki) występuje w
  //    local-part maila, domenie LUB display name skrzynki.
  // 3. Ten sam email dla wielu klientów z różnymi NIF → odrzucamy wszystkie.
  const DOMAIN_BLOCKLIST = [
    'olmed.net.pl', 'dhl.com', 'dhl.pl', 'ups.com', 'fedex.com',
    'gls-group.com', 'gls-poland.com', 'gls-spain.com', 'inpost.pl',
    'dpd.com', 'dpd.pl', 'globkurier.pl', 'globkurier.com',
    'correos.es', 'correos.com', 'sending.es', 'seur.com',
    'mrw.es', 'nacex.es', 'tipsa.com', 'redyser.com',
    'kuehne-nagel.com', 'tnt.com', 'postnl.nl', 'amazon.com',
    'ebay.com', 'paypal.com', 'stripe.com', 'mailchimp.com',
    'sendgrid.net', 'mailgun.org', 'shopify.com',
    'noreply.com', 'notification.com',
  ];
  const tokenize = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').split(/\s+/)
    .filter(t => t.length >= 4 && !['surf', 'sport', 'gmbh', 'sociedad', 'limitada', 'farma', 'farmacia', 'parafarm', 'shop', 'store', 'company'].includes(t));

  // Najpierw — agreguj plan po emailu żeby wykryć kolizje.
  const emailGroups = new Map();
  const rawPlan = [];
  for (const m of matches) {
    if (typeof m.customerIndex !== 'number' || !m.email) continue;
    if (typeof m.confidence === 'number' && m.confidence < minConfidence) continue;
    const c = contractors[m.customerIndex - 1];
    if (!c) continue;
    rawPlan.push({ m, c });
    const lower = m.email.toLowerCase().trim();
    if (!emailGroups.has(lower)) emailGroups.set(lower, []);
    emailGroups.get(lower).push(c);
  }

  const plan = [];
  const rejected = [];
  for (const { m, c } of rawPlan) {
    const email = m.email.toLowerCase().trim();
    const display = c.organization || [c.firstname, c.lastname].filter(Boolean).join(' ') || c.name || '';
    const customerTokens = tokenize(display);

    const inboxEntry = uniqueEmails.find(u => u.email === email);
    const inboxContext = inboxEntry
      ? { displayName: inboxEntry.name, subjects: inboxEntry.subjects, count: inboxEntry.count }
      : null;
    const reasoning = m.reasoning || null;

    // Guard 1: blocklist domen
    const domain = email.split('@')[1] || '';
    if (DOMAIN_BLOCKLIST.some(d => domain === d || domain.endsWith('.' + d))) {
      rejected.push({ contractorName: display, nif: c.nif, email, confidence: m.confidence, reason: 'blocklisted_domain', reasoning, inboxContext });
      continue;
    }

    // Guard 2: ten sam email do wielu różnych klientów (różne NIF) → drop
    const sharers = emailGroups.get(email) || [];
    const uniqueNifs = new Set(sharers.map(x => x.nif).filter(Boolean));
    if (uniqueNifs.size > 1) {
      rejected.push({ contractorName: display, nif: c.nif, email, confidence: m.confidence, reason: 'shared_across_distinct_companies', sharedWith: sharers.map(s => s.organization || s.name).filter(x => x !== display), reasoning, inboxContext });
      continue;
    }

    // Guard 3: brak jakiegokolwiek tokenu nazwy w email lub display
    const haystack = (email + ' ' + (inboxEntry ? inboxEntry.name : '') + ' ' + (inboxEntry ? inboxEntry.subjects.join(' ') : '')).toLowerCase();
    const tokenHit = customerTokens.some(t => haystack.includes(t));
    if (customerTokens.length > 0 && !tokenHit) {
      rejected.push({ contractorName: display, nif: c.nif, email, confidence: m.confidence, reason: 'no_customer_token_in_email_or_displayname', reasoning, inboxContext });
      continue;
    }

    plan.push({
      contractorId: c.id,
      contractorName: display,
      nif: c.nif,
      email,
      confidence: m.confidence,
      reasoning: m.reasoning || null,
    });
  }

  if (dryRun) {
    return res.json({
      ok: true,
      dryRun: true,
      inbox,
      emailsScanned: emails.length,
      uniqueContacts: uniqueEmails.length,
      contractorsWithoutEmail: contractors.length,
      planSize: plan.length,
      rejectedSize: rejected.length,
      plan,
      rejected,
      tokensUsed: llm.usage,
    });
  }

  let updated = 0;
  for (const item of plan) {
    try {
      await prisma.esContractor.update({
        where: { id: item.contractorId },
        data: { email: item.email },
      });
      updated++;
    } catch (e) {
      console.error('[cs ai-match-emails] update failed:', item.contractorId, e.message);
    }
  }

  res.json({
    ok: true,
    inbox,
    emailsScanned: emails.length,
    uniqueContacts: uniqueEmails.length,
    contractorsWithoutEmail: contractors.length,
    updated,
    planSize: plan.length,
    rejectedSize: rejected.length,
    rejected,
    tokensUsed: llm.usage,
  });
}));

// Cofnięcie błędnych dopasowań — czyści email field na EsContractor
// dla podanych NIF-ów albo emaili.
router.post('/clear-emails', asyncHandler(async (req, res) => {
  const { nifs, emails: emailsToClear } = req.body || {};
  const where = { OR: [] };
  if (Array.isArray(nifs) && nifs.length) where.OR.push({ nif: { in: nifs } });
  if (Array.isArray(emailsToClear) && emailsToClear.length) where.OR.push({ email: { in: emailsToClear.map(e => e.toLowerCase()) } });
  if (!where.OR.length) {
    return res.status(400).json({ error: 'pass nifs[] or emails[] in body' });
  }
  const before = await prisma.esContractor.findMany({
    where,
    select: { id: true, organization: true, nif: true, email: true },
  });
  const result = await prisma.esContractor.updateMany({
    where,
    data: { email: null },
  });
  res.json({ ok: true, cleared: result.count, contractors: before });
}));

// ============ HELPERS ============

router.get('/_period', asyncHandler(async (req, res) => {
  const date = req.query.date ? new Date(req.query.date) : new Date();
  res.json({ date: date.toISOString(), period: cs.dateToPeriod(date) });
}));

module.exports = router;
