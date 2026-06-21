'use strict';

// Zakładka „Dodatkowa księgowość" — akcje miesięczne z UI (nie cron):
//  - raport (pokrycie KSeF + WDT bez wysyłki)
//  - wyślij wszystkie nie-w-KSeF faktury miesiąca do KSeF (przez iFirmę)
//  - sparuj faktury WDT bez wysyłki (auto-link z zamówieniami GK)
// Wysyłka „listów na maila" robiona z frontu przez istniejące /api/jpk/build-and-send.

const router = require('express').Router();
const { selfCall } = require('../services/agent-runtime');
const { monthRange, buildReport } = require('../services/monthly-accounting');

// Raport za miesiąc. Najpierw odświeża status KSeF (Subject1) — best-effort.
router.get('/accounting/monthly-report', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { from, to, fromIso, toIso } = monthRange(req.query.month);
    try { await selfCall('POST', '/api/ksef/sync-sales-status', { from: fromIso, to: toIso }); } catch (_) { /* best-effort */ }
    const rep = await buildReport(prisma, { from, to });
    res.json({ ok: true, range: { from: fromIso, to: toIso }, sales: rep.sales, wdt: rep.wdt });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Wyślij do KSeF wszystkie faktury miesiąca, których jeszcze tam nie ma.
router.post('/accounting/send-month-to-ksef', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { from, to, fromIso, toIso } = monthRange(req.body && req.body.month);
    const rep = await buildReport(prisma, { from, to });
    const results = []; let sent = 0;
    for (const inv of rep._toSend) {
      try {
        const r = await selfCall('POST', `/api/invoices/${inv.id}/ksef-send`, {});
        const ok = !!(r.body && r.body.ok);
        if (ok) sent++;
        results.push({ number: inv.number, ok, ksefNumber: (r.body && r.body.ksefNumber) || null, info: r.body && (r.body.info || r.body.error) });
      } catch (e) {
        results.push({ number: inv.number, ok: false, info: e.message });
      }
    }
    res.json({ ok: true, range: { from: fromIso, to: toIso }, attempted: rep._toSend.length, sent, failed: rep._toSend.length - sent, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Sparuj faktury WDT bez wysyłki (auto-link po nazwie kontrahenta z GK).
router.post('/accounting/pair-wdt', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { from, to, fromIso, toIso } = monthRange(req.body && req.body.month);
    const rep = await buildReport(prisma, { from, to });
    const results = []; let paired = 0;
    for (const inv of rep._wdtUnpaired) {
      try {
        const r = await selfCall('POST', '/api/invoices/link-shipment', { invoiceNumber: inv.number });
        const ok = !!(r.body && r.body.ok);
        if (ok) paired++;
        results.push({ number: inv.number, ok, shipmentNumber: (r.body && r.body.shipmentNumber) || null, info: r.body && r.body.error });
      } catch (e) {
        results.push({ number: inv.number, ok: false, info: e.message });
      }
    }
    res.json({ ok: true, range: { from: fromIso, to: toIso }, attempted: rep._wdtUnpaired.length, paired, failed: rep._wdtUnpaired.length - paired, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
