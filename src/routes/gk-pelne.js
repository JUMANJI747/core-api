'use strict';

/* PEŁNE API GLOBKURIERA DLA CLAUDE (25.11.2026).
 *
 * Właściciel: „żebyśmy przez ciebie mogli nadawać paczki dowolnie, nie tylko
 * z podjazdem kuriera; przez CRM zawsze podjazd kuriera, ale żebyś ty miał
 * wszystkie opcje z tego API". Panel CRM (Wysyłki, Magazyn) zostaje bez zmian
 * na /glob/quote + /glob/order (zawsze PICKUP). Tu jest osobna, „ekspercka"
 * ścieżka, z której korzysta Claude według OBSLUGA.md:
 *
 *   GET  /api/gk/v1/*        — odczyt dowolnego zasobu API GK (produkty z każdym
 *                              sposobem nadania/odbioru, dodatki, punkty i paczkomaty,
 *                              terminy odbioru, kraje, zamówienie, etykiety…),
 *                              zapytanie przekazane 1:1, token po naszej stronie;
 *   GET  /api/gk/nadawcy     — nasi nadawcy (Sender) z gotowym senderAddress;
 *   POST /api/gk/zamowienie  — zamówienie z pełnym body GK (collectionType PICKUP /
 *                              POINT / CROSSBORDER, pointId, dodatki, cło…).
 *                              DOMYŚLNIE PRÓBA: walidacja GK + wycena, nic nie powstaje.
 *                              Prawdziwe zlecenie tylko z "zamow": true;
 *   POST /api/gk/odbior      — ponowne zamówienie podjazdu do istniejącego zlecenia
 *                              (tylko z "zamow": true).
 *
 * Bezpieczniki: orderHash liczony z treści zamówienia (GK odrzuca identyczne
 * zlecenie w ciągu 24 h kodem 429 — powtórzone wywołanie nie zrobi drugiej
 * paczki), po braku odpowiedzi GK sprawdzamy, czy zlecenie powstało (GET /v1/order
 * po hashu), a każde zlecenie zapisujemy jako zdarzenie shipment.created —
 * inaczej strażnik zgłosiłby je jako „zamówienie GlobKurier, którego NIE złożył CRM". */

const router = require('express').Router();
const https = require('https');
const crypto = require('crypto');
const asyncHandler = require('../asyncHandler');
const { gkName, gkStreet, gkCity, numerGk, rozbijNumerDomu } = require('../services/adres-gk');
const { normalizujTelefon } = require('../services/telefon');
const { opisOdmowyGk } = require('../services/gk-odmowa');

const GK_HOST = 'api.globkurier.pl';
const DOMYSLNY_TELEFON = '+48502189886';
const DOMYSLNY_EMAIL = 'delivery@surfstickbell.com';
const TYPY_NADANIA = ['PICKUP', 'POINT', 'CROSSBORDER'];
const MAX_NAZWA = 30; // tyle GK zostawia z nazwy na liście przewozowym

const tylkoWlasciciel = (req, res) => {
  if (req.crm && req.crm.role === 'magazyn') { res.status(403).json({ ok: false, error: 'tylko właściciel' }); return false; }
  return true;
};

/* ---------- jedno wywołanie API GK (JSON albo plik) ---------- */
function gkHttpDomyslny(metoda, sciezka, { body = null, token = null, timeoutMs = 30000, surowe = null } = {}) {
  return new Promise((resolve, reject) => {
    // surowe = { typ, buf } — treść inna niż JSON (np. multipart z dokumentem handlowym).
    const dane = surowe ? surowe.buf : (body ? JSON.stringify(body) : null);
    const typTresci = surowe ? surowe.typ : 'application/json';
    const req = https.request({
      hostname: GK_HOST, path: sciezka, method: metoda,
      headers: {
        Accept: 'application/json, application/pdf, */*', 'Accept-Language': 'pl',
        ...(token ? { 'X-Auth-Token': token } : {}),
        ...(dane ? { 'Content-Type': typTresci, 'Content-Length': Buffer.byteLength(dane) } : {}),
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`GlobKurier timeout po ${Math.round(timeoutMs / 1000)} s (${metoda} ${sciezka.split('?')[0]})`)));
    req.on('error', reject);
    if (dane) req.write(dane);
    req.end();
  });
}
let gkHttp = gkHttpDomyslny;
let pobierzToken = async () => require('../glob-client').getToken();

