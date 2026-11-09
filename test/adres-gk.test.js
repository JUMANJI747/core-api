'use strict';
// Weryfikacja adresu pod GlobKurier (services/adres-gk.js) — 9.11.2026,
// po auto-liście #5, który padł na „Via dell'Industria" / „(LI)".
const test = require('node:test');
const assert = require('node:assert/strict');
const { sprawdzOdbiorce, gkStreet, gkCity, gkName, numerGk } = require('../src/services/adres-gk');

test('przypadek #5: apostrof i skrót prowincji poprawione, adres przechodzi', () => {
  const w = sprawdzOdbiorce({
    name: 'Cantiere Navale Faccenda SRL - Manuela Bernini', street: "Via dell'Industria", houseNumber: 'SNC',
    postCode: '57016', city: 'Rosignano Marittimo (LI)', country: 'IT', phone: '+393356856257', email: 'shop@faccenda.it',
  });
  assert.deepEqual(w.bledy, []);
  assert.equal(w.adres.street, 'Via dell Industria');
  assert.equal(w.adres.city, 'Rosignano Marittimo');
  assert.equal(w.poprawki.length, 2);
  assert.match(w.ostrzezenia[0], /„Cantiere Navale Faccenda SRL -”/, 'ostrzega, że GK utnie nazwę');
});

test('pola GK: znaki spoza listy znikają, ukośnik w nazwie → myślnik, numer bez spacji', () => {
  assert.equal(gkStreet('C/ Mayor, 12'), 'C/ Mayor, 12');
  assert.equal(gkStreet('Rua D’Ouro "Velha" (fundos)'), 'Rua D Ouro Velha fundos');
  assert.equal(gkCity("L'Aquila (AQ)"), 'L Aquila');
  assert.equal(gkCity('Józefów'), 'Józefów');
  assert.equal(gkName('Surfstylefever / Stefan'), 'Surfstylefever - Stefan');
  assert.equal(numerGk('12 A.'), '12A');
});

test('poprawki: numer z ulicy, lokal osobno, kod PL z myślnikiem, telefon z kierunkowym', () => {
  const w = sprawdzOdbiorce({ name: 'WeWave', street: 'Fabryczna 6/10', postCode: '05077', city: 'Warszawa', country: 'pl', phone: '502 189 198' });
  assert.deepEqual(w.bledy, []);
  assert.deepEqual([w.adres.street, w.adres.houseNumber, w.adres.apartmentNumber, w.adres.postCode, w.adres.phone, w.adres.country],
    ['Fabryczna', '6', '10', '05-077', '+48502189198', 'PL']);
  assert.equal(w.poprawki.length, 4);
});

test('błędy, które GK odrzuci: zły kod, brak numeru domu, nieczytelny telefon, braki', () => {
  const zlyKod = sprawdzOdbiorce({ name: 'salted', street: 'Zeughofstraße', houseNumber: '20', postCode: '1099', city: 'Berlin', country: 'DE', phone: '+4915780547308' });
  assert.deepEqual(zlyKod.bledy, ['kod pocztowy „1099” nie pasuje do DE (5 cyfr)']);
  const bezNumeru = sprawdzOdbiorce({ name: 'X', street: 'Via Roma', postCode: '00100', city: 'Roma', country: 'IT', phone: '+39 06 1234 5678' });
  assert.match(bezNumeru.bledy[0], /numer domu \(gdy budynek nie ma numeru: SNC albo bn\)/);
  const tel = sprawdzOdbiorce({ name: 'X', street: 'Calle Mayor', houseNumber: '1', postCode: '28001', city: 'Madrid', country: 'ES', phone: '12' });
  assert.match(tel.bledy[0], /telefon „12” nieczytelny/);
  const pusty = sprawdzOdbiorce({});
  assert.match(pusty.bledy[0], /^brakuje: nazwa, ulica, numer domu .*kod pocztowy, miasto, telefon$/);
});

test('ostrzeżenia nie blokują: telefon spoza kraju, zły e-mail', () => {
  const w = sprawdzOdbiorce({ name: 'Shop', street: 'Hauptstraße', houseNumber: '5', postCode: '10115', city: 'Berlin', country: 'DE', phone: '+48 502 189 198', email: 'shop@' });
  assert.deepEqual(w.bledy, []);
  assert.equal(w.ostrzezenia.length, 2);
  assert.equal(w.adres.email, '');
});
