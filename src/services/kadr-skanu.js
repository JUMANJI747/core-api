'use strict';
/**
 * kadr-skanu.js — PRZYCIĘCIE SKANU DO TREŚCI i powiększenie do limitu API.
 *
 * Powód (raport BAR z 04.09.2026): paragon z drukarki termicznej zajmował 11%
 * kartki A4. Cały preprocessing (obrót, deskew, normalize) zostawiał go na
 * pełnej stronie, a `-resize '2000x2000<'` w ogóle nie działał na skanie A4
 * (znak `<` = powiększ tylko mniejsze). Model dostawał prawie białą kartkę
 * z drobnym drukiem i pomylił jedną cyfrę: 4523,29 zamiast 4529,29.
 *
 * Tokeny obrazu to płytki 28×28, a modele wysokiej rozdzielczości (4.7 i nowsze)
 * przycinają dłuższy bok do 2576 px; standardowe — do 1568. Każdy piksel bieli
 * to piksel odebrany cyfrom. Po przycięciu do treści i powiększeniu do limitu
 * tekst dostaje ~7× więcej pikseli.
 *
 * Wykrywanie treści: profil atramentu po wierszach i kolumnach z PROGIEM —
 * pojedyncza plamka (na skanie z 04.09 była brązowa kropka w rogu) nie może
 * rozciągnąć kadru na całą stronę. Kadrujemy tylko, gdy treść zajmuje wyraźnie
 * mniej niż stronę; przy pełnostronicowym dokumencie nic nie ruszamy.
 */

const sharp = require('sharp');

const DLUGI_BOK = 2576;          // limit klasy wysokiej rozdzielczości
const PROG_CIEMNY = 140;         // piksel < 140 (0-255) liczy się jako atrament
/* Dwa progi, bo jeden nie umie odróżnić plamki od cyfry:
   - OSTRY (2% linii ciemne) wyznacza RDZEŃ treści — pojedyncza kropka
     atramentu ani blada linia skanera go nie osiągną, wiersz tekstu tak,
   - ŁAGODNY (0,3%) służy tylko do ROZSZERZENIA rdzenia o to, co do niego
     przylega — skrajna cyfra w ostatniej kolumnie nie może zostać ścięta.
   Pierwsza wersja z jednym progiem 0,4% wciągała kropkę z rogu kartki
   i kadr rósł z 11% do 26% strony. */
const PROG_RDZENIA = 0.02;
const PROG_PRZYLEGANIA = 0.003;
const MAX_PRZERWA = 0.03;        // rozszerzanie toleruje przerwę do 3% wymiaru
const MARGINES = 0.015;          // zapas wokół treści
const KADRUJ_PONIZEJ = 0.70;     // kadruj tylko, gdy treść < 70% powierzchni strony

/** Rdzeń: skrajne indeksy linii ≥ PROG_RDZENIA. */
function rdzen(profil) {
  let od = -1, doo = -1;
  for (let k = 0; k < profil.length; k++) if (profil[k] >= PROG_RDZENIA) { if (od < 0) od = k; doo = k; }
  return od < 0 ? null : [od, doo];
}

/** Rozszerza [od, do] o przylegającą treść (≥ PROG_PRZYLEGANIA), tolerując krótkie przerwy. */
function rozszerz(profil, [od, doo]) {
  const przerwa = Math.max(2, Math.round(profil.length * MAX_PRZERWA));
  let k = od - 1, pusto = 0;
  while (k >= 0 && pusto <= przerwa) { if (profil[k] >= PROG_PRZYLEGANIA) { od = k; pusto = 0; } else pusto++; k--; }
  k = doo + 1; pusto = 0;
  while (k < profil.length && pusto <= przerwa) { if (profil[k] >= PROG_PRZYLEGANIA) { doo = k; pusto = 0; } else pusto++; k++; }
  return [od, doo];
}

function zakresTresci(profil) {
  const r = rdzen(profil);
  return r ? rozszerz(profil, r) : null;
}

/**
 * @param {Buffer} png  strona po obróceniu/wyprostowaniu
 * @returns {Promise<{png: Buffer, przyciete: boolean, udzialTresci: number, wymiary: string}>}
 */
async function kadrujDoTresci(png) {
  const meta = await sharp(png).metadata();
  const { width: W, height: H } = meta;

  // Profil liczymy na zmniejszonej kopii — chodzi o położenie, nie o szczegóły.
  const skala = Math.min(1, 900 / Math.max(W, H));
  const { data, info } = await sharp(png)
    .resize({ width: Math.max(1, Math.round(W * skala)), kernel: 'nearest' })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;

  const wiersze = new Array(h).fill(0), kolumny = new Array(w).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x] < PROG_CIEMNY) { wiersze[y]++; kolumny[x]++; }
    }
  }
  const zy = zakresTresci(wiersze.map(v => v / w));
  const zx = zakresTresci(kolumny.map(v => v / h));
  if (!zy || !zx) {
    return { png, przyciete: false, udzialTresci: 0, wymiary: `${W}x${H}` };
  }

  const y0 = Math.max(0, Math.round((zy[0] / skala) - H * MARGINES));
  const y1 = Math.min(H, Math.round((zy[1] / skala) + H * MARGINES));
  const x0 = Math.max(0, Math.round((zx[0] / skala) - W * MARGINES));
  const x1 = Math.min(W, Math.round((zx[1] / skala) + W * MARGINES));
  const udzial = ((x1 - x0) * (y1 - y0)) / (W * H);

  let obraz = sharp(png);
  let przyciete = false;
  if (udzial < KADRUJ_PONIZEJ && (x1 - x0) > 50 && (y1 - y0) > 50) {
    obraz = obraz.extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 });
    przyciete = true;
  }
  /* Powiększamy DO limitu, nie ponad: powyżej 2576 px na dłuższym boku API i tak
     skaluje w dół, więc większy plik to sam transfer bez zysku. Zmniejszamy też
     strony większe niż limit — z tego samego powodu. */
  const szerK = przyciete ? (x1 - x0) : W;
  const wysK = przyciete ? (y1 - y0) : H;
  const s = DLUGI_BOK / Math.max(szerK, wysK);
  obraz = obraz.resize({
    width: Math.round(szerK * s),
    height: Math.round(wysK * s),
    kernel: 'lanczos3',
  });
  const out = await obraz.png().toBuffer();
  return {
    png: out, przyciete,
    udzialTresci: Math.round(udzial * 100) / 100,
    wymiary: `${Math.round(szerK * s)}x${Math.round(wysK * s)}`,
  };
}

module.exports = { kadrujDoTresci };