async function gk(metoda, sciezka, opcje = {}) {
  const token = await pobierzToken();
  return gkHttp(metoda, sciezka, { ...opcje, token });
}
const bladGk = (r) => opisOdmowyGk(r.json ? Buffer.from(JSON.stringify(r.json)) : r.buf) || `HTTP ${r.status}`;

/* ---------- GET /api/gk/v1/* — odczyt 1:1 ---------- */
router.get(/^\/v1\/(.+)$/, asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const zasob = String(req.params[0] || '');
  // Logowanie i tokeny zostają po stronie serwera; reszta API GK to odczyt danych konta.
  if (/^(auth|user\/token)/i.test(zasob) || zasob.includes('..')) return res.status(400).json({ ok: false, error: 'tego zasobu nie przekazuję (logowanie/tokeny)' });
  const zapytanie = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  let r;
  try { r = await gk('GET', `/v1/${zasob}${zapytanie}`); }
  catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  if (r.json != null) return res.status(r.status).json(r.json);
  res.status(r.status);
  if (r.typ) res.setHeader('Content-Type', r.typ);
  if (r.naglowki && r.naglowki['content-disposition']) res.setHeader('Content-Disposition', r.naglowki['content-disposition']);
  res.send(r.buf);
}));

/* ---------- nadawcy ---------- */
function przytnijNazwe(n) {
  const s = String(n || '').trim();
  if (s.length <= MAX_NAZWA) return s;
  return s.split(' ').reduce((acc, w) => ((`${acc} ${w}`).trim().length <= MAX_NAZWA ? `${acc} ${w}`.trim() : acc), '') || s.slice(0, MAX_NAZWA);
}
/** senderAddress w kształcie GK z naszego rekordu Sender (te same reguły co /glob/order). */
function adresNadawcy(s) {
  const ex = (s && typeof s.extras === 'object' && s.extras) || {};
  const kraj = String(s.country || 'PL').toUpperCase();
  const rozbity = rozbijNumerDomu(ex.houseNumber || s.houseNumber || '');
  const tel = normalizujTelefon(ex.phone || s.phone || '', kraj);
  const adres = {
    name: przytnijNazwe(gkName(ex.name || s.companyName || s.name || 'Surf Stick Bell')),
    street: gkStreet(String(ex.street || s.street || '').trim()),
    houseNumber: numerGk(rozbity.dom) || '1',
    postCode: String(s.postCode || ex.postCode || '').trim(),
    city: gkCity(String(s.city || ex.city || '').trim()),
    countryId: Number(s.countryId) || 1,
    phone: tel || DOMYSLNY_TELEFON,
    email: String(ex.email || s.email || DOMYSLNY_EMAIL).trim(),
  };
  const lokal = numerGk(ex.apartmentNumber || rozbity.lokal);
  if (lokal) adres.apartmentNumber = lokal;
  return adres;
}

router.get('/nadawcy', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const lista = await req.app.locals.prisma.sender.findMany({ orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
  res.json({ ok: true, nadawcy: lista.map((s) => ({ id: s.id, nazwa: s.name, domyslny: !!s.isDefault, senderAddress: adresNadawcy(s) })) });
}));

/* ---------- budowa zamówienia ---------- */
async function mapaKrajow(prisma) {
  try {
    const row = await prisma.config.findUnique({ where: { key: 'gk_country_ids' } });
    const m = row && row.value ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : {};
    return (m && typeof m === 'object') ? m : {};
  } catch (_) { return {}; }
}

/** Czyści adres pod GK: znaki w nazwie/ulicy/mieście, numer domu, telefon z kierunkowym
 *  kraju; `country` (ISO) zamienia na countryId. pointId i reszta pól — bez zmian. */
