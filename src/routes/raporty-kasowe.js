'use strict';

/* RAPORTY KASOWE (26.10.2026, przeniesione z n8n) — podgląd i sterowanie.
 * Pod /api (klucz API CRM). Logika: services/raporty-kasowe*.js.
 *
 *   GET  /api/raporty-kasowe/stan       — włączone?, konto Google, dostęp do
 *                                          arkusza, stan skrzynki, ostatnie raporty i kopie
 *   POST /api/raporty-kasowe/sprawdz    — cykl skrzynki teraz
 *   POST /api/raporty-kasowe/od {od}    — przerób maile od daty RRRR-MM-DD
 *                                          (zaległe; duplikaty w arkuszu pomijane)
 *   POST /api/raporty-kasowe/kopia      — kopia arkusza (+ zakładka, gdy jutro 1-szy)
 *   GET  /api/raporty-kasowe/kopie/:id  — pobranie kopii XLSX */

const router = require('express').Router();
const cyk = require('../services/raporty-kasowe-cykl');

const opakuj = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
};

router.get('/raporty-kasowe/stan', opakuj(async (req, res) => {
  res.json({ ok: true, ...(await cyk.stan()) });
}));

router.post('/raporty-kasowe/sprawdz', opakuj(async (req, res) => {
  res.json({ ok: true, wynik: await cyk.cykl() });
}));

router.post('/raporty-kasowe/od', opakuj(async (req, res) => {
  await cyk.przetworzOd(req.body && req.body.od);
  res.json({ ok: true, info: `Następne cykle przerobią maile od ${req.body.od} (po 15 na cykl, co 3 min). Już wpisane dni z tymi samymi kwotami zostaną pominięte bez maili.` });
}));

router.post('/raporty-kasowe/kopia', opakuj(async (req, res) => {
  res.json({ ok: true, wynik: await cyk.kopiaIZakladka() });
}));

router.get('/raporty-kasowe/kopie/:id', opakuj(async (req, res) => {
  const k = await req.app.locals.prisma.kopiaArkusza.findUnique({ where: { id: req.params.id } });
  if (!k) return res.status(404).json({ ok: false, error: 'brak kopii' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${k.nazwa}"`);
  res.send(Buffer.from(k.dane));
}));

module.exports = router;
