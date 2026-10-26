'use strict';

/* Faktury na zamówienie systemu mailingowego (26.10.2026): token, walidacja,
 * limity, idempotencja po ref, zapis w CRM, błędy iFirmy. iFirma, Telegram
 * i baza podstawione. */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');

const SRC = path.join(__dirname, '..', 'src');
function podstaw(plik, eksport) {
  const p = require.resolve(path.join(SRC, plik));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: eksport };
}
const telegram = [];
podstaw('services/telegram-helper.js', { resolveTelegram: async () => ({ token: 'T', chatId: '1' }) });
podstaw('telegram-utils.js', { sendTelegram: async (t, c, tekst) => { telegram.push(tekst); } });
podstaw('services/activity-log.js', { logActivity: () => {} });
podstaw('services/ifirma-payload.js', { buildIfirmaContractorPayload: async () => ({ ifirmaId: null }) });

// iFirma podstawiona — liczy wywołania; można wymusić błąd.
const ifirma = {
  wywolania: [], upserty: [], blad: null, numer: '255/2026',
  async upsertContractor(p) { this.upserty.push(p); return { ok: true }; },
  async createInvoice(a) { if (this.blad) throw new Error(this.blad); this.wywolania.push(a); return { ok: true, invoiceNumber: null, ifirmaId: 900 + this.wywolania.length }; },
  async fetchInvoices() { return [{ FakturaId: 900 + this.wywolania.length, PelnyNumer: this.numer }]; },
  async fetchInvoicePdf() { return Buffer.from('%PDF-1.4 faktura testowa'); },
};
podstaw('ifirma-client.js', ifirma);

const fz = require(path.join(SRC, 'services', 'faktury-zewn'));
const TOKEN = 'tokenTestowyFakturMailing1234567890abcd';

function baza({ limity, kontrahenci = [] } = {}) {
  const config = new Map([[fz.KLUCZ_TOKENY, JSON.stringify([{ nazwa: 'mailing', hash: fz.sha256(TOKEN) }, { nazwa: 'stary', hash: fz.sha256('wylaczonyToken123456789012345'), aktywny: false }])]]);
  if (limity) config.set(fz.KLUCZ_LIMITY, JSON.stringify(limity));
  const locki = new Map();
  const faktury = [];
  const kontr = [...kontrahenci];
  return {
    _locki: locki, _faktury: faktury, _kontr: kontr,
    config: { findUnique: async ({ where }) => (config.has(where.key) ? { key: where.key, value: config.get(where.key) } : null) },
    confirmLock: {
      create: async ({ data }) => { if (locki.has(data.key)) { const e = new Error('P2002'); e.code = 'P2002'; throw e; } locki.set(data.key, { key: data.key, invoiceNumber: null, invoiceId: null }); return locki.get(data.key); },
      findUnique: async ({ where }) => locki.get(where.key) || null,
      update: async ({ where, data }) => { const r = { ...locki.get(where.key), ...data }; locki.set(where.key, r); return r; },
      delete: async ({ where }) => { locki.delete(where.key); return {}; },
    },
    contractor: {
      findFirst: async ({ where }) => kontr.find(k => where.nip.in.includes(k.nip)) || null,
      create: async ({ data }) => { const k = { id: `k${kontr.length + 1}`, tags: [], ...data }; kontr.push(k); return k; },
      update: async ({ where, data }) => { const k = kontr.find(x => x.id === where.id); Object.assign(k, data); return k; },
    },
    invoice: {
      create: async ({ data }) => { const f = { id: `f${faktury.length + 1}`, ksefNumber: null, ...data }; faktury.push(f); return f; },
      findUnique: async ({ where }) => faktury.find(f => f.id === where.id) || null,
      count: async ({ where }) => faktury.filter(f => f.source === where.source).length,
    },
  };
}
const zamowienie = (over = {}) => ({
  ref: 'sub_42:2026-11',
  klient: { nazwa: 'Wewave sp. z o.o.', nip: '5223342444', ulica: 'Górczewska 222', kod: '01-460', miasto: 'Warszawa', email: 'faktury@wewave.pl' },
  pozycje: [{ nazwa: 'Abonament system mailingowy — listopad 2026', ilosc: 1, jednostka: 'mies.', cenaNetto: 299 }],
  terminDni: 14,
  ...over,
});
const reset = () => { ifirma.wywolania.length = 0; ifirma.upserty.length = 0; ifirma.blad = null; telegram.length = 0; };

