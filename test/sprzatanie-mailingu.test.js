'use strict';
// Sprzątanie mailingu bez odpowiedzi (services/sprzatanie-mailingu.js):
// wybór maili i przebieg na podstawionym serwerze IMAP.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const MB = 1024 * 1024;

class FakeImap extends EventEmitter {
  constructor() { super(); this.wybrany = null; }
  connect() { setImmediate(() => this.emit('ready')); }
  end() {}
  serverSupports(c) { return FakeImap.mozliwosci.includes(c); }
  getBoxes(cb) {
    cb(null, {
      INBOX: { attribs: [], delimiter: '.' },
      Sent: { attribs: [], delimiter: '.' },
      'Sent Messages': { attribs: ['\\Sent'], delimiter: '.' },
      Drafts: { attribs: ['\\Drafts'], delimiter: '.' },
      Trash: { attribs: ['\\Trash'], delimiter: '.' },
    });
  }
  openBox(nazwa, tylkoOdczyt, cb) {
    this.wybrany = nazwa;
    FakeImap.otwarcia.push({ nazwa, tylkoOdczyt });
    cb(null, { uidvalidity: 7, messages: { total: (FakeImap.skrzynka[nazwa] || []).length } });
  }
  search(kryteria, cb) {
    const since = kryteria.find(k => k[0] === 'SINCE')[1];
    const before = kryteria.find(k => k[0] === 'BEFORE')[1];
    cb(null, FakeImap.skrzynka[this.wybrany].filter(m => m.date >= since && m.date < before).map(m => m.uid));
  }
  _wyslij(lista, opcje) {
    const pola = opcje.bodies.match(/\((.*)\)/)[1].split(' ').map(x => x.toLowerCase());
    const f = new EventEmitter();
    setImmediate(() => {
      for (const m of lista) {
        const msg = new EventEmitter();
        f.emit('message', msg);
        const s = new EventEmitter();
        msg.emit('body', s);
        s.emit('data', Buffer.from(pola.filter(p => m.h[p]).map(p => `${p}: ${m.h[p]}\r\n`).join('') + '\r\n'));
        s.emit('end');
        msg.emit('attributes', { uid: m.uid, size: m.size, date: m.date });
        msg.emit('end');
      }
      f.emit('end');
    });
    return f;
  }
  fetch(uidy, opcje) { return this._wyslij(FakeImap.skrzynka[this.wybrany].filter(m => uidy.includes(m.uid)), opcje); }
  get seq() { return { fetch: (_z, opcje) => this._wyslij(FakeImap.skrzynka[this.wybrany], opcje) }; }
  addFlags(uidy, _f, cb) { FakeImap.oflagowane.push(...uidy); cb(null); }
  expunge(uidy, cb) { FakeImap.skrzynka[this.wybrany] = FakeImap.skrzynka[this.wybrany].filter(m => !uidy.includes(m.uid)); cb(null); }
}

const sciezkaImap = require.resolve('imap');
require.cache[sciezkaImap] = { id: sciezkaImap, filename: sciezkaImap, loaded: true, exports: FakeImap };
const { sprzatnijMailing, _test: { wybierz, parsujNaglowki, domenaFirmowa } } = require('../src/services/sprzatanie-mailingu');

const d = (s) => new Date(`${s}T10:00:00Z`);
const KAMPANIA = 'Surf Stick Bell — catalogue 2025';
function nowySerwer() {
  FakeImap.mozliwosci = ['UIDPLUS'];
  FakeImap.otwarcia = [];
  FakeImap.oflagowane = [];
  const wyslij = (uid, to, data, extra = {}) => ({ uid, size: 7 * MB, date: d(data), h: { to, subject: KAMPANIA, ...extra } });
  FakeImap.skrzynka = {
    Sent: [
      wyslij(1, 'shop@surfshop.de', '2025-03-01'),           // odpisał (INBOX)
      wyslij(2, 'Anna <info@beachstore.fr>', '2025-03-01'),  // odpisał ktoś inny z firmy (baza CRM)
      wyslij(3, 'jan.kowalski@gmail.com', '2025-03-01'),     // gmail — odpisał kolega z gmaila: to nie odpowiedź
      wyslij(4, 'contact@nobody1.es', '2025-03-02'),
      wyslij(5, 'contact@nobody2.it', '2025-03-02'),
      wyslij(6, 'hello@nobody3.pt', '2025-03-03'),
      wyslij(7, 'office@kontrahent.pl', '2025-03-03'),        // kontrahent w CRM
      wyslij(8, 'buyer@nobody4.nl', '2026-02-01'),           // poza okresem
      { uid: 9, size: 2 * MB, date: d('2025-04-01'), h: { to: 'contact@nobody1.es', subject: 'Re: catalogue', 'in-reply-to': '<x@y>' } },
      { uid: 10, size: 9 * MB, date: d('2024-05-01'), h: { to: 'one@single.com', subject: 'Oferta tylko dla Was' } }, // pojedynczy mail
      { uid: 11, size: 1 * MB, date: d('2025-05-01'), h: { to: 'info@surfstickbell.com', subject: KAMPANIA } },       // wewnętrzny
      { uid: 12, size: 7 * MB, date: d('2025-03-04'), h: { to: 'a@nobody5.com, b@surfshop.de', subject: KAMPANIA } }, // zbiorowy, jeden odpisał
    ],
    'Sent Messages': [],
    INBOX: [{ uid: 1, size: 1000, date: d('2025-03-05'), h: { from: 'Shop <shop@surfshop.de>' } }],
    Trash: [{ uid: 1, size: 1000, date: d('2025-03-06'), h: { from: 'kolega.jana@gmail.com' } }],
    Drafts: [{ uid: 1, size: 1000, date: d('2025-03-06'), h: { from: 'nikodem@surfstickbell.com', to: 'hello@nobody3.pt' } }],
  };
}
const prisma = { $queryRawUnsafe: async () => [{ a: 'sales@beachstore.fr' }, { a: 'office@kontrahent.pl' }] };
const KONTO = { inbox: 'niko', user: 'nikodem@surfstickbell.com', pass: 'x', host: 'imap.test', port: 993 };