function oczyscAdres(a, krajNaId, idNaKraj) {
  const w = { ...(a || {}) };
  if (w.country && !w.countryId) {
    const id = krajNaId[String(w.country).toUpperCase()];
    if (id) w.countryId = Number(id);
  }
  const iso = String(w.country || idNaKraj[String(w.countryId)] || '').toUpperCase();
  delete w.country;
  if (w.name) w.name = przytnijNazwe(gkName(w.name));
  if (w.street) w.street = gkStreet(w.street);
  if (w.city) w.city = gkCity(w.city);
  if (w.houseNumber) w.houseNumber = numerGk(w.houseNumber);
  if (w.apartmentNumber) w.apartmentNumber = numerGk(w.apartmentNumber);
  if (w.phone && iso) { const t = normalizujTelefon(w.phone, iso); if (t) w.phone = t; }
  for (const k of Object.keys(w)) if (w[k] === '' || w[k] == null) delete w[k];
  return w;
}

// Pola wejścia, które są nasze (nie idą do GK).
const NASZE_POLA = ['senderId', 'zamow', 'invoiceNumber', 'nowyHash', 'country'];

/** Z wejścia robi body dla POST /v1/order. Rzuca przy brakach, których GK i tak nie przyjmie. */
async function zbudujZamowienie(prisma, we) {
  const b = { ...(we || {}) };
  for (const k of NASZE_POLA) delete b[k];
  const krajNaId = await mapaKrajow(prisma);
  const idNaKraj = Object.fromEntries(Object.entries(krajNaId).map(([iso, id]) => [String(id), iso]));

  if (we.senderId) {
    const s = await prisma.sender.findUnique({ where: { id: String(we.senderId) } });
    if (!s) throw Object.assign(new Error(`nie ma nadawcy ${we.senderId} (lista: GET /api/gk/nadawcy)`), { status: 400 });
    b.senderAddress = { ...adresNadawcy(s), ...((we.senderAddress && typeof we.senderAddress === 'object') ? we.senderAddress : {}) };
  }
  if (!b.senderAddress) throw Object.assign(new Error('podaj senderId (GET /api/gk/nadawcy) albo senderAddress'), { status: 400 });
  if (!b.receiverAddress) throw Object.assign(new Error('podaj receiverAddress'), { status: 400 });
  b.senderAddress = oczyscAdres(b.senderAddress, krajNaId, idNaKraj);
  b.receiverAddress = oczyscAdres(b.receiverAddress, krajNaId, idNaKraj);
  if (!b.receiverAddress.countryId) throw Object.assign(new Error('receiverAddress: podaj countryId albo country (ISO, np. DE)'), { status: 400 });

  const sh = b.shipment || {};
  if (!sh.productId) throw Object.assign(new Error('shipment.productId — wybierz produkt z GET /api/gk/v1/products'), { status: 400 });
  b.shipment = { quantity: 1, ...sh, productId: Number(sh.productId) };

  b.collectionType = String(b.collectionType || 'PICKUP').toUpperCase();
  if (!TYPY_NADANIA.includes(b.collectionType)) throw Object.assign(new Error(`collectionType: ${TYPY_NADANIA.join(' / ')}`), { status: 400 });
  if (b.collectionType !== 'PICKUP' && !b.senderAddress.pointId) throw Object.assign(new Error(`collectionType ${b.collectionType} wymaga senderAddress.pointId (punkt nadania z GET /api/gk/v1/points?productId=…&addressType=sender)`), { status: 400 });

  if (b.paymentId == null) b.paymentId = 9;           // prepaid (faktura zbiorcza) — jak wszystkie nasze zlecenia
  if (!b.content) b.content = 'Cosmetics / Surf Stick Bell';
  if (!b.purpose) b.purpose = 'SOLD';
  if (b.containsDangerousGoods == null) b.containsDangerousGoods = false; // obowiązkowe od 1.01.2027
  // GK: pusta lista dodatków to błąd („Pole nie może być puste") — bez dodatków pole znika.
  if (Array.isArray(b.addons) && b.addons.length) b.addons = b.addons.map((a) => (typeof a === 'object' ? { ...a, id: Number(a.id) } : { id: Number(a) }));
  else delete b.addons;

  // Idempotencja: ten sam body = ten sam orderHash, GK odrzuca powtórkę w 24 h (429).
  if (!b.orderHash || we.nowyHash) {
    const kanon = JSON.stringify({ ...b, orderHash: undefined, ...(we.nowyHash ? { _los: crypto.randomUUID() } : {}) });
    b.orderHash = crypto.createHash('sha256').update(kanon).digest('hex');
  }
  return b;
}

