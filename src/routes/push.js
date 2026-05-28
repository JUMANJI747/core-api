'use strict';

const router = require('express').Router();
const webpush = require('web-push');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:michal.palyska747@gmail.com';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

const CONFIG_KEY = 'push_subscriptions';

async function loadSubs(prisma) {
  try {
    const cfg = await prisma.config.findUnique({ where: { key: CONFIG_KEY } });
    if (!cfg || !cfg.value) return [];
    return JSON.parse(cfg.value);
  } catch (_) { return []; }
}

async function saveSubs(prisma, subs) {
  await prisma.config.upsert({
    where: { key: CONFIG_KEY },
    update: { value: JSON.stringify(subs) },
    create: { key: CONFIG_KEY, value: JSON.stringify(subs) },
  });
}

router.get('/push/vapid-public', (req, res) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'VAPID_PUBLIC_KEY not set in env' });
  res.json({ publicKey: VAPID_PUBLIC });
});

router.post('/push/subscribe', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'subscription required' });
  try {
    const subs = await loadSubs(prisma);
    const exists = subs.find(s => s.endpoint === sub.endpoint);
    if (!exists) {
      subs.push({ ...sub, subscribedAt: new Date().toISOString() });
      await saveSubs(prisma, subs);
    }
    res.json({ ok: true, total: subs.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/push/unsubscribe', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  try {
    const subs = await loadSubs(prisma);
    const filtered = subs.filter(s => s.endpoint !== endpoint);
    await saveSubs(prisma, filtered);
    res.json({ ok: true, removed: subs.length - filtered.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/push/test', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const r = await sendPushToAll(prisma, {
      title: 'SSB CRM — test',
      body: req.body?.message || 'Powiadomienie testowe',
      url: '/dashboard',
    });
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

async function sendPushToAll(prisma, payload) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return { ok: false, error: 'VAPID keys not configured' };
  }
  const subs = await loadSubs(prisma);
  if (!subs.length) return { ok: true, sent: 0, removed: 0 };
  const data = JSON.stringify(payload);
  let sent = 0;
  const stillValid = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, data);
      sent++;
      stillValid.push(sub);
    } catch (err) {
      console.warn('[push] failed sub:', err.statusCode, err.body || err.message);
      if (err.statusCode !== 404 && err.statusCode !== 410) {
        stillValid.push(sub);
      }
    }
  }
  if (stillValid.length !== subs.length) {
    await saveSubs(prisma, stillValid);
  }
  return { ok: true, sent, removed: subs.length - stillValid.length, total: stillValid.length };
}

module.exports = router;
module.exports.sendPushToAll = sendPushToAll;
