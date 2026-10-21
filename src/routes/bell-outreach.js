"use strict";

/* BELL OUTREACH — podgląd i sterowanie kolejką odpowiedzi do systemu
 * mailingowego (20.10.2026). Sama wysyłka dzieje się w pollerze po każdym
 * cyklu (services/bell-outreach.js); te trasy są dla właściciela:
 *   GET  /api/bell-outreach/status           — konfiguracja, liczniki, ostatnia wysyłka
 *   GET  /api/bell-outreach/kolejka          — wiersze (?status=nowy&rodzaj=&limit=)
 *   POST /api/bell-outreach/backfill {dni}   — jednorazowo zakolejkuj historię (nie wysyła)
 *   POST /api/bell-outreach/wyslij {dry}     — wyślij paczkę teraz (dry: pokaż, nie wysyłaj)
 *   POST /api/bell-outreach/wyslij-ponownie {od, dry} — jednorazowo wyślij wszystko od daty, także już wysłane
 *   POST /api/bell-outreach/rodzaj {messageId, rodzaj} — ręczna poprawka rodzaju przed wysyłką
 *   POST /api/bell-outreach/pomin {messageId} — nie wysyłać tego maila
 *   POST /api/bell-outreach/skrzynki-poza {lista} — które skrzynki Bell uznał za spoza kampanii
 * Wszystko pod /api → tylko właściciel (rola magazyn nie wchodzi). */

const express = require('express');
const router = express.Router();
const bo = require('../services/bell-outreach');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// inbox → adres konta (IMAP_ACCOUNTS: [{inbox, user, …}]) — „skrzynka" dla Bell Outreach.
function kontaAdresy() {
  try {
    const m = {};
    for (const a of JSON.parse(process.env.IMAP_ACCOUNTS || '[]')) if (a && a.inbox && a.user) m[a.inbox] = a.user;
    return m;
  } catch { return {}; }
}
// Poller jest już załadowany przez index.js — require zwraca ten sam moduł, nic nie startuje.
function narzedziaPollera() {
  try { const p = require('../inbox-poller'); return { wykryjWypis: p.wykryjWypis, czescWlasnaMaila: p.czescWlasnaMaila }; }
  catch (e) { console.error('[bell-outreach] narzędzia pollera niedostępne:', e.message); return {}; }
}

router.get('/bell-outreach/status', asyncHandler(async (req, res) => {
  res.json({ ok: true, ...(await bo.statusKolejki(req.app.locals.prisma)) });
}));

router.get('/bell-outreach/kolejka', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const where = {};
  if (req.query.status) where.status = String(req.query.status);
  if (req.query.rodzaj) where.rodzaj = String(req.query.rodzaj);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const rows = await prisma.bellOutreachMsg.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit });
  res.json({ ok: true, ile: rows.length, wiersze: rows });
}));

router.post('/bell-outreach/backfill', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const wynik = await bo.backfill(req.app.locals.prisma, { dni: b.dni || 30, kontaAdresy: kontaAdresy(), ...narzedziaPollera() });
  res.json({ ok: true, ...wynik });
}));

router.post('/bell-outreach/wyslij', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const wynik = await bo.wyslijKolejke(req.app.locals.prisma, { force: true, dryRun: b.dry === true || b.dry === 1 || b.dry === '1' ? true : (b.dry === false ? false : undefined) });
  res.json({ ok: true, ...wynik });
}));

// Jednorazowa ponowna wysyłka od daty (także już wysłane; Bell pomija duplikaty).
router.post('/bell-outreach/wyslij-ponownie', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const wynik = await bo.wyslijPonownie(req.app.locals.prisma, { od: b.od || '2026-10-20T00:00:00Z', dryRun: b.dry === true ? true : (b.dry === false ? false : undefined) });
  res.json({ ok: true, ...wynik });
}));

router.post('/bell-outreach/rodzaj', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.messageId || !bo.RODZAJE.includes(b.rodzaj)) return res.status(400).json({ ok: false, error: `podaj messageId i rodzaj z listy: ${bo.RODZAJE.join(', ')}` });
  const r = await req.app.locals.prisma.bellOutreachMsg.updateMany({ where: { messageId: String(b.messageId) }, data: { rodzaj: b.rodzaj, status: 'nowy', regula: 'ręcznie', powod: null, ...(b.adresOdbity ? { adresOdbity: String(b.adresOdbity) } : {}) } });
  if (!r.count) return res.status(404).json({ ok: false, error: 'nie ma takiego messageId w kolejce' });
  res.json({ ok: true });
}));

router.post('/bell-outreach/pomin', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.messageId) return res.status(400).json({ ok: false, error: 'podaj messageId' });
  const r = await req.app.locals.prisma.bellOutreachMsg.updateMany({ where: { messageId: String(b.messageId) }, data: { status: 'pominiety', powod: 'ręcznie' } });
  if (!r.count) return res.status(404).json({ ok: false, error: 'nie ma takiego messageId w kolejce' });
  res.json({ ok: true });
}));

router.post('/bell-outreach/skrzynki-poza', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const lista = Array.isArray((req.body || {}).lista) ? req.body.lista.map(String) : [];
  await prisma.config.upsert({ where: { key: bo.KLUCZ_SKRZYNEK_POZA }, update: { value: JSON.stringify(lista) }, create: { key: bo.KLUCZ_SKRZYNEK_POZA, value: JSON.stringify(lista) } });
  res.json({ ok: true, lista });
}));

module.exports = router;
