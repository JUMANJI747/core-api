'use strict';

/**
 * CRM v2 Etap 6 — scheduled jobs.
 *
 * Trigger: external (cron-job.org / GitHub Actions / Railway cron) →
 * POST /api/cron/<job> z headerem X-Cron-Key (env CRON_KEY). Pusty
 * CRON_KEY = endpoint odrzuca wszystko (fail-safe).
 *
 * Stan per-job w Config (key='cron:<job>:lastRunAt' / ':lastStatus' /
 * ':lastDurationMs' / ':lastError'). Idempotency lock: pg_try_advisory_lock
 * z hashem nazwy joba — drugi rownoczesny call dostaje 'skipped (busy)'.
 *
 * Health: GET /api/cron/health zwraca dla kazdego joba lastRunAt +
 * status + warnings (>26h od last ok dla daily jobow).
 */

const router = require('express').Router();
const { logActivity } = require('../services/activity-log');

function jobKey(job, suffix) { return `cron:${job}:${suffix}`; }

async function checkAuth(req) {
  const expected = (process.env.CRON_KEY || '').trim();
  if (!expected) return { ok: false, status: 503, error: 'CRON_KEY nie skonfigurowany na backendzie' };
  const got = req.get('X-Cron-Key') || req.query.key || '';
  if (got !== expected) return { ok: false, status: 401, error: 'invalid X-Cron-Key' };
  return { ok: true };
}

function hashJobName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h) + name.charCodeAt(i);
    h |= 0;
  }
  // Postgres bigint signed, mapujemy do bezpiecznego zakresu.
  return h;
}

async function withLock(prisma, jobName, fn) {
  const lockId = hashJobName(jobName);
  const got = await prisma.$queryRawUnsafe(`SELECT pg_try_advisory_lock($1)::text AS got`, lockId);
  if (!got || !got[0] || got[0].got !== 'true') {
    return { ok: false, skipped: true, reason: 'job busy (advisory lock taken)' };
  }
  try {
    return await fn();
  } finally {
    await prisma.$queryRawUnsafe(`SELECT pg_advisory_unlock($1)`, lockId).catch(() => {});
  }
}

async function persistRun(prisma, job, status, durationMs, payload) {
  const rows = [
    { key: jobKey(job, 'lastRunAt'), value: new Date().toISOString() },
    { key: jobKey(job, 'lastStatus'), value: status },
    { key: jobKey(job, 'lastDurationMs'), value: String(durationMs) },
  ];
  if (payload && payload.error) rows.push({ key: jobKey(job, 'lastError'), value: String(payload.error).slice(0, 500) });
  for (const r of rows) {
    await prisma.config.upsert({ where: { key: r.key }, update: { value: r.value }, create: r }).catch(() => {});
  }
}

async function runJob(prisma, name, runner, eventPrefix) {
  const startedAt = Date.now();
  logActivity(prisma, {
    type: `${eventPrefix}.started`,
    summary: `${name} start`,
    source: 'system',
    actorType: 'system', actorId: 'cron',
    payload: { job: name },
  });
  try {
    const result = await runner();
    const durationMs = Date.now() - startedAt;
    await persistRun(prisma, name, 'ok', durationMs);
    logActivity(prisma, {
      type: `${eventPrefix}.finished`,
      summary: `${name} ok (${durationMs}ms)`,
      source: 'system',
      actorType: 'system', actorId: 'cron',
      payload: { job: name, durationMs, ...(result && typeof result === 'object' ? result : {}) },
    });
    return { ok: true, durationMs, ...result };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    await persistRun(prisma, name, 'failed', durationMs, { error: err.message });
    logActivity(prisma, {
      type: `${eventPrefix}.failed`,
      summary: `${name} FAILED: ${err.message}`,
      source: 'system',
      actorType: 'system', actorId: 'cron',
      payload: { job: name, durationMs, error: err.message },
    });
    // Telegram notify
    try {
      const { resolveTelegram } = require('../services/telegram-helper');
      const { sendTelegram } = require('../telegram-utils');
      const tg = await resolveTelegram(prisma, { scope: 'pl' });
      if (tg.ready) {
        await sendTelegram(tg.token, String(tg.chatId), `❌ Cron ${name} FAILED\n${err.message}\n🔧 backend:cron`);
      }
    } catch (_) {}
    throw err;
  }
}

// ============ JOBS ============

