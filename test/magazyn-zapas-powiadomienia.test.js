'use strict';
// 22.11.2026: (1) złożenie zamówienia do magazynu jest blokowane, gdy wg CRM
// brakuje towaru; (2) „Powiadom magazyn" poza godzinami pracy magazynu
// (weekend, po 16:00, przed 8:00) planuje mail na 8:00 dnia roboczego.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');

const SRC = path.join(__dirname, '..', 'src');
const { kiedyPowiadomic, opisTerminu } = require(path.join(SRC, 'services', 'godziny-magazynu'));

// ── godziny pracy magazynu ──────────────────────────────────────────────────
test('kiedyPowiadomic: pn–pt 8–16 od razu; weekend, po 16 i przed 8 → 8:00 dnia roboczego (czas warszawski)', () => {
  const k = (iso) => { const r = kiedyPowiadomic(new Date(iso)); return r.odRazu ? 'od razu' : `${r.kiedy.toISOString()} | ${r.opis} | ${r.powod}`; };
  assert.equal(k('2026-11-23T07:00:00Z'), 'od razu', 'poniedziałek 8:00');
  assert.equal(k('2026-11-23T14:59:59Z'), 'od razu', 'poniedziałek 15:59');
  assert.equal(k('2026-11-22T20:05:00Z'), '2026-11-23T07:00:00.000Z | jutro, w poniedziałek 23.11 o 8:00 | weekend', 'niedziela 21:05 (przypadek #10)');
  assert.equal(k('2026-11-23T15:00:00Z'), '2026-11-24T07:00:00.000Z | jutro, we wtorek 24.11 o 8:00 | po 16:00', 'równo 16:00 to już po godzinach');
  assert.equal(k('2026-11-23T06:59:00Z'), '2026-11-23T07:00:00.000Z | dziś o 8:00 | przed 8:00');
  assert.equal(k('2026-11-27T16:30:00Z'), '2026-11-30T07:00:00.000Z | w poniedziałek 30.11 o 8:00 | po 16:00', 'piątek wieczorem → poniedziałek');
  assert.equal(k('2026-11-28T10:00:00Z'), '2026-11-30T07:00:00.000Z | w poniedziałek 30.11 o 8:00 | weekend', 'sobota w południe');
  // czas letni: 8:00 w Warszawie to 6:00 UTC
  assert.equal(k('2026-07-03T15:30:00Z'), '2026-07-06T06:00:00.000Z | w poniedziałek 06.07 o 8:00 | po 16:00');
  assert.equal(k('2026-07-06T06:00:00Z'), 'od razu');
  // weekend ze zmianą czasu: plan liczony już w nowym czasie
  assert.equal(k('2026-10-24T12:00:00Z').slice(0, 24), '2026-10-26T07:00:00.000Z');
  assert.equal(k('2026-03-28T12:00:00Z').slice(0, 24), '2026-03-30T06:00:00.000Z');
  assert.equal(opisTerminu('2026-11-23T07:00:00Z'), 'w poniedziałek 23.11 o 8:00');
});

// ── trasy: podstawione zależności ───────────────────────────────────────────
function podstaw(plik, eksport) {
  const p = require.resolve(path.join(SRC, plik));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: eksport };
}
const S = { maile: [], bladMaila: null, telegram: [] };
const prod = (ean, name, symbol, variant = null, extras = {}) => ({ ean, name, variant, extras: { symbol, ...extras } });
const KATALOG = [
  prod('5902082579021', 'SURF GEL extreme waterproof gel spf 50+', 'BgwS'),
  prod('5902082579045', 'SURF DAILY protection spf 50', 'BfdpS'),
  prod('5902082579052', 'SURF LIPS lip balm spf 50+', 'BlbS'),
  prod('5902082579014', 'SURF CARE hydrating cream', 'BfchS'),
  prod('5902082556022', 'SURF STICK zinc stick spf 50+', 'BSS 01', 'Blue'),
  { ean: 'BOX-COLLECTION-30', name: 'Surf Collection Box', variant: null, extras: { composition: [
    { ean: '5902082579052', variant: 'Lip Balm', qty: 12 }, { ean: '5902082579021', variant: 'Gel SPF50+', qty: 6 },
    { ean: '5902082579045', variant: 'Daily UV SPF50+', qty: 6 }, { ean: '5902082579014', variant: 'Hydrating Cream', qty: 6 }] } },
  { ean: 'BOX-BLUE-30', name: 'Surf Stick Box Blue', variant: null, extras: { composition: [{ ean: '5902082556022', variant: 'Blue', qty: 30 }] } },
];
podstaw('mail-sender.js', { sendMail: async (m) => { if (S.bladMaila) throw new Error(S.bladMaila); S.maile.push(m); return { id: 'm' }; } });
podstaw('services/agent-runtime.js', { selfCall: async () => ({ status: 500, body: {} }) });
podstaw('glob-client.js', { getOrderLabels: async () => ({ status: 404 }) });
podstaw('services/product-catalog.js', { getActiveCatalog: async () => KATALOG });
podstaw('services/telegram-helper.js', { resolveTelegram: async () => ({ token: 'T', chatId: '1' }) });
podstaw('telegram-utils.js', { sendTelegram: async (t, c, tekst) => { S.telegram.push(String(tekst)); return { ok: true }; } });
const magazyn = require(path.join(SRC, 'routes', 'magazyn'));
const T = magazyn._test;
const zegar = (iso) => T.ustawZegar(() => new Date(iso));

