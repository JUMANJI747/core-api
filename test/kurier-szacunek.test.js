'use strict';
// Cena kuriera przy składaniu zamówienia magazynu + bezpiecznik ceny
// (services/kurier-szacunek.js) i numery krajów GK (routes/glob-quote.js).
// 10.11.2026: paczka #5 do Włoch poszła za 138,94 zł zamiast 46,70 zł.
const test = require('node:test');
const assert = require('node:assert/strict');
const { szacujPaczke, limitCeny, zaDrogo, opisSzacunku } = require('../src/services/kurier-szacunek');

const linia = (name, qty, extra = {}) => ({ ean: 'x', name, qty, packaging: null, ...extra });

test('paczka jak w magazynie: 2 zatowarowane ekspozytory → karton „2x205”', () => {
  // zamówienia #6 i #7: magazyn wziął 37×27×38, 2,2 kg
  const items = [
    { ean: 'BOX-COLLECTION-30', name: 'Surf Collection Box', qty: 2, packaging: 'ekspozytor' },
    linia('SURF LIPS lip balm spf 50+', 24), linia('SURF GEL extreme waterproof gel spf 50+', 12),
    linia('SURF DAILY protection spf 50', 12), linia('SURF CARE hydrating cream', 12),
    { ean: 'EKSPOZYTOR', name: 'Ekspozytor (pusty)', qty: 2, packaging: null },
  ];
  assert.deepEqual(szacujPaczke(items, 2.2), { dlugoscCm: 37, szerokoscCm: 27, wysokoscCm: 38, wagaKg: 2.2, szt: 60, ekspozytory: 2 });
});

test('paczka luzem: do 60 szt. mały karton, do 150 „205”, do 300 „2x205”', () => {
  const w = (szt) => { const p = szacujPaczke([linia('SURF STICK zinc stick spf 50+', szt)], szt / 30); return [p.dlugoscCm, p.szerokoscCm, p.wysokoscCm]; };
  assert.deepEqual(w(60), [29, 19, 10]);   // #4, #5
  assert.deepEqual(w(75), [37, 27, 18]);   // #2
  assert.deepEqual(w(120), [37, 27, 18]);  // #3
  assert.deepEqual(w(240), [37, 27, 38]);
  assert.deepEqual(w(600), [40, 40, 40]);
  assert.equal(szacujPaczke([linia('stick', 5)], 0.17).wagaKg, 0.5, 'waga nie mniejsza niż 0,5 kg');
});

test('bezpiecznik ceny: limit to 1,5× szacunku, ale co najmniej +25 zł', () => {
  assert.equal(limitCeny(46.70), 71.70);
  assert.equal(limitCeny(100), 150);
  assert.equal(limitCeny(0), null);
  assert.equal(zaDrogo(50.99, 46.70), false, 'trochę większy karton przechodzi');
  assert.equal(zaDrogo(138.94, 46.70), true, 'przypadek z 9.11 zostałby zatrzymany');
  assert.equal(zaDrogo(138.94, null), false, 'bez szacunku nie blokujemy');
});

test('opis szacunku: cena, przewoźnik, paczka; jedna oferta = ostrzeżenie', () => {
  const s = { cena: 46.7, przewoznik: 'FedEX', usluga: 'Paczka do 2kg Regional Economy', ofert: 6, inne: [{ przewoznik: 'DPD', cena: 59.31 }], paczka: { dlugoscCm: 29, szerokoscCm: 19, wysokoscCm: 10, wagaKg: 1.6 } };
  assert.equal(opisSzacunku(s), 'Kurier (szacunek): 46,70 zł — FedEX Paczka do 2kg Regional Economy (paczka ok. 29×19×10 cm, 1,6 kg); kolejne: DPD 59,31 zł');
  assert.match(opisSzacunku({ ...s, cena: 138.94, ofert: 1, inne: [] }), /138,94 zł.*UWAGA: GK podał tylko jedną ofertę/);
  assert.match(opisSzacunku({ blad: 'wycena: HTTP 502' }), /Nie udało się sprawdzić ceny kuriera/);
});

test('numery krajów GK: oficjalna lista wygrywa, heurystyka telefonowa tylko dopisuje', () => {
  const { scalMapeKrajow, skazonyKodKraju } = require('../src/routes/glob-quote')._test;
  // 29.06.2026: głosowanie po prefiksie +39 dało IT→41 („Włochy (wyspy)")
  assert.equal(scalMapeKrajow({ IT: 33, AT: 4 }, { IT: 41, XX: 7 }, null).IT, 33, 'bez listy GK heurystyka nie nadpisuje istniejących');
  assert.equal(scalMapeKrajow({ IT: 33 }, { XX: 7 }, null).XX, 7, 'ale dopisuje brakujące');
  assert.deepEqual(scalMapeKrajow({ IT: 41 }, { IT: 41 }, { IT: 33, IT2: 41 }), { IT: 33, IT2: 41 }, 'lista GK naprawia skażoną mapę');
  assert.equal(skazonyKodKraju({ IT: 41, IT2: 41 }, 'IT'), true);
  assert.equal(skazonyKodKraju({ IT: 33, IT2: 41 }, 'IT'), false);
  assert.equal(skazonyKodKraju({ ES: 14, ES2: 34, ES3: 286 }, 'ES'), false);
  assert.equal(skazonyKodKraju({ AT: 4 }, 'AT'), false);
});
