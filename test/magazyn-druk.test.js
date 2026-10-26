'use strict';

/* Druk zamówienia i „Powiadom magazyn" (26.10.2026). PDF z tabelą pozycji
 * (obie role) i mail z delivery@ do magazynu z PDF-em i dokumentami (tylko
 * właściciel, drugi raz tylko świadomie). Baza i wysyłka maili podstawione. */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const { PDFParse } = require('pdf-parse');

const SRC = path.join(__dirname, '..', 'src');
const { pdfZamowienia, trescMaila } = require(path.join(SRC, 'services', 'magazyn-druk'));

async function tekstPdf(buf) {
  const r = await new PDFParse({ data: buf }).getText();
  return { tekst: r.text, stron: r.total };
}

const KOLORY = [['BSS 01', 'Blue', '5902082556022'], ['BSS 04', 'Pink', '5902082556053'], ['BSS 06', 'Skin', '5902082564942']];
function zamowienie(over = {}) {
  return {
    id: 'z7', numer: 7, status: 'NOWE', createdAt: new Date('2026-10-26T08:40:00Z'), autoList: true,
    contractorId: 'c1', contractor: { id: 'c1', name: 'Wewave' }, invoiceNumber: '254/2026', emailId: null,
    odbiorca: { name: 'Wewave Spółka z o.o.', street: 'Górczewska', houseNumber: '222', postCode: '01-460', city: 'Warszawa', country: 'PL', phone: '+48 793 706 166', email: 'wewave.camps@gmail.com' },
    uwagiNasze: 'Ekspozytor osobno, ostrożnie <kruche>', uwagiMagazynu: null,
    items: [
      { id: 'b', ean: 'BOX-STICK-30', name: 'Box Surf Stick mix', variant: 'w kartonie', symbol: null, qty: 2, parentEan: null, packaging: 'karton' },
      ...KOLORY.map(([s, v, e], n) => ({ id: `k${n}`, ean: e, name: 'SURF STICK zinc stick spf 50+', variant: v, symbol: s, qty: 20, parentEan: 'BOX-STICK-30', packaging: null })),
      { id: 'e', ean: 'EKSPOZYTOR', name: 'Ekspozytor (pusty)', variant: null, symbol: null, qty: 1, parentEan: 'BOX-STICK-30', packaging: null },
      { id: 'm', ean: '5902082576174', name: 'SURF GIRL waterproof mascara', variant: 'Pink', symbol: 'BmwS003', qty: 12, parentEan: null, packaging: null },
    ],
    dokumenty: [{ id: 'd1', filename: 'WZ-12-2026.pdf', contentType: 'application/pdf', size: 9, opis: 'WZ 12/2026', dodal: 'michal', createdAt: new Date('2026-10-26T08:41:00Z') }],
    ...over,
  };
}

test('PDF: polskie znaki, odbiorca, kody, kolory, EAN, suma sztuk (bez nagłówka boxa i pustego ekspozytora), dokumenty', async () => {
  const { toPublicMagazyn } = pomocnicze();
  const buf = await pdfZamowienia(toPublicMagazyn(zamowienie()), { teraz: new Date('2026-10-26T08:45:00Z') });
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');
  const { tekst, stron } = await tekstPdf(buf);
  assert.equal(stron, 1);
  for (const s of ['Zamówienie #7', 'Wewave Spółka z o.o.', 'Górczewska 222, 01-460 Warszawa', '+48 793 706 166', 'BSS 01', 'Blue', '5902082556022', 'BmwS003',
    'w kartonie', '2 kart.', 'Ekspozytor pusty', 'Razem do spakowania: 72 szt.', 'WZ 12/2026', 'Spakował(a)', 'zamówi się sam', 'Ekspozytor osobno, ostrożnie']) {
    assert.ok(tekst.includes(s), `brak w PDF: ${s}`);
  }
  assert.ok(!tekst.includes('254/2026'), 'numer FV to dane CRM — magazyn go nie dostaje');
  assert.ok(!tekst.includes('wewave.camps@gmail.com'), 'e-mail odbiorcy to dane CRM');
});

test('PDF: długie zamówienie na kilku stronach, nagłówek tabeli i numer strony na każdej', async () => {
  const items = Array.from({ length: 45 }, (_, n) => ({ id: `i${n}`, ean: String(5902082500000 + n), name: `Produkt testowy ${n}`, variant: 'Mint', symbol: `K${n}`, qty: 1, parentEan: null, packaging: null }));
  const { tekst, stron } = await tekstPdf(await pdfZamowienia({ numer: 99, status: 'NOWE', createdAt: new Date(), odbiorca: {}, items, dokumenty: [] }));
  assert.ok(stron >= 2, `stron: ${stron}`);
  assert.equal((tekst.match(/Kod\s+Produkt/g) || []).length, stron, 'nagłówek tabeli na każdej stronie');
  assert.ok(tekst.includes(`strona ${stron}/${stron}`));
  assert.ok(tekst.includes('Produkt testowy 44') && tekst.includes('Razem do spakowania: 45 szt.'));
  assert.ok(tekst.includes('nie podano'), 'bez odbiorcy — informacja zamiast pustki');
});