/** Podjazd kuriera bez podanego terminu: najbliższy termin z GK. */
async function uzupelnijOdbior(b) {
  if (b.collectionType !== 'PICKUP' || (b.pickup && b.pickup.date)) return null;
  const s = b.senderAddress; const r = b.receiverAddress;
  try {
    const slot = await require('../glob-client').findNearestPickupDate(b.shipment.productId, {
      senderCountryId: s.countryId, senderPostCode: s.postCode, senderCity: s.city, senderStreet: s.street, senderHouseNumber: s.houseNumber,
      receiverCountryId: r.countryId, receiverPostCode: r.postCode, receiverCity: r.city, weight: b.shipment.weight,
    }, 10, 8000);
    if (slot && slot.date) { b.pickup = { date: slot.date, timeFrom: slot.timeFrom, timeTo: slot.timeTo }; return b.pickup; }
  } catch (e) { console.warn('[gk/zamowienie] termin odbioru:', e.message); }
  return null;
}

/** Wycena całego zamówienia (GET /v1/order/price) + nazwy i ceny wybranych dodatków. */
async function wycen(b) {
  const s = b.senderAddress; const r = b.receiverAddress; const sh = b.shipment;
  const wspolne = new URLSearchParams({
    productId: String(sh.productId), length: String(sh.length), width: String(sh.width), height: String(sh.height),
    weight: String(sh.weight), quantity: String(sh.quantity || 1),
    senderCountryId: String(s.countryId), receiverCountryId: String(r.countryId),
  });
  if (s.postCode) wspolne.set('senderPostCode', s.postCode);
  if (r.postCode) wspolne.set('receiverPostCode', r.postCode);
  // Słownik dodatków produktu — kategorie (ubezpieczenie / pobranie) i wymagane.
  let slownik = [];
  try {
    const d = await gk('GET', `/v1/product/addons?${wspolne.toString()}`);
    const lista = d.json && (d.json.addons || d.json.results || d.json.items || (Array.isArray(d.json) ? d.json : []));
    if (Array.isArray(lista)) slownik = lista;
  } catch (e) { console.warn('[gk/zamowienie] dodatki:', e.message); }
  const poId = new Map(slownik.map((a) => [Number(a.id), a]));
  const cena = new URLSearchParams(wspolne);
  cena.set('paymentId', String(b.paymentId));
  const dodatki = b.addons || [];
  for (const a of dodatki) {
    cena.append('addonIds[]', String(a.id));
    const kat = String((poId.get(a.id) || {}).category || '');
    if (a.value != null && /INSURANCE/i.test(kat)) cena.set('insuranceValue', String(a.value));
    if (a.value != null && /CASH_ON_DELIVERY/i.test(kat)) cena.set('cashOnDeliveryValue', String(a.value));
  }
  if (b.discountCode) cena.set('discountCode', String(b.discountCode));
  const p = await gk('GET', `/v1/order/price?${cena.toString()}`);
  const wybrane = dodatki.map((a) => { const d = poId.get(a.id) || {}; return { id: a.id, nazwa: d.addonName || d.name || null, kategoria: d.category || null, cenaBrutto: d.priceGross != null ? Number(d.priceGross) : null }; });
  const wybraneId = new Set(dodatki.map((a) => a.id));
  const wymaganeBrak = slownik.filter((a) => (a.isRequired || a.required) && !wybraneId.has(Number(a.id))).map((a) => ({ id: Number(a.id), nazwa: a.addonName || a.name, kategoria: a.category || null }));
  if (p.status >= 400) return { ok: false, blad: bladGk(p), wybrane, wymaganeBrak };
  const j = p.json || {};
  return { ok: true, brutto: j.totalGrossPrice != null ? Number(j.totalGrossPrice) : null, netto: j.totalNetPrice != null ? Number(j.totalNetPrice) : null, waluta: j.currency || 'PLN', wybrane, wymaganeBrak, szczegoly: j };
}

