'use strict';
/**
 * obrazy.js — z wyprostowanego skanu karty robi ZESTAW 4 OBRAZÓW dla modelu:
 *
 *   1. calaStrona   — kontekst: layout, parafki, dopiski, stopka (≤1,15 Mpx)
 *   2. naglowek     — miesiąc/rok, nazwisko, norma (duże piksele na odręczne nazwisko)
 *   3. gornaPolowka — nagłówki kolumn + dni 1–16 (wiersz ~54 px zamiast ~31 na całej stronie)
 *   4. dolnaPolowka — dni 16–31 + wiersz SUMA + pas pod tabelą
 *
 * Filozofia inna niż w core-api/src/karta-pracy.js (16 izolowanych wycinków):
 * tniemy WYŁĄCZNIE poziomo między wierszami, każdy wiersz zostaje CAŁY, kolumny
 * nietknięte — model widzi tabelę tak, jak widział ją czat, tylko w większych
 * pikselach. Jedyny zabieg: przycięcie prawej krawędzi do końca kolumny "Chor."
 * (dalej są puste rubryki) — to nie chirurgia kolumn, tylko zdjęcie martwego
 * marginesu, podnosi wiersz połówki z ~42 do ~54 px.
 *
 * Skalowanie robimy PO NASZEJ stronie (lanczos3), nie w API: API ma dwa limity
 * (1568 px dłuższego boku ORAZ ~1600 tok/obraz ≈ 1,15 Mpx przy tok=W*H/750)
 * i dla A4 wiąże ten tokenowy — nie oddajemy resamplingu nieznanemu filtrowi.
 *
 * detectGrid to KOPIA z karta-pracy.js (sprawdzona na produkcji). Nowość: brak
 * siatki NIE odrzuca strony — jest fallback na stałe ułamki wysokości z zakładką.
 */

const sharp = require('sharp');

const MPX = 1150000;          // budżet pikseli jednego obrazu (~1533 tokeny)
const ROWS = 32;              // 31 dni + wiersz SUMA
const CHOR_END = 0.8248;      // koniec kolumny "Chor." jako ułamek szerokości tabeli
const JAKOSC = 88;

/* ------------------------------------------------- detekcja siatki (kopia) */

function findLines(profile, minHits, minGap) {
  const hits = [];
  for (let i = 0; i < profile.length; i++) if (profile[i] >= minHits) hits.push(i);
  const groups = [];
  for (const x of hits) {
    const last = groups[groups.length - 1];
    if (last && x - last[last.length - 1] <= minGap) last.push(x);
    else groups.push([x]);
  }
  return groups.map(g => Math.round(g.reduce((a, b) => a + b, 0) / g.length));
}

/** wysokosc wiersza wynikajaca z geometrii formularza (ta sama, co w fallbacku) */
const oczekiwanaWysokoscWiersza = H => (H * 0.938 - H * 0.163) / ROWS;
const wysokoscWierszaSensowna = (rowH, H) =>
  rowH > oczekiwanaWysokoscWiersza(H) * 0.8 && rowH < oczekiwanaWysokoscWiersza(H) * 1.2;

