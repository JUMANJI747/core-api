'use strict';

/* PEŁNE API IFIRMY DLA CLAUDE (26.11.2026).
 *
 * Właściciel: „weź z dokumentacji API iFirmy wszystkie opcje — potrzebuję faktur
 * eksportowych, wystawiania WZ itp.; nie w CRM, ale żebyś ty mógł". Panel CRM
 * zostaje przy swoich ścieżkach (/ifirma/invoice-preview + invoice-confirm).
 * Tu jest przejście do CAŁEGO API iFirmy (https://api.ifirma.pl), z którego
 * korzysta Claude według OBSLUGA.md §2b:
 *
 *   GET      /api/if/iapi/<zasób>   — odczyt (listy, szczegóły, PDF/XML, kontrahenci,
 *                                      miesiąc księgowy, limit API, stawki VAT UE…);
 *   POST|PUT /api/if/iapi/<zasób>   — zapis: {"dane": {…JSON iFirmy…}}. DOMYŚLNIE
 *                                      PODGLĄD (nic nie idzie do iFirmy); wysłanie
 *                                      tylko z "wykonaj": true;
 *   GET      /api/if/stan           — które klucze są ustawione (bez wartości) i limit API.
 *
 * WZ (dokumentów magazynowych) API iFirmy NIE ma — w dokumentacji nie ma magazynu.
 *
 * Bezpieczniki zapisu:
 *  - idempotencja przez ConfirmLock (klucz = treść żądania): ten sam dokument
 *    wysłany drugi raz nie powstanie drugi raz (odpowiedź juzWykonane), a numer
 *    wystawionej faktury trafia do ConfirmLock — strażnik zna go jako „z CRM";
 *  - brak odpowiedzi iFirmy = blokada zostaje („niepewne"): najpierw sprawdzić
 *    listę faktur, potem ponowić z "ponowPoSprawdzeniu": true;
 *  - Kod 201 „miesiąc/rok księgowy" → przestawienie miesiąca na datę dokumentu
 *    i jedno ponowienie (jak przy fakturach z CRM). */

const router = require('express').Router();
const https = require('https');
const crypto = require('crypto');
const asyncHandler = require('../asyncHandler');
const { claimConfirm, completeConfirm, releaseConfirm } = require('../services/confirm-lock');

const HOST = 'www.ifirma.pl';
const BAZA = `https://${HOST}/iapi/`;
const WYDATKI = /^(kosztdzialalnosci|kosztdzialalnoscivat|zakuptowaruvat|oplatatelefon)([./]|$)/i;

const tylkoWlasciciel = (req, res) => {
  if (req.crm && req.crm.role === 'magazyn') { res.status(403).json({ ok: false, error: 'tylko właściciel' }); return false; }
  return true;
};