test('treść maila: temat z numerem i sztukami, pozycje z kodami, HTML bez wstrzyknięć', () => {
  const { toPublicMagazyn } = pomocnicze();
  const m = trescMaila(toPublicMagazyn(zamowienie()));
  assert.match(m.subject, /^Nowe zamówienie #7 do spakowania \(72 szt\.\)/);
  assert.match(m.text, /20 × BSS 01 {2}SURF STICK zinc stick spf 50\+ Blue/);
  assert.match(m.text, /Górczewska 222, 01-460 Warszawa · tel\. \+48 793 706 166/);
  assert.match(m.text, /Dokumenty do włożenia do paczki .*WZ 12\/2026/);
  assert.ok(!m.text.includes('254/2026') && !m.text.includes('wewave.camps'));
  assert.ok(m.html.includes('&lt;kruche&gt;') && !m.html.includes('<kruche>'));
});

// ── trasy: podstawione zależności, baza i wysyłka maili ─────────────────────
function podstaw(plik, eksport) {
  const p = require.resolve(path.join(SRC, plik));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: eksport };
}
const wyslane = [];
let bladWysylki = null;
podstaw('mail-sender.js', { sendMail: async (m) => { if (bladWysylki) throw new Error(bladWysylki); wyslane.push(m); return { id: 'mail1' }; } });
podstaw('services/agent-runtime.js', { selfCall: async () => ({ status: 500, body: {} }) });
podstaw('glob-client.js', { getOrderLabels: async () => ({ status: 404 }) });
podstaw('services/product-catalog.js', { getActiveCatalog: async () => [] });
const magazyn = require(path.join(SRC, 'routes', 'magazyn'));

function pomocnicze() {
  // Kształt roli magazyn (bez danych CRM) — w trasach sprawdza go prawdziwy toPublic.
  return {
    toPublicMagazyn: (o) => ({ ...o, contractorId: null, contractorName: null, invoiceNumber: null, emailId: null, odbiorca: { ...o.odbiorca, email: '' } }),
  };
}

function baza(z) {
  const stan = { z: { ...z }, aktualizacje: [] };
  return {
    stan,
    warehouseOrder: {
      findUnique: async ({ where }) => (where.id === stan.z.id ? stan.z : null),
      update: async ({ data }) => { stan.aktualizacje.push(data); stan.z = { ...stan.z, ...data }; return stan.z; },
    },
    warehouseOrderDoc: { findMany: async () => [{ filename: 'WZ-12-2026.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-1.4 wz') }] },
  };
}

