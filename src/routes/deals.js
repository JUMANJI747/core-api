'use strict';

const router = require('express').Router();
const asyncHandler = require('../asyncHandler');
const { validateBody, z } = require('../validate');

const createDealSchema = z.object({
  contractorId: z.string().min(1),
  status: z.string().optional(),
  language: z.string().optional(),
  campaign: z.string().optional(),
  value: z.coerce.number().optional(),
  currency: z.string().optional(),
  notes: z.string().optional(),
  // n8n Master agent tool sends `title`; Deal has no title column.
  // Treat as alias for notes when notes is empty.
  title: z.string().optional(),
  nextAction: z.string().optional(),
  nextActionDate: z.string().optional(),
}).transform(d => ({ ...d, notes: d.notes || d.title, title: undefined }));

router.post('/', validateBody(createDealSchema), asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { contractorId, status, language, campaign, value, currency, notes, nextAction, nextActionDate } = req.body;
  const deal = await prisma.deal.create({
    data: { contractorId, status: status || 'LEAD', language, campaign, value, currency, notes, nextAction, nextActionDate: nextActionDate ? new Date(nextActionDate) : null },
  });
  await prisma.activity.create({ data: { dealId: deal.id, type: 'STATUS_CHANGE', note: `Created as ${deal.status}`, actor: 'system' } });
  res.json(deal);
}));

router.patch('/:id/status', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { status, note, actor } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  const deal = await prisma.deal.update({ where: { id: req.params.id }, data: { status, updatedAt: new Date() } });
  await prisma.activity.create({ data: { dealId: deal.id, type: 'STATUS_CHANGE', note: note || `→ ${status}`, actor: actor || 'user' } });
  res.json(deal);
}));

router.post('/:id/activity', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { type, note, data, actor } = req.body;
  const activity = await prisma.activity.create({
    data: { dealId: req.params.id, type: type || 'NOTE', note, data: data || {}, actor: actor || 'user' },
  });
  res.json(activity);
}));

router.get('/', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { status, campaign, limit } = req.query;
  const where = {};
  if (status) where.status = status;
  if (campaign) where.campaign = { contains: campaign, mode: 'insensitive' };
  const deals = await prisma.deal.findMany({ where, include: { contractor: true, activities: { take: 5, orderBy: { createdAt: 'desc' } } }, take: parseInt(limit) || 50, orderBy: { updatedAt: 'desc' } });
  res.json(deals);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const deal = await prisma.deal.findUnique({ where: { id: req.params.id }, include: { contractor: true, activities: { orderBy: { createdAt: 'desc' } } } });
  if (!deal) return res.status(404).json({ error: 'not found' });
  res.json(deal);
}));

module.exports = router;