async function detectGrid(png) {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const dark = (x, y) => data[y * W + x] < 200 ? 1 : 0;

  const yA = Math.round(H * 0.16), yB = Math.round(H * 0.93);
  const colProfile = new Array(W).fill(0);
  for (let y = yA; y < yB; y += 2) for (let x = 0; x < W; x++) colProfile[x] += dark(x, y);
  let left = null, right = null;
  for (const frac of [0.55, 0.45, 0.35, 0.28]) {
    const vs = findLines(colProfile, (yB - yA) / 2 * frac, 8)
      .filter(x => x < W * 0.15 || x > W * 0.85);
    if (vs.length >= 2 && vs[vs.length - 1] - vs[0] >= W * 0.7) {
      left = vs[0]; right = vs[vs.length - 1]; break;
    }
  }
  if (left === null) throw new Error('nie znalazlem ramki tabeli');
  const tw = right - left;

  const xA = left + Math.round(tw * 0.02), xB = left + Math.round(tw * 0.60);
  const rowProfile = new Array(H).fill(0);
  for (let x = xA; x < xB; x += 2) for (let y = 0; y < H; y++) rowProfile[y] += dark(x, y);
  let hs = [];
  for (const frac of [0.55, 0.45, 0.35, 0.28]) {
    hs = findLines(rowProfile, (xB - xA) / 2 * frac, 6).filter(y => y > H * 0.13);
    if (hs.length >= 20) break;
  }
  if (hs.length < 10) throw new Error('nie znalazlem siatki wierszy');

  // mediana odstępów — odporna na zabłąkaną linię stopki (patrz karta-pracy.js)
  const top = hs[0], bottom = hs[hs.length - 1];
  const odstepy = [];
  for (let i = 1; i < hs.length; i++) odstepy.push(hs[i] - hs[i - 1]);
  const zgrubna = (bottom - top) / ROWS;
  const sensowne = odstepy.filter(d => d > zgrubna * 0.7 && d < zgrubna * 1.4).sort((a, b) => a - b);
  const rowH = sensowne.length >= 5 ? sensowne[Math.floor(sensowne.length / 2)] : zgrubna;

  /* KONTROLA ZDROWEGO ROZSADKU: wiersz karty ma znana wysokosc wzgledem strony
     (formularz jest zawsze ten sam), wiec zmierzona wartosc musi sie w nia
     trafic. Bez tego przekrzywiona strona daje siatke, ktora WYGLADA na dobra:
     rozmazane linie mnoza sie w profilu, mediana odstepow spada i mamy cicho
     zla geometrie. Stajnia 8/2026 str.8 (Wojcik, przekrzywienie 1 stopien):
     rowH 53,2 px zamiast 84 jak na pozostalych siedmiu kartach - polowki byly
     ciete nie tam, gdzie trzeba, a `bladSiatki` pokazywal null.
     Rzut tutaj oznacza zejscie na siatke z ulamkow (ta sama geometria, tylko
     bez pomiaru) i - co wazniejsze - zostawia slad w metadanych. */
  if (!wysokoscWierszaSensowna(rowH, H)) {
    throw new Error(`wysokosc wiersza ${rowH.toFixed(1)} px odbiega od oczekiwanej `
      + `${oczekiwanaWysokoscWiersza(H).toFixed(1)} px - strona zapewne przekrzywiona, siatka niepewna`);
  }

  return { W, H, left, right, tw, top, rowH, metoda: 'siatka' };
}

/** Fallback bez siatki: stałe ułamki wysokości strony, zmierzone na formularzu.
 *  Mniej precyzyjne, ale połówki mają zakładkę 2 wierszy — nic nie ginie. */
function siatkaZUlamkow(W, H) {
  const top = Math.round(H * 0.163);
  const rowH = (H * 0.938 - top) / ROWS;
  return { W, H, left: Math.round(W * 0.028), right: Math.round(W * 0.972),
    tw: Math.round(W * 0.944), top, rowH, metoda: 'fallback-ulamki' };
}

/* --------------------------------------------------- drugi formularz: zlecenie
 * Karta zlecenia ma INNĄ geometrię niż karta pracy: tabela zajmuje y 0,158-0,727
 * wysokości strony i x 0,09-0,79 (zmierzone na wszystkich 38 kartach sierpnia
 * 2026, rozrzut ±0,002). Nie używamy tu `detectGrid`: kontrola geometrii jest
 * skrojona pod proporcje karty pracy i słusznie odrzuciłaby ten formularz.
 * Ułamki są stabilne, bo to ten sam wydruk co miesiąc. */
const ZLEC = { y0: 0.150, y1: 0.735, x0: 0.055, x1: 0.815, srodek: 0.45 };

