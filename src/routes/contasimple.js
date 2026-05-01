'use strict';

const router = require('express').Router();
const prisma = require('../db');
const asyncHandler = require('../asyncHandler');
const cs = require('../contasimple-client');

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

// ============ HELPERS ============

router.get('/_period', asyncHandler(async (req, res) => {
  const date = req.query.date ? new Date(req.query.date) : new Date();
  res.json({ date: date.toISOString(), period: cs.dateToPeriod(date) });
}));

module.exports = router;