test('nagłówki i domeny', () => {
  assert.deepEqual(parsujNaglowki('To: a@b.pl,\r\n c@d.pl\r\nSubject: =?UTF-8?Q?Cze=C5=9B=C4=87?=\r\n'), { to: 'a@b.pl, c@d.pl', subject: '=?UTF-8?Q?Cze=C5=9B=C4=87?=' });
  assert.equal(domenaFirmowa('x@shop.surfshop.de'), 'surfshop.de');
  assert.equal(domenaFirmowa('x@gmail.com'), null);
  assert.equal(domenaFirmowa('x@yahoo.co.uk'), null);
  assert.equal(domenaFirmowa('x@firma.com.pl'), 'firma.com.pl');
});

test('próba: kasuje tylko kampanię bez odpowiedzi; reszta zostaje z powodem; nic nie rusza', async () => {
  nowySerwer();
  const r = await sprzatnijMailing(prisma, KONTO, { od: '2024-01-01', do: '2026-01-01', minOdbiorcow: 5 });
  assert.equal(r.proba, true);
  assert.equal(r.wyslanychWOkresie, 11);
  assert.equal(r.doUsuniecia.n, 4, JSON.stringify(r)); // 3 (gmail bez odpowiedzi z adresu), 4, 5, 6
  assert.equal(r.doUsuniecia.mb, 28);
  assert.deepEqual(r.zostaja, { odpowiedzi: 1, wewnetrzne: 1, bezOdbiorcy: 0, pojedyncze: 1, ktosOdpisal: 4 });
  assert.deepEqual(r.kampanie, [{ temat: KAMPANIA, wyslano: 8, odpisalo: 4, doUsuniecia: 4, mb: 28 }]);
  assert.equal(FakeImap.oflagowane.length, 0);
  assert.ok(FakeImap.otwarcia.every(o => o.tylkoOdczyt));
});

test('kasowanie wymaga liczby z próby; inna liczba = nic nie skasowane', async () => {
  nowySerwer();
  await assert.rejects(sprzatnijMailing(prisma, KONTO, { proba: false }), /oczekiwane/);
  const r = await sprzatnijMailing(prisma, KONTO, { proba: false, oczekiwane: 3 });
  assert.match(r.blad, /zmieniła się liczba/);
  assert.equal(FakeImap.oflagowane.length, 0);
});

test('kasowanie: znikają dokładnie 4 maile z kampanii bez odpowiedzi', async () => {
  nowySerwer();
  const r = await sprzatnijMailing(prisma, KONTO, { proba: false, oczekiwane: 4 });
  assert.equal(r.usunieto, 4);
  assert.deepEqual(FakeImap.skrzynka.Sent.map(m => m.uid), [1, 2, 7, 8, 9, 10, 11, 12]);
  assert.equal(FakeImap.skrzynka.INBOX.length, 1);
});

test('bez UID EXPUNGE nic nie kasuje', async () => {
  nowySerwer();
  FakeImap.mozliwosci = [];
  const r = await sprzatnijMailing(prisma, KONTO, { proba: false, oczekiwane: 4 });
  assert.match(r.blad, /UID EXPUNGE/);
  assert.equal(FakeImap.skrzynka.Sent.length, 12);
});

test('wybierz: temat do mniej niż minOdbiorcow adresów to nie mailing', () => {
  const wyslane = ['a@x1.com', 'b@x2.com', 'c@x3.com'].map((to, i) => ({ uid: i, size: 1, h: { to, subject: 'Mała akcja' } }));
  const pisali = { adresy: new Set(), domeny: new Set() };
  assert.equal(wybierz(wyslane, pisali, { minOdbiorcow: 5 }).doUsuniecia.length, 0);
  assert.equal(wybierz(wyslane, pisali, { minOdbiorcow: 3 }).doUsuniecia.length, 3);
});
