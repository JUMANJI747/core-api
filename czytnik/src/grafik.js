'use strict';
/**
 * grafik.js — odczyt grafiku zmian (arkusz Google / xlsx) jako POMOCY, nie źródła.
 *
 * ŹRÓDŁEM PRAWDY JEST KARTA PRACY (ustalenie z użytkownikiem). Grafik to plan,
 * aktualizowany w trakcie miesiąca; Ala liczy z niego etat i nadgodziny, ale to
 * nie jest dokument o tym, ile ktoś faktycznie przepracował. Grafik daje nam
 * trzy rzeczy, których z karty nie widać:
 *
 *   1. KTÓRE DNI BYŁY ZMIANAMI — kluczowe przy nieobecnościach osób na 12/12:
 *      ptaszek na karcie stoi przy każdym dniu kalendarzowym zwolnienia, a płatne
 *      są tylko te dni, w których osoba miała zmianę (Korgul 6/2026: 6 ptaszków,
 *      grafik pokazuje 2 zmiany po 12 h),
 *   2. GODZINY NIEOBECNOŚCI — grafik ma je wpisane wprost w kolumnie „ilość godzin",
 *   3. DNI, KTÓRYCH NA KARCIE BRAKUJE — grafik ma zmianę, karta pusty wiersz
 *      (Korgul 6/2026 dzień 17: 12 h w grafiku, nic na karcie). To sygnał dla
 *      człowieka, nie podstawa do doliczenia godzin.
 *
 * FORMAT ARKUSZA (wspólny dla wszystkich działów):
 *   wiersz 1: imiona w co trzeciej kolumnie, począwszy od kolumny 3
 *   wiersz 2: "GODZINY PRACY" | "" | "ILOŚĆ GODZIN"
 *   wiersze 4+: [dzień miesiąca] [dzień tygodnia] potem trójki [od][do][godziny]
 *   na dole: "GODZIN:" / "NORMA:" / "NADGODZINY:" z sumą w trzeciej kolumnie
 *   wartości: liczba (godzina), "w" wolne, "u" urlop, "z" zwolnienie, puste
 *
 * Wejście to SIATKA (tablica tablic) — dokładnie to, co zwraca węzeł Google
 * Sheets w n8n bez nagłówków, i to samo, co da się wyciągnąć z xlsx.
 */

const KOD_DNIA = { w: 'wolne', u: 'urlop', z: 'zwolnienie', c: 'zwolnienie', n: 'nieobecnosc' };

const kom = (wiersz, i) => (wiersz && wiersz[i] !== undefined && wiersz[i] !== null) ? wiersz[i] : '';