/** Atrapa bazy: stan towaru, zamówienia czekające na spakowanie i lista zamówień. */
function baza({ stan = {}, czekaja = {}, zamowienia = [] } = {}) {
  const db = {
    utworzone: [], zamowienia: zamowienia.map(z => ({ ...z })),
    stockMovement: { groupBy: async ({ where }) => where.ean.in.filter(e => e in stan).map(e => ({ ean: e, _sum: { delta: stan[e] } })) },
    warehouseOrderItem: { groupBy: async ({ where }) => {
      assert.deepEqual({ packaging: where.packaging, order: where.order }, { packaging: null, order: { status: 'NOWE' } }, 'rezerwują tylko linie towaru z zamówień NOWE');
      return where.ean.in.filter(e => e in czekaja).map(e => ({ ean: e, _sum: { qty: czekaja[e] } }));
    } },
    contractor: { findUnique: async () => null },
    warehouseOrderDoc: { findMany: async () => [{ filename: 'WZ-2-11-2026.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-1.4 wz') }] },
    warehouseOrder: {
      create: async ({ data }) => { const o = { id: `n${db.utworzone.length + 1}`, numer: 11 + db.utworzone.length, status: 'NOWE', ...data, items: data.items.create, dokumenty: [], contractor: null }; db.utworzone.push(o); return o; },
      // Odczyty zwracają KOPIE (jak Prisma — migawkę wiersza), zapisy zmieniają wiersz w „bazie".
      findUnique: async ({ where }) => { const z = db.zamowienia.find(x => x.id === where.id); return z ? { ...z } : null; },
      findMany: async ({ where }) => db.zamowienia.filter(z => z.powiadomNa && z.powiadomNa <= where.powiadomNa.lte).map(z => ({ ...z })),
      update: async ({ where, data }) => { const z = db.zamowienia.find(x => x.id === where.id); Object.assign(z, data); return z; },
      updateMany: async ({ where, data }) => {
        const z = db.zamowienia.find(x => x.id === where.id);
        if (!z) return { count: 0 };
        if ('powiadomNa' in where && String(z.powiadomNa) !== String(where.powiadomNa)) return { count: 0 };
        if (where.status && z.status !== where.status) return { count: 0 };
        Object.assign(z, data); return { count: 1 };
      },
    },
    stockMovementCreate: [],
  };
  db.stockMovement.createMany = async ({ data }) => { db.stockMovementCreate.push(...data); return { count: data.length }; };
  db.$transaction = async (fn) => fn(db);
  return db;
}
async function zapytaj(db, metoda, sciezka, { rola = 'owner', body } = {}) {
  const app = express();
  app.use(express.json());
  app.locals.prisma = db;
  app.use((req, _res, next) => { req.crm = rola === 'magazyn' ? { user: 'm.urbaniak@bell.com.pl', role: 'magazyn' } : { user: 'nikodem', role: 'owner' }; next(); });
  app.use('/', magazyn);
  const serwer = app.listen(0);
  await new Promise(r => serwer.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${serwer.address().port}${sciezka}`, { method: metoda, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  } finally { serwer.close(); }
}

// ── (1) blokada przy braku towaru ───────────────────────────────────────────
const STAN_10 = { '5902082579021': 72, '5902082579045': 71, '5902082579052': 305, '5902082579014': 95, '5902082556022': 210 };
const ZAM_10 = [{ ean: 'BOX-COLLECTION-30', qty: 4, packaging: 'karton' }, { ean: '5902082579021', qty: 50 }, { ean: '5902082579045', qty: 50 }, { ean: '5902082579052', qty: 50 }];

test('przypadek #10: 74 żele przy 72 na stanie i 74 Daily przy 71 → zamówienie zablokowane z listą braków', async () => {
  const db = baza({ stan: STAN_10 });
  const r = await zapytaj(db, 'POST', '/zamowienia', { body: { items: ZAM_10 } });
  assert.equal(r.status, 400);
  assert.equal(r.json.zaMaloTowaru, true);
  assert.equal(r.json.error, [
    'Za mało towaru w magazynie — zamówienie NIE zostało złożone.',
    '• SURF GEL (BgwS): potrzeba 74, dostępne 72 — brakuje 2',
    '• SURF DAILY (BfdpS): potrzeba 74, dostępne 71 — brakuje 3',
    'Zmniejsz ilości albo wpisz przyjęcie towaru (Paczki → Stan w magazynie → Przyjęcie / korekta).',
  ].join('\n'));
  assert.deepEqual(r.json.braki.map(b => [b.symbol, b.potrzeba, b.naStanie, b.dostepne, b.brakuje]), [['BgwS', 74, 72, 72, 2], ['BfdpS', 74, 71, 71, 3]]);
  assert.equal(db.utworzone.length, 0, 'nic nie zapisano');
});

test('po zmniejszeniu ilości do stanu zamówienie przechodzi (równo tyle, ile jest, wystarcza)', async () => {
  const db = baza({ stan: STAN_10 });
  const items = [ZAM_10[0], { ean: '5902082579021', qty: 48 }, { ean: '5902082579045', qty: 47 }, ZAM_10[3]];
  const r = await zapytaj(db, 'POST', '/zamowienia', { body: { items } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(db.utworzone.length, 1);
  assert.equal(r.json.zamowienie.status, 'NOWE');
});

test('towar czekający w innych zamówieniach do spakowania jest zarezerwowany', async () => {
  // na stanie 72 żele, ale 50 czeka już w zamówieniu NOWE → dostępne 22
  const db = baza({ stan: STAN_10, czekaja: { '5902082579021': 50 } });
  const r = await zapytaj(db, 'POST', '/zamowienia', { body: { items: [{ ean: 'BOX-COLLECTION-30', qty: 4, packaging: 'karton' }] } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /• SURF GEL \(BgwS\): potrzeba 24, dostępne 22 \(na stanie 72, a 50 czeka w innych zamówieniach do spakowania\) — brakuje 2/);
  assert.equal(r.json.braki.length, 1);
  const ok = await zapytaj(baza({ stan: STAN_10, czekaja: { '5902082579021': 48 } }), 'POST', '/zamowienia', { body: { items: [{ ean: 'BOX-COLLECTION-30', qty: 4, packaging: 'karton' }] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
});

test('towar, którego w ogóle nie ma na stanie, blokuje; kolor w nazwie; ekspozytory nie blokują', async () => {
  const brak = await zapytaj(baza({ stan: {} }), 'POST', '/zamowienia', { body: { items: [{ ean: '5902082556022', qty: 5 }] } });
  assert.equal(brak.status, 400);
  assert.match(brak.json.error, /• SURF STICK Blue \(BSS 01\): potrzeba 5, dostępne 0 — brakuje 5/);
  // stan ujemny (więcej wydano niż przyjęto) nie pokazuje „dostępne -3"
  const ujemny = await zapytaj(baza({ stan: { '5902082556022': -3 } }), 'POST', '/zamowienia', { body: { items: [{ ean: '5902082556022', qty: 5 }] } });
  assert.match(ujemny.json.error, /potrzeba 5, dostępne 0 — brakuje 8/);
  // ekspozytor zatowarowany: stan pustych ekspozytorów nie jest prowadzony (bywa ujemny) — liczy się tylko towar
  const db = baza({ stan: { '5902082556022': 60, EKSPOZYTOR: -4 } });
  const r = await zapytaj(db, 'POST', '/zamowienia', { body: { items: [{ ean: 'BOX-BLUE-30', qty: 2, packaging: 'ekspozytor' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(db.utworzone[0].items.some(i => i.ean === 'EKSPOZYTOR' && i.qty === 2));
  const zaDuzo = await zapytaj(baza({ stan: { '5902082556022': 59 } }), 'POST', '/zamowienia', { body: { items: [{ ean: 'BOX-BLUE-30', qty: 2, packaging: 'ekspozytor' }] } });
  assert.match(zaDuzo.json.error, /SURF STICK Blue \(BSS 01\): potrzeba 60, dostępne 59 — brakuje 1/);
});

// ── (2) „Powiadom magazyn" poza godzinami pracy ─────────────────────────────
const NIEDZIELA_2105 = '2026-11-22T20:05:00Z';
const PON_0759 = '2026-11-23T06:59:00Z';
const PON_0800 = '2026-11-23T07:00:00Z';
const PON_1100 = '2026-11-23T10:00:00Z';
const zam = (over = {}) => ({
  id: 'z10', numer: 10, status: 'NOWE', autoList: false, odbiorca: { name: 'MOGA BAQUEIRA S.L.', street: 'EDIFICIO VAL DE RUDA', houseNumber: 'SN', postCode: '25598', city: 'BAQUEIRA BERET', country: 'ES', phone: '+34621187121', email: '' },
  items: [{ id: 'i1', ean: '5902082579021', name: 'SURF GEL extreme waterproof gel spf 50+', variant: null, symbol: 'BgwS', qty: 48, packaging: null, sort: 0 }],
  dokumenty: [], contractor: null, powiadomionoAt: null, powiadomNa: null, powiadomNaKto: null, powiadomNaDo: null, powiadomProby: 0, powiadomBlad: null, ...over,
});
const czysto = () => { S.maile.length = 0; S.telegram.length = 0; S.bladMaila = null; };

test('niedziela 21:05: kliknięcie NIE wysyła maila — plan na poniedziałek 8:00, wysyłka dopiero wtedy', async () => {
  czysto(); zegar(NIEDZIELA_2105);
  const db = baza({ zamowienia: [zam()] });
  const r = await zapytaj(db, 'POST', '/zamowienia/z10/powiadom', { body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.zaplanowano, true);
  assert.equal(r.json.kiedy, '2026-11-23T07:00:00.000Z');
  assert.equal(r.json.komunikat, 'Magazyn dostanie maila jutro, w poniedziałek 23.11 o 8:00 — teraz jest poza godzinami pracy magazynu (weekend).');
  assert.equal(S.maile.length, 0);
  assert.equal(r.json.zamowienie.powiadomionoAt, null);
  assert.equal(r.json.zamowienie.powiadomNa, '2026-11-23T07:00:00.000Z');
  const mag = (await zapytaj(db, 'GET', '/zamowienia/z10', { rola: 'magazyn' })).json.zamowienie;
  assert.equal(mag.powiadomNa, null, 'plan to sprawa właściciela');

  // drugie kliknięcie tego samego wieczoru nie dubluje — ten sam termin
  const drugi = await zapytaj(db, 'POST', '/zamowienia/z10/powiadom', { body: {} });
  assert.equal(drugi.json.kiedy, '2026-11-23T07:00:00.000Z');

  assert.equal(await magazyn.wyslijZaplanowanePowiadomienia(db, new Date(PON_0759)), 0, 'minutę przed 8:00 jeszcze nic');
  assert.equal(S.maile.length, 0);
  assert.equal(await magazyn.wyslijZaplanowanePowiadomienia(db, new Date(PON_0800)), 1);
  assert.equal(S.maile.length, 1);
  const m = S.maile[0];
  assert.equal(m.from, 'delivery@surfstickbell.com');
  assert.equal(m.to, 'm.urbaniak@bell.com.pl');
  assert.match(m.subject, /Nowe zamówienie #10/);
  assert.deepEqual(m.attachments.map(a => a.filename), ['zamowienie-10.pdf', 'WZ-2-11-2026.pdf']);
  const z = db.zamowienia[0];
  assert.ok(z.powiadomionoAt instanceof Date);
  assert.equal(z.powiadomilKto, 'nikodem', 'zapisany ten, kto kliknął');
  assert.equal(z.powiadomionoDo, 'm.urbaniak@bell.com.pl');
  assert.equal(z.powiadomNa, null);
  assert.equal(await magazyn.wyslijZaplanowanePowiadomienia(db, new Date(PON_1100)), 0, 'drugi raz nie wychodzi');
  assert.equal(S.maile.length, 1);
});

test('zamówienie anulowane przed 8:00 → plan skasowany, magazyn nie dostaje nic (przypadek #10)', async () => {
  czysto(); zegar(NIEDZIELA_2105);
  const db = baza({ zamowienia: [zam()] });
  await zapytaj(db, 'POST', '/zamowienia/z10/powiadom', { body: {} });
  assert.ok(db.zamowienia[0].powiadomNa);
  const a = await zapytaj(db, 'PATCH', '/zamowienia/z10', { body: { status: 'ANULOWANE' } });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(db.zamowienia[0].status, 'ANULOWANE');
  assert.equal(db.zamowienia[0].powiadomNa, null);
  assert.equal(await magazyn.wyslijZaplanowanePowiadomienia(db, new Date(PON_0800)), 0);
  assert.equal(S.maile.length, 0);
});

test('w godzinach pracy mail idzie od razu; {teraz:true} wysyła od razu także w weekend i kasuje plan; {anulujPlan:true} kasuje sam plan', async () => {
  czysto(); zegar(PON_1100);
  let db = baza({ zamowienia: [zam()] });
  let r = await zapytaj(db, 'POST', '/zamowienia/z10/powiadom', { body: {} });
  assert.equal(r.json.zaplanowano, undefined);
  assert.equal(r.json.wyslano.do, 'm.urbaniak@bell.com.pl');
  assert.equal(S.maile.length, 1);

  czysto(); zegar(NIEDZIELA_2105);
  db = baza({ zamowienia: [zam()] });
  await zapytaj(db, 'POST', '/zamowienia/z10/powiadom', { body: {} });
  r = await zapytaj(db, 'POST', '/zamowienia/z10/powiadom', { body: { teraz: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(S.maile.length, 1);
  assert.equal(db.zamowienia[0].powiadomNa, null, 'plan zniknął — rano nie pójdzie drugi mail');
  assert.equal(await magazyn.wyslijZaplanowanePowiadomienia(db, new Date(PON_0800)), 0);

  czysto();
  db = baza({ zamowienia: [zam()] });
  await zapytaj(db, 'POST', '/zamowienia/z10/powiadom', { body: {} });
  r = await zapytaj(db, 'POST', '/zamowienia/z10/powiadom', { body: { anulujPlan: true } });
  assert.equal(r.json.planAnulowany, true);
  assert.equal(db.zamowienia[0].powiadomNa, null);
  assert.equal((await zapytaj(db, 'POST', '/zamowienia/z10/powiadom', { body: { anulujPlan: true } })).status, 400);
  assert.equal((await zapytaj(db, 'POST', '/zamowienia/z10/powiadom', { rola: 'magazyn', body: {} })).status, 403);
  assert.equal(S.maile.length, 0);
});

test('podgląd mówi, kiedy mail wyjdzie; ponowne powiadomienie poza godzinami też czeka do rana', async () => {
  czysto(); zegar(NIEDZIELA_2105);
  const db = baza({ zamowienia: [zam({ powiadomionoAt: new Date('2026-11-20T09:00:00Z'), powiadomionoDo: 'm.urbaniak@bell.com.pl' })] });
  const p = await zapytaj(db, 'POST', '/zamowienia/z10/powiadom', { body: { podglad: true } });
  assert.equal(p.json.wysylka, 'jutro, w poniedziałek 23.11 o 8:00');
  assert.match(p.json.temat, /#10/);
  assert.equal((await zapytaj(db, 'POST', '/zamowienia/z10/powiadom', { body: {} })).status, 409, 'bez {ponownie} nadal 409');
  const r = await zapytaj(db, 'POST', '/zamowienia/z10/powiadom', { body: { ponownie: true } });
  assert.equal(r.json.zaplanowano, true);
  assert.equal(S.maile.length, 0);
  assert.equal(await magazyn.wyslijZaplanowanePowiadomienia(db, new Date(PON_0800)), 1);
  assert.equal(S.maile.length, 1);
  zegar(PON_1100);
  assert.equal((await zapytaj(db, 'POST', '/zamowienia/z10/powiadom', { body: { podglad: true } })).json.wysylka, 'od razu');
});

test('mail nie wychodzi rano: ponowienie co 5 minut, po trzech próbach alarm do właściciela i błąd przy zamówieniu', async () => {
  czysto(); zegar(NIEDZIELA_2105);
  const db = baza({ zamowienia: [zam()] });
  await zapytaj(db, 'POST', '/zamowienia/z10/powiadom', { body: {} });
  S.bladMaila = 'Invalid login: 535';
  const t0 = new Date(PON_0800).getTime();
  assert.equal(await magazyn.wyslijZaplanowanePowiadomienia(db, new Date(t0)), 0);
  assert.equal(db.zamowienia[0].powiadomProby, 1);
  assert.equal(db.zamowienia[0].powiadomNa.toISOString(), '2026-11-23T07:05:00.000Z');
  assert.deepEqual(S.telegram, [], 'pierwsza porażka bez alarmu');
  assert.equal(await magazyn.wyslijZaplanowanePowiadomienia(db, new Date(t0 + 60 * 1000)), 0, 'przed upływem 5 minut nie ponawia');
  assert.equal(db.zamowienia[0].powiadomProby, 1);
  await magazyn.wyslijZaplanowanePowiadomienia(db, new Date(t0 + 5 * 60 * 1000));
  await magazyn.wyslijZaplanowanePowiadomienia(db, new Date(t0 + 10 * 60 * 1000));
  const z = db.zamowienia[0];
  assert.equal(z.powiadomProby, 3);
  assert.equal(z.powiadomNa, null, 'koniec prób');
  assert.equal(z.powiadomionoAt, null);
  assert.match(z.powiadomBlad, /Invalid login/);
  assert.equal(S.telegram.length, 1);
  assert.match(S.telegram[0], /^✉️ Magazyn #10 \(MOGA BAQUEIRA S\.L\., BAQUEIRA BERET\): zaplanowany mail do magazynu NIE wyszedł \(3 próby\)\.\nBłąd: Invalid login: 535\nKliknij „Powiadom magazyn” przy zamówieniu jeszcze raz\./);
  assert.equal((await zapytaj(db, 'GET', '/zamowienia/z10')).json.zamowienie.powiadomBlad, 'Invalid login: 535');
  // poczta wróciła po drugiej próbie → mail wychodzi, licznik i błąd znikają
  czysto(); zegar(NIEDZIELA_2105);
  const db2 = baza({ zamowienia: [zam()] });
  await zapytaj(db2, 'POST', '/zamowienia/z10/powiadom', { body: {} });
  S.bladMaila = 'ETIMEDOUT';
  await magazyn.wyslijZaplanowanePowiadomienia(db2, new Date(t0));
  S.bladMaila = null;
  assert.equal(await magazyn.wyslijZaplanowanePowiadomienia(db2, new Date(t0 + 5 * 60 * 1000)), 1);
  assert.equal(db2.zamowienia[0].powiadomProby, 0);
  assert.equal(db2.zamowienia[0].powiadomBlad, null);
  assert.deepEqual(S.telegram, []);
});

test('dwa przebiegi cyklu naraz wysyłają jeden mail; zamówienie już wysłane do klienta jest pomijane', async () => {
  czysto(); zegar(NIEDZIELA_2105);
  const db = baza({ zamowienia: [zam(), zam({ id: 'z9', numer: 9, status: 'WYSLANE', powiadomNa: new Date(PON_0800), powiadomNaKto: 'nikodem' })] });
  await zapytaj(db, 'POST', '/zamowienia/z10/powiadom', { body: {} });
  const [a, b] = await Promise.all([magazyn.wyslijZaplanowanePowiadomienia(db, new Date(PON_0800)), magazyn.wyslijZaplanowanePowiadomienia(db, new Date(PON_0800))]);
  assert.equal(a + b, 1);
  assert.equal(S.maile.length, 1);
  assert.match(S.maile[0].subject, /#10/);
  assert.equal(db.zamowienia[1].powiadomNa, null);
  assert.equal(db.zamowienia[1].powiadomionoAt, null, '#9 (WYSLANE) bez maila');
});

test.after(() => T.ustawZegar(null));
