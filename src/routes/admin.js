'use strict';

const router = require('express').Router();
const { getToken: getGkToken } = require('../glob-client');
const { runBackfill: runContractorV2Backfill } = require('../services/contractor-v2-backfill');
const { runBackfill: runContractorContactsBackfill } = require('../services/contractor-contacts-backfill');
const { runBackfill: runInvoiceSnapshotsBackfill } = require('../services/invoice-snapshot-backfill');
const https = require('https');

// ============ ADMIN ENDPOINTS ============
// Każdy z tych endpointów jest opakowaniem dla potężnej operacji której
// zwykłe sub-agenty nie powinny mieć dostępu. Dostępne dla Sudo Agenta
// (i bezpośrednio przez API_KEY auth — to ten sam klucz co wszędzie).
//
// Każda destrukcyjna operacja loguje pełny request i caller w Railway →
// trail audytowy.

// Read-only SQL. Tylko SELECT (regex check). Zwraca max 500 wierszy.
router.post('/admin/query', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { sql, params } = req.body || {};
  if (!sql || typeof sql !== 'string') return res.status(400).json({ error: 'sql (string) required' });
  const trimmed = sql.trim().replace(/^\s*--.*$/gm, '').trim();
  // Permissive read-only check: must start with SELECT or WITH (CTE), must not
  // contain destructive keywords as standalone words.
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    return res.status(400).json({ error: 'only SELECT / WITH queries allowed in /admin/query — use /admin/mutate for writes' });
  }
  if (/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/i.test(trimmed)) {
    return res.status(400).json({ error: 'destructive keyword detected — use /admin/mutate for writes' });
  }
  try {
    console.log(`[admin/query] ${trimmed.slice(0, 300)}`);
    const rows = await prisma.$queryRawUnsafe(trimmed, ...(Array.isArray(params) ? params : []));
    const arr = Array.isArray(rows) ? rows : [rows];
    res.json({ ok: true, rowCount: arr.length, rows: arr.slice(0, 500), truncated: arr.length > 500 });
  } catch (e) {
    console.error('[admin/query] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Destructive SQL. INSERT / UPDATE / DELETE / etc. WYMAGA confirm:true.
router.post('/admin/mutate', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { sql, params, confirm } = req.body || {};
  if (!sql || typeof sql !== 'string') return res.status(400).json({ error: 'sql required' });
  if (confirm !== true) return res.status(400).json({ error: 'destructive — pass { "confirm": true } to proceed' });
  try {
    console.warn(`[admin/mutate] ${sql.trim().slice(0, 500)}`);
    const affected = await prisma.$executeRawUnsafe(sql, ...(Array.isArray(params) ? params : []));
    res.json({ ok: true, rowsAffected: affected });
  } catch (e) {
    console.error('[admin/mutate] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Proxy: wywołaj DOWOLNY endpoint naszego backendu (/api/*) tym samym
// kluczem co request. Pozwala Sudo wywołać każdy istniejący endpoint
// nawet jeśli zwykły sub-agent go nie ma w toolach.
router.post('/admin/call-endpoint', async (req, res) => {
  const http = require('http');
  const { method = 'POST', path, body } = req.body || {};
  if (!path || typeof path !== 'string') return res.status(400).json({ error: 'path required (e.g. "/api/transactions")' });
  if (!path.startsWith('/api/')) return res.status(400).json({ error: 'path must start with /api/' });
  const apiKey = (process.env.API_KEY || '').trim();
  const data = body && method !== 'GET' ? JSON.stringify(body) : '';
  let finalPath = path;
  if (method === 'GET' && body && typeof body === 'object') {
    const params = Object.entries(body).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]);
    if (params.length) finalPath = `${path}?${new URLSearchParams(params).toString()}`;
  }
  console.log(`[admin/call-endpoint] ${method} ${finalPath}`);
  const opts = {
    hostname: '127.0.0.1', port: process.env.PORT || 3000, path: finalPath, method,
    headers: {
      'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
  };
  const proxyReq = http.request(opts, (proxyRes) => {
    const chunks = [];
    proxyRes.on('data', c => chunks.push(c));
    proxyRes.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      try { res.json({ ok: proxyRes.statusCode < 400, status: proxyRes.statusCode, body: JSON.parse(text) }); }
      catch (_) { res.json({ ok: proxyRes.statusCode < 400, status: proxyRes.statusCode, body: text }); }
    });
  });
  proxyReq.on('error', e => res.status(500).json({ error: e.message }));
  if (data) proxyReq.write(data);
  proxyReq.end();
});

// Raw GlobKurier API call. Sudo może wywołać każdy endpoint GK którego
// nasz glob-client jeszcze nie ma jako funkcji. Token dorzucany automatycznie.
router.post('/admin/gk-raw', async (req, res) => {
  const { method = 'GET', path, body, headers: extraHeaders } = req.body || {};
  if (!path || typeof path !== 'string') return res.status(400).json({ error: 'path required (e.g. "/v1/order/tracking?orderNumber=GK...")' });
  if (!path.startsWith('/v1/')) return res.status(400).json({ error: 'path must start with /v1/' });
  try {
    const token = await getGkToken();
    const data = body && method !== 'GET' ? JSON.stringify(body) : '';
    const opts = {
      hostname: 'api.globkurier.pl', port: 443, path, method,
      headers: {
        'X-Auth-Token': token,
        'Accept': 'application/json',
        'Accept-Language': 'pl',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(extraHeaders || {}),
      },
    };
    console.log(`[admin/gk-raw] ${method} ${path}`);
    const proxyReq = https.request(opts, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { res.json({ status: proxyRes.statusCode, body: JSON.parse(text) }); }
        catch (_) { res.json({ status: proxyRes.statusCode, body: text }); }
      });
    });
    proxyReq.on('error', e => res.status(500).json({ error: e.message }));
    if (data) proxyReq.write(data);
    proxyReq.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ CRM v2 BACKFILLS ============
// Jednorazowe migracje danych — idempotentne (nadpisuja tylko puste pola).
// Dry-run domyslnie; { "apply": true } zapisuje.

// Etap 1: Contractor extras + flat fields -> aliases/externalIds/primaryEmail.
router.post('/admin/backfill/contractor-v2', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const apply = req.body && req.body.apply === true;
  const verbose = req.body && req.body.verbose === true;
  console.log(`[admin/backfill/contractor-v2] apply=${apply} verbose=${verbose}`);
  try {
    const result = await runContractorV2Backfill(prisma, {
      apply, verbose,
      log: (msg) => console.log(`[backfill] ${msg}`),
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[admin/backfill/contractor-v2] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Etap 1.2 + 1.3: ContractorContact + ContractorAddress backfill z flat
// fields (email/phone/address) + extras.locations[].
router.post('/admin/backfill/contractor-contacts', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const apply = req.body && req.body.apply === true;
  const verbose = req.body && req.body.verbose === true;
  console.log(`[admin/backfill/contractor-contacts] apply=${apply} verbose=${verbose}`);
  try {
    const result = await runContractorContactsBackfill(prisma, {
      apply, verbose,
      log: (msg) => console.log(`[backfill] ${msg}`),
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[admin/backfill/contractor-contacts] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Etap 2.1: Invoice + EsInvoice contractor snapshot (contractorName/Nip/
// Country/City) wypelniony z aktualnego stanu (Es)Contractor. Idempotentny —
// nadpisuje tylko puste pola, wiec reczne korekty z NocoDB przezyja kolejne
// uruchomienie.
router.post('/admin/backfill/invoice-snapshots', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const apply = req.body && req.body.apply === true;
  const verbose = req.body && req.body.verbose === true;
  console.log(`[admin/backfill/invoice-snapshots] apply=${apply} verbose=${verbose}`);
  try {
    const result = await runInvoiceSnapshotsBackfill(prisma, {
      apply, verbose,
      log: (msg) => console.log(`[backfill] ${msg}`),
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[admin/backfill/invoice-snapshots] error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
