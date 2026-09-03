/* siatka.js — wykrywa PRAWDZIWE poziome linie tabeli na stronie karty zlecenia.
 *
 * Powstalo, gdy recznie sprawdzalem sporne wiersze sierpnia 2026: model
 * "y0 + d * staly_krok" trafial przy dniu 2, a przy 21 wycinal juz sasiedni
 * wiersz. Zamiast dostrajac stala, mierzymy linie na KAZDEJ stronie osobno
 * (dopasowanie najmniejszymi kwadratami, wiec brakujace krawedzie nie psuja
 * wyniku) - to samo podejscie, co detectGrid przy kartach pracy.
 * Zweryfikowane na wszystkich 38 stronach teczki zlecen 8/2026.
 */
'use strict';
const sharp = require('sharp');

const X0 = 0.055, X1 = 0.815;   // kolumny: Dzien | Liczba godzin | Podpis

/** @returns {Promise<{W:number,H:number,linie:number[]}>} linie w pikselach, rosnaco */
async function linieTabeli(png) {
  const meta = await sharp(png).metadata();
  const { width: W, height: H } = meta;
  const left = Math.round(W * X0), szer = Math.round(W * (X1 - X0));
  const { data, info } = await sharp(png)
    .extract({ left, top: 0, width: szer, height: H })
    .greyscale().resize({ width: 700, kernel: 'lanczos3' })
    .raw().toBuffer({ resolveWithObject: true });

  const sw = info.width, sh = info.height;
  const ciemne = new Array(sh).fill(0);
  for (let y = 0; y < sh; y++) {
    let c = 0;
    for (let x = 0; x < sw; x++) if (data[y * sw + x] < 140) c++;
    ciemne[y] = c / sw;
  }
  /* Prog musi byc ruchomy: strona 9 jest lekko przekrzywiona i zadna linia nie
     jest ciemna na calej szerokosci naraz - przy stalym 0,6 wychodzilo ZERO linii.
     Schodzimy w dol, az znajdziemy sensowna liczbe krawedzi. */
  const zProgiem = (prog) => {
    const pasma = [];
    let start = -1;
    for (let y = 0; y < sh; y++) {
      if (ciemne[y] >= prog) { if (start < 0) start = y; }
      else if (start >= 0) { pasma.push((start + y - 1) / 2); start = -1; }
    }
    if (start >= 0) pasma.push((start + sh - 1) / 2);
    return pasma;
  };
  let pasma = [];
  let uzytyProg = null;
  for (const prog of [0.6, 0.5, 0.42, 0.35, 0.3, 0.25]) {
    pasma = zProgiem(prog);
    uzytyProg = prog;
    if (pasma.length >= 30) break;
  }

  // z powrotem do pikseli oryginalu
  const skala = H / sh;
  return { W, H, prog: uzytyProg, linie: pasma.map(y => y * skala) };
}

/**
 * Granice wiersza danego dnia. Zaklada, ze wykryte linie to kolejne krawedzie
 * wierszy tabeli; wiersz naglowka jest pierwszy, potem dni 1..31, potem SUMA.
 * @returns {{gora:number,dol:number}|null}
 */
function wierszDnia(linie, dzien, H) {
  /* Nie wymagamy KOMPLETU linii - na 5 z 38 stron kilku krawedzi nie widac.
     Zamiast szukac nieprzerwanego ciagu, dopasowujemy model y = a + b*k
     (k = numer krawedzi) metoda najmniejszych kwadratow: brakujace linie po
     prostu nie wnosza punktow, a reszta i tak wyznacza siatke. */
  if (linie.length < 15) return null;
  const odstepy = [];
  for (let i = 1; i < linie.length; i++) odstepy.push(linie[i] - linie[i - 1]);
  const posort = [...odstepy].sort((a, b) => a - b);
  const krok = posort[Math.floor(posort.length / 2)];
  if (!(krok > 5)) return null;

  const pkt = linie.map(y => ({ k: Math.round((y - linie[0]) / krok), y }));
  // odrzucamy krawedzie, ktore po zaokragleniu trafiaja w to samo k (grube linie)
  const wg = new Map();
  for (const p of pkt) if (!wg.has(p.k)) wg.set(p.k, p);
  const dane = [...wg.values()];
  if (dane.length < 12) return null;
  const n = dane.length;
  const sk = dane.reduce((s, p) => s + p.k, 0);
  const sy = dane.reduce((s, p) => s + p.y, 0);
  const skk = dane.reduce((s, p) => s + p.k * p.k, 0);
  const sky = dane.reduce((s, p) => s + p.k * p.y, 0);
  const b = (n * sky - sk * sy) / (n * skk - sk * sk);
  const a = (sy - b * sk) / n;
  if (!(b > 5)) return null;

  /* Zakotwiczenie: krawedz o indeksie 0 to GORA WIERSZA NAGLOWKA (~0,158 H,
     zmierzone: 552-556 px przy H=3496 na stronach z kompletem krawedzi).
     Wiersz dnia d lezy wiec miedzy krawedzia d a d+1 - nie d-1 a d, bo naglowek
     zjada pierwszy indeks. Ta jedynka kosztowala mnie dwa podejscia do wycinkow. */
  const CEL = 0.158 * H;
  let m = Math.round((CEL - a) / b);
  const gora = a + b * (m + dzien);
  const dol = gora + b;
  if (!(gora > 0 && dol < H)) return null;
  return { gora, dol, krok: b, ileLinii: dane.length, dopasowanie: Math.abs(a + b * m - CEL) / b };
}

module.exports = { linieTabeli, wierszDnia, X0, X1 };

if (require.main === module) {
  (async () => {
    const png = process.argv[2];
    const g = await linieTabeli(png);
    console.log('linii:', g.linie.length, 'H:', g.H);
    const w = wierszDnia(g.linie, Number(process.argv[3] || 1), g.H);
    console.log('wiersz:', w);
  })();
}
