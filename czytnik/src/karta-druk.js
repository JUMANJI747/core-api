'use strict';
/**
 * karta-druk.js — PUSTE karty ewidencji czasu pracy gotowe do wydruku.
 *
 * Druga strona Czytnika: zanim zaczniemy karty czytać, musimy je najpierw
 * rozdać. Do tej pory Ala co miesiąc otwierała wzór w Excelu, wpisywała ręcznie
 * miesiąc, nazwisko i wymiar godzin, i drukowała — dla każdego pracownika
 * osobno. Tutaj robi to jedno wywołanie: PDF z kartami dla całej listy na
 * kilka miesięcy do przodu.
 *
 * WZÓR NIE JEST PRZEPISANY Z PALCA. `assets/karta-wzor.json` powstał z
 * oryginalnego pliku kadrowego (Karta_ewid.cz._pr.obowiazuje_OK.xls, arkusz
 * „Wzór") przez `narzedzia/wzor-do-json.py` — mamy stamtąd szerokości kolumn,
 * wysokości wierszy, scalenia, teksty, czcionki i ramki co do komórki. Renderer
 * poniżej jest małym silnikiem druku arkusza: liczy geometrię, rysuje krawędzie
 * (grubsza wygrywa nad cieńszą tam, gdzie dwie komórki dzielą krawędź) i składa
 * teksty z wyrównaniem jak w Excelu (z przelewaniem poza komórkę dla etykiet).
 * Gdy Ala zmieni wzór — powtarzamy ekstrakcję, kod zostaje bez zmian.
 *
 * WYPEŁNIANE POLA (reszta zostaje pusta — wypełnia pracownik i przełożony):
 *   C2  miesiąc i rok
 *   J2  ilość godzin do przepracowania  <- art. 130 KP, `kalendarz.wymiarCzasuPracy`
 *   G3  nazwisko i imię pracownika
 *   M2  dział (gdy znany)
 *   C3  nr ewidencyjny (gdy podany)
 *
 * Dni, których w miesiącu nie ma (30-dniowy wrzesień, luty), dostają pusty
 * numer i delikatnie szary wiersz — żeby nikt tam nic nie wpisał.
 *
 * Czcionka: Liberation Sans (metrycznie zgodna z Arialem ze wzoru) jest
 * DOŁĄCZONA do repo — obraz Dockera nie ma żadnych czcionek, a PDF bez
 * osadzonego kroju nie zapisze polskich znaków.
 */

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { wymiarCzasuPracy, dniMiesiaca } = require('./kalendarz');

const WZOR = path.join(__dirname, '..', 'assets', 'karta-wzor.json');
const FONTY = path.join(__dirname, '..', 'assets', 'fonty');

const MIESIACE = ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec',
  'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień'];

/* jednostki Excela -> punkty PDF */
const KOL_PT = 7 / 256 * 0.75;   // 1/256 szerokości znaku -> px(96dpi) -> pkt
const TWIP_PT = 1 / 20;
const GRUBOSC = { 0: 0, 1: 0.5, 2: 1.1 };   // style ramek: cienka / średnia
const MARGINES = 1.5;                        // wcięcie tekstu w komórce, jak w Excelu (pkt)

/* pola wypełniane w nagłówku wzoru (wiersz/kolumna liczone od zera) */
const POLA = {
  miesiac: { r: 1, c: 2 },     // C2
  norma: { r: 1, c: 9 },       // J2
  dzial: { r: 1, c: 12 },      // M2
  nrEwid: { r: 2, c: 2 },      // C3
  osoba: { r: 2, c: 6 },       // G3
};
const ETYKIETA_DZIAL = { r: 1, c: 11 };      // L2 „Dział: ......" -> „Dział:" gdy wpisujemy
const KOL_DNIA = 0;                          // A — numer dnia
const WIERSZ_DNIA_1 = 7;                     // A8 = dzień 1

let wzorCache = null;
const wczytajWzor = () => (wzorCache ||= JSON.parse(fs.readFileSync(WZOR, 'utf8')));

