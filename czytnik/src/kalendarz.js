'use strict';
/**
 * kalendarz.js — święta ustawowe i wymiar czasu pracy (art. 130 KP).
 * KOPIA z core-api/src/karty-pracy-odczyt.js — Czytnik ma być samodzielny,
 * bez importów z core-api (osobny serwis, osobny deploy, docelowo osobne repo).
 */

function wielkanoc(r) {
  const a = r % 19, b = Math.floor(r / 100), c = r % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return new Date(Date.UTC(r, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1));
}
const plusDni = (d, n) => new Date(d.getTime() + n * 86400000);

function swietaRoku(rok) {
  const w = wielkanoc(rok);
  return [new Date(Date.UTC(rok, 0, 1)), new Date(Date.UTC(rok, 0, 6)), w, plusDni(w, 1),
    new Date(Date.UTC(rok, 4, 1)), new Date(Date.UTC(rok, 4, 3)), plusDni(w, 49), plusDni(w, 60),
    new Date(Date.UTC(rok, 7, 15)), new Date(Date.UTC(rok, 10, 1)), new Date(Date.UTC(rok, 10, 11)),
    new Date(Date.UTC(rok, 11, 25)), new Date(Date.UTC(rok, 11, 26))];
}
const swietaMiesiaca = (rok, m) => swietaRoku(rok)
  .filter(d => d.getUTCFullYear() === rok && d.getUTCMonth() === m - 1).map(d => d.getUTCDate());

/** art. 130 KP: 8 h x dni pn-pt minus 8 h za kazde swieto w dniu innym niz niedziela */
function wymiarCzasuPracy(rok, mies) {
  const dni = new Date(Date.UTC(rok, mies, 0)).getUTCDate();
  let rob = 0;
  for (let d = 1; d <= dni; d++) {
    const w = new Date(Date.UTC(rok, mies - 1, d)).getUTCDay();
    if (w >= 1 && w <= 5) rob++;
  }
  const obn = swietaRoku(rok)
    .filter(d => d.getUTCFullYear() === rok && d.getUTCMonth() === mies - 1 && d.getUTCDay() !== 0).length;
  return rob * 8 - obn * 8;
}

/** Formularz nie ma rubryki roku — bierzemy najświeższy rok, w którym miesiąc się skończył. */
function domyslnyRok(miesiac, dzisiaj = new Date()) {
  const r = dzisiaj.getUTCFullYear();
  const koniecMiesiaca = new Date(Date.UTC(r, miesiac, 0, 23, 59, 59));
  return koniecMiesiaca <= dzisiaj ? r : r - 1;
}

const dniMiesiaca = (rok, mies) => new Date(Date.UTC(rok, mies, 0)).getUTCDate();

module.exports = { wielkanoc, swietaRoku, swietaMiesiaca, wymiarCzasuPracy, domyslnyRok, dniMiesiaca };
