'use strict';

const router = require('express').Router();
const asyncHandler = require('../asyncHandler');
const { processLogisticsQuery } = require('../services/logistics-agent');

// Stateless agent endpoint. Master agent (n8n) sends a self-contained query
// (with any context it wants the sub-agent to see), gets back a text reply.
router.post('/agent/logistics', asyncHandler(async (req, res) => {
  const { query } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query (string) required' });
  }
  const result = await processLogisticsQuery(query);
  res.json(result);
}));

module.exports = router;
