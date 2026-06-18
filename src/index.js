'use strict';

const express = require('express');
const prisma = require('./db');

const app = express();
// Limit podniesiony, bo wysylka maila z zalacznikami idzie jako JSON z base64
// (base64 zwieksza rozmiar o ~33%). UI dopuszcza ~20 MB realnych plikow ->
// po zakodowaniu ~27 MB, wiec backend musi przyjac wiekszy body. Wczesniej '5mb'
// odrzucal maile z zalacznikami juz od ~3.7 MB plikow (HTTP 413).
app.use(express.json({ limit: '32mb' }));

app.locals.prisma = prisma;

const PORT = process.env.PORT || 3000;
const API_KEY = (process.env.API_KEY || '').trim();

// ============ AUTH MIDDLEWARE ============
function auth(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'] || '';
  if (key.trim() !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
app.use('/api', auth);

// ============ PUBLIC MAP (no /api prefix → no auth middleware) ============
// /map serves the Leaflet HTML page; /map-data returns GeoJSON. Both work
// anonymously (jitter + no popups) by default. Pass ?key=API_KEY for full data.
app.use('/', require('./routes/map'));

// ============ HEALTH ============
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: true });
  } catch (e) {
    res.json({ ok: true, db: false, error: e.message });
  }
});

// Marker wersji — do weryfikacji ktory commit Railway faktycznie wdrozyl.
// Jesli /api/core/_version zwraca to JSON => nowy kod jest live; jesli
// "Cannot GET /api/_version" => serwer dalej na starym kodzie.
app.get('/api/_version', (req, res) => {
  res.json({
    ok: true,
    marker: 'invoice-pdf-route',
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT || null,
    branch: process.env.RAILWAY_GIT_BRANCH || null,
    hasInvoicePdfRoute: true,
    startedAt: new Date().toISOString(),
  });
});

// ============ ROUTES ============
app.use('/api/contractors', require('./routes/contractors'));
app.use('/api/deals', require('./routes/deals'));
app.use('/api/consignments', require('./routes/consignments'));
app.use('/api', require('./routes/emails'));
app.use('/api/mailing', require('./routes/mailing'));
app.use('/api/products', require('./routes/products'));
app.use('/api', require('./routes/config'));
app.use('/api', require('./routes/invoices'));
app.use('/api/jpk', require('./routes/jpk'));
app.use('/api/jpk', require('./routes/jpk-package'));
app.use('/api', require('./routes/parse-document'));
app.use('/api', require('./routes/analytics'));
app.use('/api', require('./routes/glob'));
app.use('/api', require('./routes/agent'));
app.use('/api', require('./routes/telegram-callback'));
app.use('/api', require('./routes/admin'));
app.use('/api', require('./routes/activity'));
app.use('/api', require('./routes/cron'));
app.use('/api', require('./routes/transactions'));
app.use('/api', require('./routes/push'));
app.use('/api/contasimple', require('./routes/contasimple'));

// ============ ERROR MIDDLEWARE ============
// Catches errors thrown from any route handler wrapped in asyncHandler,
// or passed via next(err). Must be registered AFTER all routes.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(`[error] ${req.method} ${req.url}:`, err.stack || err.message || err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ============ START ============
const server = app.listen(PORT, () => {
  console.log(`Core API running on port ${PORT}`);
});

// ============ GK COUNTRIES SELF-HEAL ============
// Przy starcie upewnij się, że mapa krajów GlobKurier (Config 'gk_country_ids')
// jest kompletna. Jeśli pusta lub szczątkowa (<50 wpisów), pobierz pełną
// oficjalną listę z GET /v1/countries — cały świat, w tym cała Europa.
// Nieblokujące i best-effort: brak credentiali GK / błąd sieci nie wstrzymuje
// startu. Dzięki temu nikt nie musi odpalać sync ręcznie po deployu.
(async () => {
  try {
    if (!process.env.GLOBKURIER_EMAIL || !process.env.GLOBKURIER_PASSWORD) return;
    const cfg = await prisma.config.findUnique({ where: { key: 'gk_country_ids' } });
    let count = 0;
    if (cfg && cfg.value) {
      try {
        const parsed = typeof cfg.value === 'string' ? JSON.parse(cfg.value) : cfg.value;
        if (parsed && typeof parsed === 'object') count = Object.keys(parsed).length;
      } catch (_) {}
    }
    if (count >= 50) {
      console.log(`[startup] GK country map OK (${count} krajów)`);
      return;
    }
    const { syncCountriesFromApi } = require('./routes/glob-quote');
    const r = await syncCountriesFromApi(prisma);
    console.log(`[startup] GK country map zsynchronizowana: ${r.count} krajów z /v1/countries`);
  } catch (e) {
    console.error('[startup] GK country sync skipped:', e.message);
  }
})();

// ============ INBOX POLLER ============
const { stopPolling } = require('./inbox-poller');

// ============ GRACEFUL SHUTDOWN ============
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining...`);

  stopPolling();

  // Force-exit fallback if drain hangs
  const forceExitTimer = setTimeout(() => {
    console.error('[shutdown] forced exit after 30s timeout');
    process.exit(1);
  }, 30000);
  forceExitTimer.unref();

  server.close(async () => {
    console.log('[shutdown] HTTP server closed');
    try {
      await prisma.$disconnect();
      console.log('[shutdown] Prisma disconnected');
    } catch (e) {
      console.error('[shutdown] Prisma disconnect error:', e.message);
    }
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