/** Który klucz iFirmy podpisuje dany zasób (dokumentacja: „Niezbędne informacje"). */
function nazwaKlucza(sciezka) {
  const s = String(sciezka || '').replace(/^\/+/, '');
  if (/^abonent\//i.test(s)) return 'abonent';
  if (/^rachunek/i.test(s)) return 'rachunek';
  if (WYDATKI.test(s)) return 'wydatek';
  return 'faktura';
}
const ENV_KLUCZA = { faktura: 'IFIRMA_API_KEY', abonent: 'IFIRMA_API_KEY_ABONENT', rachunek: 'IFIRMA_API_KEY_RACHUNEK', wydatek: 'IFIRMA_API_KEY_WYDATEK' };
function wartoscKlucza(nazwa) {
  const v = process.env[ENV_KLUCZA[nazwa]] || (nazwa === 'abonent' ? process.env.IFIRMA_API_KEY : '');
  return String(v || '').trim();
}

/** Nagłówek Authentication: hmac-sha1(klucz hex, url BEZ parametrów + login + nazwa klucza + treść). */
function podpis(urlBezParametrow, nazwa, tresc) {
  const login = String(process.env.IFIRMA_USER || '').trim();
  const kl = wartoscKlucza(nazwa);
  if (!login || !kl) throw Object.assign(new Error(`brak klucza iFirmy „${nazwa}” (${ENV_KLUCZA[nazwa]}${nazwa === 'faktura' ? ' i IFIRMA_USER' : ''}) — wygeneruj go w iFirma → Konfiguracja → API`), { status: 503 });
  const hash = crypto.createHmac('sha1', Buffer.from(kl, 'hex')).update(urlBezParametrow + login + nazwa + (tresc || ''), 'utf8').digest('hex');
  return `IAPIS user=${login}, hmac-sha1=${hash}`;
}

function ifirmaHttpDomyslny(metoda, sciezkaZParametrami, { tresc = null, timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const bezParametrow = sciezkaZParametrami.split('?')[0];
    const rozsz = (bezParametrow.match(/\.(json|pdf|xml)$/i) || [null, 'json'])[1].toLowerCase();
    let auth;
    try { auth = podpis(BAZA + bezParametrow, nazwaKlucza(bezParametrow), tresc); } catch (e) { reject(e); return; }
    const req = https.request({
      hostname: HOST, path: `/iapi/${sciezkaZParametrami}`, method: metoda,
      headers: {
        Accept: { json: 'application/json', pdf: 'application/pdf', xml: 'application/xml' }[rozsz],
        Authentication: auth,
        ...(tresc != null ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(tresc, 'utf8') } : {}),
      },
    }, (res) => {
      const kawalki = [];
      res.on('data', (c) => kawalki.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(kawalki);
        const typ = String(res.headers['content-type'] || '');
        let json = null;
        if (/json/i.test(typ) || /^\s*[[{]/.test(buf.slice(0, 64).toString('utf8'))) { try { json = JSON.parse(buf.toString('utf8')); } catch (_) { /* nie JSON */ } }
        resolve({ status: res.statusCode, typ, buf, json, naglowki: res.headers });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`iFirma timeout po ${Math.round(timeoutMs / 1000)} s (${metoda} ${bezParametrow})`)));
    req.on('error', reject);
    if (tresc != null) req.write(tresc);
    req.end();
  });
}
let ifirmaHttp = ifirmaHttpDomyslny;
let przestawMiesiac = async (m, r) => require('../ifirma-client').setAccountingMonth(m, r);

/** Ścieżka zasobu dokładnie tak, jak przyszła (z kodowaniem %…) — podpis liczy się z wysyłanego URL-a. */
function surowaSciezka(req) {
  const u = req.originalUrl;
  const i = u.indexOf('/iapi/');
  return i >= 0 ? u.slice(i + '/iapi/'.length) : '';
}
const odp = (r) => (r.json && (r.json.response || r.json)) || {};
const kodIfirmy = (r) => { const o = odp(r); return o.Kod != null ? Number(o.Kod) : null; };
const opis = (r) => { const o = odp(r); return [o.Informacja, o.Kod != null ? `(Kod ${o.Kod})` : null].filter(Boolean).join(' ') || `HTTP ${r.status}`; };

/** Pierwsza wartość pola o danej nazwie w odpowiedzi (iFirma zagnieżdża różnie: response / Wynik). */
function znajdzPole(o, nazwy) {
  if (!o || typeof o !== 'object') return null;
  for (const n of nazwy) if (o[n] != null && o[n] !== '') return o[n];
  for (const v of Object.values(o)) { const w = znajdzPole(v, nazwy); if (w != null) return w; }
  return null;
}

/* ---------- odczyt ---------- */
router.get('/stan', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const klucze = Object.fromEntries(Object.keys(ENV_KLUCZA).map((n) => [n, !!wartoscKlucza(n)]));
  let limit = null;
  try { const r = await ifirmaHttp('GET', 'abonent/limit.json'); limit = odp(r); } catch (e) { limit = { blad: e.message }; }
  res.json({ ok: true, login: !!String(process.env.IFIRMA_USER || '').trim(), klucze, limit, uwaga: 'WZ (dokumentów magazynowych) API iFirmy nie ma.' });
}));

router.get(/^\/iapi\/(.+)$/, asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const sciezka = surowaSciezka(req);
  if (!sciezka || sciezka.includes('..')) return res.status(400).json({ ok: false, error: 'podaj zasób, np. /api/if/iapi/faktury.json?dataOd=2026-11-01&dataDo=2026-11-30' });
  let r;
  try { r = await ifirmaHttp('GET', sciezka); }
  catch (e) { return res.status(e.status || 502).json({ ok: false, error: e.message }); }
  if (r.json != null) return res.status(r.status).json(r.json);
  res.status(r.status);
  if (r.typ) res.setHeader('Content-Type', r.typ);
  if (r.naglowki && r.naglowki['content-disposition']) res.setHeader('Content-Disposition', r.naglowki['content-disposition']);
  res.send(r.buf);
}));