router.post('/cron/sync-ifirma', async (req, res) => {
  const auth = await checkAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  const prisma = req.app.locals.prisma;
  try {
    const result = await withLock(prisma, 'sync-ifirma', async () => {
      return await runJob(prisma, 'sync-ifirma', async () => {
        const { processIfirmaInvoices, computeSyncWindow } = require('../services/ifirma-sync');
        const { fetchInvoices } = require('../ifirma-client');
        // Okno 60 dni, ALE rozszerzane do najstarszej nieoplaconej FV — sync
        // AKTUALIZUJE paidAmount/status, wiec musi objac stare FV, ktorych
        // platnosc zaksiegowano pozno (inaczej "oplacona" nie wskakuje do CRM).
        const { dataOd, dataDo } = await computeSyncWindow(prisma);
        const invs = await fetchInvoices({ dataOd, dataDo });
        const r = await processIfirmaInvoices(invs, prisma, { dataOd, dataDo, dryRun: false });
        // Auto-scal OCZYWISTE duplikaty (ten sam znormalizowany NIP) — tu właśnie
        // powstają z faktur. Best-effort: błąd dedupu nie psuje syncu.
        let contractorsDeduped = 0;
        try {
          const { selfCall } = require('../services/agent-runtime');
          const dd = await selfCall('POST', '/api/admin/dedupe-contractors', { apply: true });
          contractorsDeduped = (dd.body && dd.body.merged) || 0;
        } catch (e) {
          console.error('[cron/sync-ifirma] auto-dedupe failed:', e.message);
        }
        return { ...r, contractorsDeduped };
      }, 'sync.ifirma');
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/cron/sync-contasimple', async (req, res) => {
  const auth = await checkAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  const prisma = req.app.locals.prisma;
  try {
    const result = await withLock(prisma, 'sync-contasimple', async () => {
      return await runJob(prisma, 'sync-contasimple', async () => {
        // Wolamy istniejacy /api/contasimple/sync-customers przez self-loop
        // bo logika siedzi tam — nie duplikujemy.
        const http = require('http');
        const apiKey = (process.env.API_KEY || '').trim();
        return await new Promise((resolve, reject) => {
          const r = http.request({
            hostname: '127.0.0.1', port: process.env.PORT || 3000,
            path: '/api/contasimple/sync-customers', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
          }, (resp) => {
            const chunks = [];
            resp.on('data', c => chunks.push(c));
            resp.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch (e) { reject(e); }
            });
          });
          r.on('error', reject);
          r.end('{}');
        });
      }, 'sync.contasimple');
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/cron/prune-activity', async (req, res) => {
  const auth = await checkAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  const prisma = req.app.locals.prisma;
  try {
    const result = await withLock(prisma, 'prune-activity', async () => {
      return await runJob(prisma, 'prune-activity', async () => {
        const { runPrune } = require('../services/activity-prune');
        const r = await runPrune(prisma, { apply: true });
        const totalDeleted = r.policies.reduce((s, p) => s + (p.deleted || 0), 0);
        // Emit sync.activity_pruned with rollup.
        logActivity(prisma, {
          type: 'sync.activity_pruned',
          summary: `Pruned ${totalDeleted} activity events`,
          source: 'system',
          actorType: 'system', actorId: 'cron',
          payload: { totalDeleted, policies: r.policies },
        });
        return { totalDeleted, policies: r.policies };
      }, 'sync.activity_pruned');
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Raport miesięczny (9. dnia): iFirma sync → ile FV w KSeF / ile dosłać →
// ile WDT bez sparowanej wysyłki. Zakres domyślny: poprzedni miesiąc
// (override body {from,to} YYYY-MM-DD lub {month:"YYYY-MM"}). Wysyła Telegram.
function isWdtInvoice(inv) {
  const t = `${inv.ifirmaType || ''} ${inv.type || ''}`.toLowerCase();
  return t.includes('dostawa_ue') || t.includes('wdt');
}
function prevMonthRange() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59));
  return { from, to };
}

router.post('/cron/monthly-report', async (req, res) => {
  const auth = await checkAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  const prisma = req.app.locals.prisma;
  try {
    const result = await withLock(prisma, 'monthly-report', async () => {
      return await runJob(prisma, 'monthly-report', async () => {
        // Zakres
        let { from, to } = prevMonthRange();
        const b = req.body || {};
        if (b.month && /^\d{4}-\d{2}$/.test(b.month)) {
          const [y, m] = b.month.split('-').map(Number);
          from = new Date(Date.UTC(y, m - 1, 1));
          to = new Date(Date.UTC(y, m, 0, 23, 59, 59));
        }
        if (b.from) from = new Date(b.from);
        if (b.to) { to = new Date(b.to); to.setUTCHours(23, 59, 59, 999); }
        const fromIso = from.toISOString().slice(0, 10);
        const toIso = to.toISOString().slice(0, 10);

        // 1) iFirma sync (te same kroki co /cron/sync-ifirma)
        let sync = { created: 0, updated: 0 };
        try {
          const { processIfirmaInvoices, computeSyncWindow } = require('../services/ifirma-sync');
          const { fetchInvoices } = require('../ifirma-client');
          const win = await computeSyncWindow(prisma);
          const invs = await fetchInvoices({ dataOd: win.dataOd, dataDo: win.dataDo });
          const r = await processIfirmaInvoices(invs, prisma, { dataOd: win.dataOd, dataDo: win.dataDo, dryRun: false });
          sync = { created: (r.invoices && r.invoices.created) || 0, updated: (r.invoices && r.invoices.updated) || 0 };
        } catch (e) {
          console.error('[cron/monthly-report] iFirma sync failed:', e.message);
          sync = { error: e.message };
        }

        // 2) KSeF sync statusu sprzedaży (Subject1) — żeby ksefNumber był świeży
        let ksefSync = null;
        try {
          const { selfCall } = require('../services/agent-runtime');
          const r = await selfCall('POST', '/api/ksef/sync-sales-status', { from: fromIso, to: toIso });
          ksefSync = r.body && (r.body.matched != null) ? { matched: r.body.matched, found: r.body.found } : null;
        } catch (e) {
          console.error('[cron/monthly-report] ksef sync failed:', e.message);
        }

        // 3) Dane do raportu (wspólny builder — parowanie WDT jak na stronie Faktury)
        const { buildReport } = require('../services/monthly-accounting');
        const rep = await buildReport(prisma, { from, to });
        const total = rep.sales.total;
        const inKsef = rep.sales.inKsef;
        const toSendList = rep.sales.toSendNumbers;
        const wdtUnpairedList = rep.wdt.unpairedNumbers;
        const wdtTotal = rep.wdt.total;

        const report = {
          range: { from: fromIso, to: toIso },
          sync, ksefSync,
          sales: rep.sales,
          wdt: rep.wdt,
        };

        // 4) Telegram
        try {
          const { resolveTelegram } = require('../services/telegram-helper');
          const { sendTelegram } = require('../telegram-utils');
          const tg = await resolveTelegram(prisma, { scope: 'pl' });
          if (tg.ready) {
            const lines = [
              `📋 Raport miesięczny ${fromIso} → ${toIso}`,
              ``,
              `🔄 iFirma sync: ${sync.error ? '⚠ ' + sync.error : `+${sync.created} / ~${sync.updated}`}`,
              ``,
              `🧾 Sprzedaż (iFirma): ${total} FV`,
              `   ✅ w KSeF: ${inKsef}`,
              `   📨 do dosłania: ${toSendList.length}${toSendList.length ? '\n      ' + toSendList.slice(0, 30).join(', ') + (toSendList.length > 30 ? ' …' : '') : ''}`,
              ``,
              `🚚 WDT bez sparowanej wysyłki: ${wdtUnpairedList.length} / ${wdtTotal}${wdtUnpairedList.length ? '\n   ' + wdtUnpairedList.slice(0, 30).join(', ') + (wdtUnpairedList.length > 30 ? ' …' : '') : ''}`,
            ];
            await sendTelegram(tg.token, String(tg.chatId), lines.join('\n'));
          }
        } catch (e) {
          console.error('[cron/monthly-report] telegram failed:', e.message);
        }

        return report;
      }, 'sync.monthly_report');
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============ HEALTH ============
router.get('/cron/health', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const KNOWN_JOBS = ['sync-ifirma', 'sync-contasimple', 'prune-activity', 'monthly-report'];
  const out = {};
  const warnings = [];
  const now = Date.now();
  for (const j of KNOWN_JOBS) {
    const [lastRun, status, dur, err] = await Promise.all([
      prisma.config.findUnique({ where: { key: jobKey(j, 'lastRunAt') } }),
      prisma.config.findUnique({ where: { key: jobKey(j, 'lastStatus') } }),
      prisma.config.findUnique({ where: { key: jobKey(j, 'lastDurationMs') } }),
      prisma.config.findUnique({ where: { key: jobKey(j, 'lastError') } }),
    ]);
    const lastRunAt = lastRun ? lastRun.value : null;
    out[j] = {
      lastRunAt,
      lastStatus: status ? status.value : null,
      lastDurationMs: dur ? parseInt(dur.value, 10) : null,
      ...(status && status.value === 'failed' && err ? { lastError: err.value } : {}),
    };
    if (lastRunAt) {
      const ageH = (now - new Date(lastRunAt).getTime()) / (1000 * 60 * 60);
      if (ageH > 26 && j.startsWith('sync-')) warnings.push(`${j}: missed expected run window (>${Math.round(ageH)}h since last run)`);
      if (out[j].lastStatus === 'failed') warnings.push(`${j}: last run FAILED — ${out[j].lastError || 'no detail'}`);
    } else {
      warnings.push(`${j}: never ran`);
    }
  }
  res.json({ jobs: out, warnings });
});

module.exports = router;
