'use strict';

/* FAKTURY NA ZAMÓWIENIE Z ZEWNĄTRZ (26.10.2026) — trasy dla systemu
 * mailingowego. Poza /api: zamiast głównego klucza CRM osobny token tylko do
 * faktur (Authorization: Bearer …, w Config sam skrót SHA-256). Logika
 * i zabezpieczenia: services/faktury-zewn.js.
 *
 *   POST /zewn/faktury           — wystaw (albo {proba:true} = podgląd kwot)
 *   GET  /zewn/faktury?ref=…     — stan: numer, kwoty, zapłata, KSeF; &pdf=1 z PDF */

const router = require('express').Router();
const fz = require('../services/faktury-zewn');

async function autoryzuj(req, res) {
  const zrodlo = await fz.zrodloZTokenu(req.app.locals.prisma, req);
  if (!zrodlo) { res.status(401).json({ ok: false, error: 'Brak albo zły token (Authorization: Bearer …)' }); return null; }
  return zrodlo;
}

router.post('/zewn/faktury', async (req, res) => {
  try {
    const zrodlo = await autoryzuj(req, res);
    if (!zrodlo) return;
    const { status, json } = await fz.wystaw(req.app.locals.prisma, zrodlo, req.body || {});
    res.status(status).json(json);
  } catch (e) {
    console.error('[zewn/faktury]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/zewn/faktury', async (req, res) => {
  try {
    const zrodlo = await autoryzuj(req, res);
    if (!zrodlo) return;
    const { status, json } = await fz.stan(req.app.locals.prisma, zrodlo, req.query.ref, { zPdf: req.query.pdf === '1' });
    res.status(status).json(json);
  } catch (e) {
    console.error('[zewn/faktury GET]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
