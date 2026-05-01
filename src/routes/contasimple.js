'use strict';

const router = require('express').Router();
const asyncHandler = require('../asyncHandler');
const cs = require('../contasimple-client');

// Sanity-check endpoint. After deploy, run:
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

module.exports = router;
