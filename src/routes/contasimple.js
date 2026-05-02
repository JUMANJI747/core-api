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
} = require('../es-stores');
const {
  findEsContractor,
  expandEsLines,
  buildEsTotals,
  buildContasimplePayload,
  IGIC_DEFAULT_PCT,
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
  const remote = await cs.listAllProducts();
  const list = (remote && remote.data) || [];
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
  // Look up Nikodem's product IDs from the local mirror
  const findIdByName = async (name) => {
    const p = await prisma.esProduct.findFirst({
      where: { name: { contains: name, mode: 'insensitive' }, category: 'product' },
    });
    return p ? p.contasimpleId : null;
  };

  const stickId = await findIdByName('SURF STICK BELL');
  const lipId = await findIdByName('SURF LIP BALM');
  const dailyId = await findIdByName('SURF DAILY');
  const careId = await findIdByName('SURF CARE');
  const gelId = await findIdByName('SURF EXTREME GEL');

  const boxes = [
    {
      ean: 'BOX-STICK-ES',
      name: 'BOX SURF STICK',
      composition: [{ name: 'SURF STICK BELL SPF 50+', contasimpleId: stickId, qty: 30 }],
    },
    {
      ean: 'BOX-COLLECTION-ES',
      name: 'BOX COLLECTION',
      composition: [
        { name: 'SURF LIP BALM BELL SPF 50+', contasimpleId: lipId, qty: 12 },
        { name: 'SURF DAILY BELL SPF 50+', contasimpleId: dailyId, qty: 6 },
        { name: 'SURF EXTREME GEL BELL SPF 50+', contasimpleId: gelId, qty: 6 },
        { name: 'SURF CARE BELL', contasimpleId: careId, qty: 6 },
      ],
    },
    {
      // Mascara not in Contasimple yet — placeholder. When Nikodem adds the
      // product in Contasimple UI, /sync-products will pick it up and the
      // composition entry below will resolve via name lookup at expand time.
      ean: 'BOX-MASCARA-ES',
      name: 'BOX SURF MASCARA',
      composition: [{ name: 'SURF MASCARA BELL', contasimpleId: null, qty: 30 }],
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
      results.push({ ean: b.ean, action: 'updated', totalQty });
    } else {
      await prisma.esProduct.create({ data });
      results.push({ ean: b.ean, action: 'created', totalQty });
    }
  }
  res.json({ ok: true, boxes: results });
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

  const csPayload = buildContasimplePayload({
    targetEntityId: contractor.contasimpleId,
    lines,
    invoiceDate,
  });

  const csResult = await cs.createInvoice(period, csPayload);
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

  // PDF → Telegram (best-effort).
  let pdfSent = false;
  try {
    const tgTokenCfg = await prisma.config.findUnique({ where: { key: 'telegram_bot_token' } });
    const tgChatCfg = await prisma.config.findUnique({ where: { key: 'telegram_chat_id_es' } })
      || await prisma.config.findUnique({ where: { key: 'telegram_chat_id' } });
    const tgToken = tgTokenCfg && tgTokenCfg.value;
    const tgChat = tgChatCfg && tgChatCfg.value;
    if (tgToken && tgChat) {
      const { buffer } = await cs.fetchInvoicePdf(period, invoice.id);
      const filename = `factura_${(invoice.number || invoice.id).toString().replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`;
      const caption = `Factura ${invoice.number || invoice.id} — ${contractor.name} (${preview.totals.brutto} €)`;
      await sendTelegramDocument(tgToken, tgChat, buffer, filename, caption);
      pdfSent = true;
    }
  } catch (tgErr) {
    console.error('[cs invoice-confirm] Telegram PDF send failed:', tgErr.message);
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

  return { invoice, localInvoice, pdfSent, period };
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
      contasimpleResponse: result.invoice,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, status: e.status, body: e.body });
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
      contasimpleResponse: result.invoice,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, status: e.status, body: e.body });
  }
}));

// ============ HELPERS ============

router.get('/_period', asyncHandler(async (req, res) => {
  const date = req.query.date ? new Date(req.query.date) : new Date();
  res.json({ date: date.toISOString(), period: cs.dateToPeriod(date) });
}));

module.exports = router;
