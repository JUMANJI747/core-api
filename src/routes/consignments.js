'use strict';

const router = require('express').Router();
const asyncHandler = require('../asyncHandler');

router.post('/open', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { contractorId, notes } = req.body;
  if (!contractorId) return res.status(400).json({ error: 'contractorId required' });
  const c = await prisma.consignment.create({ data: { contractorId, notes } });
  res.json(c);
}));

router.post('/:id/received', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { items } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'items required' });
  const results = [];
  for (const item of items) {
    const existing = await prisma.consignmentItem.findUnique({
      where: { consignmentId_name: { consignmentId: req.params.id, name: item.name } },
    });
    if (existing) {
      const updated = await prisma.consignmentItem.update({
        where: { id: existing.id },
        data: { qtyReceived: existing.qtyReceived + (item.qty || 1), unitPrice: item.unitPrice || existing.unitPrice },
      });
      results.push(updated);
    } else {
      const created = await prisma.consignmentItem.create({
        data: { consignmentId: req.params.id, name: item.name, unitPrice: item.unitPrice || 0, qtyReceived: item.qty || 1 },
      });
      results.push(created);
    }
  }
  res.json({ ok: true, items: results });
}));

router.post('/:id/returned', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { items } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'items required' });
  const results = [];
  for (const item of items) {
    const found = await prisma.consignmentItem.findFirst({
      where: { consignmentId: req.params.id, name: { equals: item.name, mode: 'insensitive' } },
      include: { returns: true },
    });
    if (!found) { results.push({ name: item.name, error: 'not found' }); continue; }
    const totalReturned = found.returns.reduce((s, r) => s + r.qty, 0);
    const maxReturn = found.qtyReceived - totalReturned;
    const qty = Math.min(item.qty || 1, maxReturn);
    if (qty <= 0) { results.push({ name: item.name, error: 'nothing to return' }); continue; }
    const ret = await prisma.consignmentReturn.create({ data: { itemId: found.id, qty, note: item.note } });
    results.push({ name: item.name, returned: qty, ret });
  }
  res.json({ ok: true, items: results });
}));

router.get('/:id/summary', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const consignment = await prisma.consignment.findUnique({
    where: { id: req.params.id },
    include: { contractor: true, items: { include: { returns: true } } },
  });
  if (!consignment) return res.status(404).json({ error: 'not found' });

  let totalValue = 0;
  const lines = consignment.items.map((item) => {
    const returned = item.returns.reduce((s, r) => s + r.qty, 0);
    const sold = item.qtyReceived - returned;
    const unitPrice = Number(item.unitPrice);
    const value = sold * unitPrice;
    totalValue += value;
    return { name: item.name, unitPrice, received: item.qtyReceived, returned, sold, value };
  });

  res.json({
    id: consignment.id,
    contractor: consignment.contractor.name,
    status: consignment.status,
    lines,
    totalValue,
    createdAt: consignment.createdAt,
  });
}));

router.post('/:id/settle', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { method, note } = req.body;
  const consignment = await prisma.consignment.update({
    where: { id: req.params.id },
    data: { status: 'SETTLED', settledAt: new Date(), notes: note },
  });
  await prisma.auditLog.create({
    data: { actor: 'user', action: 'CONSIGNMENT_SETTLED', entityType: 'consignment', entityId: req.params.id, payload: { method, note } },
  });
  res.json(consignment);
}));

router.get('/', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { status, contractorId } = req.query;
  const where = {};
  if (status) where.status = status;
  if (contractorId) where.contractorId = contractorId;
  const list = await prisma.consignment.findMany({ where, include: { contractor: true }, orderBy: { createdAt: 'desc' } });
  res.json(list);
}));

module.exports = router;
