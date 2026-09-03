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

/* --- OCR jako trzeci glos (ocr-tabela.js) ------------------------------ */
const { tabelaZOcr, zapisKomorki } = require('../src/ocr-tabela');

test('OCR: slowa rozbite na znaki skladaja sie z powrotem w jedna liczbe', () => {
  // Vision potrafi zwrocic "8", "," i "5" jako trzy osobne slowa
  const slowa = [{ tekst: '8', x0: 10, x1: 20, y0: 0, y1: 10 },
    { tekst: ',', x0: 21, x1: 23, y0: 0, y1: 10 },
    { tekst: '5', x0: 24, x1: 34, y0: 0, y1: 10 }];
  assert.equal(zapisKomorki(slowa, 0, 50, -5, 15).tekst, '8,5');
});

test('OCR: liczba spoza rubryki nie wpada do sasiada', () => {
  const slowa = [{ tekst: '12', x0: 100, x1: 120, y0: 0, y1: 10 }];
  assert.equal(zapisKomorki(slowa, 0, 50, -5, 15).tekst, '', 'srodek slowa jest poza rubryka');
});

test('OCR: tabela z naszej siatki trafia liczby we wlasciwe dni i kolumny', () => {
  const g = { W: 1000, H: 3500, left: 30, right: 970, tw: 940, top: 570, rowH: 85 };
  const x = f => g.left + f * g.tw, y = i => g.top + i * g.rowH + g.rowH / 2;
  const slowa = [
    { tekst: '11', x0: x(0.41), x1: x(0.44), y0: y(0) - 5, y1: y(0) + 5 },      // dzien 1 RAZEM
    { tekst: '12,5', x0: x(0.41), x1: x(0.45), y0: y(14) - 5, y1: y(14) + 5 },  // dzien 15 RAZEM
    { tekst: '12,5', x0: x(0.60), x1: x(0.64), y0: y(14) - 5, y1: y(14) + 5 },  // dzien 15 100%
    { tekst: '195,5', x0: x(0.41), x1: x(0.46), y0: y(31) - 5, y1: y(31) + 5 }, // wiersz SUMA
  ];
  const t = tabelaZOcr(slowa, g, 31);
  assert.equal(t.dni[0].razem, '11');
  assert.equal(t.dni[14].razem, '12,5');
  assert.equal(t.dni[14].sto, '12,5', 'kolumna 100% ma trafic do pola sto');
  assert.equal(t.dni[1].razem, '', 'puste dni zostaja puste');
  assert.equal(t.suma, '195,5');
});

test('drugi czytelnik potwierdza sume i otwiera droge do auto (sciezka E)', () => {
  // pelny miesiac: 20 dni po 8 h = 160 h (norma sierpnia 2026), z pominieciem
  // 15 sierpnia - swieto ma wlasna regule i slusznie wstrzymuje karte bez wpisu 100%
  const dni = {}; const dniDrugiego = [];
  for (const d of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23]) {
    dni[d] = { od: '8:00', do: '16:00', razem: '8' };
    dniDrugiego.push({ d, wniosek: { razem: '8' } });
  }
  const drugi = { naglowek: { nazwisko: 'NIKOLA MALĄG', miesiac: '8', rok: '2026', norma: '160' },
    dni: dniDrugiego };
  const w = zszyjIKontroluj(karta(dni), { zapis: 'NIKOLA MALĄG' }, OKRES, 1, null, drugi);
  assert.ok(w.sciezki.zgodne.includes('drugiOdczyt'), 'zgodny drugi odczyt to sciezka dowodowa');
  assert.equal(w.C, 160);
  assert.equal(w.status, 'auto', 'sam drugi czytelnik wystarcza jako niezalezne potwierdzenie');
});

test('rozjazd z drugim czytelnikiem wstrzymuje karte (Woloch 8/2026 dzien 9)', () => {
  const dni = { 9: { od: '6:00', do: '15:30', razem: '8,5' } };
  const drugi = { naglowek: { nazwisko: 'NIKOLA MALĄG' },
    dni: [{ d: 9, wniosek: { razem: '9,5' } }] };
  const w = zszyjIKontroluj(karta(dni), { zapis: 'NIKOLA MALĄG' }, OKRES, 3, null, drugi);
  assert.notEqual(w.status, 'auto');
  assert.ok(w.sporne.some(s => s.dzien === 9 && /drugi czytelnik/.test(s.uwaga || '')));
});

