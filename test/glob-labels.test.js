'use strict';

/* Kopie listów przewozowych GK (2.11.2026): kopia z bazy ma pierwszeństwo,
 * każdy PDF z GK zostaje w bazie, próby po zamówieniu, kopia przed
 * anulowaniem, przegląd zaległych. GlobKurier i baza podstawione. */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');

const SRC = path.join(__dirname, '..', 'src');
function podstaw(plik, eksport) {
  const p = require.resolve(path.join(SRC, plik));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: eksport };
}

const pdf = (tekst) => Buffer.from(`%PDF-1.4\n${tekst}\n${'x'.repeat(200)}`);
const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);

// Baza: tylko globLabel; klucz złożony hash_format jak w Prisma, Bytes
// oddawane jako Uint8Array jak w Prisma 6.
function baza(kopie = []) {
  const wiersze = new Map(kopie.map(k => [`${k.hash}|${k.format || 'A4'}`, { format: 'A4', ...k }]));
  const klucz = (w) => `${w.hash_format.hash}|${w.hash_format.format}`;
  return {
    wiersze,
    globLabel: {
      findUnique: async ({ where }) => {
        const w = wiersze.get(klucz(where));
        return w ? { ...w, data: new Uint8Array(w.data) } : null;
      },
      upsert: async ({ where, create, update }) => {
        const w = wiersze.has(klucz(where)) ? { ...wiersze.get(klucz(where)), ...update } : { ...create };
        wiersze.set(klucz(where), w);
        return w;
      },
      findMany: async ({ where }) => [...wiersze.values()]
        .filter(w => where.hash.in.includes(w.hash) && w.format === where.format)
        .map(w => ({ hash: w.hash })),
    },
  };
}

// GlobKurier: etykiety per hash ({status, body}, Error albo funkcja), lista
// zamówień od najnowszych, rejestr wywołań. Bez `this` — trasy destrukturyzują.
function globKurier({ etykiety = {}, zamowienia = [] } = {}) {
  const wywolania = [];
  return {
    wywolania, etykiety, zamowienia,
    getOrderLabels: async (hash, format) => {
      wywolania.push(['etykieta', hash, format]);
      const e = typeof etykiety[hash] === 'function' ? etykiety[hash]() : etykiety[hash];
      if (e instanceof Error) throw e;
      return e || { status: 404, body: Buffer.from('{"message":"Not found"}') };
    },
    getOrders: async ({ limit, offset }) => {
      wywolania.push(['lista', offset]);
      return [{ offset, limit, total: zamowienia.length, results: zamowienia.slice(offset, offset + limit) }];
    },
    deleteOrder: async (hash) => { wywolania.push(['anuluj', hash]); return { status: 204, body: null }; },
    getOrderTracking: async () => ({}),
    getReceivers: async () => [],
  };
}

const dataGk = (dniTemu) => new Date(Date.now() - dniTemu * 864e5).toISOString().slice(0, 19).replace('T', ' ');

// Próby po zamówieniu idą na timerach z unref() (nie trzymają procesu przy
// restarcie) — w teście pętlę zdarzeń trzymamy sami.
async function zTrzymaniem(p) {
  const t = setInterval(() => {}, 1000);
  try { return await p; } finally { clearInterval(t); }
}

const gl = require(path.join(SRC, 'services', 'glob-labels'));

test('kopia z bazy ma pierwszeństwo — GK nie jest pytany', async () => {
  const prisma = baza([{ hash: HASH, data: pdf('z bazy') }]);
  const gk = globKurier();
  const r = await gl.getOrderLabels(HASH, 'A4', { prisma, gk });
  assert.equal(r.status, 200);
  assert.equal(r.zBazy, true);
  assert.ok(Buffer.isBuffer(r.body));
  assert.match(r.body.toString(), /z bazy/);
  assert.equal(gk.wywolania.length, 0);
});