/* ---------- zapis: domyślnie podgląd, wysłanie tylko z "wykonaj": true ---------- */
async function zapis(metoda, req, res) {
  if (!tylkoWlasciciel(req, res)) return;
  const prisma = req.app.locals.prisma;
  const b = req.body || {};
  const sciezka = surowaSciezka(req);
  if (!sciezka || sciezka.includes('..')) return res.status(400).json({ ok: false, error: 'podaj zasób iFirmy' });
  if (b.dane !== undefined && (typeof b.dane !== 'object' || b.dane === null)) return res.status(400).json({ ok: false, error: '"dane" to obiekt JSON z dokumentacji iFirmy' });
  const tresc = b.dane === undefined ? '' : JSON.stringify(b.dane);
  const bezParametrow = sciezka.split('?')[0];
  const klucz = nazwaKlucza(bezParametrow);

  if (b.wykonaj !== true) {
    return res.json({
      ok: true, podglad: true, metoda, url: BAZA + sciezka, klucz, kluczUstawiony: !!wartoscKlucza(klucz), dane: b.dane === undefined ? null : b.dane,
      uwaga: 'Nic nie zostało wysłane do iFirmy. Po akceptacji właściciela wyślij to samo z "wykonaj": true.',
    });
  }

  // Idempotencja: ten sam zasób + ta sama treść = ta sama blokada.
  const kluczBlokady = `ifapi:${crypto.createHash('sha256').update(`${metoda} ${sciezka} ${tresc}${b.nowyKlucz ? ` ${crypto.randomUUID()}` : ''}`).digest('hex')}`;
  let blokada = await claimConfirm(prisma, kluczBlokady);
  if (blokada.state === 'in_progress' && b.ponowPoSprawdzeniu === true) {
    await releaseConfirm(prisma, kluczBlokady);
    blokada = await claimConfirm(prisma, kluczBlokady);
  }
  if (blokada.state === 'done') {
    return res.json({ ok: true, juzWykonane: true, numer: blokada.invoiceNumber === 'wykonano' ? null : blokada.invoiceNumber, id: blokada.invoiceId || null, uwaga: 'To samo żądanie zostało już wykonane — drugi raz nie wysyłam. Świadomie drugi raz: "nowyKlucz": true.' });
  }
  if (blokada.state === 'in_progress') {
    return res.status(409).json({ ok: false, wToku: true, error: 'To samo żądanie jest w toku albo poprzednie skończyło się bez odpowiedzi iFirmy. Sprawdź, czy dokument nie powstał (GET /api/if/iapi/faktury.json?dataOd=…&dataDo=…), potem ponów z "ponowPoSprawdzeniu": true.' });
  }

  let r;
  try {
    r = await ifirmaHttp(metoda, sciezka, { tresc });
    // Miesiąc księgowy iFirmy musi pasować do daty dokumentu — przestawiamy i ponawiamy raz.
    const o = odp(r);
    const data = b.dane && (b.dane.DataSprzedazy || b.dane.DataWystawienia);
    if (kodIfirmy(r) === 201 && /miesi[aą]c.*ksi[eę]gow|rok.*ksi[eę]gow/i.test(String(o.Informacja || '')) && /^\d{4}-\d{2}/.test(String(data || ''))) {
      const [rok, mies] = String(data).split('-').map(Number);
      console.log(`[if/zapis] miesiąc księgowy → ${rok}-${String(mies).padStart(2, '0')} i ponowienie (${bezParametrow})`);
      await przestawMiesiac(mies, rok);
      r = await ifirmaHttp(metoda, sciezka, { tresc });
    }
  } catch (e) {
    if (e.status === 503) { await releaseConfirm(prisma, kluczBlokady); return res.status(503).json({ ok: false, error: e.message }); }
    // Bez odpowiedzi nie wiadomo, czy dokument powstał — blokada zostaje.
    console.error(`[if/zapis] ${metoda} ${bezParametrow} bez odpowiedzi:`, e.message);
    return res.status(502).json({ ok: false, niepewne: true, error: `${e.message}. Nie wiadomo, czy iFirma wykonała żądanie — sprawdź (np. GET /api/if/iapi/faktury.json?dataOd=…), potem ponów z "ponowPoSprawdzeniu": true.` });
  }

  const kod = kodIfirmy(r);
  if (r.status !== 200 || (kod != null && kod !== 0)) {
    await releaseConfirm(prisma, kluczBlokady);
    return res.status(r.status >= 500 ? 502 : 400).json({ ok: false, error: `iFirma odrzuciła: ${opis(r)}`, ifirma: r.json || r.buf.toString('utf8').slice(0, 500) });
  }

  // Sukces. Dla nowego dokumentu sprzedaży: identyfikator i pełny numer (czasem trzeba dopytać).
  let id = znajdzPole(odp(r), ['Identyfikator', 'FakturaId', 'IdentyfikatorFaktury']);
  let numer = znajdzPole(odp(r), ['PelnyNumer']);
  const rodzaj = (bezParametrow.match(/^((?:faktura|rachunek)[a-z]+)\.json$/i) || [])[1];
  if (metoda === 'POST' && rodzaj && id && !numer) {
    try { numer = znajdzPole(odp(await ifirmaHttp('GET', `${rodzaj}/${encodeURIComponent(id)}.json`)), ['PelnyNumer']); }
    catch (e) { console.warn('[if/zapis] numer dokumentu:', e.message); }
  }
  // Numer w ConfirmLock = dokument „z CRM" dla strażnika (przegląd faktur).
  await completeConfirm(prisma, kluczBlokady, numer || 'wykonano', id != null ? String(id) : null);
  console.log(`[if/zapis] ${metoda} ${bezParametrow} OK${numer ? ` — ${numer}` : ''}${id ? ` (id ${id})` : ''}`);
  return res.json({ ok: true, numer: numer || null, id: id != null ? String(id) : null, ifirma: odp(r) });
}
router.post(/^\/iapi\/(.+)$/, asyncHandler((req, res) => zapis('POST', req, res)));
router.put(/^\/iapi\/(.+)$/, asyncHandler((req, res) => zapis('PUT', req, res)));

module.exports = router;
module.exports._test = {
  nazwaKlucza, podpis, znajdzPole,
  ustawHttp: (f) => { ifirmaHttp = f || ifirmaHttpDomyslny; },
  ustawMiesiac: (f) => { przestawMiesiac = f || (async (m, r) => require('../ifirma-client').setAccountingMonth(m, r)); },
};
