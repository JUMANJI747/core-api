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
  saveEsPreview(previewId, { preview, contractor, lines, invoiceDate, body });

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
  const { preview, contractor, lines, invoiceDate } = stored;
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
    const tgTokenCfg = await prisma.config.findUnique({ where: { key: 'telegram_bot_token' } });
    const tgChatCfg = await prisma.config.findUnique({ where: { key: 'telegram_chat_id_es' } })
      || await prisma.config.findUnique({ where: { key: 'telegram_chat_id' } });
    const tgToken = tgTokenCfg && tgTokenCfg.value;
    const tgChat = tgChatCfg && tgChatCfg.value;
    if (!tgToken) pdfError = 'telegram_bot_token missing in Config';
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
  saveEsDeletePreview(previewId, { period, invoices: found, summary, contractor: contractorInfo });

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
  const { period, invoices, contractor } = stored;
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
    const tgChatCfg = await prisma.config.findUnique({ where: { key: 'telegram_chat_id_es' } })
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

// ============ HELPERS ============

router.get('/_period', asyncHandler(async (req, res) => {
  const date = req.query.date ? new Date(req.query.date) : new Date();
  res.json({ date: date.toISOString(), period: cs.dateToPeriod(date) });
}));

module.exports = router;
