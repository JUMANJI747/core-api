'use strict';

const router = require('express').Router();
const asyncHandler = require('../asyncHandler');
const { processLogisticsQuery } = require('../services/logistics-agent');
const { processAccountingQuery } = require('../services/accounting-agent');
const { processAccountingEsQuery } = require('../services/accounting-agent-es');
const { processCommunicationQuery } = require('../services/communication-agent');
const { processOperationsQuery } = require('../services/operations-agent');

// Stateless agent endpoints. Master agent (n8n) sends a self-contained query
// (with any context it wants the sub-agent to see), gets back a text reply.

router.post('/agent/logistics', asyncHandler(async (req, res) => {
  const { query } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query (string) required' });
  }
  const result = await processLogisticsQuery(query);
  res.json(result);
}));

router.post('/agent/accounting', asyncHandler(async (req, res) => {
  const { query } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query (string) required' });
  }
  const result = await processAccountingQuery(query);
  res.json(result);
}));

router.post('/agent/accounting-es', asyncHandler(async (req, res) => {
  const { query, chatId } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query (string) required' });
  }
  const result = await processAccountingEsQuery(query, { chatId });
  res.json(result);
}));

router.post('/agent/communication', asyncHandler(async (req, res) => {
  const { query } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query (string) required' });
  }
  const result = await processCommunicationQuery(query);
  res.json(result);
}));

router.post('/agent/operations', asyncHandler(async (req, res) => {
  const { query } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query (string) required' });
  }
  const result = await processOperationsQuery(query);
  res.json(result);
}));

module.exports = router;
