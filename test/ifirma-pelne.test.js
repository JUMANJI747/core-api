'use strict';
// Pełne API iFirmy dla Claude (26.11.2026): odczyt dowolnego zasobu, zapis
// domyślnie jako podgląd, wysłanie tylko z "wykonaj": true; idempotencja przez
// ConfirmLock, miesiąc księgowy, brak odpowiedzi = blokada zostaje.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

process.env.IFIRMA_USER = 'surfstick';
process.env.IFIRMA_API_KEY = '111111';
process.env.IFIRMA_API_KEY_ABONENT = '222222';
delete process.env.IFIRMA_API_KEY_RACHUNEK;
delete process.env.IFIRMA_API_KEY_WYDATEK;
const ifPelne = require(path.join(__dirname, '..', 'src', 'routes', 'ifirma-pelne'));
const T = ifPelne._test;

function atrapa(odpowiedz) {
  const wolania = [];
  T.ustawHttp(async (metoda, sciezka, opcje = {}) => {
    wolania.push({ metoda, sciezka, tresc: opcje.tresc });
    const r = await odpowiedz(metoda, sciezka, opcje.tresc, wolania.length);
    if (r instanceof Error) throw r;
    const buf = r.buf || Buffer.from(JSON.stringify(r.json || {}));
    return { status: r.status || 200, typ: r.typ || 'application/json', buf, json: r.buf ? null : (r.json || {}), naglowki: r.naglowki || {} };
  });
  return wolania;
}
function baza() {
  const blokady = new Map();
  return {
    blokady,
    confirmLock: {
      create: async ({ data }) => { if (blokady.has(data.key)) { const e = new Error('unique'); e.code = 'P2002'; throw e; } blokady.set(data.key, { ...data, invoiceNumber: null, invoiceId: null }); return data; },
      findUnique: async ({ where }) => blokady.get(where.key) || null,
      update: async ({ where, data }) => { blokady.set(where.key, { ...blokady.get(where.key), ...data }); return blokady.get(where.key); },
      delete: async ({ where }) => { blokady.delete(where.key); return {}; },
    },
  };
}
async function zapytaj(db, metoda, sciezka, { rola = 'owner', body } = {}) {
  const app = express();
  app.use(express.json());
  app.locals.prisma = db;
  app.use((req, _res, next) => { req.crm = rola === 'magazyn' ? { user: 'm', role: 'magazyn' } : { user: 'claude', role: 'owner' }; next(); });
  app.use('/api/if', ifPelne);
  const serwer = app.listen(0);
  await new Promise(r => serwer.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${serwer.address().port}${sciezka}`, { method: metoda, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const typ = res.headers.get('content-type') || '';
    return { status: res.status, typ, json: typ.includes('json') ? await res.json() : null, buf: typ.includes('json') ? null : Buffer.from(await res.arrayBuffer()) };
  } finally { serwer.close(); }
}
const FAKTURA_EKSPORT = { DataWystawienia: '2026-11-26', DataSprzedazy: '2026-11-26', FormatDatySprzedazy: 'DZN', SposobZaplaty: 'PRZ', Jezyk: 'en', Waluta: 'EUR', RodzajPodpisuOdbiorcy: 'BPO', WidocznyNumerGios: false, Numer: null, Pozycje: [{ StawkaVat: 0, Ilosc: 30, CenaJednostkowa: 4.5, NazwaPelna: 'SURF STICK zinc stick spf 50+', NazwaPelnaObca: 'SURF STICK zinc stick spf 50+', Jednostka: 'szt.', JednostkaObca: 'pcs', TypStawkiVat: 'PRC' }], Kontrahent: { Nazwa: 'Surf Shop Ltd', KodPocztowy: 'SW1A 1AA', Kraj: 'Wielka Brytania', KodKraju: 'GB', Miejscowosc: 'London' } };

test('klucze per zasób i podpis zgodny z dokumentacją (wektor z FAQ iFirmy, URL bez parametrów)', () => {
  assert.equal(T.nazwaKlucza('fakturaeksporttowarow.json'), 'faktura');
  assert.equal(T.nazwaKlucza('kontrahenci/IFIRMA%20SA.json'), 'faktura');
  assert.equal(T.nazwaKlucza('abonent/miesiacksiegowy.json'), 'abonent');
  assert.equal(T.nazwaKlucza('abonent/limit.json'), 'abonent');
  assert.equal(T.nazwaKlucza('rachunekkraj.json'), 'rachunek');
  assert.equal(T.nazwaKlucza('kosztdzialalnoscivat.json'), 'wydatek');
  assert.equal(T.nazwaKlucza('zakuptowaruvat.json'), 'wydatek');
  // FAQ iFirmy: hmac dla klucza hex 111111 i wiadomości 222222
  assert.equal(crypto.createHmac('sha1', Buffer.from('111111', 'hex')).update('222222').digest('hex'), 'cec153ee6350475f117a307111e2bd7d83034925');
  const url = 'https://www.ifirma.pl/iapi/fakturakraj/list.json';
  const oczekiwany = crypto.createHmac('sha1', Buffer.from('111111', 'hex')).update(`${url}surfstickfaktura`).digest('hex');
  assert.equal(T.podpis(url, 'faktura', ''), `IAPIS user=surfstick, hmac-sha1=${oczekiwany}`);
  assert.throws(() => T.podpis('https://www.ifirma.pl/iapi/rachunekkraj.json', 'rachunek', ''), /brak klucza iFirmy „rachunek” \(IFIRMA_API_KEY_RACHUNEK\)/);
});

test('odczyt: zasób z parametrami 1:1 (z kodowaniem), PDF jako plik; magazyn bez dostępu', async () => {
  const wolania = atrapa((m, s) => (s.endsWith('.pdf?jezykWydruku=obcy') ? { typ: 'application/pdf', buf: Buffer.from('%PDF-1.4 x') } : { json: { response: { Kod: 0, Wynik: [] } } }));
  const db = baza();
  const lista = await zapytaj(db, 'GET', '/api/if/iapi/faktury.json?dataOd=2026-11-01&dataDo=2026-11-30&status=nieoplacone');
  assert.equal(lista.status, 200);
  assert.equal(wolania[0].sciezka, 'faktury.json?dataOd=2026-11-01&dataDo=2026-11-30&status=nieoplacone');
  await zapytaj(db, 'GET', '/api/if/iapi/kontrahenci/IFIRMA%20SA.json');
  assert.equal(wolania[1].sciezka, 'kontrahenci/IFIRMA%20SA.json', 'kodowanie zostaje — podpis liczy się z wysyłanego URL-a');
  const pdf = await zapytaj(db, 'GET', '/api/if/iapi/fakturaeksporttowarow/123.pdf?jezykWydruku=obcy');
  assert.match(pdf.typ, /application\/pdf/);
  assert.equal(pdf.buf.slice(0, 5).toString(), '%PDF-');
  assert.equal((await zapytaj(db, 'GET', '/api/if/iapi/faktury.json', { rola: 'magazyn' })).status, 403);
  assert.equal(wolania.length, 3);
});

test('zapis bez "wykonaj": tylko podgląd — nic nie idzie do iFirmy', async () => {
  const wolania = atrapa(() => ({ json: { response: { Kod: 0 } } }));
  const r = await zapytaj(baza(), 'POST', '/api/if/iapi/fakturaeksporttowarow.json', { body: { dane: FAKTURA_EKSPORT } });
  assert.equal(r.json.podglad, true);
  assert.equal(r.json.url, 'https://www.ifirma.pl/iapi/fakturaeksporttowarow.json');
  assert.equal(r.json.klucz, 'faktura');
  assert.equal(r.json.kluczUstawiony, true);
  assert.deepEqual(r.json.dane, FAKTURA_EKSPORT);
  assert.equal(wolania.length, 0);
});

test('wystawienie: numer dopytany po identyfikatorze, zapis w ConfirmLock (strażnik), powtórka nie robi drugiej faktury', async () => {
  const wolania = atrapa((m, s) => {
    if (m === 'POST') return { json: { response: { Kod: 0, Informacja: 'Faktura została wystawiona.', Identyfikator: 98765 } } };
    if (m === 'GET' && s === 'fakturaeksporttowarow/98765.json') return { json: { response: { Kod: 0, Wynik: { PelnyNumer: '1/2026/EXP', FakturaId: 98765 } } } };
    return { status: 404, json: {} };
  });
  const db = baza();
  const r = await zapytaj(db, 'POST', '/api/if/iapi/fakturaeksporttowarow.json', { body: { dane: FAKTURA_EKSPORT, wykonaj: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.ok, r.json.numer, r.json.id], [true, '1/2026/EXP', '98765']);
  assert.equal(wolania[0].tresc, JSON.stringify(FAKTURA_EKSPORT), 'treść wysłana dokładnie jak podana');
  const [blokada] = [...db.blokady.values()];
  assert.equal(blokada.invoiceNumber, '1/2026/EXP');
  assert.match(blokada.key, /^ifapi:[0-9a-f]{64}$/);
  const drugi = await zapytaj(db, 'POST', '/api/if/iapi/fakturaeksporttowarow.json', { body: { dane: FAKTURA_EKSPORT, wykonaj: true } });
  assert.equal(drugi.json.juzWykonane, true);
  assert.equal(drugi.json.numer, '1/2026/EXP');
  assert.equal(wolania.filter(w => w.metoda === 'POST').length, 1, 'jedna faktura');
  await zapytaj(db, 'POST', '/api/if/iapi/fakturaeksporttowarow.json', { body: { dane: FAKTURA_EKSPORT, wykonaj: true, nowyKlucz: true } });
  assert.equal(wolania.filter(w => w.metoda === 'POST').length, 2, 'świadomie druga: nowyKlucz');
});

test('Kod 201 „miesiąc księgowy": przestawienie na miesiąc dokumentu i jedno ponowienie', async () => {
  let przestawiono = null;
  T.ustawMiesiac(async (m, r) => { przestawiono = [m, r]; });
  atrapa((m, s, tresc, nr) => (m === 'POST' && nr === 1
    ? { json: { response: { Kod: 201, Informacja: 'Data sprzedaży niezgodna z miesiącem i rokiem księgowym' } } }
    : { json: { response: { Kod: 0, Identyfikator: 5, Wynik: { PelnyNumer: '268/2026' } } } }));
  const r = await zapytaj(baza(), 'POST', '/api/if/iapi/fakturakraj.json', { body: { dane: { ...FAKTURA_EKSPORT, DataSprzedazy: '2026-12-01' }, wykonaj: true } });
  assert.equal(r.json.numer, '268/2026');
  assert.deepEqual(przestawiono, [12, 2026]);
  T.ustawMiesiac(null);
});

test('odmowa iFirmy: 400 z treścią i blokada zwolniona (poprawiony dokument można wysłać)', async () => {
  let odrzucaj = true;
  atrapa(() => (odrzucaj ? { json: { response: { Kod: 201, Informacja: "Pole 'Kontrahent.KodPocztowy' jest wymagane" } } } : { json: { response: { Kod: 0, Identyfikator: 7, Wynik: { PelnyNumer: '2/2026/EXP' } } } }));
  const db = baza();
  const r = await zapytaj(db, 'POST', '/api/if/iapi/fakturaeksporttowarow.json', { body: { dane: FAKTURA_EKSPORT, wykonaj: true } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /iFirma odrzuciła: Pole 'Kontrahent\.KodPocztowy' jest wymagane \(Kod 201\)/);
  assert.equal(db.blokady.size, 0);
  odrzucaj = false;
  assert.equal((await zapytaj(db, 'POST', '/api/if/iapi/fakturaeksporttowarow.json', { body: { dane: FAKTURA_EKSPORT, wykonaj: true } })).json.numer, '2/2026/EXP');
});

test('brak odpowiedzi iFirmy: „niepewne", blokada zostaje (409), ponowienie dopiero z ponowPoSprawdzeniu', async () => {
  let awaria = true;
  const wolania = atrapa(() => (awaria ? new Error('iFirma timeout po 45 s (POST fakturawdt.json)') : { json: { response: { Kod: 0, Identyfikator: 9, Wynik: { PelnyNumer: '269/2026' } } } }));
  const db = baza();
  const r = await zapytaj(db, 'POST', '/api/if/iapi/fakturawdt.json', { body: { dane: FAKTURA_EKSPORT, wykonaj: true } });
  assert.equal(r.status, 502);
  assert.equal(r.json.niepewne, true);
  awaria = false;
  const drugi = await zapytaj(db, 'POST', '/api/if/iapi/fakturawdt.json', { body: { dane: FAKTURA_EKSPORT, wykonaj: true } });
  assert.equal(drugi.status, 409);
  assert.equal(wolania.length, 1, 'bez sprawdzenia nie wysyłam drugi raz');
  const trzeci = await zapytaj(db, 'POST', '/api/if/iapi/fakturawdt.json', { body: { dane: FAKTURA_EKSPORT, wykonaj: true, ponowPoSprawdzeniu: true } });
  assert.equal(trzeci.json.numer, '269/2026');
});

test('zasób bez ustawionego klucza (rachunek): 503 z instrukcją, nic nie wysłane, blokada zwolniona', async () => {
  T.ustawHttp(null); // prawdziwy klient — podpis rzuci przed wysłaniem
  const db = baza();
  const r = await zapytaj(db, 'POST', '/api/if/iapi/rachunekkraj.json', { body: { dane: { Numer: null }, wykonaj: true } });
  assert.equal(r.status, 503);
  assert.match(r.json.error, /IFIRMA_API_KEY_RACHUNEK/);
  assert.equal(db.blokady.size, 0);
});

test('PUT (np. edycja kontrahenta) przechodzi tą samą drogą', async () => {
  const wolania = atrapa(() => ({ json: { response: { Kod: 0, Informacja: 'Zmieniono' } } }));
  const r = await zapytaj(baza(), 'PUT', '/api/if/iapi/kontrahenci/MOGA.json', { body: { dane: { Email: 'x@y.es' }, wykonaj: true } });
  assert.equal(r.json.ok, true);
  assert.deepEqual([wolania[0].metoda, wolania[0].sciezka], ['PUT', 'kontrahenci/MOGA.json']);
  assert.equal(r.json.numer, null);
});

test.after(() => { T.ustawHttp(null); T.ustawMiesiac(null); });