test('brak kopii → GK → kopia zostaje, kolejne pobranie już z bazy', async () => {
  const prisma = baza();
  const gk = globKurier({ etykiety: { [HASH]: { status: 200, body: pdf('z GK') } } });
  const r = await gl.getOrderLabels(HASH, 'A4', { prisma, gk, orderNumber: 'GK261102000001' });
  assert.equal(r.status, 200);
  assert.equal(r.zBazy, false);
  const w = prisma.wiersze.get(`${HASH}|A4`);
  assert.equal(w.zrodlo, 'pobranie');
  assert.equal(w.orderNumber, 'GK261102000001');
  assert.equal(w.size, r.body.length);

  gk.etykiety[HASH] = { status: 404, body: Buffer.from('{}') }; // np. po anulowaniu w GK
  const r2 = await gl.getOrderLabels(HASH, 'A4', { prisma, gk });
  assert.equal(r2.status, 200);
  assert.equal(r2.zBazy, true);
  assert.match(r2.body.toString(), /z GK/);
  assert.equal(gk.wywolania.length, 1);
});

test('GK 404 bez kopii → 404 jak dawniej, nic nie zapisane', async () => {
  const prisma = baza();
  const r = await gl.getOrderLabels(HASH, 'A4', { prisma, gk: globKurier() });
  assert.equal(r.status, 404);
  assert.equal(prisma.wiersze.size, 0);
});

test('GK 200, ale nie PDF — nie zapisuje, oddaje odpowiedź GK bez zmian', async () => {
  const prisma = baza();
  const body = Buffer.from('{"message":"Etykieta w przygotowaniu"}');
  const r = await gl.getOrderLabels(HASH, 'A4', { prisma, gk: globKurier({ etykiety: { [HASH]: { status: 200, body } } }) });
  assert.equal(r.status, 200);
  assert.equal(r.body, body);
  assert.equal(prisma.wiersze.size, 0);
});

test('osobna kopia na format, zły format → A4', async () => {
  const prisma = baza([{ hash: HASH, format: 'A6', data: pdf('A6') }]);
  const gk = globKurier({ etykiety: { [HASH]: { status: 200, body: pdf('A4') } } });
  assert.match((await gl.getOrderLabels(HASH, 'A6', { prisma, gk })).body.toString(), /A6/);
  assert.match((await gl.getOrderLabels(HASH, 'A4&x=1', { prisma, gk })).body.toString(), /A4/);
  assert.deepEqual(gk.wywolania, [['etykieta', HASH, 'A4']]);
});

test('odswiez: najpierw GK i aktualizacja kopii; gdy GK zawiedzie — kopia', async () => {
  const prisma = baza([{ hash: HASH, data: pdf('stara'), zrodlo: 'zamowienie' }]);
  const gk = globKurier({ etykiety: { [HASH]: { status: 200, body: pdf('nowa') } } });
  const r = await gl.getOrderLabels(HASH, 'A4', { prisma, gk, odswiez: true });
  assert.equal(r.zBazy, false);
  assert.match(Buffer.from(prisma.wiersze.get(`${HASH}|A4`).data).toString(), /nowa/);
  assert.equal(prisma.wiersze.get(`${HASH}|A4`).zrodlo, 'zamowienie'); // źródło z pierwszego zapisu

  gk.etykiety[HASH] = { status: 404, body: Buffer.from('{}') };
  const r404 = await gl.getOrderLabels(HASH, 'A4', { prisma, gk, odswiez: true });
  assert.equal(r404.status, 200);
  assert.equal(r404.zBazy, true);

  gk.etykiety[HASH] = new Error('getOrderLabels timeout 25s');
  const rBlad = await gl.getOrderLabels(HASH, 'A4', { prisma, gk, odswiez: true });
  assert.equal(rBlad.zBazy, true);
  await assert.rejects(gl.getOrderLabels(HASH2, 'A4', { prisma, gk: globKurier({ etykiety: { [HASH2]: new Error('timeout') } }), odswiez: true }), /timeout/);
});

test('błąd bazy nie psuje pobierania — działa prosto z GK', async () => {
  const prisma = { globLabel: {
    findUnique: async () => { throw new Error('relation "GlobLabel" does not exist'); },
    upsert: async () => { throw new Error('relation "GlobLabel" does not exist'); },
  } };
  const r = await gl.getOrderLabels(HASH, 'A4', { prisma, gk: globKurier({ etykiety: { [HASH]: { status: 200, body: pdf('GK') } } }) });
  assert.equal(r.status, 200);
  assert.match(r.body.toString(), /GK/);
});