/** geometria: pozycje i rozmiary kolumn/wierszy w punktach + skala do strony */
function geometria(wzor, strona) {
  const kol = wzor.kolumnyXls.map(w => w * KOL_PT);
  const wier = wzor.wierszeTwipy.map(h => h * TWIP_PT);
  const W = kol.reduce((a, b) => a + b, 0), H = wier.reduce((a, b) => a + b, 0);
  const skala = Math.min(strona.szer / W, strona.wys / H);
  const x0 = strona.x + (strona.szer - W * skala) / 2;
  const y0 = strona.y;
  const xs = [x0], ys = [y0];
  for (const w of kol) xs.push(xs[xs.length - 1] + w * skala);
  for (const h of wier) ys.push(ys[ys.length - 1] + h * skala);
  return { xs, ys, skala };
}

/** mapa scaleń: klucz „r:c" -> {r0,r1,c0,c1} (r1/c1 wyłącznie, jak w xlrd) */
function mapaScalen(wzor) {
  const glowna = new Map(), wchlonieta = new Set();
  for (const [r0, r1, c0, c1] of wzor.scalone) {
    glowna.set(`${r0}:${c0}`, { r0, r1, c0, c1 });
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) if (!(r === r0 && c === c0)) wchlonieta.add(`${r}:${c}`);
    }
  }
  return { glowna, wchlonieta };
}

/**
 * Krawędzie rysujemy raz, biorąc grubszy z dwóch stylów, które się na nią
 * składają (prawa krawędź komórki po lewej i lewa krawędź komórki po prawej).
 * Inaczej cienka linia sąsiada zamazywałaby średnią ramkę tabeli.
 *
 * Krawędzie WEWNĄTRZ scalenia pomijamy — w arkuszu ich nie widać (komórki
 * scalone rysują tylko obwódkę), a bez tego przez „Ilość godzin RAZEM"
 * przechodziłaby kreska.
 */
function krawedzie(wzor) {
  const poziome = new Map(), pionowe = new Map();
  const max = (m, k, v) => { if (v && v > (m.get(k) || 0)) m.set(k, v); };
  const wPoziomieWewnatrz = (r, c) => wzor.scalone.some(([r0, r1, c0, c1]) =>
    r > r0 && r < r1 && c >= c0 && c < c1);
  const wPionieWewnatrz = (r, c) => wzor.scalone.some(([r0, r1, c0, c1]) =>
    c > c0 && c < c1 && r >= r0 && r < r1);
  for (const k of wzor.komorki) {
    const [l, p, g, d] = k.ramki;
    if (!wPionieWewnatrz(k.r, k.c)) max(pionowe, `${k.r}:${k.c}`, l);
    if (!wPionieWewnatrz(k.r, k.c + 1)) max(pionowe, `${k.r}:${k.c + 1}`, p);
    if (!wPoziomieWewnatrz(k.r, k.c)) max(poziome, `${k.r}:${k.c}`, g);
    if (!wPoziomieWewnatrz(k.r + 1, k.c)) max(poziome, `${k.r + 1}:${k.c}`, d);
  }
  return { poziome, pionowe };
}

function nazwaFontu(pogrubiona) { return pogrubiona ? 'karta-b' : 'karta'; }

/**
 * Tekst w komórce z wyrównaniem Excela.
 *
 * Komórki bez zawijania przelewają się poza swoją szerokość — ale tylko na
 * PUSTYCH sąsiadów, dokładnie jak w arkuszu (dlatego „Ilość godzin do
 * przepracowania:" wisi po lewej od swojej ramki, a długa legenda na dole
 * urywa się przed „Podpis kierownika działu"). `przelew` to zakres, w którym
 * wolno rysować; poza niego tniemy.
 */
