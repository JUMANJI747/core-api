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

test('jednostka przy liczbie ze slepego odczytu nie jest rozjazdem (stajnia 8/2026: "8.5h")', () => {
  const dni = { 15: { od: '8:00', do: '16:30', razem: '8,5' } };
  const slepaZJednostka = { dni: [{ d: '15', razem: '8.5h' }], suma: '' };
  const w = zszyjIKontroluj(karta(dni), { zapis: 'NIKOLA MALĄG' },
    { ...OKRES, zrodloGodzin: 'razem' }, 4, slepaZJednostka);
  assert.deepEqual(w.sporne.filter(s => /slepa transkrypcja/.test(s.uwaga || '')), [],
    '"8.5h" i 8,5 to ta sama liczba');
});

test('sufit z godzin obcinajacy na brzydki ulamek pyta o minuty (Zak 8/2026 dzien 20)', () => {
  const dni = { 20: { od: '9:40', do: '18:30', razem: '9' } };   // 8,83 h - nie polowka
  const w = zszyjIKontroluj(karta(dni), { zapis: 'NIKOLA MALĄG' },
    { ...OKRES, zrodloGodzin: 'razem' }, 3, slepa(dni));
  assert.ok(w.sporne.some(s => /minuty moga byc zle odczytane/.test(s.uwaga || '')));
});

test('sufit obcinajacy na rowna polowke nie budzi alarmu (normalna przerwa w stajni)', () => {
  const dni = { 20: { od: '8:00', do: '18:00', razem: '10' }, 21: { od: '8:00', do: '18:00', razem: '9,5' } };
  const w = zszyjIKontroluj(karta(dni), { zapis: 'NIKOLA MALĄG' },
    { ...OKRES, zrodloGodzin: 'razem' }, 3, slepa(dni));
  assert.deepEqual(w.sporne.filter(s => /minuty/.test(s.uwaga || '')), []);
  assert.equal(w.C, 19.5, 'odliczona przerwa jest normalna: liczy sie wpisane RAZEM');
});

/* --- geometria siatki (obrazy.js) ------------------------------------- */
const { oczekiwanaWysokoscWiersza, wysokoscWierszaSensowna } = require('../src/obrazy');

test('siatka z przekrzywionej strony jest odrzucana (stajnia 8/2026 str.8: rowH 53,2 zamiast 84)', () => {
  const H = 3524;                        // wysokosc renderu 300 dpi strony A4
  assert.ok(Math.abs(oczekiwanaWysokoscWiersza(H) - 85.3) < 1);
  assert.ok(wysokoscWierszaSensowna(84, H), 'proste karty maja przechodzic');
  assert.ok(wysokoscWierszaSensowna(85, H));
  assert.equal(wysokoscWierszaSensowna(53.2, H), false, 'zla geometria ma byc odrzucona');
});

test('slepy odczyt przesuniety o kolumne nie jest rozjazdem (Korejwo 8/2026: UW 12 h wpisane jako nocne)', () => {
  const dni = { 20: { uw: '12' }, 21: { uw: '12' } };
  const slepyZPrzesunieciem = { dni: [{ d: '20', razem: '', sto: '', nocne: '12' },
    { d: '21', razem: '', sto: '', nocne: '12' }], suma: '' };
  const w = zszyjIKontroluj(karta(dni), { zapis: 'NIKOLA MALĄG' }, OKRES, 11, slepyZPrzesunieciem);
  assert.deepEqual(w.sporne.filter(s => s.pole === 'nocne'), [],
    'wartosc rowna sasiedniej rubryce to pomylka kolumny, nie rozjazd odczytu');
  assert.ok(w.ostrzezenia.some(o => /pomylil kolumne/.test(o)), 'ale ma zostac slad w ostrzezeniach');
});

test('prawdziwy rozjazd w kolumnie 100% nadal wstrzymuje karte (Malag 8/2026: zgubione 12,5 h)', () => {
  const dni = { 15: { od: '11:00', do: '23:30', razem: '12,5' } };   // glowny nie widzi 100%
  const slepyZeSetka = { dni: [{ d: '15', razem: '12.5', sto: '12.5', nocne: '' }], suma: '' };
  const w = zszyjIKontroluj(karta(dni), { zapis: 'NIKOLA MALĄG' }, OKRES, 10, slepyZeSetka);
  assert.ok(w.sporne.some(s => s.pole === '100%' && s.dzien === 15));
});