test('po zamówieniu: ponawia, aż GK wystawi list, i zapisuje kopię', async () => {
  const prisma = baza();
  let proba = 0;
  const gk = globKurier({ etykiety: { [HASH]: () => (++proba < 3
    ? (proba === 1 ? new Error('ECONNRESET') : { status: 400, body: Buffer.from('{"message":"label not ready"}') })
    : { status: 200, body: pdf('gotowy') }) } });
  const ok = await zTrzymaniem(gl.zabezpieczPoZamowieniu(HASH, { prisma, gk, orderNumber: 'GK261102000002', opoznienia: [0, 0, 0, 0] }));
  assert.equal(ok, true);
  assert.equal(proba, 3);
  const w = prisma.wiersze.get(`${HASH}|A4`);
  assert.equal(w.zrodlo, 'zamowienie');
  assert.equal(w.orderNumber, 'GK261102000002');
});

test('po zamówieniu: kopia już jest (np. z Telegrama) — bez pytania GK; same porażki → false', async () => {
  const gk = globKurier();
  assert.equal(await zTrzymaniem(gl.zabezpieczPoZamowieniu(HASH, { prisma: baza([{ hash: HASH, data: pdf('jest') }]), gk, opoznienia: [0] })), true);
  assert.equal(gk.wywolania.length, 0);
  assert.equal(await zTrzymaniem(gl.zabezpieczPoZamowieniu(HASH, { prisma: baza(), gk, opoznienia: [0, 0] })), false);
  assert.equal(gk.wywolania.length, 2);
  assert.equal(await gl.zabezpieczPoZamowieniu('', { prisma: baza(), gk, opoznienia: [0] }), false);
});

