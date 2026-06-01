'use strict';

const http = require('http');
const router = require('express').Router();

function internalPost(path, apiKey, bodyObj) {
  return new Promise((resolve, reject) => {
    const port = process.env.PORT || 3000;
    const body = JSON.stringify(bodyObj || {});
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
  const { limit, chatId, scope } = req.query;
  if (!chatId) return res.json([]);
  const take = Math.min(parseInt(limit) || 20, 100);
  const where = { chatId };
  // scope rozdzelinia PL/Kanary boty ktore na Telegram maja ten sam
  // chat.id (= user.id w privacie). Bez scope -> backward compat (zwraca
  // wszystko po chatId, tak jak wczesniej). Z scope -> tylko swojego bota.
  if (scope) where.scope = scope;
  const messages = await prisma.memory.findMany({
    where,
    take,
    orderBy: { createdAt: 'desc' },
  });
  res.json(messages.reverse());
});

router.post('/memory', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { role, content, chatId, scope } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  const msg = await prisma.memory.create({
    data: { chatId, role, content, scope: scope || 'pl' },
  });
  res.json(msg);
});

router.delete('/memory/clear', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { chatId, scope } = req.query;
  if (!chatId) return res.status(400).json({ error: 'chatId required (use /memory/cleanup to purge orphans)' });
  const where = { chatId };
  if (scope) where.scope = scope;
  const result = await prisma.memory.deleteMany({ where });
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
        pg_total_relation_size(c.oid)::text AS bytes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = 'public'
      ORDER BY pg_total_relation_size(c.oid) DESC
      LIMIT 15
    `;

    const dbSize = await prisma.$queryRaw`SELECT pg_size_pretty(pg_database_size(current_database())) as total, pg_database_size(current_database())::text as bytes`;

    let bloat = [];
    try {
      bloat = await prisma.$queryRaw`
        SELECT relname as "table", n_dead_tup::text as dead, n_live_tup::text as live,
          pg_size_pretty(pg_total_relation_size(c.oid)) as size
        FROM pg_stat_user_tables t
        JOIN pg_class c ON c.relname = t.relname AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
        WHERE n_dead_tup > 0
        ORDER BY n_dead_tup DESC LIMIT 10
      `;
    } catch (e) { bloat = [{ error: e.message }]; }

    let walSize = null;
    try {
      const wal = await prisma.$queryRaw`SELECT pg_size_pretty(sum(size)) as wal_size FROM pg_ls_waldir()`;
      walSize = wal[0] && wal[0].wal_size;
    } catch (e) { walSize = 'no permission'; }

    // Cleanup old drafts if requested
    let cleaned = null;
    if (req.query.cleanup === 'true') {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const deletedDrafts = await prisma.email.deleteMany({ where: { direction: 'DRAFT', createdAt: { lt: dayAgo } } });
      cleaned = { draftsDeleted: deletedDrafts.count };

      // VACUUM after cleanup
      try { await prisma.$executeRawUnsafe('VACUUM ANALYZE'); cleaned.vacuum = 'ok'; } catch (e) { cleaned.vacuum = e.message; }
    }

    // Deep diagnostics
    let walFiles = null;
    try {
      const wf = await prisma.$queryRaw`SELECT count(*)::text as count, pg_size_pretty(sum(size)::bigint) as total FROM pg_ls_waldir()`;
      walFiles = { count: parseInt(wf[0].count), total: wf[0].total };
    } catch (e) { walFiles = { error: e.message }; }

    let replicationSlots = [];
    try {
      replicationSlots = await prisma.$queryRaw`
        SELECT slot_name, slot_type, active::text,
          pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as retained_wal,
          pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::text as retained_bytes
        FROM pg_replication_slots
      `;
      replicationSlots = replicationSlots.map(s => ({ ...s, retained_bytes: parseInt(s.retained_bytes || 0) }));
    } catch (e) { replicationSlots = [{ error: e.message }]; }

    let walSettings = [];
    try {
      walSettings = await prisma.$queryRaw`
        SELECT name, setting, unit FROM pg_settings
        WHERE name IN ('wal_keep_size','max_wal_size','min_wal_size','wal_level','archive_mode','max_slot_wal_keep_size')
      `;
    } catch (e) { walSettings = [{ error: e.message }]; }

    res.json({
      ok: true,
      totalDbSize: { total: dbSize[0].total, bytes: parseInt(dbSize[0].bytes) },
      counts,
      sizes: sizes.map(s => ({ ...s, bytes: parseInt(s.bytes) })),
      bloat: bloat.map(b => ({ ...b, dead: parseInt(b.dead || 0), live: parseInt(b.live || 0) })),
      walSize,
      walFiles,
      replicationSlots,
      walSettings,
      ...(cleaned ? { cleaned } : {}),
    });
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

    // Optional carrier hint z body (np. "Tak zamów FedEx" → carrier=FedEx).
    // Backward-compat: stare wywołania bez body dalej działają.
    const carrierHint = (req.body && (req.body.carrier || req.body.productId)) || null;
    const chatIdFromBody = req.body && req.body.chatId ? String(req.body.chatId) : null;

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

    // Check newest GK courier quote < 30 min. Quoty żyją w in-memory
    // app.locals.quoteStore (zapisywane przez /api/glob/quote). Dla
    // "Tak zamów FedEx" → potwierdzamy najświeższą wycenę i strzelamy
    // do /api/glob/order.
    let quoteTimestamp = null;
    let newestQuoteId = null;
    let newestQuoteOffers = null;
    const quoteStore = req.app.locals.quoteStore || {};
    for (const k of Object.keys(quoteStore)) {
      const q = quoteStore[k];
      if (!q || !q.createdAt) continue;
      const ts = new Date(q.createdAt).getTime();
      if (now - ts >= thirtyMin) continue;
      if (!quoteTimestamp || ts > quoteTimestamp) {
        quoteTimestamp = ts;
        newestQuoteId = k;
        newestQuoteOffers = q.offers || [];
      }
    }
    // DB fallback — pamiec procesu (quoteStore) gubiona przy restarcie/redeployu,
    // przez co "tak" po wycenie nie znajdowalo zamowienia (Master wpadal w petle).
    // Wycena jest trwale w tabeli Quote — bierzemy najnowsza w oknie 30 min.
    if (!quoteTimestamp) {
      try {
        const row = await prisma.quote.findFirst({
          where: { createdAt: { gte: new Date(now - thirtyMin) } },
          orderBy: { createdAt: 'desc' },
        });
        if (row && row.data) {
          quoteTimestamp = new Date(row.createdAt).getTime();
          newestQuoteId = row.id;
          newestQuoteOffers = row.data.offers || [];
        }
      } catch (e) { console.error('[confirm-latest] quote DB fallback error:', e.message); }
    }

    if (!invoiceTimestamp && !emailTimestamp && !quoteTimestamp) {
      const lastAction = agentCtx && agentCtx.data && agentCtx.data.lastAction;
      const why = lastAction === 'confirmed'
        ? 'Ostatnia akcja została już potwierdzona — nie ma świeżego podglądu/draftu do zatwierdzenia.'
        : 'Brak aktywnego podglądu faktury, draftu maila ani wyceny kuriera do zatwierdzenia.';
      return res.status(400).json({
        ok: false,
        error: 'Nic do potwierdzenia',
        reason: why,
        hint: 'To narzędzie służy WYŁĄCZNIE do zatwierdzenia świeżego podglądu (do 30 min). Aby wystawić nową fakturę albo wysłać nowego maila — użyj Sub-agent Księgowość lub Sub-agent Komunikacja, NIE tego narzędzia. NIE retryuj — wybierz inny tool.',
      });
    }

    const apiKey = req.headers['x-api-key'] || '';

    // Pick newest of three (invoice / email / GK quote)
    const winner = [
      { kind: 'invoice', ts: invoiceTimestamp },
      { kind: 'email', ts: emailTimestamp },
      { kind: 'shipment', ts: quoteTimestamp },
    ].filter(x => x.ts).sort((a, b) => b.ts - a.ts)[0];

    if (winner.kind === 'invoice') {
      const result = await internalPost('/api/ifirma/invoice-confirm-latest', apiKey);
      return res.json({ ok: true, type: 'invoice', result });
    }
    if (winner.kind === 'email') {
      const result = await internalPost('/api/send-email/confirm-latest', apiKey);
      return res.json({ ok: true, type: 'email', result });
    }
    // shipment: order cheapest (or carrier hint if podany)
    const orderBody = { quoteId: newestQuoteId };
    if (carrierHint) orderBody.productId = carrierHint;
    if (chatIdFromBody) orderBody.chatId = chatIdFromBody;
    const result = await internalPost('/api/glob/order', apiKey, orderBody);
    return res.json({ ok: true, type: 'shipment', quoteId: newestQuoteId, carrier: carrierHint || 'cheapest', result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy do Telegrama — wysyłka wiadomości tekstowej bez parse_mode (czysty
// plain text, Telegram nie próbuje parsować markdown/html). Master n8n
// woła ten endpoint zamiast natywnego Telegram node który wymusza wybór
// HTML/Markdown/MarkdownV2 z dropdown — przy każdym znaku specjalnym wywala
// "can't parse entities".
//
// Body: { chatId, text, scope?: 'pl'|'kanary' }
// Token wybiera backend: scope='kanary' → env_KANARY/env_ES → Config kanary
//                       scope='pl' (default) → env TELEGRAM_BOT_TOKEN → Config telegram_bot_token
router.post('/telegram-send', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { chatId, text, scope } = req.body || {};
  if (!chatId) return res.status(400).json({ ok: false, error: 'chatId required' });
  if (!text || typeof text !== 'string') return res.status(400).json({ ok: false, error: 'text (string) required' });

  const { resolveToken } = require('../services/telegram-helper');
  const { token } = await resolveToken(prisma, scope);
  if (!token) return res.status(503).json({ ok: false, error: 'no telegram bot token configured' });

  const { sendTelegram } = require('../telegram-utils');
  try {
    const tgResp = await sendTelegram(token, String(chatId), text);
    if (tgResp && tgResp.ok) {
      return res.json({ ok: true, messageId: tgResp.result && tgResp.result.message_id, chatId, scope: scope || 'pl' });
    }
    return res.json({ ok: false, error: (tgResp && tgResp.description) || 'unknown', tgResponse: tgResp });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

module.exports = router;
