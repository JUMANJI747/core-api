'use strict';

/* CENA KURIERA WIDOCZNA PRZED ZAMÓWIENIEM + BEZPIECZNIK CENY (10.11.2026).
 *
 * Auto-list zamawiał najtańszą ofertę dopiero po spakowaniu i nikt nie widział
 * ceny: paczka do Włoch (9.11, #5) poszła za 138,94 zł zamiast ~47 zł, bo
 * system miał zły numer kraju („Włochy (wyspy)") i GK oddał jedną, drogą
 * ofertę. Właściciel: „system powinien sprawdzać wycenę wcześniej i mi
 * pokazywać przy składaniu zamówienia".
 *
 * Tu są części czyste (bez sieci):
 *  - `szacujPaczke(items, wagaKg)` — karton, jaki magazyn zwykle bierze
 *    (z historii zamówień #2–#7), zanim sam go wybierze,
 *  - `limitCeny` / `zaDrogo` — auto-list NIE zamawia, gdy cena przy pakowaniu
 *    jest wyraźnie wyższa niż pokazana właścicielowi przy składaniu,
 *  - `opisSzacunku` — jedno zdanie dla człowieka.
 * Wycenę w GK robi routes/magazyn.js (wycenKuriera). */

const EAN_EKSPOZYTORA = 'EKSPOZYTOR';

/** Sztuki towaru (bez nagłówków boxów i pustych ekspozytorów) oraz liczba
 *  zatowarowanych ekspozytorów. `items` w kształcie WarehouseOrderItem. */
function policz(items) {
  let szt = 0;
  let ekspozytory = 0;
  for (const i of items || []) {
    const qty = Number(i.qty) || 0;
    if (i.packaging) { if (i.packaging === 'ekspozytor') ekspozytory += qty; continue; }
    if (i.ean === EAN_EKSPOZYTORA || /ekspozytor.*pusty/i.test(String(i.name || ''))) continue;
    szt += qty;
  }
  return { szt, ekspozytory };
}

/* Kartony z praktyki magazynu: „pud/164" 29×19×10 (do 60 szt. luzem),
 * „205" 37×27×18 (do ~150 szt. albo 1 zatowarowany ekspozytor),
 * „2x205" 37×27×38 (2 ekspozytory albo do ~300 szt.). Powyżej — 40×40×40. */
function szacujPaczke(items, wagaKg) {
  const { szt, ekspozytory } = policz(items);
  let d;
  if (ekspozytory > 0) d = { dlugoscCm: 37, szerokoscCm: 27, wysokoscCm: Math.min(19 * ekspozytory, 76) };
  else if (szt <= 60) d = { dlugoscCm: 29, szerokoscCm: 19, wysokoscCm: 10 };
  else if (szt <= 150) d = { dlugoscCm: 37, szerokoscCm: 27, wysokoscCm: 18 };
  else if (szt <= 300) d = { dlugoscCm: 37, szerokoscCm: 27, wysokoscCm: 38 };
  else d = { dlugoscCm: 40, szerokoscCm: 40, wysokoscCm: 40 };
  const waga = Math.max(0.5, Math.ceil((Number(wagaKg) || 0) * 10) / 10);
  return { ...d, wagaKg: waga, szt, ekspozytory };
}

/** Najwyższa cena, przy której auto-list jeszcze zamawia sam: 1,5× szacunku,
 *  ale nie mniej niż szacunek + 25 zł (mały karton vs trochę większy to
 *  zwykle kilka–kilkanaście złotych różnicy). */
function limitCeny(szacunek) {
  const s = Number(szacunek);
  if (!(s > 0)) return null;
  return Math.round(Math.max(s * 1.5, s + 25) * 100) / 100;
}
function zaDrogo(cena, szacunek) {
  const limit = limitCeny(szacunek);
  return limit != null && Number(cena) > limit;
}

const zl = (n) => `${Number(n).toFixed(2).replace('.', ',')} zł`;

/** Jedno zdanie o szacunku — do komunikatów i dla Claude. */
function opisSzacunku(s) {
  if (!s) return '';
  if (s.blad) return `Nie udało się sprawdzić ceny kuriera: ${s.blad}`;
  const p = s.paczka || {};
  const paczka = p.dlugoscCm ? ` (paczka ok. ${p.dlugoscCm}×${p.szerokoscCm}×${p.wysokoscCm} cm, ${String(p.wagaKg).replace('.', ',')} kg)` : '';
  const inne = Array.isArray(s.inne) && s.inne.length ? `; kolejne: ${s.inne.map(o => `${o.przewoznik} ${zl(o.cena)}`).join(', ')}` : '';
  const jedna = s.ofert === 1 ? ' — UWAGA: GK podał tylko jedną ofertę, sprawdź adres i kraj' : '';
  return `Kurier (szacunek): ${zl(s.cena)} — ${s.przewoznik}${s.usluga ? ` ${s.usluga}` : ''}${paczka}${inne}${jedna}`;
}

module.exports = { szacujPaczke, limitCeny, zaDrogo, opisSzacunku, zl, policz, EAN_EKSPOZYTORA };