async function obrazyZlecenia(png) {
  const m = await sharp(png).metadata();
  const { width: W, height: H } = m;
  const wytnij = (a, b) => {
    const top = Math.max(0, Math.round(H * a));
    const wys = Math.min(H - top, Math.round(H * (b - a)));
    const left = Math.max(0, Math.round(W * ZLEC.x0));
    const szer = Math.min(W - left, Math.round(W * (ZLEC.x1 - ZLEC.x0)));
    return sharp(png).extract({ left, top, width: szer, height: wys });
  };
  const [cala, nag, gora, dol] = await Promise.all([
    zmiesc(png),
    zmiesc(sharp(png).extract({ left: 0, top: 0, width: W, height: Math.round(H * 0.16) })),
    zmiesc(wytnij(ZLEC.y0, ZLEC.srodek + 0.02)),      // naglowek kolumn + dni 1-16
    zmiesc(wytnij(ZLEC.srodek - 0.02, ZLEC.y1)),      // dni 16-31 + wiersz SUMA
  ]);
  return {
    calaStrona: cala.jpeg.toString('base64'),
    naglowek: nag.jpeg.toString('base64'),
    gornaPolowka: gora.jpeg.toString('base64'),
    dolnaPolowka: dol.jpeg.toString('base64'),
    meta: { formularz: 'zlecenie', wymiary: {
      calaStrona: `${cala.szer}x${cala.wys}`, naglowek: `${nag.szer}x${nag.wys}`,
      gorna: `${gora.szer}x${gora.wys}`, dolna: `${dol.szer}x${dol.wys}` } },
  };
}

/**
 * PASKI WIERSZY — ten sam formularz zlecenia, ale pokrojony na waskie paski
 * po kilka wierszy, kazdy POWIEKSZONY.
 *
 * Po co: model myli cyfry (5/6, 8/9, 2/3) nie dlatego, ze patrzy w zle miejsce,
 * tylko dlatego, ze dostaje ich za malo w pikselach. Zmierzone na sierpniu 2026:
 * przy podziale na polowki tabeli jeden wiersz to ~96 tokenow obrazu; gdy
 * czytalem recznie pojedyncze wiersze w powiekszeniu, bylo ich ~440 — i wtedy
 * te same cyfry czytaly sie bez pomylek. 8 z 15 blednych dni to byly wlasnie
 * czyste pomylki cyfr.
 *
 * Granice wierszy bierzemy z PRAWDZIWYCH linii tabeli (siatka.js), a nie ze
 * stalego kroku — stala dryfuje i przy dniu 21 pasek zaczyna sie na sasiednim
 * wierszu.
 *
 * @param {Buffer} png            strona w 300 dpi
 * @param {number} wierszyNaPasek ile dni na jednym obrazie
 * @param {number} szerokosc      docelowa szerokosc paska w px (powiekszenie)
 */
const PASEK_DLUGI_BOK = 2576;   // maks. dluzszy bok dla klasy wysokiej rozdzielczosci
/* PELNA szerokosc tabeli. Pierwsza wersja obcinala do 0,62, zeby nie placic
   tokenami za bialy margines — i na karcie Lugowskiego zepsula trzy dni:
   model przestal przepisywac liczbe dopisana po prawej stronie rubryki.
   Pasek NIE byl ucieta (sprawdzone na obrazie), wiec winny byl prompt, ktory
   uprzedzal o przycieciu. Wniosek: nie opisuj modelowi ograniczenia, tylko go
   nie twórz. Pelna szerokosc daje ~300 tokenow na wiersz zamiast ~414, wciaz
   trzy razy wiecej niz polowki. */
const PASEK_X0 = 0.055, PASEK_X1 = 0.815;

