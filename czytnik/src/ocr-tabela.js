'use strict';
/**
 * ocr-tabela.js — słowa z OCR + NASZA siatka karty = niezależna tabela wartości.
 *
 * Google Vision umie sam wykrywać tabele, ale świadomie z tego nie korzystamy:
 * mapowanie „która liczba należy do którego dnia i której rubryki" jest sercem
 * całego odczytu i ma zostać po naszej stronie, gdzie jest zmierzone
 * (`obrazy.detectGrid`) i sprawdzone na korpusie. Od OCR bierzemy wyłącznie to,
 * w czym jest naprawdę niezależny: ROZPOZNANIE ZNAKÓW.
 *
 * Dzięki temu trzeci głos myli się inaczej niż model — a o to w nim chodzi.
 */

const { KOLUMNY } = require('./obrazy');

/** czy prostokąt słowa leży (środkiem) w prostokącie rubryki */
const wSrodku = (s, x0, x1, y0, y1) => {
  const sx = (s.x0 + s.x1) / 2, sy = (s.y0 + s.y1) / 2;
  return sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1;
};

/**
 * Skleja słowa leżące w jednej rubryce w jeden zapis. Vision tnie „8,5" bywa
 * na „8", „,", „5" — bez sklejania mielibyśmy trzy bezużyteczne kawałki.
 */
function zapisKomorki(slowa, x0, x1, y0, y1) {
  const w = slowa.filter(s => wSrodku(s, x0, x1, y0, y1)).sort((a, b) => a.x0 - b.x0);
  if (!w.length) return { tekst: '', pewnosc: null };
  const tekst = w.map(s => s.tekst).join('').replace(/\s+/g, '');
  const pewnosci = w.map(s => s.pewnosc).filter(p => p != null);
  return { tekst, pewnosc: pewnosci.length ? +(pewnosci.reduce((a, b) => a + b, 0) / pewnosci.length).toFixed(2) : null };
}

/**
 * @param {Array} slowa      wynik ocr-google.slowa()
 * @param {Object} g         siatka z obrazy.detectGrid
 * @param {number} dniWMies  ile dni ma miesiąc
 * @returns {{dni: Array<{d, razem, sto, nocne, pewnosc}>, suma: string}}
 *          kształt zgodny ze ślepą transkrypcją, żeby walidacja mogła
 *          porównywać jednym kodem
 */
function tabelaZOcr(slowa, g, dniWMies = 31) {
  const y = i => g.top + i * g.rowH;
  const x = f => g.left + f * g.tw;
  // rubryki są nieco „ciaśniejsze" niż linie siatki: liczba bywa pisana
  // na kresce, ale środek znaku prawie zawsze zostaje w swojej rubryce
  const margY = g.rowH * 0.08;

  const wiersz = (i) => {
    const y0 = y(i) + margY, y1 = y(i + 1) - margY;
    const out = { pewnosc: null };
    const pewnosci = [];
    for (const pole of ['razem', 'sto', 'nocne']) {
      const [f0, f1] = KOLUMNY[pole];
      const k = zapisKomorki(slowa, x(f0), x(f1), y0, y1);
      out[pole] = k.tekst;
      if (k.pewnosc != null) pewnosci.push(k.pewnosc);
    }
    if (pewnosci.length) out.pewnosc = +(pewnosci.reduce((a, b) => a + b, 0) / pewnosci.length).toFixed(2);
    return out;
  };

  const dni = [];
  for (let d = 1; d <= dniWMies; d++) {
    const w = wiersz(d - 1);
    dni.push({ d: String(d), razem: w.razem, sto: w.sto, nocne: w.nocne, pewnosc: w.pewnosc });
  }
  const suma = wiersz(31).razem;
  return { dni, suma };
}

module.exports = { tabelaZOcr, zapisKomorki };
