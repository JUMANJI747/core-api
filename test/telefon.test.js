'use strict';
// Telefony odbiorców: normalizacja do +<kierunkowy><numer> i numer brany
// wprost z wklejonego tekstu (services/telefon.js + /api/glob/parse-address).
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const { normalizujTelefon, telefonyWTekscie, telefonZTekstu } = require('../src/services/telefon');

const SALTED = '+4915780547308';

test('niemiecki numer w każdym zapisie daje ten sam E.164', () => {
  for (const zapis of [
    '+4915780547308', '+49 (0)157 80547308', '0157 80547308', '+49 0157 80547308',
    '+49 157 805 473 08', 'Tel.: +49 (0) 1578 0547308', '0049 157 80547308',
    '0157/80547308', '4915780547308', '+49 157 80547308',
  ]) assert.equal(normalizujTelefon(zapis, 'DE'), SALTED, zapis);
});

test('inne kraje: zero krajowe znika, poza Włochami', () => {
  assert.equal(normalizujTelefon('502 189 198', 'PL'), '+48502189198');
  assert.equal(normalizujTelefon('+48 502 189 198', 'PL'), '+48502189198');
  assert.equal(normalizujTelefon('48502189198', 'pl'), '+48502189198');
  assert.equal(normalizujTelefon('48 123 45 67', 'PL'), '+48481234567'); // Radom, nie kierunkowy
  assert.equal(normalizujTelefon('+34 624 46 48 33', 'ES'), '+34624464833');
  assert.equal(normalizujTelefon('06 12 34 56 78', 'FR'), '+33612345678');
  assert.equal(normalizujTelefon('+33 (0)6 12 34 56 78', 'FR'), '+33612345678');
  assert.equal(normalizujTelefon('+44 (0)20 7946 0958', 'GB'), '+442079460958');
  assert.equal(normalizujTelefon('+39 02 1234 5678', 'IT'), '+390212345678');
  assert.equal(normalizujTelefon('02 1234 5678', 'IT'), '+390212345678');
  assert.equal(normalizujTelefon('393 123 4567', 'IT'), '+393931234567'); // komórka, nie kierunkowy
  assert.equal(normalizujTelefon('45 12 34 56', 'DK'), '+4545123456');
  assert.equal(normalizujTelefon('45 12 34 56 78', 'DK'), '+4512345678');
});

test('nie zgaduje: zapis krajowy bez kraju, śmieci, pusto', () => {
  assert.equal(normalizujTelefon('502189198', null), null);
  assert.equal(normalizujTelefon('0000 0712 1981 2874', 'PL'), null);
  assert.equal(normalizujTelefon('12345', 'DE'), null);
  assert.equal(normalizujTelefon('', 'DE'), null);
  assert.equal(normalizujTelefon(null, 'DE'), null);
});

const BLOK = 'salted GmbH, HRB 196740 B\nLuisa Möst\nZeughofstraße 20 10997 Berlin\nTel. +49 157 80547308\n10997 Berlin\nFax: 030 1234568\nluisa@salted.de';

test('telefon z tekstu: przekręcona podpowiedź modelu wraca do numeru z tekstu', () => {
  for (const hint of ['+49157805473080', '+491578054730', '+49015780547308', '+49157805473008', '+491578054708', SALTED, '+49 157 80547308'])
    assert.equal(telefonZTekstu(BLOK, hint, 'DE'), SALTED, hint);
  assert.equal(telefonZTekstu(BLOK, null, 'DE'), SALTED, 'model nie dał telefonu');
});

test('telefon z tekstu: kod pocztowy z następnej linii nie skleja się z numerem', () => {
  const numery = telefonyWTekscie(BLOK, 'DE');
  assert.ok(numery.some(n => n.numer === SALTED && n.pewny));
  assert.ok(numery.find(n => n.numer === '+49301234568' && !n.pewny), 'fax bez etykiety telefonu');
});

test('telefon z tekstu: kilka numerów — wygrywa najbliższy podpowiedzi', () => {
  const t = 'Tel. 030 1234567 / 0157 80547308\nMobil: +48 502 189 198';
  assert.equal(telefonZTekstu(t, '+491578054708', 'DE'), SALTED);
  assert.equal(telefonZTekstu(t, '+49301234567', 'DE'), '+49301234567');
  assert.equal(telefonZTekstu(t, '+485021891980', 'DE'), '+48502189198');
});

test('telefon z tekstu: numer krajowy bez etykiety też jest poprawiany', () => {
  const t = 'Luisa Möst\nZeughofstraße 20\n10997 Berlin\n0157 80547308';
  assert.equal(telefonZTekstu(t, '+491578054708', 'DE'), SALTED);
});

test('telefon z tekstu: brak numeru w tekście → znormalizowana podpowiedź albo null', () => {
  assert.equal(telefonZTekstu('Luisa Möst, Berlin', '0157 80547308', 'DE'), SALTED);
  assert.equal(telefonZTekstu('Luisa Möst, Berlin', null, 'DE'), null);
});

test('POST /glob/parse-address: telefon z tekstu, nie z odpowiedzi modelu', async () => {
  // Podstawiony Anthropic: model oddaje przekręcony numer (jak 1.11.2026).
  const oryginal = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      cb(res);
      const odp = { name: 'Luisa Möst', street: 'Zeughofstraße', houseNumber: '20', postCode: '10997', city: 'Berlin', country: 'de', phone: '+49 157 805473080', email: null };
      res.emit('data', Buffer.from(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(odp) }] })));
      res.emit('end');
    };
    return req;
  };
  const env = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test';
  try {
    const router = require('../src/routes/glob-quote');
    const warstwa = router.stack.find(l => l.route && l.route.path === '/glob/parse-address' && l.route.methods.post);
    const wynik = await new Promise((resolve, reject) => {
      const res = { status() { return res; }, json: resolve };
      Promise.resolve(warstwa.route.stack[0].handle({ body: { text: 'Luisa Möst\nZeughofstraße 20, 10997 Berlin\nTel.: +4915780547308' } }, res, reject)).catch(reject);
    });
    assert.equal(wynik.ok, true);
    assert.equal(wynik.parsed.phone, SALTED);
    assert.equal(wynik.parsed.country, 'DE');
  } finally {
    https.request = oryginal;
    if (env === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = env;
  }
});