function tekst(doc, t, box, styl, skala, przelew) {
  if (!t) return;
  const rozmiar = Math.max(4, styl.sz * skala);
  doc.font(nazwaFontu(styl.pogrubiona)).fontSize(rozmiar).fillColor('#000');
  const pad = MARGINES * skala;
  const wolne = Math.max(6, box.w - 2 * pad);

  if (styl.zawijaj) {
    /* Wzór jest złożony Arialem i Calibri; Calibri jest węższe od naszego kroju,
       więc w wąskich nagłówkach („UB NN niepłatne") ostatnie słowo nie mieściłoby
       się w kolumnie i pękało w połowie. Zwężamy stopień pisma tylko tyle, ile
       trzeba, żeby najdłuższe słowo weszło całe. */
    const najdluzsze = t.split(/\s+/).reduce((a, s) => Math.max(a, doc.widthOfString(s)), 0);
    if (najdluzsze > wolne) doc.fontSize(Math.max(rozmiar * 0.75, rozmiar * wolne / najdluzsze));
    const wys = doc.heightOfString(t, { width: wolne, align: 'center' });
    const y = styl.pionowo === 0 ? box.y + pad
      : styl.pionowo === 1 ? box.y + (box.h - wys) / 2
        : box.y + box.h - wys - pad;
    doc.text(t, box.x + pad, y, { width: wolne, align: 'center' });
    return;
  }

  const szer = doc.widthOfString(t);
  const wys = doc.currentLineHeight();
  const y = styl.pionowo === 0 ? box.y + pad * 0.6
    : styl.pionowo === 1 ? box.y + (box.h - wys) / 2
      : box.y + box.h - wys - pad * 0.6;
  const x = styl.poziomo === 2 ? box.x + (box.w - szer) / 2
    : styl.poziomo === 3 ? box.x + box.w - szer - pad
      : box.x + pad;

  const p = przelew || { x: box.x, w: box.w };
  doc.save();
  doc.rect(p.x, box.y - 1, p.w, box.h + 2).clip();
  doc.text(t, x, y, { lineBreak: false });
  doc.restore();
}

/**
 * Rysuje JEDNĄ kartę na bieżącej stronie dokumentu.
 * @param {PDFDocument} doc
 * @param {Object} dane {osoba, rok, miesiac, norma, dzial, nrEwid}
 */