/** Skutki po zleceniu: zdarzenie (strażnik je zna), powiązanie z fakturą, lista FV. */
async function poZleceniu(prisma, z, b, invoiceNumber) {
  const numer = z.number || z.orderNumber || null;
  const hash = z.hash || z.orderHash || b.orderHash;
  const odb = b.receiverAddress || {};
  try {
    const { logActivity } = require('../services/activity-log');
    logActivity(prisma, {
      type: 'shipment.created', summary: `Paczka ${numer || hash} (API Claude, ${b.collectionType}) → ${odb.name || '?'}`, source: 'gk',
      shipmentNumber: numer, actorType: 'user', actorId: 'claude',
      payload: { orderHash: hash, number: numer, collectionType: b.collectionType, productId: b.shipment.productId, receiverName: odb.name, receiverCity: odb.city, receiverPointId: odb.pointId || null, senderPointId: (b.senderAddress || {}).pointId || null, addons: (b.addons || []).map((a) => a.id), invoiceNumber: invoiceNumber || null, zrodlo: 'api/gk' },
      tags: ['zrodlo:api-gk', `collection:${String(b.collectionType).toLowerCase()}`],
    });
  } catch (e) { console.error('[gk/zamowienie] zdarzenie:', e.message); }
  if (invoiceNumber && (numer || hash)) {
    try { await prisma.invoice.updateMany({ where: { number: String(invoiceNumber) }, data: { shipmentNumber: numer || hash, shipmentHash: hash || null } }); }
    catch (e) { console.error('[gk/zamowienie] powiązanie z FV:', e.message); }
  }
  try {
    const inv = require('./invoices');
    if (inv && typeof inv.addGkOrderToCache === 'function') inv.addGkOrderToCache({ number: numer || hash, status: 'NEW', carrier: '', receiverName: odb.name || '', date: new Date().toISOString(), tracking: null });
  } catch (_) { /* best-effort */ }
}

