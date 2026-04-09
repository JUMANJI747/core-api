'use strict';

const http = require('http');
const router = require('express').Router();

function internalPost(path, apiKey) {
  return new Promise((resolve, reject) => {
    const port = process.env.PORT || 3000;
    const body = '{}';
    const options = {
      hostname: 'localhost',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': apiKey || '',
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON from internal endpoint')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

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
  const { limit, chatId } = req.query;
  if (!chatId) return res.json([]);
  const take = Math.min(parseInt(limit) || 20, 100);
  const messages = await prisma.memory.findMany({
    where: { chatId },
    take,
    orderBy: { createdAt: 'desc' },
  });
  res.json(messages.reverse());
});

router.post('/memory', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { role, content, chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  const msg = await prisma.memory.create({ data: { chatId, role, content } });
  res.json(msg);
});

router.delete('/memory/clear', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { chatId } = req.query;
  if (!chatId) return res.status(400).json({ error: 'chatId required (use /memory/cleanup to purge orphans)' });
  const result = await prisma.memory.deleteMany({ where: { chatId } });
  res.json({ ok: true, deleted: result.count });
});

router.post('/memory/cleanup', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const result = await prisma.memory.deleteMany({ where: { chatId: null } });
  res.json({ ok: true, deleted: result.count });
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

// ============ DB STATS ============

router.get('/db-stats', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const counts = {
      emails: await prisma.email.count(),
      emailsInbound: await prisma.email.count({ where: { direction: 'INBOUND' } }),
      emailsOutbound: await prisma.email.count({ where: { direction: 'OUTBOUND' } }),
      emailsDraft: await prisma.email.count({ where: { direction: 'DRAFT' } }),
      emailAttachments: await prisma.emailAttachment.count(),
      documents: await prisma.document.count(),
      monthlyPackages: await prisma.monthlyPackage.count(),
      invoices: await prisma.invoice.count(),
      contractors: await prisma.contractor.count(),
      memory: await prisma.memory.count(),
    };

    const sizes = await prisma.$queryRaw`
      SELECT
        c.relname AS "table",
        pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
        pg_total_relation_size(c.oid) AS bytes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = 'public'
      ORDER BY pg_total_relation_size(c.oid) DESC
      LIMIT 15
    `;

    res.json({ ok: true, counts, sizes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// ============ CONFIRM LATEST ============

router.post('/confirm-latest', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const now = Date.now();
    const thirtyMin = 30 * 60 * 1000;

    // Check AgentContext "ksiegowosc" for invoice preview
    let invoiceTimestamp = null;
    const agentCtx = await prisma.agentContext.findUnique({ where: { id: 'ksiegowosc' } });
    if (agentCtx && agentCtx.data && agentCtx.data.lastAction === 'preview') {
      const ts = agentCtx.data.timestamp;
      if (ts && (now - ts) < thirtyMin) {
        invoiceTimestamp = ts;
      }
    }

    // Check newest email draft < 30 min
    let emailTimestamp = null;
    const thirtyMinutesAgo = new Date(now - thirtyMin);
    const draft = await prisma.email.findFirst({
      where: { direction: 'DRAFT', createdAt: { gte: thirtyMinutesAgo } },
      orderBy: { createdAt: 'desc' },
    });
    if (draft) {
      emailTimestamp = draft.createdAt.getTime();
    }

    if (!invoiceTimestamp && !emailTimestamp) {
      return res.json({ ok: false, error: 'Nic do potwierdzenia' });
    }

    const apiKey = req.headers['x-api-key'] || '';

    // Take the newer of the two
    if (invoiceTimestamp && (!emailTimestamp || invoiceTimestamp >= emailTimestamp)) {
      const result = await internalPost('/api/ifirma/invoice-confirm-latest', apiKey);
      return res.json({ ok: true, type: 'invoice', result });
    } else {
      const result = await internalPost('/api/send-email/confirm-latest', apiKey);
      return res.json({ ok: true, type: 'email', result });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
