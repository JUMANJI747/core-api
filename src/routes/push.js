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
    const ua = String(req.headers['user-agent'] || '').slice(0, 200);
    if (!exists) {
      subs.push({ ...sub, subscribedAt: new Date().toISOString(), ua });
    } else {
      // Ponowna rejestracja tego samego endpointu (guzik „Napraw"/odświeżenie
      // kluczy) — aktualizujemy klucze i stempel, nie dublujemy wpisu.
      Object.assign(exists, { keys: sub.keys || exists.keys, lastSeenAt: new Date().toISOString(), ua });
    }
    await saveSubs(prisma, subs);
    res.json({ ok: true, total: subs.length, registered: true, isNew: !exists });
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

/* DIAGNOSTYKA PUSH (13.10.2026). „Guzik testu nic nie daje" — backend wysyłał
 * do 4 subskrypcji z czerwca i wszystkie przyjmował Apple/Google, ale nie było
 * jak sprawdzić, czy TO urządzenie jest wśród nich. Teraz:
 *   POST /push/check {endpoint}   → czy backend zna subskrypcję tej przeglądarki
 *   GET  /push/subscriptions      → lista (host, data, UA) bez kluczy
 *   POST /push/test {endpoint?}   → wynik PER subskrypcja (host, kod odpowiedzi) */
const hostZ = (ep) => { try { return new URL(ep).host; } catch (_) { return '?'; } };
const skrotZ = (ep) => String(ep || '').slice(-12);

router.post('/push/check', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { endpoint } = req.body || {};
  const subs = await loadSubs(prisma);
  const mine = endpoint ? subs.find(s => s.endpoint === endpoint) : null;
  res.json({ ok: true, registered: !!mine, total: subs.length, vapid: !!(VAPID_PUBLIC && VAPID_PRIVATE),
    mine: mine ? { host: hostZ(mine.endpoint), skrot: skrotZ(mine.endpoint), subscribedAt: mine.subscribedAt, lastSeenAt: mine.lastSeenAt || null } : null });
});

router.get('/push/subscriptions', async (req, res) => {
  const subs = await loadSubs(req.app.locals.prisma);
  res.json({ ok: true, total: subs.length, vapid: !!(VAPID_PUBLIC && VAPID_PRIVATE),
    subs: subs.map(s => ({ host: hostZ(s.endpoint), skrot: skrotZ(s.endpoint), subscribedAt: s.subscribedAt, lastSeenAt: s.lastSeenAt || null, ua: s.ua || null })) });
});

router.post('/push/test', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { endpoint, message } = req.body || {};
    const r = await sendPushToAll(prisma, {
      title: 'SSB CRM — test',
      body: message || 'Powiadomienie testowe',
      url: '/dashboard',
      tag: `test-${Date.now()}`,
    }, { onlyEndpoint: endpoint || null });
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

async function sendPushToAll(prisma, payload, opts = {}) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return { ok: false, error: 'VAPID keys not configured' };
  }
  const subs = await loadSubs(prisma);
  if (!subs.length) return { ok: true, sent: 0, removed: 0, total: 0, wyniki: [] };
  const cel = opts.onlyEndpoint ? subs.filter(s => s.endpoint === opts.onlyEndpoint) : subs;
  if (opts.onlyEndpoint && !cel.length) return { ok: false, error: 'Backend nie zna subskrypcji tej przeglądarki — zarejestruj ponownie.', sent: 0, total: subs.length, wyniki: [] };
  const data = JSON.stringify(payload);
  let sent = 0;
  const martwe = new Set();
  const wyniki = [];
  for (const sub of cel) {
    try {
      // TTL 1h + urgency high: iOS doręcza od razu zamiast grupować; stare
      // powiadomienia (mail sprzed godziny) nie mają sensu po czasie.
      const r = await webpush.sendNotification(sub, data, { TTL: 3600, urgency: 'high' });
      sent++;
      wyniki.push({ host: hostZ(sub.endpoint), skrot: skrotZ(sub.endpoint), ok: true, status: r && r.statusCode });
    } catch (err) {
      console.warn('[push] failed sub:', err.statusCode, err.body || err.message);
      wyniki.push({ host: hostZ(sub.endpoint), skrot: skrotZ(sub.endpoint), ok: false, status: err.statusCode || null, error: String(err.body || err.message || '').slice(0, 160) });
      if (err.statusCode === 404 || err.statusCode === 410) martwe.add(sub.endpoint);
    }
  }
  if (martwe.size) await saveSubs(prisma, subs.filter(s => !martwe.has(s.endpoint)));
  return { ok: true, sent, removed: martwe.size, total: subs.length - martwe.size, wyniki };
}

module.exports = router;
module.exports.sendPushToAll = sendPushToAll;