/* --- drugi formularz: umowa zlecenie (zlecenia.js) --------------------- */
const zl = require('../src/zlecenia');

test('zlecenie: godziny licza sie z PRZEDZIALU, nie z liczby', () => {
  assert.equal(zl.godzinyDnia({ od: '7:00', do: '15:00', zapis: '7 00 - 15 00' }), 8);
  assert.equal(zl.godzinyDnia({ od: '', do: '', zapis: '7-15' }), 8, 'przedzial bez rozbicia tez');
  assert.equal(zl.godzinyDnia({ od: '', do: '', zapis: '8' }), 8, 'sama liczba, gdy ktos tak wpisal');
  assert.equal(zl.godzinyDnia({ od: '9:30', do: '17:00', zapis: '' }), 7.5);
  assert.equal(zl.godzinyDnia({ od: '', do: '', zapis: '' }), null);
});

test('zlecenie: nazwa miesiaca slownie jest rozumiana', () => {
  assert.equal(zl.numerMiesiaca('SIERPIEŃ'), 8);
  assert.equal(zl.numerMiesiaca('sierpien'), 8);
  assert.equal(zl.numerMiesiaca('8'), 8);
  assert.equal(zl.numerMiesiaca(''), null);
});

const kartaZl = (dni, extra = {}) => ({
  imieNazwisko: extra.nazwisko || 'JACEK SIENIUC', miesiac: 'SIERPIEŃ', rok: '2026',
  suma: extra.suma || '', uwagaOgolna: '',
  dni: dni.map(d => ({ d: String(d.d), zapis: d.zapis || '', od: d.od || '', do: d.do || '',
    podpis: 'tak', uwaga: '' })),
});

test('zlecenie: zgodni czytelnicy daja auto, a suma liczy sie z godzin', () => {
  const dni = [{ d: 1, od: '7:00', do: '15:00' }, { d: 3, od: '7:00', do: '15:00' }];
  const w = zl.walidujZlecenie(kartaZl(dni), kartaZl(dni), { rok: 2026, miesiac: 8 }, 1);
  assert.equal(w.godziny, 16);
  assert.equal(w.status, 'auto');
});

test('zlecenie: rozjazd godzin miedzy czytelnikami wstrzymuje karte', () => {
  const a = [{ d: 1, od: '7:00', do: '15:00' }];
  const b = [{ d: 1, od: '7:00', do: '16:00' }];
  const w = zl.walidujZlecenie(kartaZl(a), kartaZl(b), { rok: 2026, miesiac: 8 }, 1);
  assert.equal(w.status, 'do_weryfikacji');
  assert.ok(w.sporne.some(s => s.dzien === 1));
});

test('zlecenie: literowka w nazwisku NIE blokuje, suma decyduje', () => {
  const dni = [{ d: 1, od: '7:00', do: '15:00' }];
  const w = zl.walidujZlecenie(kartaZl(dni), kartaZl(dni, { nazwisko: 'JACEK SIENIUK' }),
    { rok: 2026, miesiac: 8 }, 1);
  assert.equal(w.status, 'auto', 'godziny sie zgadzaja, wiec karta przechodzi');
  assert.ok(w.ostrzezenia.some(o => /nazwisko/.test(o)), 'ale obie wersje ida do sladu');
});

test('zlecenie: wypelniony wiersz SUMA jest darmowa kontrola', () => {
  const dni = [{ d: 1, od: '7:00', do: '15:00' }];
  const w = zl.walidujZlecenie(kartaZl(dni, { suma: '10' }), kartaZl(dni), { rok: 2026, miesiac: 8 }, 1);
  assert.ok(w.sporne.some(s => s.dzien === 'SUMA'), 'suma z karty rozni sie od sumy dni');
});