test('przegląd zaległych: okno dni, pomija z kopią, zapisuje resztę, liczy nieudane', async () => {
  gl._nieudane.clear();
  const prisma = baza([{ hash: 'h-ma', data: pdf('ma') }]);
  const gk = globKurier({
    zamowienia: [
      { hash: 'h-nowy', number: 'GK1', status: 'NEW', creationDate: dataGk(1) },
      { hash: 'h-ma', number: 'GK2', status: 'DELIVERED', creationDate: dataGk(2) },
      { hash: 'h-anul', number: 'GK3', status: 'CANCELED', creationDate: dataGk(3) },
      { hash: 'h-stary', number: 'GK4', status: 'DELIVERED', creationDate: dataGk(20) },
    ],
    etykiety: { 'h-nowy': { status: 200, body: pdf('nowy') }, 'h-stary': { status: 200, body: pdf('stary') } },
  });
  const r = await gl.zabezpieczZalegle({ prisma, gk, dni: 14, przerwaMs: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.zamowien, 3);
  assert.equal(r.maKopie, 1);
  assert.equal(r.zapisane, 1);
  assert.deepEqual(r.nieudane, [{ numer: 'GK3', status: 'CANCELED', http: 404 }]);
  assert.equal(prisma.wiersze.get('h-nowy|A4').zrodlo, 'przeglad');
  assert.equal(prisma.wiersze.get('h-nowy|A4').orderNumber, 'GK1');
  assert.ok(!prisma.wiersze.has('h-stary|A4'));
  assert.equal(gk.wywolania.filter(w => w[0] === 'lista').length, 1); // strona sięgnęła przed okno
});

test('przegląd: hash bez listu po 3 próbach pomijany; limit → pozostalo', async () => {
  gl._nieudane.clear();
  const zamowienia = ['x1', 'x2', 'x3'].map((h, i) => ({ hash: h, number: `GK${i}`, status: 'CANCELED', creationDate: dataGk(1) }));
  const gk = globKurier({ zamowienia });
  for (let i = 0; i < 3; i++) await gl.zabezpieczZalegle({ prisma: baza(), gk, przerwaMs: 0 });
  const przed = gk.wywolania.filter(w => w[0] === 'etykieta').length;
  const r = await gl.zabezpieczZalegle({ prisma: baza(), gk, przerwaMs: 0 });
  assert.equal(r.pominiete, 3);
  assert.equal(gk.wywolania.filter(w => w[0] === 'etykieta').length, przed);

  gl._nieudane.clear();
  const r2 = await gl.zabezpieczZalegle({ prisma: baza(), gk, przerwaMs: 0, limit: 1 });
  assert.equal(r2.nieudane.length, 1);
  assert.equal(r2.pozostalo, 2);
});

test('przegląd: kolejne strony, dopóki pełne i w oknie; drugi przegląd naraz odmawia', async () => {
  gl._nieudane.clear();
  const zamowienia = Array.from({ length: 150 }, (_, i) => ({ hash: `p${i}`, number: `GK${i}`, status: 'DELIVERED', creationDate: dataGk(1) }));
  const prisma = baza(zamowienia.map(z => ({ hash: z.hash, data: pdf(z.hash) })));
  let puść;
  const blokada = new Promise(r => { puść = r; });
  const gk = globKurier({ zamowienia });
  const getOrders = gk.getOrders;
  gk.getOrders = async (q) => { await blokada; return getOrders(q); };

  const pierwszy = gl.zabezpieczZalegle({ prisma, gk, przerwaMs: 0 });
  const drugi = await gl.zabezpieczZalegle({ prisma, gk, przerwaMs: 0 });
  assert.equal(drugi.ok, false);
  puść();
  const r = await pierwszy;
  assert.equal(r.zamowien, 150);
  assert.equal(r.maKopie, 150);
  assert.deepEqual(gk.wywolania.filter(w => w[0] === 'lista').map(w => w[1]), [0, 100]);
});

// ── trasy ────────────────────────────────────────────────────────────────────
const bazaTras = baza();
const gkTras = globKurier();
podstaw('db.js', bazaTras);
podstaw('glob-client.js', gkTras);

test('trasy: GET /glob/labels z kopii i z GK, 404 z opisem; anulowanie zostawia kopię', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', require(path.join(SRC, 'routes', 'glob-orders')));
  const serwer = app.listen(0);
  const url = `http://127.0.0.1:${serwer.address().port}/api`;
  try {
    bazaTras.wiersze.set(`${HASH}|A4`, { hash: HASH, format: 'A4', data: pdf('kopia OHANA') });
    const r = await fetch(`${url}/glob/labels/${HASH}?format=A4`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.equal(r.headers.get('x-etykieta-zrodlo'), 'kopia-crm');
    assert.match(Buffer.from(await r.arrayBuffer()).toString(), /kopia OHANA/);

    gkTras.etykiety[HASH2] = { status: 200, body: pdf('świeża z GK') };
    const r2 = await fetch(`${url}/glob/labels/${HASH2}`);
    assert.equal(r2.headers.get('x-etykieta-zrodlo'), 'globkurier');
    assert.ok(bazaTras.wiersze.has(`${HASH2}|A4`));

    const r404 = await fetch(`${url}/glob/labels/${'c'.repeat(64)}`);
    assert.equal(r404.status, 404);
    assert.match((await r404.json()).szczegoly, /nie ma jego kopii/);

    const HASH3 = 'd'.repeat(64);
    gkTras.etykiety[HASH3] = { status: 200, body: pdf('przed anulowaniem') };
    const a = await fetch(`${url}/glob/delete-order`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash: HASH3 }) });
    assert.equal((await a.json()).deleted, true);
    assert.equal(bazaTras.wiersze.get(`${HASH3}|A4`).zrodlo, 'anulowanie');
    const kolejnosc = gkTras.wywolania.filter(w => w[1] === HASH3).map(w => w[0]);
    assert.deepEqual(kolejnosc, ['etykieta', 'anuluj']);

    gl._nieudane.clear();
    gkTras.zamowienia.push({ hash: HASH3, number: 'GK9', status: 'CANCELED', creationDate: dataGk(1) });
    const z = await fetch(`${url}/glob/labels/zabezpiecz`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dni: 30 }) });
    const zj = await z.json();
    assert.equal(z.status, 200);
    assert.equal(zj.dni, 30);
    assert.equal(zj.maKopie, 1);
  } finally {
    serwer.close();
  }
});
