'use strict';
// Wymóg deklaracji celnej (27.11.2026) w zamówieniu z CRM (/glob/order — panel,
// magazyn, auto-list): poza obszar celny UE kurier nie jest zamawiany, bo ta
// ścieżka nie wysyła deklaracji. Wyjątek tylko na wyraźne życzenie właściciela.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// glob-client bez sieci: każde wywołanie GK jest zapisywane — blokada ma zadziałać przed nim.
const wolaniaGk = [];
const sciezkaKlienta = require.resolve(path.join(__dirname, '..', 'src', 'glob-client.js'));
require.cache[sciezkaKlienta] = {
  id: sciezkaKlienta, filename: sciezkaKlienta, loaded: true,
  exports: new Proxy({}, { get: (_, nazwa) => async () => { wolaniaGk.push(String(nazwa)); throw new Error('GK niedostępne w teście'); } }),
};
const router = require('../src/routes/glob-quote');

function zamow(body, wycena) {
  const warstwa = router.stack.find(l => l.route && l.route.path === '/glob/order' && l.route.methods.post);
  const quoteId = '1764240000000';
  const req = { body: { quoteId, ...body }, app: { locals: { prisma: {}, quoteStore: { [quoteId]: wycena } } } };
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(j) { resolve({ status: this.statusCode, json: j }); }, setHeader() {} };
    Promise.resolve(warstwa.route.stack[0].handle(req, res, reject)).catch(reject);
  });
}

const WYCENA_CH = {
  sender: { name: 'Surf Stick Bell', country: 'PL', postCode: '05-410' },
  receiver: { name: 'unlimited options GmbH', country: 'CH', postCode: '4532', city: 'Feldbrunnen' },
  quoteParams: { senderCountryId: 1, receiverCountryId: 261, receiverPostCode: '4532' },
  offers: [{ productId: 3563, carrier: 'FedEX', price: 96.51 }],
};

test('/glob/order: wysyłka do Szwajcarii i na Kanary bez deklaracji — kurier NIE zamówiony, GK nie wołany, zamek wyceny wolny', async () => {
  const r = await zamow({ productId: 3563 }, WYCENA_CH);
  assert.equal(r.status, 200, 'odmowa jak odmowa GK: 200 + ok:false (magazyn nie uzna jej za „niepewną”)');
  assert.equal(r.json.ok, false);
  assert.equal(r.json.wymagaDeklaracjiCelnej, true);
  assert.match(r.json.error, /Wysyłka poza UE \(CH — poza obszarem celnym UE\) wymaga deklaracji celnej.*kurier NIE został zamówiony.*wyraźne życzenie właściciela/);

  const ponownie = await zamow({ productId: 3563 }, WYCENA_CH);
  assert.equal(ponownie.json.duplicate, undefined, 'blokada nie zajmuje zamka wyceny');
  assert.equal(ponownie.json.wymagaDeklaracjiCelnej, true);

  const kanary = await zamow({}, { ...WYCENA_CH, receiver: { name: 'Surf Shop', country: 'ES', postCode: '38650', city: 'Arona' }, quoteParams: { receiverCountryId: 14, receiverPostCode: '38650' } });
  assert.match(kanary.json.error, /ES: Wyspy Kanaryjskie — poza obszarem celnym UE/);

  assert.deepEqual(wolaniaGk, [], 'żadnego wywołania GlobKuriera');
});