/* ---------- POST /api/gk/zamowienie ---------- */
router.post('/zamowienie', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const prisma = req.app.locals.prisma;
  const we = req.body || {};
  let b;
  try { b = await zbudujZamowienie(prisma, we); }
  catch (e) { return res.status(e.status || 500).json({ ok: false, error: e.message }); }
  const odbior = await uzupelnijOdbior(b);

  if (we.zamow !== true) {
    // PRÓBA: walidacja GK + wycena. Żadne zlecenie nie powstaje.
    let walidacja;
    try {
      // Walidacja nie przyjmuje orderHash („Nadmiarowe pole") — ma go tylko samo zlecenie.
      const { orderHash: _bezHasha, ...doWalidacji } = b;
      const v = await gk('POST', '/v1/order/validate', { body: doWalidacji });
      walidacja = v.status < 400 ? { ok: true } : { ok: false, bledy: bladGk(v), surowa: v.json };
    } catch (e) { walidacja = { ok: false, bledy: e.message }; }
    let cena;
    try { cena = await wycen(b); } catch (e) { cena = { ok: false, blad: e.message }; }
    return res.json({
      ok: walidacja.ok && cena.ok, proba: true, walidacja, cena, odbior: odbior || b.pickup || null,
      zamowienie: b, orderHash: b.orderHash,
      dalej: 'Nic nie zostało zamówione. Po akceptacji właściciela wyślij ten sam body z "zamow": true.',
    });
  }

  // PRAWDZIWE ZLECENIE (płatne).
  const sprawdzPoHashu = async () => {
    try {
      const g = await gk('GET', `/v1/order?hash=${encodeURIComponent(b.orderHash)}`);
      return g.status === 200 && g.json && (g.json.number || g.json.hash) ? g.json : null;
    } catch (_) { return null; }
  };
  /* Pola nowsze niż część API GK (orderHash, containsDangerousGoods): gdy zlecenie
     odbije je jako „Nadmiarowe pole", ponawiamy raz bez nich — odbite zlecenie nie
     powstało, więc ponowienie nie zrobi drugiej paczki. Bez orderHash tracimy tylko
     sprawdzanie po hashu (patrz bezHasha). */
  let bezHasha = false;
  const nadmiarowe = (odp) => {
    const f = (odp && odp.json && (odp.json.fields || (odp.json.errors && odp.json.errors.fields))) || {};
    return ['orderHash', 'containsDangerousGoods'].filter((k) => /nadmiarow|extra|not allowed|unexpected/i.test(String(f[k] || '')));
  };
  let r;
  try {
    r = await gk('POST', '/v1/order', { body: b, timeoutMs: 45000 });
    const zbedne = r.status === 400 ? nadmiarowe(r) : [];
    if (zbedne.length) {
      console.warn(`[gk/zamowienie] GK nie przyjmuje w zleceniu: ${zbedne.join(', ')} — ponawiam bez`);
      const b2 = { ...b };
      for (const k of zbedne) delete b2[k];
      bezHasha = zbedne.includes('orderHash');
      r = await gk('POST', '/v1/order', { body: b2, timeoutMs: 45000 });
    }
  } catch (e) {
    if (bezHasha) return res.status(502).json({ ok: false, niepewne: true, error: `${e.message}. Nie wiadomo, czy zlecenie powstało — sprawdź najnowsze zlecenia (GET /api/gk/v1/orders?limit=5) zanim ponowisz.` });
    const juz = await sprawdzPoHashu();
    if (juz) { await poZleceniu(prisma, juz, b, we.invoiceNumber); return res.json({ ok: true, numer: juz.number, hash: juz.hash || b.orderHash, uwaga: 'GlobKurier nie odpowiedział na czas, ale zlecenie powstało.', zlecenie: juz }); }
    return res.status(502).json({ ok: false, niepewne: true, orderHash: b.orderHash, error: `${e.message}. Nie wiadomo, czy zlecenie powstało — sprawdź GET /api/gk/v1/order?hash=${b.orderHash} zanim ponowisz.` });
  }
  const z = r.json || {};
  if (r.status < 300 && (z.number || z.hash || z.orderNumber)) {
    await poZleceniu(prisma, z, b, we.invoiceNumber);
    console.log(`[gk/zamowienie] zlecenie ${z.number || z.hash} (${b.collectionType}, produkt ${b.shipment.productId})`);
    return res.json({ ok: true, numer: z.number || z.orderNumber || null, hash: z.hash || b.orderHash, odbior: b.pickup || null, zlecenie: z });
  }
  // Każda odmowa: czy zlecenie z NASZYM orderHashem już istnieje? (429 = identyczne
  // zlecenie w ciągu 24 h; 5xx = nie wiadomo; inna odmowa przy powtórce z innym
  // terminem). Zlecenie o tym hashu mogło powstać tylko z tego samego zamówienia.
  const juz = bezHasha ? null : await sprawdzPoHashu();
  if (juz) {
    await poZleceniu(prisma, juz, b, we.invoiceNumber);
    return res.json({ ok: true, numer: juz.number, hash: juz.hash || b.orderHash, juzZamowione: true, uwaga: 'To zlecenie zostało już złożone wcześniej (ten sam orderHash) — drugiego nie ma.', zlecenie: juz });
  }
  if (r.status >= 500) return res.status(502).json({ ok: false, niepewne: true, orderHash: b.orderHash, error: `GlobKurier zgłosił błąd serwera (HTTP ${r.status}): ${bladGk(r)}. Zlecenia o tym orderHash nie ma — można ponowić tym samym body.` });
  return res.status(400).json({ ok: false, error: `GlobKurier odrzucił zlecenie (HTTP ${r.status}): ${bladGk(r)}`, gk: r.json, orderHash: b.orderHash });
}));

/* ---------- POST /api/gk/dokument-handlowy — dokumenty do odprawy (ETD) ----------
 * 27.11.2026, #12 do Szwajcarii: FedEx nadaje poza UE w trybie ETD — faktura musi
 * trafić elektronicznie do GlobKuriera (inaczej odprawa stoi). GK: najpierw manifest
 * (inicjuje listę dokumentów przewoźnika), potem POST multipart z plikiem w base64.
 * Bez "wykonaj": true tylko manifest (jakie typy dokumentów, co już wgrane). */
