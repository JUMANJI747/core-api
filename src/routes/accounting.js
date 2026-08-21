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
//
// UWAGA na limit KSeF (20 zapytań metadata/h): raport wczytuje się przy wejściu
// w zakładkę, przy zmianie miesiąca I PO KAŻDEJ AKCJI (np. po „Wyślij wszystkie
// do KSeF"). Wcześniej szło stąd zapytanie BEZ throttla, więc kilka kliknięć
// potrafiło wyczerpać cały godzinny limit i numery KSeF przestawały się
// dociągać. Teraz wspólny, throttlowany kanał — max raz na 10 min.
router.get('/accounting/monthly-report', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { from, to, fromIso, toIso } = monthRange(req.query.month);
    // fire-and-forget — świeży ksefNumber pojawi się przy kolejnym wejściu.
    // Odczyt z iFirmy, ALE przez throttle 10 min (własny klucz w Config) —
    // raport ładuje się przy każdym wejściu, zmianie miesiąca i po KAŻDEJ
    // akcji; bez throttla każdy z tych momentów puszczałby serię do iFirmy.
    const { syncMissingFromIfirmaThrottled } = require('../services/ifirma-ksef-sync');
    syncMissingFromIfirmaThrottled(prisma, { minIntervalMs: 10 * 60 * 1000, from: fromIso, to: toIso, limit: 30, budgetMs: 30000 }).catch(() => {});
    const rep = await buildReport(prisma, { from, to });
    res.json({ ok: true, range: { from: fromIso, to: toIso }, sales: rep.sales, wdt: rep.wdt });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// WYMUSZONE odświeżenie statusów KSeF dla oglądanego miesiąca — guzik w UI.
// Odczyt idzie z IFIRMY (NumerKSEF w szczegółach FV): bez limitu 20/h, łapie
// też wysyłki zrobione ręcznie w panelu iFirmy, o których nasz system nie wie.
// Sekwencyjnie z throttlem; czego nie zdążymy w budżecie czasu (limit 60 s
// proxy), wraca w `remaining` — kolejne kliknięcie dokończy.
router.post('/accounting/refresh-ksef-status', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { fromIso, toIso } = monthRange(req.body && req.body.month);
    const { syncMissingFromIfirma } = require('../services/ifirma-ksef-sync');
    // budżet 25 s: sprawdzany PRZED wywołaniem, a jedno wywołanie iFirmy może
    // trwać do 30 s (HTTP timeout) — 25+30 < 60 s limitu proxy.
    const r = await syncMissingFromIfirma(prisma, { from: fromIso, to: toIso, limit: 100, budgetMs: 25000 });
    if (r.skipped === 'busy') {
      return res.json({ ok: false, error: 'Odczyt numerów KSeF już trwa w tle — spróbuj za chwilę.' });
    }
    // iFirma padła w całości → powiedz to wprost, zamiast udawać czysty przebieg.
    if (r.checked > 0 && r.got === 0 && r.errorCount === r.checked) {
      return res.json({ ok: false, error: `iFirma nie odpowiada (${(r.errors[0] && r.errors[0].error) || 'brak szczegółów'})`, ...r });
    }
    res.json({ ok: true, range: { from: fromIso, to: toIso }, ...r });
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
    // Po masowej wysyłce KSeF nadaje numery z opóźnieniem — jeden przebieg
    // odczytu z iFirmy po ~90 s dopisze je do faktur (bez limitu 20/h).
    // Gdy akurat trwa inny przebieg (skipped=busy), ponawiamy raz po kolejnych
    // 90 s; potem i tak dogoni to throttlowany odczyt w tle.
    if (sent > 0) {
      const { syncMissingFromIfirma } = require('../services/ifirma-ksef-sync');
      const runPull = (attempt) => {
        setTimeout(() => {
          syncMissingFromIfirma(prisma, { from: fromIso, to: toIso, limit: 100, budgetMs: 120000 })
            .then(r => {
              if (r.skipped === 'busy' && attempt < 2) return runPull(attempt + 1);
              console.log('[accounting/send-month-to-ksef] odczyt numerów KSeF z iFirmy:', JSON.stringify(r.skipped ? r : { checked: r.checked, got: r.got, pending: r.stillPending.length, errors: r.errorCount }));
            })
            .catch(() => {});
        }, 90 * 1000).unref?.();
      };
      runPull(1);
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

// Pojedyncza faktura: AI proponuje JEDEN list (po „Rozłącz" lub gdy auto-paruj
// nie złapał). NIE zapisuje — zwraca propozycję do potwierdzenia w UI. offset
// pozwala przeszukać starsze wysyłki (0 = ostatnie 100, 100 = 100–200…).
router.post('/accounting/pair-wdt-one', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { invoiceId, offset = 0 } = req.body || {};
    if (!invoiceId) return res.status(400).json({ ok: false, error: 'invoiceId wymagane' });
    const inv = await prisma.invoice.findUnique({
      where: { id: String(invoiceId) },
      select: { id: true, number: true, contractorId: true, contractorName: true, contractorCountry: true, contractorCity: true, contractorNip: true },
    });
    if (!inv) return res.status(404).json({ ok: false, error: 'Nie znaleziono faktury' });

    const invoicesRouter = require('./invoices');
    const allGk = await invoicesRouter.getGkOrders();
    const usedNumbers = new Set(
      (await prisma.invoice.findMany({ where: { shipmentNumber: { not: null }, NOT: { id: inv.id } }, select: { shipmentNumber: true } }))
        .map(i => String(i.shipmentNumber)),
    );
    const off = Math.max(0, Number(offset) || 0);
    const orders = (allGk || []).filter(o => o.number && !usedNumbers.has(String(o.number))).slice(off, off + 100);
    if (!orders.length) return res.json({ ok: true, proposal: null, message: 'Brak wysyłek do przeszukania.' });

    const { pairWdtSmart } = require('../services/wdt-pairing');
    const { paired, rejected } = await pairWdtSmart([inv], orders);
    if (paired.length) {
      const m = paired[0];
      const a = m.order.receiver || {};
      return res.json({
        ok: true,
        proposal: {
          shipmentNumber: m.order.number, shipmentHash: m.order.hash || null, carrier: m.order.carrier || null,
          receiverName: m.order.receiverName, country: a.country || null, city: a.city || null, postCode: a.postCode || null,
          reason: m.reason || '',
        },
      });
    }
    return res.json({
      ok: true, proposal: null, rejected,
      message: rejected.length
        ? 'AI znalazł kandydata, ale odrzucił (kraj/Polska). Spróbuj „Szukaj wcześniej".'
        : (off ? 'AI nie znalazł w starszych (100–200). Sprawdź ręcznie.' : 'AI nie znalazł w ostatnich 100. Spróbuj „Szukaj wcześniej".'),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
