'use strict';
/**
 * Testy walidacji — `npm test` (node:test, 0 zależności, 0 wywołań API).
 *
 * Każdy test tutaj powstał z KONKRETNEJ wpadki na prawdziwych kartach, nie
 * z wyobraźni. Nazwa testu mówi, co poszło nie tak i kiedy.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { zszyjIKontroluj } = require('../src/walidacja');

const LISTA = ['Nikola Maląg', 'Paulina Biziewska'];

/** minimalna karta: dni {numer: {od, do, razem, ...}} */
function karta(dni, extra = {}) {
  const pusty = { od: '', do: '', razem: '', sto: '', nocne: '', uw: '', chor: '', kod: '', notatka: '' };
  return {
    naglowek: { nazwisko: extra.nazwisko || 'NIKOLA MALĄG', miesiac: '8', rok: '2026', norma: '160' },
    dni: Array.from({ length: 31 }, (_, i) => {
      const d = i + 1;
      const w = dni[d] || {};
      return {
        d,
        zapis: { ...pusty, ...w },
        wniosek: { razem: w.razem ?? '', sto: w.sto ?? '', nocne: w.nocne ?? '',
          uw: w.uw ?? '', chor: w.chor ?? '', kod: w.kod ?? '' },
        pewnosc: 'wysoka', uwaga: '',
      };
    }),
    suma: { zapis: { razem: '', sto: '', nocne: '', uw: '', chor: '' },
      wniosek: { razem: extra.suma ?? '', sto: '', nocne: '', uw: '', chor: '' },
      pewnosc: 'wysoka', uwaga: '' },
    rozbieznosci: [],
  };
}

const OKRES = { rok: 2026, miesiac: 8, nazwiska: LISTA, domyslnaStawkaDnia: 8, zrodloGodzin: 'odDo' };
const slepa = dni => ({ dni: Object.entries(dni).map(([d, w]) => ({ d, razem: String(w.razem ?? '') })), suma: '' });

test('praca w swieto bez wpisu 100% wstrzymuje karte (Malag 8/2026: zgubione 12,5 h)', () => {
  const dni = { 14: { od: '11:00', do: '22:00', razem: '11' },
    15: { od: '9:30', do: '22:00', razem: '12,5' } };   // 15.08 = swieto, kolumna 100% pusta
  const w = zszyjIKontroluj(karta(dni), { zapis: 'NIKOLA MALĄG' }, OKRES, 10, slepa(dni));
  assert.notEqual(w.status, 'auto', 'karta z praca w swieto bez 100% nie moze przejsc automatem');
  assert.ok(w.sporne.some(s => s.pole === '100%' && s.dzien === 15),
    'brakujaca setka ma byc polem spornym, nie samym ostrzezeniem');
});

test('praca w swieto Z wpisem 100% nie budzi alarmu', () => {
  const dni = { 14: { od: '11:00', do: '22:00', razem: '11' },
    15: { od: '9:30', do: '22:00', razem: '12,5', sto: '12,5' } };
  const w = zszyjIKontroluj(karta(dni), { zapis: 'NIKOLA MALĄG' }, OKRES, 10, slepa(dni));
  assert.equal(w.sporne.filter(s => s.pole === '100%').length, 0);
  // 11 h (dzien 14) + 12,5 h (dzien 15) + 12,5 h ze 100% = 36 h.
  // Setka DOLICZA sie do godzin - regula od uzytkownika: "tam gdzie jest
  // kolumna 100% to tez dodajemy do godzin".
  assert.equal(w.C, 36, 'C = godziny z dni + 100%');
});

test('kod PZ (praca zdalna) z godzinami to praca, nie konflikt (Biziewska 8/2026: 19 falszywych problemow)', () => {
  const dni = { 5: { od: '9:00', do: '18:00', razem: '9', kod: 'PZ' },
    6: { od: '9:00', do: '15:30', razem: '6,5', kod: 'PZ' } };
  const w = zszyjIKontroluj(karta(dni, { nazwisko: 'PAULINA BIZIEWSKA' }),
    { zapis: 'PAULINA BIZIEWSKA' }, OKRES, 12, slepa(dni));
  assert.deepEqual(w.problemy.filter(p => /kod "PZ"/.test(p)), []);
  assert.equal(w.C, 15.5);
});

test('kod nieobecnosci razem z godzinami nadal jest problemem', () => {
  const dni = { 5: { od: '9:00', do: '18:00', razem: '9', kod: 'Uw' } };
  const w = zszyjIKontroluj(karta(dni), { zapis: 'NIKOLA MALĄG' }, OKRES, 10, slepa(dni));
  assert.ok(w.problemy.some(p => /kod "Uw"/.test(p)));
});