const NAZWA_PLIKU_GK = /^[A-Za-z0-9_.\-() ]{1,128}$/;
function multipart(pola) {
  const granica = `----gk${crypto.randomBytes(12).toString('hex')}`;
  const czesci = Object.entries(pola).map(([k, v]) => `--${granica}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  return { typ: `multipart/form-data; boundary=${granica}`, buf: Buffer.from(`${czesci.join('')}--${granica}--\r\n`, 'utf8') };
}
router.post('/dokument-handlowy', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const b = req.body || {};
  const hash = String(b.hash || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(hash)) return res.status(400).json({ ok: false, error: 'podaj hash zlecenia (64 znaki)' });
  let man;
  try { man = await gk('GET', `/v1/order/tradeDocument/manifest?hash=${hash}`); }
  catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  if (man.status >= 400) return res.status(400).json({ ok: false, error: `manifest dokumentów: ${bladGk(man)}`, gk: man.json });
  if (b.wykonaj !== true) return res.json({ ok: true, podglad: true, manifest: man.json, uwaga: 'Nic nie wgrane. Wgranie: {hash, plikBase64, nazwa, opis, typ, numer, "wykonaj": true}.' });
  const nazwa = String(b.nazwa || '').trim();
  const opis = String(b.opis || '').trim().slice(0, 256);
  const typ = String(b.typ || 'COMMERCIAL_INVOICE').trim();
  const numer = String(b.numer || '').trim();
  const plik = String(b.plikBase64 || '').replace(/\s+/g, '');
  const rozmiar = Buffer.from(plik, 'base64').length;
  const bledy = [];
  if (!NAZWA_PLIKU_GK.test(nazwa)) bledy.push('nazwa: 1–128 znaków, tylko A–Z a–z 0–9 _ . - ( ) spacja');
  if (!opis) bledy.push('opis: wymagany');
  if (!numer || numer.length > 15) bledy.push('numer: 1–15 znaków');
  if (!rozmiar) bledy.push('plikBase64: pusty');
  if (rozmiar > 1048576) bledy.push(`plik ma ${rozmiar} B — GK przyjmuje do 1 MiB`);
  if (bledy.length) return res.status(400).json({ ok: false, error: bledy.join('; ') });
  let r;
  try { r = await gk('POST', '/v1/order/tradeDocument', { surowe: multipart({ hash, content: plik, name: nazwa, description: opis, type: typ, referenceNumber: numer }) }); }
  catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  if (r.status >= 400) return res.status(400).json({ ok: false, error: `GlobKurier nie przyjął dokumentu (HTTP ${r.status}): ${bladGk(r)}`, gk: r.json });
  let po = null;
  try { po = (await gk('GET', `/v1/order/tradeDocument/manifest?hash=${hash}`)).json; } catch (_) { /* informacyjnie */ }
  console.log(`[gk/dokument] ${typ} ${numer} → zlecenie ${hash.slice(0, 12)} (${rozmiar} B)`);
  return res.json({ ok: true, gk: r.json, manifest: po });
}));

/* ---------- POST /api/gk/odbior — podjazd do istniejącego zlecenia ---------- */
router.post('/odbior', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const hash = String((req.body && req.body.hash) || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(hash)) return res.status(400).json({ ok: false, error: 'podaj hash zlecenia (64 znaki)' });
  if (!req.body || req.body.zamow !== true) return res.status(400).json({ ok: false, error: 'to zamawia kuriera u przewoźnika — wyślij z "zamow": true dopiero po zgodzie właściciela' });
  let r;
  try { r = await gk('POST', '/v1/order/createPickup', { body: { hash } }); }
  catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  if (r.status < 300) return res.json({ ok: true, gk: r.json });
  return res.status(400).json({ ok: false, error: `GlobKurier nie zamówił podjazdu (HTTP ${r.status}): ${bladGk(r)}`, gk: r.json });
}));

module.exports = router;
module.exports._test = {
  zbudujZamowienie, adresNadawcy, oczyscAdres, wycen, multipart,
  ustawGk: (f) => { gkHttp = f || gkHttpDomyslny; },
  ustawToken: (f) => { pobierzToken = f || (async () => require('../glob-client').getToken()); },
};
