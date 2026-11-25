'use strict';
// Pełne API GlobKuriera dla Claude (25.11.2026): odczyt /v1/*, zamówienie
// z każdym sposobem nadania — domyślnie próba, prawdziwe tylko z "zamow": true.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');

const SRC = path.join(__dirname, '..', 'src');
function podstaw(plik, eksport) {
  const p = require.resolve(path.join(SRC, plik));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: eksport };
}
const S = { slot: { date: '2026-11-26', timeFrom: '09:00', timeTo: '17:00' }, gkCache: [] };
podstaw('glob-client.js', {
  getToken: async () => 'TOKEN',
  findNearestPickupDate: async () => S.slot,
});
podstaw('routes/invoices.js', { addGkOrderToCache: (o) => S.gkCache.push(o) });
const gkPelne = require(path.join(SRC, 'routes', 'gk-pelne'));
const T = gkPelne._test;

/** Atrapa API GK: odpowiedź wg metody i ścieżki; zapisuje wywołania. */
function atrapaGk(odpowiedz) {
  const wolania = [];
  T.ustawGk(async (metoda, sciezka, opcje = {}) => {
    wolania.push({ metoda, sciezka, body: opcje.body ? JSON.parse(JSON.stringify(opcje.body)) : null, token: opcje.token });
    const r = await odpowiedz(metoda, sciezka, opcje.body);
    if (r instanceof Error) throw r;
    const buf = r.buf || Buffer.from(r.json !== undefined ? JSON.stringify(r.json) : '');
    return { status: r.status || 200, typ: r.typ || 'application/json', buf, json: r.json !== undefined ? r.json : null, naglowki: r.naglowki || {} };
  });
  return wolania;
}
const SENDER_GALINY = { id: 'galiny', name: 'Surf Stick Galiny', companyName: null, street: 'Galiny', houseNumber: '110', postCode: '11-200', city: 'Bartoszyce', country: 'PL', countryId: 1, phone: '502 189 886', email: 'delivery@surfstickbell.com', isDefault: true, extras: { id: 301539 } };
function baza() {
  const db = {
    zdarzenia: [], faktury: [],
    sender: {
      findUnique: async ({ where }) => (where.id === 'galiny' ? SENDER_GALINY : null),
      findMany: async () => [SENDER_GALINY],
    },
    config: { findUnique: async () => ({ value: JSON.stringify({ PL: 1, DE: 23, CZ: 8, IT: 33 }) }) },
    invoice: { updateMany: async (a) => { db.faktury.push(a); return { count: 1 }; } },
    activityEvent: { create: async ({ data }) => { db.zdarzenia.push(data); return data; } },
  };
  return db;
}
async function zapytaj(db, metoda, sciezka, { rola = 'owner', body } = {}) {
  const app = express();
  app.use(express.json());
  app.locals.prisma = db;
  app.use((req, _res, next) => { req.crm = rola === 'magazyn' ? { user: 'm', role: 'magazyn' } : { user: 'claude', role: 'owner' }; next(); });
  app.use('/', gkPelne);
  const serwer = app.listen(0);
  await new Promise(r => serwer.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${serwer.address().port}${sciezka}`, { method: metoda, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const typ = res.headers.get('content-type') || '';
    return { status: res.status, typ, json: typ.includes('json') ? await res.json() : null, buf: typ.includes('json') ? null : Buffer.from(await res.arrayBuffer()) };
  } finally { serwer.close(); }
}
const poczekaj = () => new Promise(r => setImmediate(() => setImmediate(r)));

// Paczkomat w Niemczech: produkt z dostawą do punktu, odbiorca z pointId.
const PACZKOMAT = {
  senderId: 'galiny',
  receiverAddress: { name: 'Packstation Kunde, Anna Müller', street: 'Hauptstraße', houseNumber: '5', postCode: '10115', city: 'Berlin (BE)', country: 'DE', phone: '0151 2345678', email: 'anna@example.de', pointId: 'DE-PACK-123' },
  shipment: { productId: 4242, length: 29, width: 19, height: 10, weight: 1.2 },
  addons: [{ id: 1578, value: 300 }],
};
function gkWzorcowe(nadpis = {}) {
  return (metoda, sciezka) => {
    const p = sciezka.split('?')[0];
    if (nadpis[`${metoda} ${p}`]) return nadpis[`${metoda} ${p}`](sciezka);
    if (metoda === 'POST' && p === '/v1/order/validate') return { json: {} };
    if (metoda === 'GET' && p === '/v1/product/addons') return { json: { addons: [{ id: 1578, addonName: 'Ubezpieczenie', category: 'INSURANCE', priceGross: 4.92 }, { id: 211, addonName: 'Doręczenie do osoby prywatnej', category: 'DELIVERY_TO_PERSON', isRequired: true, priceGross: 0 }] } };
    if (metoda === 'GET' && p === '/v1/order/price') return { json: { currency: 'PLN', totalGrossPrice: 41.33, totalNetPrice: 33.6 } };
    if (metoda === 'POST' && p === '/v1/order') return { json: { number: 'GK261125000001', hash: 'h'.repeat(64) } };
    return { status: 404, json: { message: 'nie ma' } };
  };
}

test('GET /v1/*: zapytanie przekazane 1:1 (tablice collectionTypes[]), token po naszej stronie; PDF jako plik', async () => {
  const wolania = atrapaGk((metoda, sciezka) => (sciezka.startsWith('/v1/order/labels')
    ? { typ: 'application/pdf', buf: Buffer.from('%PDF-1.4 x'), json: undefined, naglowki: { 'content-disposition': 'inline; filename="x.pdf"' } }
    : { json: { ok: 1, sciezka } }));
  const db = baza();
  const r = await zapytaj(db, 'GET', '/v1/products?width=10&height=10&length=10&weight=1&quantity=1&senderCountryId=1&receiverCountryId=23&collectionTypes[]=POINT&deliveryTypes[]=POINT&deliveryTypes[]=PICKUP');
  assert.equal(r.status, 200);
  assert.equal(wolania[0].sciezka, '/v1/products?width=10&height=10&length=10&weight=1&quantity=1&senderCountryId=1&receiverCountryId=23&collectionTypes[]=POINT&deliveryTypes[]=POINT&deliveryTypes[]=PICKUP');
  assert.equal(wolania[0].token, 'TOKEN');
  const pdf = await zapytaj(db, 'GET', `/v1/order/labels?orderHashes[]=${'a'.repeat(64)}&format=A4`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.typ, /application\/pdf/);
  assert.equal(pdf.buf.slice(0, 5).toString(), '%PDF-');
  // logowanie/tokeny nie przechodzą; magazyn nie ma dostępu
  assert.equal((await zapytaj(db, 'GET', '/v1/auth/login')).status, 400);
  assert.equal((await zapytaj(db, 'GET', '/v1/products?x=1', { rola: 'magazyn' })).status, 403);
  assert.equal(wolania.length, 2);
});

test('nadawcy: gotowy senderAddress z naszego rekordu (telefon E.164, numer domu)', async () => {
  atrapaGk(() => ({ json: {} }));
  const r = await zapytaj(baza(), 'GET', '/nadawcy');
  assert.deepEqual(r.json.nadawcy, [{ id: 'galiny', nazwa: 'Surf Stick Galiny', domyslny: true, senderAddress: { name: 'Surf Stick Galiny', street: 'Galiny', houseNumber: '110', postCode: '11-200', city: 'Bartoszyce', countryId: 1, phone: '+48502189886', email: 'delivery@surfstickbell.com' } }]);
});

test('próba (domyślnie): walidacja + wycena, ŻADNEGO zlecenia; adres oczyszczony, kraj z ISO, pointId zostaje', async () => {
  const wolania = atrapaGk(gkWzorcowe());
  const db = baza();
  const r = await zapytaj(db, 'POST', '/zamowienie', { body: PACZKOMAT });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.proba, true);
  assert.equal(r.json.ok, true);
  assert.ok(!wolania.some(w => w.metoda === 'POST' && w.sciezka === '/v1/order'), 'bez zlecenia');
  const b = r.json.zamowienie;
  assert.equal(b.receiverAddress.name, 'Packstation Kunde Anna Müller', 'przecinek usunięty, nazwa ≤ 30');
  assert.equal(b.receiverAddress.city, 'Berlin');
  assert.equal(b.receiverAddress.countryId, 23);
  assert.equal(b.receiverAddress.country, undefined, 'pole country nie idzie do GK');
  assert.equal(b.receiverAddress.phone, '+491512345678');
  assert.equal(b.receiverAddress.pointId, 'DE-PACK-123');
  assert.equal(b.senderAddress.name, 'Surf Stick Galiny');
  assert.deepEqual([b.collectionType, b.paymentId, b.content, b.purpose, b.containsDangerousGoods], ['PICKUP', 9, 'Cosmetics / Surf Stick Bell', 'SOLD', false]);
  assert.deepEqual(b.pickup, { date: '2026-11-26', timeFrom: '09:00', timeTo: '17:00' }, 'podjazd: najbliższy termin z GK');
  assert.match(b.orderHash, /^[0-9a-f]{64}$/);
  // wycena z dodatkami: ubezpieczenie z wartością, wymagany dodatek, którego nie wybrano
  const cena = wolania.find(w => w.sciezka.startsWith('/v1/order/price')).sciezka;
  assert.match(cena, /productId=4242/); assert.match(cena, /paymentId=9/); assert.match(cena, /addonIds%5B%5D=1578/); assert.match(cena, /insuranceValue=300/);
  assert.equal(r.json.cena.brutto, 41.33);
  assert.deepEqual(r.json.cena.wybrane, [{ id: 1578, nazwa: 'Ubezpieczenie', kategoria: 'INSURANCE', cenaBrutto: 4.92 }]);
  assert.deepEqual(r.json.cena.wymaganeBrak, [{ id: 211, nazwa: 'Doręczenie do osoby prywatnej', kategoria: 'DELIVERY_TO_PERSON' }]);
  const walid = wolania.find(w => w.sciezka === '/v1/order/validate');
  assert.equal(walid.body.orderHash, undefined, 'walidacja GK nie przyjmuje orderHash („Nadmiarowe pole")');
  assert.equal(walid.body.receiverAddress.pointId, 'DE-PACK-123');
  assert.equal(db.zdarzenia.length, 0);
});

test('próba: odmowa walidacji GK wraca czytelnie; nadanie z punktu bez pointId zatrzymane przed GK', async () => {
  atrapaGk(gkWzorcowe({ 'POST /v1/order/validate': () => ({ status: 400, json: { fields: { 'receiverAddress[pointId]': 'Nieprawidłowy punkt odbioru' } } }) }));
  const r = await zapytaj(baza(), 'POST', '/zamowienie', { body: PACZKOMAT });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.walidacja.bledy, 'receiverAddress[pointId]: Nieprawidłowy punkt odbioru');
  const wolania = atrapaGk(gkWzorcowe());
  const bezPunktu = await zapytaj(baza(), 'POST', '/zamowienie', { body: { ...PACZKOMAT, collectionType: 'POINT' } });
  assert.equal(bezPunktu.status, 400);
  assert.match(bezPunktu.json.error, /POINT wymaga senderAddress\.pointId/);
  assert.equal(wolania.length, 0);
  const zly = await zapytaj(baza(), 'POST', '/zamowienie', { body: { ...PACZKOMAT, collectionType: 'DRON' } });
  assert.match(zly.json.error, /PICKUP \/ POINT \/ CROSSBORDER/);
  assert.match((await zapytaj(baza(), 'POST', '/zamowienie', { body: { ...PACZKOMAT, senderId: 'nie-ma' } })).json.error, /nie ma nadawcy/);
});

test('bez dodatków pole addons znika (GK: „Pole nie może być puste"), także w zleceniu', async () => {
  const wolania = atrapaGk(gkWzorcowe());
  const { addons, ...bezDodatkow } = PACZKOMAT;
  const r = await zapytaj(baza(), 'POST', '/zamowienie', { body: { ...bezDodatkow, addons: [] } });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.zamowienie.addons, undefined);
  assert.equal(wolania.find(w => w.sciezka === '/v1/order/validate').body.addons, undefined);
  assert.ok(!/addonIds/.test(wolania.find(w => w.sciezka.startsWith('/v1/order/price')).sciezka));
  await zapytaj(baza(), 'POST', '/zamowienie', { body: { ...bezDodatkow, zamow: true } });
  const zlec = wolania.find(w => w.metoda === 'POST' && w.sciezka === '/v1/order');
  assert.equal(zlec.body.addons, undefined);
  assert.match(zlec.body.orderHash, /^[0-9a-f]{64}$/, 'samo zlecenie ma orderHash');
});

test('nadanie w punkcie (POINT): bez terminu podjazdu, punkt nadawcy w adresie', async () => {
  const wolania = atrapaGk(gkWzorcowe());
  const r = await zapytaj(baza(), 'POST', '/zamowienie', { body: { ...PACZKOMAT, collectionType: 'POINT', senderAddress: { pointId: 'BRT01M' } } });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.zamowienie.senderAddress.pointId, 'BRT01M');
  assert.equal(r.json.zamowienie.senderAddress.city, 'Bartoszyce', 'reszta adresu z rekordu nadawcy');
  assert.equal(r.json.zamowienie.pickup, undefined);
  assert.ok(wolania.some(w => w.sciezka === '/v1/order/validate'));
});

test('zamow:true → zlecenie, zdarzenie shipment.created (strażnik je zna), powiązanie z FV', async () => {
  const wolania = atrapaGk(gkWzorcowe());
  const db = baza();
  const r = await zapytaj(db, 'POST', '/zamowienie', { body: { ...PACZKOMAT, zamow: true, invoiceNumber: '268/2026' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.numer, 'GK261125000001');
  const zlec = wolania.filter(w => w.metoda === 'POST' && w.sciezka === '/v1/order');
  assert.equal(zlec.length, 1);
  assert.equal(zlec[0].body.zamow, undefined, 'nasze pola nie idą do GK');
  assert.equal(zlec[0].body.invoiceNumber, undefined);
  assert.equal(zlec[0].body.senderId, undefined);
  assert.equal(zlec[0].body.containsDangerousGoods, false);
  assert.ok(!wolania.some(w => w.sciezka === '/v1/order/validate'), 'przy zleceniu bez dodatkowej walidacji');
  await poczekaj();
  assert.equal(db.zdarzenia.length, 1);
  assert.equal(db.zdarzenia[0].type, 'shipment.created');
  assert.equal(db.zdarzenia[0].shipmentNumber, 'GK261125000001');
  assert.equal(db.zdarzenia[0].payload.collectionType, 'PICKUP');
  assert.deepEqual(db.faktury[0], { where: { number: '268/2026' }, data: { shipmentNumber: 'GK261125000001', shipmentHash: 'h'.repeat(64) } });
  assert.equal(S.gkCache.at(-1).number, 'GK261125000001');
});

test('powtórka tego samego zamówienia: ten sam orderHash → GK 429 → odczyt po hashu, drugiej paczki nie ma', async () => {
  let zlozone = null;
  const wolania = atrapaGk(gkWzorcowe({
    'POST /v1/order': () => (zlozone ? { status: 429, json: { message: 'Too many requests' } } : (zlozone = { json: { number: 'GK261125000002', hash: 'x'.repeat(64) } })),
    'GET /v1/order': () => (zlozone ? { json: { number: 'GK261125000002', hash: 'x'.repeat(64) } } : { status: 404, json: { message: 'brak' } }),
  }));
  const db = baza();
  const pierwsze = await zapytaj(db, 'POST', '/zamowienie', { body: { ...PACZKOMAT, zamow: true } });
  const drugie = await zapytaj(db, 'POST', '/zamowienie', { body: { ...PACZKOMAT, zamow: true } });
  assert.equal(pierwsze.json.numer, 'GK261125000002');
  assert.equal(drugie.json.ok, true);
  assert.equal(drugie.json.juzZamowione, true);
  const hashe = wolania.filter(w => w.sciezka === '/v1/order' && w.metoda === 'POST').map(w => w.body.orderHash);
  assert.equal(hashe.length, 2);
  assert.equal(hashe[0], hashe[1], 'ten sam body = ten sam orderHash');
  assert.ok(wolania.some(w => w.metoda === 'GET' && w.sciezka === `/v1/order?hash=${hashe[0]}`));
  // świadomie druga, identyczna paczka: nowyHash
  const trzecie = await zapytaj(db, 'POST', '/zamowienie', { body: { ...PACZKOMAT, nowyHash: true } });
  assert.notEqual(trzecie.json.orderHash, hashe[0]);
});

test('brak odpowiedzi GK przy zleceniu: sprawdza po hashu — jest → sukces; nie ma → 502 „niepewne" z instrukcją', async () => {
  let powstalo = true;
  atrapaGk(gkWzorcowe({
    'POST /v1/order': () => new Error('GlobKurier timeout po 45 s (POST /v1/order)'),
    'GET /v1/order': () => (powstalo ? { json: { number: 'GK261125000003', hash: 'y'.repeat(64) } } : { status: 404, json: {} }),
  }));
  const db = baza();
  const ok = await zapytaj(db, 'POST', '/zamowienie', { body: { ...PACZKOMAT, zamow: true } });
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.numer, 'GK261125000003');
  assert.match(ok.json.uwaga, /nie odpowiedział na czas, ale zlecenie powstało/);
  powstalo = false;
  const nie = await zapytaj(db, 'POST', '/zamowienie', { body: { ...PACZKOMAT, zamow: true } });
  assert.equal(nie.status, 502);
  assert.equal(nie.json.niepewne, true);
  assert.match(nie.json.error, /sprawdź GET \/api\/gk\/v1\/order\?hash=/);
});

test('odmowa GK przy zleceniu: 400 z treścią; podjazd do istniejącego zlecenia tylko z zamow:true', async () => {
  const wolania = atrapaGk(gkWzorcowe({
    'POST /v1/order': () => ({ status: 400, json: { fields: { 'receiverAddress[phone]': 'Nieprawidłowy numer' } } }),
    'GET /v1/order': () => ({ status: 404, json: {} }),
    'POST /v1/order/createPickup': () => ({ json: { ok: true } }),
  }));
  const r = await zapytaj(baza(), 'POST', '/zamowienie', { body: { ...PACZKOMAT, zamow: true } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /odrzucił zlecenie \(HTTP 400\): receiverAddress\[phone\]: Nieprawidłowy numer/);
  const hash = 'c'.repeat(64);
  assert.equal((await zapytaj(baza(), 'POST', '/odbior', { body: { hash } })).status, 400);
  assert.equal(wolania.filter(w => w.sciezka === '/v1/order/createPickup').length, 0);
  const p = await zapytaj(baza(), 'POST', '/odbior', { body: { hash, zamow: true } });
  assert.equal(p.json.ok, true);
  assert.deepEqual(wolania.find(w => w.sciezka === '/v1/order/createPickup').body, { hash });
});

test('zlecenie odbite przez „Nadmiarowe pole" orderHash: ponowione raz bez niego, jedna paczka', async () => {
  const wolania = atrapaGk(gkWzorcowe({
    'POST /v1/order': (sciezka, body) => null,
  }));
  // własna atrapa: pierwsze zlecenie z orderHash → 400 Nadmiarowe pole, drugie bez → OK
  const zlecenia = [];
  T.ustawGk(async (metoda, sciezka, opcje = {}) => {
    const p = sciezka.split('?')[0];
    if (metoda === 'POST' && p === '/v1/order') {
      zlecenia.push(JSON.parse(JSON.stringify(opcje.body)));
      if (opcje.body.orderHash) return { status: 400, typ: 'application/json', buf: Buffer.from('{}'), json: { fields: { orderHash: 'Nadmiarowe pole.' } }, naglowki: {} };
      return { status: 200, typ: 'application/json', buf: Buffer.from('{}'), json: { number: 'GK261125000009', hash: 'z'.repeat(64) }, naglowki: {} };
    }
    if (metoda === 'GET' && p === '/v1/order') throw new Error('nie powinno pytać po hashu bez orderHash');
    return { status: 200, typ: 'application/json', buf: Buffer.from('{}'), json: {}, naglowki: {} };
  });
  const db = baza();
  const r = await zapytaj(db, 'POST', '/zamowienie', { body: { ...PACZKOMAT, zamow: true } });
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  assert.equal(r.json.numer, 'GK261125000009');
  assert.equal(zlecenia.length, 2);
  assert.ok(zlecenia[0].orderHash && !zlecenia[1].orderHash);
  assert.equal(zlecenia[1].containsDangerousGoods, false, 'inne pola zostają');
  assert.equal(wolania.length, 0);
});

test.after(() => { T.ustawGk(null); T.ustawToken(null); });
