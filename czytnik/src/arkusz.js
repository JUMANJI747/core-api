'use strict';
/**
 * arkusz.js — budowa nowej zakładki miesiąca w arkuszu GODZINY.
 *
 * Po przerobieniu kompletnego miesiąca (wszystkie osoby mają godziny) system
 * zakłada zakładkę na następny miesiąc i przenosi salda, dokładnie tak, jak
 * robi to Ala ręcznie. Układ odtworzony z arkusza GODZINY 2023–2026:
 *
 *   A1 = norma miesiąca      I1 = norma miesiąca (formuły D odwołują się do I1)
 *   B1..H1 = nagłówki        J1 = notatka (np. „karolina i przemek 3/4 etatu")
 *
 *   wiersz osoby:
 *     A nazwisko
 *     B POPRZEDNI OKRES      <- TOTAL (E) z poprzedniego miesiąca
 *     C godziny bieżące      <- to, co wyliczył Czytnik z kart pracy
 *     D NADGODZ / NIEDOGODZ  = C - I1
 *     E TOTAL                = B + D            (przechodzi na następny miesiąc)
 *     F NOCNE POPRZEDNI      <- NOCNE TOTAL (H) z poprzedniego miesiąca
 *     G NOCNE BIEŻĄCY        <- nocne wyliczone z kart
 *     H NOCNE TOTAL          = F + G - I
 *     I nocne rozliczone     <- wpisuje człowiek (ile nocnych wypłacono)
 *
 * Reguły przenoszenia sprawdzone na parze czerwiec→lipiec 2026: TOTAL→POPRZEDNI
 * zgadza się dla 27 z 28 osób, NOCNE TOTAL→NOCNE POPRZEDNI dla wszystkich 20,
 * które mają wypełnione kolumny nocne.
 *
 * NORMY NIE POBIERAMY Z SIECI — liczy ją `kalendarz.wymiarCzasuPracy` z art. 130
 * Kodeksu pracy (8 h × dni pn–pt − 8 h × święta w dni inne niż niedziela).
 * Sprawdzone wobec wszystkich 43 zakładek arkusza: zgodne w 42; jedyna różnica
 * to Grudzień 2025, gdzie arkusz ma 160, a z Kodeksu wychodzi 168.
 */

const { wymiarCzasuPracy } = require('./kalendarz');

const MIESIACE = ['STYCZEŃ', 'LUTY', 'MARZEC', 'KWIECIEŃ', 'MAJ', 'CZERWIEC', 'LIPIEC',
  'SIERPIEŃ', 'WRZESIEŃ', 'PAŹDZIERNIK', 'LISTOPAD', 'GRUDZIEŃ'];
const MIESIACE_ZAKLADKA = ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec',
  'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień'];

const NAGLOWKI = ['POPRZEDNI OKRES', null, 'NADGODZ / NIEDOGODZ', 'TOTAL',
  'NOCNE POPRZEDNI OKRES', 'NOCNE BIEŻĄCY M-C', 'NOCNE TOTAL'];

const klucz = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/Ł/g, 'L').replace(/[^A-Z ]+/g, ' ')
  .trim().split(/\s+/).filter(Boolean).sort().join(' ');

const L = v => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/**
 * Czy miesiąc jest gotowy do zamknięcia — każda osoba z poprzedniej zakładki
 * ma wyliczone godziny. Bez tego nie zakładamy nowej zakładki, bo saldo
 * przeniosłoby się niepełne.
 */
function czyKompletny(poprzedniaSiatka, wyniki) {
  const osoby = wierszeOsob(poprzedniaSiatka).map(w => w.nazwisko);
  const mamy = new Map((wyniki || []).filter(w => w && w.nazwisko)
    .map(w => [klucz(w.nazwisko), w]));
  const brakujace = osoby.filter(o => !mamy.has(klucz(o)));
  const bezGodzin = (wyniki || []).filter(w => w && w.nazwisko && (w.C === null || w.C === undefined))
    .map(w => w.nazwisko);
  return { kompletny: brakujace.length === 0 && bezGodzin.length === 0, brakujace, bezGodzin };
}