test('NIP z sumą kontrolną i walidacja zamówienia', () => {
  assert.equal(fz.nipPoprawny('5223342444'), true);
  assert.equal(fz.nipPoprawny('5223342445'), false);
  assert.equal(fz.nipPoprawny('123'), false);
  const zle = fz.waliduj({ ref: 'zły ref ze spacją', klient: { nazwa: 'X', nip: '5223342445', ulica: '', kod: '01460', miasto: '' }, pozycje: [{ nazwa: 'a', ilosc: 1, cenaNetto: 10, cenaBrutto: 12 }, { nazwa: 'b', ilosc: 0, cenaNetto: 1.234 }], terminDni: 90 });
  const tekst = zle.bledy.join(' | ');
  for (const s of ['ref:', 'klient.nip', 'klient.nazwa', 'klient.ulica', 'klient.kod', 'klient.miasto', 'DOKŁADNIE jedną cenę', 'pozycje[1].ilosc', 'pozycje[1]: cena', 'terminDni']) assert.ok(tekst.includes(s), `brak błędu: ${s}`);
  const mieszane = fz.waliduj(zamowienie({ pozycje: [{ nazwa: 'a', ilosc: 1, cenaNetto: 10 }, { nazwa: 'b', ilosc: 1, cenaBrutto: 12.3 }] }));
  assert.ok(mieszane.bledy.some(b => b.includes('nie mieszaj')));
  assert.ok(fz.waliduj(zamowienie({ pozycje: [{ nazwa: 'a', ilosc: 1, cenaNetto: 10, gtu: 'GTU_99' }] })).bledy.some(b => b.includes('gtu')));
});

test('sumy: netto 299 → VAT 68,77, brutto 367,77; brutto 2×123 → netto 200, VAT 46; NIP z prefiksem i kreskami przyjęty', () => {
  assert.deepEqual(fz.waliduj(zamowienie()).dane.suma, { netto: 299, vat: 68.77, brutto: 367.77, waluta: 'PLN' });
  const b = fz.waliduj(zamowienie({ pozycje: [{ nazwa: 'Wysyłka kampanii', ilosc: 2, cenaBrutto: 123 }] })).dane;
  assert.equal(b.trybCen, 'brutto');
  assert.deepEqual(b.suma, { netto: 200, vat: 46, brutto: 246, waluta: 'PLN' });
  assert.equal(fz.waliduj(zamowienie({ klient: { ...zamowienie().klient, nip: 'PL 522-334-24-44' } })).dane.klient.nip, '5223342444');
  assert.equal(fz.waliduj(zamowienie()).dane.linie[0].gtu, 'GTU_12', 'domyślne GTU dla usług marketingowych');
});

test('token: dobry → źródło; zły, wyłączony albo brak → odmowa', async () => {
  const db = baza();
  assert.equal(await fz.zrodloZTokenu(db, { headers: { authorization: `Bearer ${TOKEN}` } }), 'mailing');
  assert.equal(await fz.zrodloZTokenu(db, { headers: { authorization: 'Bearer zlyTokenZlyTokenZlyToken123' } }), null);
  assert.equal(await fz.zrodloZTokenu(db, { headers: { authorization: 'Bearer wylaczonyToken123456789012345' } }), null);
  assert.equal(await fz.zrodloZTokenu(db, { headers: {} }), null);
});

test('wystawienie: krajowa VAT 23% PLN z pozycjami usług, zapis w CRM, numer, PDF, Telegram; ten sam ref → ta sama faktura', async () => {
  reset();
  const db = baza();
  const r = await fz.wystaw(db, 'mailing', zamowienie());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.numer, '255/2026');
  assert.equal(r.json.brutto, 367.77);
  assert.equal(r.json.netto, 299);
  assert.equal(r.json.terminPlatnosci.length, 10);
  assert.equal(Buffer.from(r.json.pdf.base64, 'base64').slice(0, 5).toString(), '%PDF-');
  assert.equal(ifirma.wywolania.length, 1);
  const w = ifirma.wywolania[0];
  assert.equal(w.rodzaj, 'krajowa'); assert.equal(w.waluta, 'PLN'); assert.equal(w.priceMode, 'netto'); assert.equal(w.paymentDays, 14);
  assert.deepEqual(w.pozycje, [{ nazwa: 'Abonament system mailingowy — listopad 2026', nazwaPelna: 'Abonament system mailingowy — listopad 2026', ilosc: 1, jednostka: 'mies.', gtu: 'GTU_12', cenaNetto: 299 }]);
  assert.equal(w.kontrahent.nip, '5223342444'); assert.equal(w.kontrahent.postCode, '01-460'); assert.equal(w.kontrahent.address, 'Górczewska 222');
  assert.equal(ifirma.upserty.length, 1);
  const f = db._faktury[0];
  assert.equal(f.source, 'mailing-api'); assert.equal(f.extras.ref, 'sub_42:2026-11'); assert.equal(f.type, 'krajowa');
  assert.equal(db._locki.get('zewn:mailing:sub_42:2026-11').invoiceNumber, '255/2026');
  assert.equal(db._kontr.length, 1); assert.deepEqual(db._kontr[0].tags, ['mailing']);
  assert.ok(telegram.some(t => t.includes('255/2026') && t.includes('Wewave')));
  const drugi = await fz.wystaw(db, 'mailing', zamowienie());
  assert.equal(drugi.status, 200); assert.equal(drugi.json.duplikat, true); assert.equal(drugi.json.numer, '255/2026');
  assert.equal(ifirma.wywolania.length, 1, 'iFirma wołana tylko raz');
  assert.equal(db._faktury.length, 1);
});

