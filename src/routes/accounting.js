'use strict';

// Zakładka „Dodatkowa księgowość" — akcje miesięczne z UI (nie cron):
//  - raport (pokrycie KSeF + WDT bez wysyłki)
//  - wyślij wszystkie nie-w-KSeF faktury miesiąca do KSeF (przez iFirmę)
//  - sparuj faktury WDT bez wysyłki (auto-link z zamówieniami GK)
// Wysyłka „listów na maila" robiona z frontu przez istniejące /api/jpk/build-and-send.

const router = require('express').Router();
const { selfCall } = require('../services/agent-runtime');
const { monthRange, buildReport } = require('../services/monthly-accounting');

// Raport za miesiąc. Status KSeF odświeżamy W TLE (auth+polling KSeF bywa wolny i
// powodował abort/timeout requestu) — raport renderuje się od razu z bazy.
router.get('/accounting/monthly-report', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { from, to, fromIso, toIso } = monthRange(req.query.month);
    // fire-and-forget — świeży ksefNumber pojawi się przy kolejnym wejściu
    selfCall('POST', '/api/ksef/sync-sales-status', { from: fromIso, to: toIso }).catch(() => {});
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

// Sparuj BRAKUJĄCE faktury WDT/eksport (bez zapisanego numeru wysyłki) z
// ostatnimi zamówieniami GK — model Opus + podwójna weryfikacja kraju (kraj musi
// się zgadzać i NIE może to być list do Polski). Zapisuje numer/hash wysyłki na
// fakturze i adres dostawy na kontrahencie.
router.post('/accounting/pair-wdt', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { from, to, fromIso, toIso } = monthRange(req.body && req.body.month);
    const rep = await buildReport(prisma, { from, to });
    const unpaired = rep._wdtUnpaired; // faktury WDT/eksport BEZ shipmentNumber
    if (!unpaired.length) {
      return res.json({ ok: true, range: { from: fromIso, to: toIso }, attempted: 0, paired: 0, rejected: [], message: 'Wszystkie WDT/eksport już sparowane.' });
    }

    // Ostatnie zamówienia GK (z cache, mają hash + adres + kraj). Pomijamy te już
    // przypięte do innych faktur (żeby nie dublować).
    const invoicesRouter = require('./invoices');
    const allGk = await invoicesRouter.getGkOrders();
    const usedNumbers = new Set(
      (await prisma.invoice.findMany({ where: { shipmentNumber: { not: null } }, select: { shipmentNumber: true } }))
        .map(i => String(i.shipmentNumber)),
    );
    const orders = (allGk || []).filter(o => o.number && !usedNumbers.has(String(o.number))).slice(0, 100);

    const { pairWdtSmart } = require('../services/wdt-pairing');
    const { paired: matched, rejected, proposals } = await pairWdtSmart(unpaired, orders);

    // Zapis zweryfikowanych par: numer/hash/kurier na fakturze + adres dostawy.
    const pairedOut = [];
    for (const m of matched) {
      try {
        await prisma.invoice.update({
          where: { id: m.inv.id },
          data: { shipmentNumber: String(m.order.number), shipmentHash: m.order.hash || null, shipmentCarrier: m.order.carrier || null },
        });
        // adres dostawy → kontrahent (best-effort, ostatnio używany)
        const a = (m.order.receiver) || {};
        if (m.inv.contractorId && (a.street || a.city)) {
          selfCall('POST', `/api/contractors/${m.inv.contractorId}/delivery-address`, {
            street: a.street, houseNumber: a.houseNumber, postCode: a.postCode, city: a.city,
            country: a.country, contactPerson: a.contactPerson, phone: a.phone, email: a.email, source: 'gk_pairing',
          }).catch(() => {});
        }
        pairedOut.push({ number: m.inv.number, shipmentNumber: m.order.number, receiver: m.order.receiverName, reason: m.reason });
      } catch (e) {
        rejected.push({ number: m.inv.number, shipment: m.order.number, reason: 'zapis: ' + e.message });
      }
    }

    res.json({
      ok: true, range: { from: fromIso, to: toIso },
      attempted: unpaired.length, proposals, paired: pairedOut.length,
      stillMissing: unpaired.length - pairedOut.length,
      pairedList: pairedOut, rejected,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