/** wiersze osób z istniejącej zakładki (pomija nagłówek i puste) */
function wierszeOsob(siatka) {
  const out = [];
  for (let r = 1; r < (siatka || []).length; r++) {
    const w = siatka[r] || [];
    const n = String(w[0] ?? '').trim();
    if (!n) continue;
    out.push({
      wiersz: r + 1, nazwisko: n,
      poprzedniOkres: L(w[1]), godziny: L(w[2]),
      total: L(w[4]),
      nocnePoprzedni: L(w[5]), nocneBiezacy: L(w[6]), nocneTotal: L(w[7]),
      nocneRozliczone: L(w[8]), notatka: w[9] ?? null,
    });
  }
  return out;
}

/**
 * Buduje siatkę nowej zakładki.
 *
 * @param {Object} o
 * @param {Array<Array>} o.poprzedniaSiatka  zakładka miesiąca, który zamykamy
 * @param {Array} o.wyniki   karty z Czytnika: [{nazwisko, C, G}]
 * @param {number} o.rok     rok NOWEGO miesiąca
 * @param {number} o.miesiac miesiąc NOWY (1-12)
 * @param {boolean} [o.wymuszaj]  załóż zakładkę nawet przy niekompletnym miesiącu
 * @returns {{siatka, nazwaZakladki, norma, kompletnosc, ostrzezenia}}
 */
function nowaZakladka({ poprzedniaSiatka, wyniki, rok, miesiac, wymuszaj = false }) {
  const ostrzezenia = [];
  const osoby = wierszeOsob(poprzedniaSiatka);
  if (!osoby.length) throw new Error('poprzednia zakladka nie ma ani jednego wiersza osoby');

  const kompletnosc = czyKompletny(poprzedniaSiatka, wyniki);
  if (!kompletnosc.kompletny && !wymuszaj) {
    return { siatka: null, kompletnosc, nazwaZakladki: null, norma: null,
      ostrzezenia: [
        kompletnosc.brakujace.length
          ? `brak kart dla: ${kompletnosc.brakujace.join(', ')}` : null,
        kompletnosc.bezGodzin.length
          ? `bez wyliczonych godzin: ${kompletnosc.bezGodzin.join(', ')}` : null,
        'zakladki NIE zalozono - saldo przenioslo by sie niepelne (wymuszaj: true, zeby mimo to)',
      ].filter(Boolean) };
  }

  const norma = wymiarCzasuPracy(rok, miesiac);
  const wgOsoby = new Map((wyniki || []).filter(w => w && w.nazwisko)
    .map(w => [klucz(w.nazwisko), w]));

  // wiersz 1: normy i naglowki, dokladnie jak w istniejacych zakladkach
  const naglowek = [norma, NAGLOWKI[0], MIESIACE[miesiac - 1], NAGLOWKI[2], NAGLOWKI[3],
    NAGLOWKI[4], NAGLOWKI[5], NAGLOWKI[6], norma];
  const notatkaGlowna = (poprzedniaSiatka[0] || [])[9];
  if (notatkaGlowna) naglowek[9] = notatkaGlowna;

  const siatka = [naglowek];
  for (const o of osoby) {
    const r = siatka.length + 1;                    // numer wiersza w arkuszu
    const w = wgOsoby.get(klucz(o.nazwisko));
    if (!w) ostrzezenia.push(`${o.nazwisko}: brak karty w tym miesiacu - godziny puste`);
    siatka.push([
      o.nazwisko,
      o.total,                                       // B <- TOTAL z zamykanego miesiaca
      w && w.C !== null && w.C !== undefined ? w.C : null,   // C godziny z kart
      `=C${r}-$I$1`,                                 // D nadgodziny
      `=B${r}+D${r}`,                                // E total (przejdzie dalej)
      o.nocneTotal !== null ? o.nocneTotal : (o.nocnePoprzedni ?? null),  // F <- NOCNE TOTAL
      w && w.G ? w.G : null,                         // G nocne biezace z kart
      `=F${r}+G${r}-I${r}`,                          // H nocne total
      null,                                          // I nocne rozliczone - wpisuje czlowiek
      o.notatka || null,
    ]);
  }

  return {
    siatka,
    nazwaZakladki: `${MIESIACE_ZAKLADKA[miesiac - 1]} ${rok}`,
    norma,
    kompletnosc,
    ostrzezenia,
  };
}

module.exports = { nowaZakladka, czyKompletny, wierszeOsob, MIESIACE_ZAKLADKA };