/** '11' | 11 | '11:30' | 11.5 -> godziny dziesiętne; null gdy to nie godzina */
function godzina(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = String(v || '').trim().replace(',', '.');
  if (!t) return null;
  const m = t.match(/^(\d{1,2})(?:[:.]\s*(\d{1,2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 24) return null;
  let mi = m[2] ? Number(m[2]) : 0;
  if (m[2] && m[2].length === 1) mi *= 10;
  if (mi > 59) return null;
  return h + mi / 60;
}

/** litera oznaczająca rodzaj dnia, albo null gdy to liczba/puste */
function kodDnia(v) {
  const t = String(v ?? '').trim().toLowerCase();
  if (!t || t.length > 2) return null;
  return KOD_DNIA[t[0]] || null;
}

/**
 * @param {Array<Array>} siatka wiersze arkusza (tablica tablic), od wiersza 1
 * @returns {{osoby: Object, miesiac: string|null}} osoby[imie] =
 *          { dni: {1: {od, do, godziny, kod}}, suma, norma, nadgodziny }
 */
function parsujGrafik(siatka) {
  if (!Array.isArray(siatka) || siatka.length < 4) return { osoby: {}, miesiac: null };
  const naglowek = siatka[0] || [];
  const osoby = {};
  const kolumny = [];
  for (let c = 2; c < naglowek.length; c++) {
    const v = String(kom(naglowek, c) || '').trim();
    if (v) { kolumny.push({ imie: v, c }); }
  }
  for (const { imie, c } of kolumny) {
    const dni = {};
    let suma = null, norma = null, nadgodziny = null;
    for (let r = 2; r < siatka.length; r++) {
      const w = siatka[r] || [];
      const etykieta = String(kom(w, c) || '').trim().toUpperCase();
      if (etykieta.startsWith('GODZIN')) { const v = godzinaLiczba(kom(w, c + 2)); if (v !== null) suma = v; continue; }
      if (etykieta.startsWith('NORMA')) { const v = godzinaLiczba(kom(w, c + 2)); if (v !== null) norma = v; continue; }
      if (etykieta.startsWith('NADGODZIN')) { const v = godzinaLiczba(kom(w, c + 2)); if (v !== null) nadgodziny = v; continue; }
      const d = Number(String(kom(w, 0)).trim());
      if (!Number.isInteger(d) || d < 1 || d > 31) continue;
      const od = kom(w, c), do_ = kom(w, c + 1), g = kom(w, c + 2);
      const kod = kodDnia(od) || kodDnia(do_);
      const godzin = godzinaLiczba(g);
      const jestCos = String(od).trim() || String(do_).trim() || (godzin !== null && godzin !== 0);
      if (!jestCos) continue;
      dni[d] = {
        od: kod ? null : godzina(od),
        do: kod ? null : godzina(do_),
        godziny: godzin,
        kod: kod || null,
      };
    }
    osoby[imie] = { dni, suma, norma, nadgodziny };
  }
  return { osoby, miesiac: String(kom(siatka[0], 1) || kom(siatka[1], 1) || '').trim() || null };
}

/** liczba godzin z komórki „ilość godzin" — puste/spacja/tekst -> null */
function godzinaLiczba(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = String(v ?? '').trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------- dopasowanie imion do listy */

const tokeny = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/Ł/g, 'L').replace(/[^A-Z ]+/g, ' ')
  .trim().split(/\s+/).filter(Boolean);

// zdrobnienia spotykane w grafikach wobec listy kadrowej
const ZDROBNIENIA = {
  EMILKA: 'EMILIA', MARZENKA: 'MARZENA', DANUSIA: 'DANUTA', BASIA: 'BARBARA',
  BEATKA: 'BEATA', GABRYSIA: 'GABRIELA', OLEK: 'ALEKSANDER', OLA: 'ALEKSANDRA',
  JULKA: 'JULIA', ANIA: 'ANNA', ULA: 'URSZULA', ZUZIA: 'ZUZANNA', PRZEMEK: 'PRZEMYSLAW',
  KAROLA: 'KAROLINA', INGA: 'INHA', ANDRIEJ: 'ANDRII',
};
const rozwin = t => ZDROBNIENIA[t] || t;

/**
 * Dopasowanie imienia z grafiku do pełnego nazwiska z listy kadrowej.
 * Wymaga JEDNOZNACZNOŚCI — dwie pasujące osoby oznaczają brak dopasowania
 * (w firmie są dwie Marzeny, dwie Natalie i trzy Weroniki).
 */
function dopasujImie(imieZGrafiku, lista) {
  const t = tokeny(imieZGrafiku).map(rozwin);
  if (!t.length || !Array.isArray(lista)) return null;
  const pasuje = lista.filter(pelne => {
    const p = tokeny(pelne).map(rozwin);
    return t.every(x => p.some(y => y === x || (x.length >= 4 && y.startsWith(x))));
  });
  return pasuje.length === 1 ? pasuje[0] : null;
}

/**
 * Scala kilka arkuszy grafiku (bar, kuchnia, recepcja...) w jedną mapę
 * pełne_nazwisko -> { dni, suma, ... }. Imiona niedopasowane trafiają do
 * `nieprzypisane`, żeby nie znikały po cichu.
 */
function zbudujGrafikMiesiaca(arkusze, lista) {
  const wynik = {}, nieprzypisane = [];
  for (const { nazwa, siatka } of arkusze || []) {
    const { osoby } = parsujGrafik(siatka);
    for (const [imie, dane] of Object.entries(osoby)) {
      const pelne = dopasujImie(imie, lista);
      if (!pelne) { nieprzypisane.push({ dzial: nazwa || null, imie }); continue; }
      // ta sama osoba moze byc w dwoch dzialach - scalamy dni
      if (!wynik[pelne]) wynik[pelne] = { dni: {}, suma: null, norma: null, dzialy: [] };
      Object.assign(wynik[pelne].dni, dane.dni);
      if (dane.suma !== null) wynik[pelne].suma = (wynik[pelne].suma || 0) + dane.suma;
      if (dane.norma !== null) wynik[pelne].norma = dane.norma;
      if (nazwa) wynik[pelne].dzialy.push(nazwa);
    }
  }
  return { grafik: wynik, nieprzypisane };
}

module.exports = { parsujGrafik, zbudujGrafikMiesiaca, dopasujImie, godzina, kodDnia };