async function zapytaj(db, metoda, sciezka, { rola = 'owner', body } = {}) {
  const app = express();
  app.use(express.json());
  app.locals.prisma = db;
  app.use((req, _res, next) => { req.crm = rola === 'magazyn' ? { user: 'm.urbaniak@bell.com.pl', role: 'magazyn' } : { user: 'michal', role: 'owner' }; next(); });
  app.use('/', magazyn);
  const serwer = app.listen(0);
  await new Promise(r => serwer.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${serwer.address().port}${sciezka}`, { method: metoda, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const typ = res.headers.get('content-type') || '';
    return { status: res.status, typ, buf: typ.includes('pdf') ? Buffer.from(await res.arrayBuffer()) : null, json: typ.includes('json') ? await res.json() : null };
  } finally { serwer.close(); }
}

test('trasa PDF: obie role dostają PDF zamówienia; brak zamówienia → 404', async () => {
  const db = baza(zamowienie());
  for (const rola of ['magazyn', 'owner']) {
    const r = await zapytaj(db, 'GET', '/zamowienia/z7/pdf', { rola });
    assert.equal(r.status, 200);
    assert.match(r.typ, /application\/pdf/);
    assert.equal(r.buf.slice(0, 5).toString(), '%PDF-');
    const { tekst } = await tekstPdf(r.buf);
    assert.ok(tekst.includes('Zamówienie #7') && !tekst.includes('254/2026'), `rola ${rola}: PDF w kształcie dla magazynu`);
  }
  assert.equal((await zapytaj(db, 'GET', '/zamowienia/nie-ma/pdf')).status, 404);
});

test('Powiadom magazyn: tylko właściciel; mail z delivery@ do magazynu z PDF i dokumentami; zapis kiedy/kto/dokąd', async () => {
  wyslane.length = 0; bladWysylki = null;
  const db = baza(zamowienie());
  assert.equal((await zapytaj(db, 'POST', '/zamowienia/z7/powiadom', { rola: 'magazyn' })).status, 403);
  assert.equal(wyslane.length, 0);
  const r = await zapytaj(db, 'POST', '/zamowienia/z7/powiadom');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(wyslane.length, 1);
  const m = wyslane[0];
  assert.equal(m.from, 'delivery@surfstickbell.com');
  assert.equal(m.to, 'm.urbaniak@bell.com.pl');
  assert.match(m.subject, /Nowe zamówienie #7/);
  assert.ok(m.body.includes('BSS 01') && m.html.includes('BSS 01'));
  assert.deepEqual(m.attachments.map(a => a.filename), ['zamowienie-7.pdf', 'WZ-12-2026.pdf']);
  assert.equal(m.attachments[0].content.slice(0, 5).toString(), '%PDF-');
  assert.equal(m.attachments[0].contentType, 'application/pdf');
  const zapis = db.stan.aktualizacje[0];
  assert.ok(zapis.powiadomionoAt instanceof Date);
  assert.equal(zapis.powiadomilKto, 'michal');
  assert.equal(zapis.powiadomionoDo, 'm.urbaniak@bell.com.pl');
  assert.equal(r.json.zamowienie.powiadomilKto, 'michal');
  assert.ok(r.json.zamowienie.powiadomionoAt);
});

test('Powiadom magazyn: drugi raz tylko z {ponownie:true}; podgląd bez wysyłki; anulowane i zły adres odrzucone; błąd SMTP bez zapisu', async () => {
  wyslane.length = 0; bladWysylki = null;
  const db = baza(zamowienie({ powiadomionoAt: new Date('2026-10-26T09:00:00Z'), powiadomionoDo: 'm.urbaniak@bell.com.pl' }));
  const drugi = await zapytaj(db, 'POST', '/zamowienia/z7/powiadom');
  assert.equal(drugi.status, 409);
  assert.equal(drugi.json.juzPowiadomiono, true);
  assert.match(drugi.json.error, /powiadomiony już 26\.10\.2026, 10:00/, 'czas polski (od 25.10 zimowy, UTC+1)');
  assert.equal(wyslane.length, 0);
  const podglad = await zapytaj(db, 'POST', '/zamowienia/z7/powiadom', { body: { podglad: true } });
  assert.equal(podglad.status, 200);
  assert.equal(podglad.json.podglad, true);
  assert.match(podglad.json.temat, /#7/);
  assert.deepEqual(podglad.json.zalaczniki.map(a => a.filename), ['zamowienie-7.pdf', 'WZ-12-2026.pdf']);
  assert.equal(wyslane.length, 0, 'podgląd nic nie wysyła');
  assert.equal((await zapytaj(db, 'POST', '/zamowienia/z7/powiadom', { body: { ponownie: true } })).status, 200);
  assert.equal(wyslane.length, 1);
  assert.equal((await zapytaj(db, 'POST', '/zamowienia/z7/powiadom', { body: { ponownie: true, do: 'zly-adres' } })).status, 400);
  const anulowane = baza(zamowienie({ status: 'ANULOWANE' }));
  assert.equal((await zapytaj(anulowane, 'POST', '/zamowienia/z7/powiadom')).status, 400);
  bladWysylki = 'Invalid login: 535';
  const nowe = baza(zamowienie());
  const blad = await zapytaj(nowe, 'POST', '/zamowienia/z7/powiadom');
  assert.equal(blad.status, 502);
  assert.match(blad.json.error, /nie wyszedł: Invalid login/);
  assert.equal(nowe.stan.aktualizacje.length, 0, 'bez wysyłki nie zapisujemy „powiadomiono"');
  bladWysylki = null;
});

test('lista dla magazynu: widać, że powiadomiono, ale bez loginu i adresu (dane właściciela)', async () => {
  const db = baza(zamowienie({ powiadomionoAt: new Date('2026-10-26T09:00:00Z'), powiadomilKto: 'michal', powiadomionoDo: 'm.urbaniak@bell.com.pl' }));
  const mag = (await zapytaj(db, 'GET', '/zamowienia/z7', { rola: 'magazyn' })).json.zamowienie;
  assert.ok(mag.powiadomionoAt);
  assert.equal(mag.powiadomilKto, null);
  assert.equal(mag.powiadomionoDo, null);
  const wl = (await zapytaj(db, 'GET', '/zamowienia/z7')).json.zamowienie;
  assert.equal(wl.powiadomilKto, 'michal');
  assert.equal(wl.powiadomionoDo, 'm.urbaniak@bell.com.pl');
});