function rysujKarte(doc, dane) {
  const wzor = wczytajWzor();
  const strona = {
    x: doc.page.margins.left, y: doc.page.margins.top,
    szer: doc.page.width - doc.page.margins.left - doc.page.margins.right,
    wys: doc.page.height - doc.page.margins.top - doc.page.margins.bottom,
  };
  const { xs, ys, skala } = geometria(wzor, strona);
  const komorki = new Map(wzor.komorki.map(k => [`${k.r}:${k.c}`, k]));
  const { glowna, wchlonieta } = mapaScalen(wzor);
  const { poziome, pionowe } = krawedzie(wzor);
  const ostatniDzien = dniMiesiaca(dane.rok, dane.miesiac);

  // 1. szare tło wierszy dni, których w tym miesiącu nie ma
  for (let d = ostatniDzien + 1; d <= 31; d++) {
    const r = WIERSZ_DNIA_1 + d - 1;
    if (r >= ys.length - 1) break;
    doc.rect(xs[0], ys[r], xs[xs.length - 1] - xs[0], ys[r + 1] - ys[r])
      .fillColor('#ededed').fill();
  }

  // 2. krawędzie
  doc.strokeColor('#000');
  for (const [klucz, styl] of poziome) {
    const [r, c] = klucz.split(':').map(Number);
    if (r >= ys.length || c >= xs.length - 1) continue;
    doc.lineWidth(GRUBOSC[styl] * skala || 0.5).moveTo(xs[c], ys[r]).lineTo(xs[c + 1], ys[r]).stroke();
  }
  for (const [klucz, styl] of pionowe) {
    const [r, c] = klucz.split(':').map(Number);
    if (r >= ys.length - 1 || c >= xs.length) continue;
    doc.lineWidth(GRUBOSC[styl] * skala || 0.5).moveTo(xs[c], ys[r]).lineTo(xs[c], ys[r + 1]).stroke();
  }

  // 3. teksty wzoru + nasze wypełnienia
  const wypelnienia = new Map();
  const dopisz = (pole, wartosc) => {
    if (wartosc === null || wartosc === undefined || wartosc === '') return;
    wypelnienia.set(`${POLA[pole].r}:${POLA[pole].c}`, String(wartosc));
  };
  dopisz('miesiac', `${MIESIACE[dane.miesiac - 1]} ${dane.rok}`);
  dopisz('norma', dane.norma);
  dopisz('osoba', dane.osoba);
  dopisz('dzial', dane.dzial);
  dopisz('nrEwid', dane.nrEwid);

  /* czy komórka (r,c) ma jakąkolwiek treść — łącznie z tym, że należy do
     scalenia, którego lewy górny róg ma treść. Od tego zależy, dokąd wolno
     przelać się tekstowi sąsiada. */
  const zajeta = (r, c) => {
    let kl = `${r}:${c}`;
    if (wchlonieta.has(kl)) {
      const s = wzor.scalone.find(([r0, r1, c0, c1]) => r >= r0 && r < r1 && c >= c0 && c < c1);
      if (s) kl = `${s[0]}:${s[2]}`;
    }
    if (wypelnienia.has(kl)) return true;
    const k = komorki.get(kl);
    return !!(k && k.t);
  };

  for (const k of wzor.komorki) {
    const klucz = `${k.r}:${k.c}`;
    if (wchlonieta.has(klucz)) continue;
    const scal = glowna.get(klucz);
    const c1 = scal ? scal.c1 : k.c + 1;
    const r1 = scal ? scal.r1 : k.r + 1;
    const box = { x: xs[k.c], y: ys[k.r], w: xs[c1] - xs[k.c], h: ys[r1] - ys[k.r] };
    let cl = k.c, cp = c1;
    while (cl > 0 && !zajeta(k.r, cl - 1)) cl--;
    while (cp < xs.length - 1 && !zajeta(k.r, cp)) cp++;
    const przelew = { x: xs[cl], w: xs[cp] - xs[cl] };

    let t = wypelnienia.has(klucz) ? wypelnienia.get(klucz) : k.t;
    let styl = k;
    if (wypelnienia.has(klucz)) {
      // wpisywane wartości zawsze wyśrodkowane w swojej ramce, nie „na dole"
      styl = { ...k, pionowo: 1, poziomo: 2, zawijaj: false };
      const dostepne = box.w - 2 * MARGINES * skala;
      doc.font(nazwaFontu(k.pogrubiona)).fontSize(k.sz * skala);
      if (doc.widthOfString(t) > dostepne) {
        styl = { ...styl, sz: Math.max(6, k.sz * dostepne / doc.widthOfString(t)) };
      }
    }
    // numery dni spoza miesiąca znikają (wiersz i tak jest wyszarzony)
    if (k.c === KOL_DNIA && k.r >= WIERSZ_DNIA_1 && Number(k.t) > ostatniDzien) t = '';
    // etykieta „Dział: ......" -> „Dział:", gdy dział wpisujemy
    if (k.r === ETYKIETA_DZIAL.r && k.c === ETYKIETA_DZIAL.c && dane.dzial) t = 'Dział:';

    tekst(doc, t, box, styl, skala, przelew);
  }
}

/**
 * Domyślna obsada: lista umów o pracę i działy z `korpus/pracownicy.json`
 * (to samo źródło, co przy czytaniu kart — jedna lista, nie dwie).
 * n8n może podać własne `osoby`/`dzialy` w wywołaniu i tej listy nie ruszać.
 */
function domyslniPracownicy() {
  try {
    const p = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'korpus', 'pracownicy.json'), 'utf8'));
    return { osoby: p.lista || [], dzialy: p.dzialy || {} };
  } catch {
    return { osoby: [], dzialy: {} };
  }
}

/** kolejne miesiące od zadanego: {rok, miesiac} */
function miesiaceOd(rok, miesiac, ile) {
  const out = [];
  for (let i = 0; i < ile; i++) {
    const m0 = miesiac - 1 + i;
    out.push({ rok: rok + Math.floor(m0 / 12), miesiac: (m0 % 12) + 1 });
  }
  return out;
}

