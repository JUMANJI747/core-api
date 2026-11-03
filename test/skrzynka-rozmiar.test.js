'use strict';
// Rozmiar skrzynki i sprzątanie kanarków (services/skrzynka-rozmiar.js)
// na podstawionym serwerze IMAP.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const DZIEN = 24 * 60 * 60 * 1000;
const KB = 1024;

class FakeImap extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; this.wybrany = null; FakeImap.ostatni = this; }
  connect() { setImmediate(() => this.emit('ready')); }
  end() {}
  serverSupports(c) { return FakeImap.mozliwosci.includes(c); }
  getQuotaRoot(_n, cb) { cb(null, { '': { storage: { usage: 950 * 1024, limit: 1000 * 1024 } } }); }
  getBoxes(cb) {
    cb(null, { INBOX: { attribs: [], delimiter: '.', children: {
      Sent: { attribs: ['\\Sent'], delimiter: '.' },
      Trash: { attribs: ['\\Trash'], delimiter: '.' },
    } } });
  }
  openBox(nazwa, tylkoOdczyt, cb) {
    this.wybrany = nazwa;
    FakeImap.otwarcia.push({ nazwa, tylkoOdczyt });
    cb(null, { messages: { total: (FakeImap.skrzynka[nazwa] || []).length } });
  }
  search(kryteria, cb) {
    const [[typ, wartosc]] = kryteria;
    const w = String(wartosc).toLowerCase();
    cb(null, FakeImap.skrzynka[this.wybrany]
      .filter(m => (typ === 'SUBJECT' ? m.temat : `${m.temat} ${m.tekst || ''}`).toLowerCase().includes(w))
      .map(m => m.uid));
  }
  _wyslij(lista, opcje) {
    const f = new EventEmitter();
    setImmediate(() => {
      for (const m of lista) {
        const msg = new EventEmitter();
        f.emit('message', msg);
        if (opcje.bodies) {
          const s = new EventEmitter();
          msg.emit('body', s);
          s.emit('data', Buffer.from(`Subject: ${m.temat}\r\n\r\n`));
          s.emit('end');
        }
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
  expunge(uidy, cb) {
    FakeImap.skrzynka[this.wybrany] = FakeImap.skrzynka[this.wybrany].filter(m => !uidy.includes(m.uid));
    cb(null);
  }
}

function nowySerwer() {
  const teraz = Date.now();
  FakeImap.mozliwosci = ['QUOTA', 'UIDPLUS'];
  FakeImap.otwarcia = [];
  FakeImap.oflagowane = [];
  FakeImap.skrzynka = {
    INBOX: [
      { uid: 1, temat: 'Katalog 2027', size: 3 * 1024 * KB, date: new Date(teraz - 30 * DZIEN) },
      { uid: 2, temat: 'Re: zamówienie', size: 12 * KB, date: new Date(teraz - 2 * DZIEN) },
      { uid: 3, temat: '[CRM-KANAREK] niko-abc', size: 2 * KB, date: new Date(teraz - DZIEN) },      // stary, niedokasowany
      { uid: 4, temat: '[CRM-KANAREK] niko-def', size: 2 * KB, date: new Date(teraz - 10 * 60000) }, // świeży — czeka na poller
      { uid: 5, temat: 'Quick question', tekst: 'warm 4ASVTZE', size: 5 * KB, date: new Date(teraz - DZIEN) },
      { uid: 6, temat: 'Pytanie', tekst: 'co to [CRM-KANAREK]?', size: 4 * KB, date: new Date(teraz - DZIEN) },
    ],
    'INBOX.Sent': [
      { uid: 1, temat: '[CRM-KANAREK] info-111', size: 2 * KB, date: new Date(teraz - 3 * DZIEN) },
      { uid: 2, temat: '[CRM-KANAREK] info-222', size: 2 * KB, date: new Date(teraz - 2 * DZIEN) },
      { uid: 3, temat: '[CRM-KANAREK] info-333', size: 2 * KB, date: new Date(teraz - 5 * 60000) },
      { uid: 4, temat: 'Oferta', size: 500 * KB, date: new Date(teraz - DZIEN) },
      { uid: 5, temat: 'Re: [crm-kanarek] co to jest', size: 3 * KB, date: new Date(teraz - DZIEN) },
    ],
    'INBOX.Trash': [{ uid: 1, temat: 'stare', size: 100 * KB, date: new Date(teraz - 90 * DZIEN) }],
  };
}

const sciezkaImap = require.resolve('imap');
require.cache[sciezkaImap] = { id: sciezkaImap, filename: sciezkaImap, loaded: true, exports: FakeImap };
const { rozmiarSkrzynki, usunKanarki } = require('../src/services/skrzynka-rozmiar');
const KONTO = { inbox: 'niko', user: 'nikodem@surfstickbell.com', pass: 'x', host: 'imap.test', port: 993 };

test('rozmiar: limit serwera, foldery od największego, duże maile, kanarki, rozgrzewanie', async () => {
  nowySerwer();
  const r = await rozmiarSkrzynki(KONTO);
  assert.deepEqual(r.limit, { uzyteMB: 950, limitMB: 1000, procent: 95 });
  assert.deepEqual(r.foldery.map(f => f.nazwa), ['INBOX', 'INBOX.Sent', 'INBOX.Trash']);
  const inbox = r.foldery[0];
  assert.equal(inbox.wiadomosci, 6);
  assert.equal(inbox.duzeNad1MB.n, 1);
  assert.equal(inbox.duzeNad1MB.mb, 3);
  assert.equal(Object.values(inbox.duzeNad1MB.latami)[0].n, 1);
  assert.deepEqual(inbox.duzeNad1MB.czesteRozmiary, [], 'jeden duży mail to nie „ten sam załącznik w kółko"');
  assert.deepEqual(inbox.kanarki, { n: 2, kb: 4 });
  assert.deepEqual(inbox.rozgrzewanie, { n: 1, mb: 0 });
  assert.equal(r.foldery[1].kanarki.n, 4, 'serwer szuka bez wielkości liter — liczba to tylko „kandydaci"');
  assert.ok(FakeImap.otwarcia.every(o => o.tylkoOdczyt), 'raport tylko czyta');
});

test('sprzątanie — próba: liczy, niczego nie kasuje, otwiera tylko do odczytu', async () => {
  nowySerwer();
  const r = await usunKanarki(KONTO);
  assert.equal(r.proba, true);
  assert.deepEqual(r.foldery.map(f => [f.nazwa, f.kanarki, f.usunieto]), [['INBOX', 1, 0], ['INBOX.Sent', 3, 0]]);
  assert.equal(FakeImap.oflagowane.length, 0);
  assert.ok(FakeImap.otwarcia.every(o => o.tylkoOdczyt));
});

test('sprzątanie: kasuje tylko kanarki — świeży w INBOX, cudzy temat i zwykłe maile zostają', async () => {
  nowySerwer();
  const r = await usunKanarki(KONTO, { proba: false });
  assert.equal(r.razem, 4);
  assert.deepEqual(FakeImap.skrzynka.INBOX.map(m => m.uid), [1, 2, 4, 5, 6]);
  assert.deepEqual(FakeImap.skrzynka['INBOX.Sent'].map(m => m.uid), [4, 5]);
  assert.equal(FakeImap.skrzynka['INBOX.Trash'].length, 1);
});

test('sprzątanie bez UID EXPUNGE na serwerze: nic nie kasuje i mówi dlaczego', async () => {
  nowySerwer();
  FakeImap.mozliwosci = ['QUOTA'];
  const r = await usunKanarki(KONTO, { proba: false });
  assert.ok(r.foldery.every(f => f.usunieto === 0 && /UID EXPUNGE/.test(f.blad)));
  assert.equal(FakeImap.oflagowane.length, 0);
  assert.equal(FakeImap.skrzynka['INBOX.Sent'].length, 5);
});
