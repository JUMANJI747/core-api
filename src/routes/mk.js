'use strict';

// Mała Księgowość (mk.app) — ETAP 0 "obicie": diagnostyka + wyzwolenie pobrania
// z KSeF do MK + odczyt list (koszty/sprzedaż) do późniejszego porównania.
// Reconciliation (MK ↔ nasza baza ↔ iFirma ↔ KSeF) = ETAP 2 (osobno).
//
// Konfiguracja przez env: MK_API_KEY albo MK_USER+MK_PASSWORD (albo
// MK_DATA_SHARING_KEY), opcjonalnie MK_BASE. Bez tego endpointy zwracają 503.

const router = require('express').Router();
const asyncHandler = require('../asyncHandler');
const mk = require('../mk-client');

function guard(res) {
  if (!mk.isConfigured()) {
    res.status(503).json({
      ok: false,
      error: 'MK nie skonfigurowane. Ustaw w env: MK_API_KEY albo MK_USER+MK_PASSWORD (opcjonalnie MK_BASE).',
    });
    return false;
  }
  return true;
}

// Diagnostyka: czy się łączymy i autoryzujemy (zwraca wersję MK).
router.get('/mk/ping', asyncHandler(async (req, res) => {
  if (!guard(res)) return;
  try {
    const version = await mk.version();
    res.json({ ok: true, base: mk.MK_BASE, version });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, status: e.status, body: e.body });
  }
}));

// Wyzwól pobranie faktur z KSeF do MK. body: { from, to, mode? }.
// mode pominięty → uruchamiamy OBA: 'buy' (koszty) i 'sell' (sprzedaż).
router.post('/mk/ksef-fetch', asyncHandler(async (req, res) => {
  if (!guard(res)) return;
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ ok: false, error: 'Podaj from i to (YYYY-MM-DD).' });
  const modes = req.body.mode ? [req.body.mode] : ['buy', 'sell'];
  const sessions = [];
  for (const mode of modes) {
    try {
      const r = await mk.ksefFetch(mode, from, to);
      sessions.push({ mode, ok: true, result: r });
    } catch (e) {
      sessions.push({ mode, ok: false, error: e.message, status: e.status, body: e.body });
    }
  }
  res.json({ ok: sessions.every(s => s.ok), range: { from, to }, sessions });
}));

// Status sesji pobierania z KSeF.
router.get('/mk/ksef-fetch/:ref', asyncHandler(async (req, res) => {
  if (!guard(res)) return;
  try {
    const r = await mk.ksefFetchStatus(req.params.ref);
    res.json({ ok: true, session: r });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, status: e.status, body: e.body });
  }
}));

// Odczyt: faktury KOSZTOWE (zakup) w MK za okres.
router.get('/mk/cost-invoices', asyncHandler(async (req, res) => {
  if (!guard(res)) return;
  try {
    const data = await mk.vatPurchaseEntries({ from: req.query.from, to: req.query.to });
    res.json({ ok: true, source: 'vat-purchase-ledger-entries', data });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, status: e.status, body: e.body });
  }
}));

// Odczyt: faktury SPRZEDAŻOWE w MK za okres.
router.get('/mk/sales-invoices', asyncHandler(async (req, res) => {
  if (!guard(res)) return;
  try {
    const data = await mk.vatSalesEntries({ from: req.query.from, to: req.query.to });
    res.json({ ok: true, source: 'vat-sales-ledger-entries', data });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, status: e.status, body: e.body });
  }
}));

// Odczyt: świeżo pobrane z KSeF, jeszcze niezaksięgowane (do podglądu po fetchu).
router.get('/mk/new-ledger-entries', asyncHandler(async (req, res) => {
  if (!guard(res)) return;
  try {
    const data = await mk.newLedgerEntries({ from: req.query.from, to: req.query.to });
    res.json({ ok: true, source: 'new-ledger-entries', data });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, status: e.status, body: e.body });
  }
}));

module.exports = router;
