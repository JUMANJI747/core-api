'use strict';
// Etykieta GK (24.11.2026): odmowa GlobKuriera ma dojść do panelu z treścią,
// a nie jako samo „HTTP 400" (paczka GK261124453398 do Czech).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { opisOdmowyGk } = require(path.join(__dirname, '..', 'src', 'routes', 'glob-orders'))._test;
const b = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x));

test('opisOdmowyGk: message, error, errors/fields (obiekt i lista), HTML, pusto', () => {
  assert.equal(opisOdmowyGk(b({ message: 'Etykieta nie jest jeszcze dostępna' })), 'Etykieta nie jest jeszcze dostępna');
  assert.equal(opisOdmowyGk(b({ error: 'Order not found' })), 'Order not found');
  assert.equal(opisOdmowyGk(b({ message: 'Błąd walidacji', fields: { 'orderHashes[0]': 'Brak etykiety' } })), 'Błąd walidacji; orderHashes[0]: Brak etykiety');
  assert.equal(opisOdmowyGk(b({ errors: ['a', { message: 'b' }] })), 'a; b');
  assert.equal(opisOdmowyGk(b({ message: 'x', error: 'x' })), 'x', 'bez powtórzeń');
  assert.equal(opisOdmowyGk(b('<html><body>Bad   Request</body></html>')), 'Bad Request');
  assert.equal(opisOdmowyGk(b('')), '');
  assert.ok(opisOdmowyGk(b('x'.repeat(2000))).length <= 400);
});
