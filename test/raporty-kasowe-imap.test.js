'use strict';

/* Odczyt skrzynki bota (raporty kasowe) na podstawionym serwerze IMAP:
 * tylko do odczytu, pierwsze uruchomienie od teraz, nowe po UID, zmiana
 * UIDVALIDITY, zaległe od daty, limit na cykl. */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const nodemailer = require('nodemailer');

class FakeImap extends EventEmitter {
  constructor(opcje) { super(); FakeImap.opcje = opcje; }
  connect() { setImmediate(() => (FakeImap.blad ? this.emit('error', new Error(FakeImap.blad)) : this.emit('ready'))); }
  openBox(nazwa, tylkoOdczyt, cb) { FakeImap.tylkoOdczyt = tylkoOdczyt; cb(null, { uidvalidity: FakeImap.uidValidity, uidnext: FakeImap.uidNext }); }
  search(kryteria, cb) { FakeImap.kryteria.push(kryteria); cb(null, FakeImap.uidy); }
  fetch(uid) {
    const f = new EventEmitter();
    setImmediate(() => {
      const m = new EventEmitter();
      f.emit('message', m);
      const s = new PassThrough();
      m.emit('body', s);
      s.on('end', () => setImmediate(() => f.emit('end')));
      s.end(FakeImap.surowe[uid]);
    });
    return f;
  }
  end() { FakeImap.zamkniete++; }
}
const p = require.resolve('imap');
require.cache[p] = { id: p, filename: p, loaded: true, exports: FakeImap };
const cyk = require(path.join(__dirname, '..', 'src', 'services', 'raporty-kasowe-cykl'));
const KONTO = { login: 'bot@example.com', haslo: 'x', imap: { host: 'imap.example.com', port: 993 }, smtp: { host: 'smtp.example.com', port: 465 } };

async function surowyMail(uid) {
  const t = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const r = await t.sendMail({ from: 'Bar <bar@hotel.pl>', to: 'bot@example.com', subject: `Raport ${uid}`, text: 'w załączniku', attachments: [{ filename: `raport-${uid}.pdf`, content: Buffer.from('%PDF-1.4 raport ' + uid), contentType: 'application/pdf' }] });
  return r.message;
}
async function serwer({ uidValidity = 7, uidNext = 110, uidy = [] } = {}) {
  Object.assign(FakeImap, { uidValidity, uidNext, uidy, kryteria: [], surowe: {}, zamkniete: 0, blad: null, tylkoOdczyt: null });
  for (const u of uidy) FakeImap.surowe[u] = await surowyMail(u);
}

test('pierwsze uruchomienie: tylko do odczytu, zaczyna od teraz (stare maile przerobił n8n)', async () => {
  await serwer({ uidy: [50, 60] });
  const r = await cyk._test.pobierzMaile(KONTO, {});
  assert.deepEqual(r, { uidValidity: 7, gora: 109, maile: [] });
  assert.equal(FakeImap.tylkoOdczyt, true, 'skrzynka otwarta tylko do odczytu');
  assert.equal(FakeImap.kryteria.length, 0);
  assert.equal(FakeImap.zamkniete, 1);
  assert.equal(FakeImap.opcje.host, 'imap.example.com');
});

test('kolejne cykle: maile po UID z załącznikami; serwer oddający starszy UID (n:*) — odfiltrowany', async () => {
  await serwer({ uidy: [100, 101, 102] });
  const r = await cyk._test.pobierzMaile(KONTO, { uidValidity: 7, lastUid: 100 });
  assert.deepEqual(FakeImap.kryteria[0], [['UID', '101:*']]);
  assert.deepEqual(r.maile.map(m => m.uid), [101, 102]);
  assert.equal(r.maile[0].from, 'bar@hotel.pl');
  assert.equal(r.maile[0].attachments[0].filename, 'raport-101.pdf');
  assert.equal(r.maile[0].attachments[0].content.slice(0, 5).toString(), '%PDF-');
});

test('zmiana UIDVALIDITY = nowa numeracja → start od teraz; tryb od daty → SINCE i wszystko od daty; limit 15 na cykl', async () => {
  await serwer({ uidValidity: 8, uidy: [3, 4] });
  assert.deepEqual((await cyk._test.pobierzMaile(KONTO, { uidValidity: 7, lastUid: 100 })).maile, []);
  const uidy = Array.from({ length: 20 }, (_, i) => i + 1);
  await serwer({ uidy });
  const r = await cyk._test.pobierzMaile(KONTO, { od: '2026-10-24' });
  assert.equal(FakeImap.kryteria[0][0][0], 'SINCE');
  assert.equal(FakeImap.kryteria[0][0][1].toISOString().slice(0, 10), '2026-10-24');
  assert.deepEqual(r.maile.map(m => m.uid), uidy.slice(0, 15));
});

test('zły login: błąd idzie do cyklu (alert po 3 razach), nic nie wisi', async () => {
  await serwer();
  FakeImap.blad = 'Invalid credentials';
  await assert.rejects(() => cyk._test.pobierzMaile(KONTO, { uidValidity: 7, lastUid: 1 }), /Invalid credentials/);
});