async function obrazyZleceniaPaski(png, { wierszyNaPasek = 4, dlugiBok = PASEK_DLUGI_BOK,
  x0 = PASEK_X0, x1 = PASEK_X1 } = {}) {
  const { linieTabeli, wierszDnia } = require('./siatka');
  const g = await linieTabeli(png);
  const pierwszy = wierszDnia(g.linie, 1, g.H);
  if (!pierwszy) throw new Error('nie wykryto siatki tabeli');

  /* Szerokosc: obcinamy PUSTA prawa czesc kolumny podpisu. Tokeny obrazu to
     platki 28x28, a dluzszy bok jest przycinany przez API do 2576 px — kazdy
     px zmarnowany na pustke to px odebrany cyfrom. Zostawiamy poczatek kolumny
     podpisu, bo na czesci kart to TAM czlowiek wpisuje liczbe godzin. */
  const left = Math.round(g.W * x0);
  const szer = Math.round(g.W * (x1 - x0));
  const paski = [];
  for (let od = 1; od <= 32; od += wierszyNaPasek) {
    const doo = Math.min(32, od + wierszyNaPasek - 1);      // 32 = wiersz SUMA
    const a = wierszDnia(g.linie, od, g.H);
    const b = wierszDnia(g.linie, doo, g.H);
    if (!a || !b) continue;
    const top = Math.max(0, Math.round(a.gora - a.krok * 0.2));
    const dol = Math.min(g.H, Math.round(b.dol + b.krok * 0.2));
    /* Powiekszamy DO limitu API, nie ponad: powyzej 2576 px na dluzszym boku
       serwis i tak skaluje w dol, wiec wieksze pliki to sam transfer bez zysku. */
    const wysZrodla = dol - top;
    const skala = dlugiBok / Math.max(szer, wysZrodla);
    const buf = await sharp(png)
      .extract({ left, top, width: szer, height: wysZrodla })
      .resize({ width: Math.round(szer * skala), kernel: 'lanczos3' })
      .normalise().sharpen()
      .jpeg({ quality: JAKOSC, mozjpeg: true }).toBuffer();
    paski.push({ od, doo, jpeg: buf });
  }
  const nag = await zmiesc(sharp(png).extract({
    left: 0, top: 0, width: g.W, height: Math.round(g.H * 0.16),
  }));
  return {
    naglowek: nag.jpeg.toString('base64'),
    paski: paski.map(p => ({ od: p.od, do: p.doo, obraz: p.jpeg.toString('base64') })),
    meta: {
      formularz: 'zlecenie-paski',
      wierszyNaPasek, dlugiBok, x0, x1,
      pasków: paski.length,
      krokWiersza: Math.round(pierwszy.krok),
    },
  };
}

/* ---------------------------------------------------------------- składanie */

async function zmiesc(bufOrSharp, maxPx = MPX) {
  const s = Buffer.isBuffer(bufOrSharp) ? sharp(bufOrSharp) : bufOrSharp;
  const buf = await s.jpeg({ quality: JAKOSC, mozjpeg: true }).toBuffer();
  const m = await sharp(buf).metadata();
  const area = m.width * m.height;
  if (area <= maxPx) return { jpeg: buf, szer: m.width, wys: m.height, skala: 1 };
  const skala = Math.sqrt(maxPx / area);
  const w = Math.round(m.width * skala);
  const out = await sharp(buf).resize({ width: w, kernel: 'lanczos3' })
    .normalise().jpeg({ quality: JAKOSC, mozjpeg: true }).toBuffer();
  const m2 = await sharp(out).metadata();
  return { jpeg: out, szer: m2.width, wys: m2.height, skala };
}

/**
 * @param {Buffer} png wyprostowany render strony
 * @returns {{calaStrona, naglowek, gornaPolowka, dolnaPolowka: string(base64), meta}}
 */
async function przygotujObrazy(png) {
  const m = await sharp(png).metadata();
  const { width: W, height: H } = m;
  let g;
  try { g = await detectGrid(png); }
  catch (e) { g = siatkaZUlamkow(W, H); g.blad = e.message; }

  const y = i => Math.round(g.top + i * g.rowH);
  const xL = Math.max(0, g.left - 6);
  const xR = Math.min(W, Math.round(g.left + CHOR_END * g.tw) + 8);

  // cała strona — kontekst
  const cala = await zmiesc(png);

  // nagłówek: od góry strony do górnej krawędzi tabeli (drukowany tekst + odręczne nazwisko)
  const nagH = Math.max(60, g.top);
  const nag = await zmiesc(sharp(png).extract({ left: 0, top: 0, width: W, height: Math.min(nagH, H) })
    .resize({ width: Math.min(1400, W), withoutEnlargement: true }));

  // połówki tabeli: tylko cięcie POZIOME, wiersze całe, z nagłówkami kolumn i zakładką
  const gTop = Math.max(0, y(0) - Math.round(g.rowH * 1.7));   // + wiersz nagłówków kolumn
  const gBot = Math.min(H, y(16) + Math.round(g.rowH * 0.2));
  const dTop = Math.max(0, y(15) - Math.round(g.rowH * 0.2));  // zakładka: dzień 16 w obu
  const dBot = Math.min(H, y(ROWS) + Math.round(g.rowH * 1.4)); // + SUMA i pas pod tabelą

  const gorna = await zmiesc(sharp(png).extract({ left: xL, top: gTop, width: xR - xL, height: gBot - gTop }));
  const dolna = await zmiesc(sharp(png).extract({ left: xL, top: dTop, width: xR - xL, height: dBot - dTop }));

  return {
    calaStrona: cala.jpeg.toString('base64'),
    naglowek: nag.jpeg.toString('base64'),
    gornaPolowka: gorna.jpeg.toString('base64'),
    dolnaPolowka: dolna.jpeg.toString('base64'),
    meta: {
      metoda: g.metoda, bladSiatki: g.blad || null,
      rowH: +g.rowH.toFixed(1),
      pxWierszaPolowki: +(g.rowH * gorna.skala).toFixed(1),
      wymiary: {
        calaStrona: `${cala.szer}x${cala.wys}`,
        naglowek: `${nag.szer}x${nag.wys}`,
        gorna: `${gorna.szer}x${gorna.wys}`,
        dolna: `${dolna.szer}x${dolna.wys}`,
      },
    },
  };
}