/** domyślnie: pierwszy PEŁNY miesiąc po dzisiejszym */
function nastepnyMiesiac(dzis = new Date()) {
  const m0 = dzis.getUTCMonth() + 1;
  return { rok: dzis.getUTCFullYear() + (m0 > 11 ? 1 : 0), miesiac: (m0 % 12) + 1 };
}

/**
 * Plan kart do wydrukowania (bez PDF-a — do podglądu i do testów).
 *
 * @param {Object} o
 * @param {string[]} [o.osoby]      lista pracowników (domyślnie cała lista UoP
 *                                  z korpus/pracownicy.json; kolejność = kolejność stron)
 * @param {{rok,miesiac}} [o.od]    pierwszy miesiąc; domyślnie następny po dzisiejszym
 * @param {number} [o.miesiecy]     ile miesięcy do przodu (domyślnie 3)
 * @param {Object} [o.dzialy]       {osoba: dział}
 * @param {Object} [o.nrEwid]       {osoba: nr ewidencyjny}
 * @param {'osoba'|'miesiac'} [o.kolejnosc]  grupowanie stron (domyślnie po osobie)
 */
function planKart({ osoby, od, miesiecy = 3, dzialy, nrEwid = {}, kolejnosc = 'osoba', dzis }) {
  const domyslne = domyslniPracownicy();
  osoby = Array.isArray(osoby) && osoby.length ? osoby : domyslne.osoby;
  dzialy = { ...domyslne.dzialy, ...(dzialy || {}) };
  if (!Array.isArray(osoby) || !osoby.length) throw new Error('brak listy osob');
  if (!(miesiecy >= 1 && miesiecy <= 24)) throw new Error('miesiecy: 1..24');
  const start = od && od.rok && od.miesiac ? od : nastepnyMiesiac(dzis);
  const okresy = miesiaceOd(start.rok, start.miesiac, miesiecy);
  const karta = (osoba, okr) => ({
    osoba, rok: okr.rok, miesiac: okr.miesiac,
    norma: wymiarCzasuPracy(okr.rok, okr.miesiac),
    dzial: dzialy[osoba] || null,
    nrEwid: nrEwid[osoba] || null,
  });
  const karty = [];
  if (kolejnosc === 'miesiac') {
    for (const okr of okresy) for (const osoba of osoby) karty.push(karta(osoba, okr));
  } else {
    for (const osoba of osoby) for (const okr of okresy) karty.push(karta(osoba, okr));
  }
  return { karty, okresy };
}

/** @returns {Promise<Buffer>} PDF: jedna karta = jedna strona A4 */
function zbudujPdf(karty) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', margins: { top: 22, bottom: 18, left: 24, right: 24 },
      info: { Title: 'Karty ewidencji czasu pracy', Author: 'Czytnik' },
      autoFirstPage: false,
    });
    doc.registerFont('karta', path.join(FONTY, 'LiberationSans-Regular.ttf'));
    doc.registerFont('karta-b', path.join(FONTY, 'LiberationSans-Bold.ttf'));
    const kawalki = [];
    doc.on('data', c => kawalki.push(c));
    doc.on('end', () => resolve(Buffer.concat(kawalki)));
    doc.on('error', reject);
    try {
      for (const k of karty) { doc.addPage(); rysujKarte(doc, k); }
      doc.end();
    } catch (e) { reject(e); }
  });
}

/** plan + PDF w jednym; zwraca też nazwę pliku do pobrania */
async function kartyDoDruku(opcje) {
  const { karty, okresy } = planKart(opcje);
  const pdf = await zbudujPdf(karty);
  const o = okresy[0], z = okresy[okresy.length - 1];
  const nazwa = `karty-${o.rok}-${String(o.miesiac).padStart(2, '0')}`
    + (okresy.length > 1 ? `_${z.rok}-${String(z.miesiac).padStart(2, '0')}` : '') + '.pdf';
  return { karty, okresy, pdf, nazwa };
}

module.exports = { kartyDoDruku, planKart, zbudujPdf, rysujKarte, miesiaceOd, nastepnyMiesiac,
  domyslniPracownicy, MIESIACE };