test('istniejący kontrahent (NIP z prefiksem) — bez nowej karty, dopisany tag i puste pola', async () => {
  reset();
  const db = baza({ kontrahenci: [{ id: 'k9', name: 'WeWave', nip: 'PL5223342444', address: 'Stary adres 1', postCode: null, city: 'Warszawa', email: null, tags: ['ifirma-import'] }] });
  const r = await fz.wystaw(db, 'mailing', zamowienie({ ref: 'r2' }));
  assert.equal(r.status, 200);
  assert.equal(db._kontr.length, 1);
  assert.deepEqual(db._kontr[0].tags, ['ifirma-import', 'mailing']);
  assert.equal(db._kontr[0].address, 'Stary adres 1', 'nie nadpisujemy danych z CRM');
  assert.equal(db._kontr[0].postCode, '01-460');
  assert.equal(ifirma.wywolania[0].kontrahent.address, 'Górczewska 222', 'na fakturze dane z zamówienia');
});

test('tryb próbny i limity: próba nic nie wystawia; ponad kwotę → 422 + Telegram; dzienny limit → 429', async () => {
  reset();
  const p = await fz.wystaw(baza(), 'mailing', { ...zamowienie(), proba: true });
  assert.equal(p.status, 200); assert.equal(p.json.proba, true); assert.equal(p.json.suma.brutto, 367.77);
  assert.equal(ifirma.wywolania.length, 0);
  const duza = await fz.wystaw(baza({ limity: { maxNettoFaktury: 200 } }), 'mailing', zamowienie());
  assert.equal(duza.status, 422);
  assert.ok(telegram.some(t => t.includes('ODRZUCONO')));
  const db = baza({ limity: { maxDziennie: 1 } });
  assert.equal((await fz.wystaw(db, 'mailing', zamowienie({ ref: 'a1' }))).status, 200);
  assert.equal((await fz.wystaw(db, 'mailing', zamowienie({ ref: 'a2' }))).status, 429);
  assert.equal(ifirma.wywolania.length, 1);
});

test('błąd iFirmy przed wystawieniem → 502 i ponowienie tym samym ref działa; błąd PO wystawieniu → 500 bez zwolnienia klucza', async () => {
  reset();
  const db = baza();
  ifirma.blad = 'Kod 201: zły miesiąc';
  const r = await fz.wystaw(db, 'mailing', zamowienie());
  assert.equal(r.status, 502);
  assert.ok(!db._locki.has('zewn:mailing:sub_42:2026-11'), 'klucz zwolniony');
  ifirma.blad = null;
  assert.equal((await fz.wystaw(db, 'mailing', zamowienie())).status, 200);

  reset();
  const db2 = baza();
  db2.invoice.create = async () => { throw new Error('baza padła'); };
  const r2 = await fz.wystaw(db2, 'mailing', zamowienie());
  assert.equal(r2.status, 500);
  assert.equal(db2._locki.get('zewn:mailing:sub_42:2026-11').invoiceNumber, 'ISSUED');
  assert.ok(telegram.some(t => t.includes('powstała w iFirmie')));
  const r3 = await fz.wystaw(db2, 'mailing', zamowienie());
  assert.equal(r3.status, 409, 'bez drugiej faktury');
  assert.equal(ifirma.wywolania.length, 1);
});

test('stan po ref: numer, zapłata, KSeF, PDF na życzenie; obcy ref → 404', async () => {
  reset();
  const db = baza();
  await fz.wystaw(db, 'mailing', zamowienie());
  db._faktury[0].ksefNumber = '5223342444-20261026-ABC';
  db._faktury[0].status = 'paid'; db._faktury[0].paidAmount = 367.77;
  const s = await fz.stan(db, 'mailing', 'sub_42:2026-11');
  assert.equal(s.status, 200);
  assert.equal(s.json.status, 'paid'); assert.equal(s.json.ksefNumer, '5223342444-20261026-ABC'); assert.equal(s.json.pdf, null);
  assert.ok((await fz.stan(db, 'mailing', 'sub_42:2026-11', { zPdf: true })).json.pdf.base64);
  assert.equal((await fz.stan(db, 'mailing', 'nie-ma')).status, 404);
  assert.equal((await fz.stan(db, 'inne', 'sub_42:2026-11')).status, 404, 'inne źródło nie widzi cudzych faktur');
});

test('trasy: bez tokenu 401, z tokenem wystawia i zwraca stan', async () => {
  reset();
  const db = baza();
  const app = express();
  app.use(express.json());
  app.locals.prisma = db;
  app.use('/', require(path.join(SRC, 'routes', 'faktury-zewn')));
  const serwer = app.listen(0);
  await new Promise(r => serwer.once('listening', r));
  const url = `http://127.0.0.1:${serwer.address().port}/zewn/faktury`;
  try {
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(zamowienie()) })).status, 401);
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(zamowienie()) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).numer, '255/2026');
    const s = await fetch(`${url}?ref=${encodeURIComponent('sub_42:2026-11')}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal((await s.json()).numer, '255/2026');
  } finally { serwer.close(); }
});