/* ------------------------------------------------- dogrywka: zoom komórki */

// Udziały szerokości tabeli zmierzone na formularzu (te same co w core-api
// karta-pracy.js — zweryfikowane wzrokowo na prawdziwych kartach).
const KOL = 0.05847;
const KOLUMNY = {
  od:    [0.0395, 0.1110],
  do:    [0.2156, 0.2927],
  razem: [0.3960, 0.4738],
  sto:   [0.4738 + 2 * KOL, 0.4738 + 3 * KOL],
  nocne: [0.4738 + 3 * KOL, 0.4738 + 4 * KOL],
  uw:    [0.4738 + 4 * KOL, 0.4738 + 5 * KOL],
  chor:  [0.4738 + 5 * KOL, 0.4738 + 6 * KOL],
};

/**
 * Wycinek JEDNEJ komórki do dogrywki: [kolumna numeru dnia | rubryka], ×4.
 * Numer dnia jest w wycinku po to, żeby model POTWIERDZIŁ tożsamość wiersza —
 * niezgodność numeru unieważnia zoom (błąd cięcia, nie odczytu).
 * dzien: 1-31 albo 'SUMA' (wtedy bez kolumny dnia — wiersz SUMA nie ma numeru).
 */
async function wytnijKomorke(png, g, dzien, pole) {
  const [f0, f1] = KOLUMNY[pole] || KOLUMNY.razem;
  const y = i => Math.round(g.top + i * g.rowH);
  const x = f => Math.round(g.left + f * g.tw);
  const wiersz = dzien === 'SUMA' ? 31 : Number(dzien) - 1;
  const top = Math.max(0, y(wiersz) - Math.round(g.rowH * 0.12));
  const h = Math.min(g.H - top, Math.round(g.rowH * 1.24));
  const czesci = [];
  if (dzien !== 'SUMA') {
    czesci.push([Math.max(0, g.left - 4), x(0.0395) + 3]);   // kolumna numeru dnia
  }
  czesci.push([Math.max(0, x(f0) - 6), Math.min(g.W, x(f1) + 6)]);
  const kawalki = [];
  let szer = 0;
  for (const [x0, x1] of czesci) {
    kawalki.push({ input: await sharp(png).extract({ left: x0, top, width: x1 - x0, height: h }).toBuffer(),
      left: szer, top: 0 });
    szer += (x1 - x0) + 6;
  }
  const sklejka = await sharp({ create: { width: szer, height: h, channels: 3, background: '#fff' } })
    .composite(kawalki).png().toBuffer();
  return (await sharp(sklejka).resize({ width: szer * 4, kernel: 'lanczos3' })
    .normalise().sharpen().jpeg({ quality: 90, mozjpeg: true }).toBuffer()).toString('base64');
}

module.exports = { przygotujObrazy, obrazyZlecenia, obrazyZleceniaPaski, detectGrid, wytnijKomorke, zmiesc, oczekiwanaWysokoscWiersza, wysokoscWierszaSensowna, KOLUMNY };
