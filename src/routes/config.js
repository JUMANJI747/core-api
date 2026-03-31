'use strict';

const router = require('express').Router();

// ============ CONFIG ============

router.get('/config', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const configs = await prisma.config.findMany();
  const obj = {};
  configs.forEach((c) => (obj[c.key] = c.value));
  res.json(obj);
});

router.put('/config/:key', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { value } = req.body;
  const config = await prisma.config.upsert({
    where: { key: req.params.key },
    update: { value: String(value) },
    create: { key: req.params.key, value: String(value) },
  });
  res.json(config);
});

// ============ MEMORY ============

router.get('/memory', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { limit } = req.query;
  const messages = await prisma.memory.findMany({ take: parseInt(limit) || 20, orderBy: { createdAt: 'desc' } });
  res.json(messages.reverse());
});

router.post('/memory', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { role, content } = req.body;
  const msg = await prisma.memory.create({ data: { role, content } });
  res.json(msg);
});

router.delete('/memory/clear', async (req, res) => {
  const prisma = req.app.locals.prisma;
  await prisma.memory.deleteMany();
  res.json({ ok: true });
});

// ============ EVENTS ============

router.get('/events', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { type, severity, resolved, limit, since } = req.query;
  const where = {};
  if (type) where.type = type;
  if (severity) where.severity = severity;
  if (resolved !== undefined) where.resolved = resolved === 'true';
  if (since) where.createdAt = { gte: new Date(since) };
  const events = await prisma.systemEvent.findMany({
    where,
    take: Math.min(parseInt(limit) || 50, 500),
    orderBy: { createdAt: 'desc' },
  });
  res.json(events);
});

// ============ AUDIT ============

router.post('/audit', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const log = await prisma.auditLog.create({ data: req.body });
  res.json(log);
});

// ============ DASHBOARD STATS ============

router.get('/stats', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const [contractors, openDeals, openConsignments, unreadEmails, pendingMailing] = await Promise.all([
    prisma.contractor.count(),
    prisma.deal.count({ where: { status: { notIn: ['PAID', 'CLIENT', 'LOST'] } } }),
    prisma.consignment.count({ where: { status: 'OPEN' } }),
    prisma.email.count({ where: { isRead: false, direction: 'INBOUND' } }),
    prisma.mailingContact.count({ where: { status: 'PENDING' } }),
  ]);
  res.json({ contractors, openDeals, openConsignments, unreadEmails, pendingMailing });
});

// ============ AGENT CONTEXT ============

router.get('/agent-context/:agentId', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const entry = await prisma.agentContext.findUnique({ where: { id: req.params.agentId } });
    res.json(entry ? entry.data : {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/agent-context/:agentId', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { data } = req.body;
    if (data === undefined) return res.status(400).json({ error: 'data required' });
    const entry = await prisma.agentContext.upsert({
      where: { id: req.params.agentId },
      update: { data },
      create: { id: req.params.agentId, data },
    });
    res.json({ ok: true, data: entry.data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
