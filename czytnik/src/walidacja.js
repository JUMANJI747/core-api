'use strict';
/**
 * walidacja.js — cała nadmiarowość karty egzekwowana DETERMINISTYCZNIE, poza modelem.
 *
 * Zasada asymetrii (ustalona z użytkownikiem): błędna liczba w wypłacie jest gorsza
 * niż karta wstrzymana; przypisanie godzin złej osobie to błąd najgorszy z możliwych.
 * Dlatego:
 *  - C liczy wyłącznie ten kod, nigdy model,
 *  - karta wychodzi jako "auto" tylko, gdy C potwierdzają >=2 NIEZALEŻNE ścieżki:
 *      a) suma literalnych transkrypcji dni (zapis),
 *      b) wiersz SUMA,
 *      c) suma czasów od/do,
 *    (wniosek modelu NIE jest ścieżką — to wynik, który ścieżki mają potwierdzić),
 *  - nazwisko: dwa zdekorelowane odczyty muszą wskazać TĘ SAMĄ pozycję zamkniętej
 *    listy; cokolwiek innego => człowiek, bez wyjątków,
 *  - brak danych != konflikt: pusty wiersz SUMA to brak ścieżki, nie problem.
 */

const { swietaMiesiaca, wymiarCzasuPracy, domyslnyRok, dniMiesiaca } = require('./kalendarz');

/* ------------------------------------------------------------------ parsery */

const L = v => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.').replace(/\s/g, '').replace(/−/g, '-'));
  return Number.isFinite(n) ? n : null;
};

/** "9:00"|"9"|"9.30"|"7/17" -> [9] | [7,17]; null gdy nie do sparsowania */
function parseCzasy(s) {
  if (s === null || s === undefined || s === '') return null;
  const czesci = String(s).split('/').map(x => x.trim()).filter(Boolean);
  const wynik = [];
  for (const c of czesci) {
    const m = c.match(/^(\d{1,2})[:.,]?(\d{2})?$/);
    if (!m) return null;
    const h = Number(m[1]), min = m[2] ? Number(m[2]) : 0;
    if (h > 24 || min > 59) return null;
    wynik.push(h + min / 60);
  }
  return wynik.length ? wynik : null;
}

/** czas pracy z od/do; obsługa dwóch zmian i przejścia przez północ; null gdy nieparsowalne */
function czasZOdDo(od, do_) {
  const a = parseCzasy(od), b = parseCzasy(do_);
  if (!a || !b || a.length !== b.length) return null;
  let suma = 0;
  for (let i = 0; i < a.length; i++) {
    let d = b[i] - a[i];
    if (d <= 0) d += 24;
    if (d > 24) return null;
    suma += d;
  }
  return Math.round(suma * 100) / 100;
}

/* ------------------------------------------------- nazwiska (zamknięta lista) */

const klucz = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/Ł/g, 'L').replace(/[^A-Z ]+/g, ' ')
  .trim().split(/\s+/).filter(Boolean).sort().join(' ');

function odlegloscEdycyjna(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** dopasowanie odczytu do zamkniętej listy: dokładne po kluczu, potem odległość <=2 */
function dopasujDoListy(odczyt, lista) {
  if (!odczyt || !Array.isArray(lista) || !lista.length) return null;
  const k = klucz(odczyt);
  if (!k) return null;
  const dokladne = lista.find(n => klucz(n) === k);
  if (dokladne) return { pozycja: dokladne, odleglosc: 0 };
  let najlepszy = null;
  for (const n of lista) {
    const d = odlegloscEdycyjna(k, klucz(n));
    if (najlepszy === null || d < najlepszy.odleglosc) najlepszy = { pozycja: n, odleglosc: d };
  }
  return najlepszy && najlepszy.odleglosc <= 2 ? najlepszy : null;
}

/* -------------------------------------------------------------------- główna */

const sumuj = a => Math.round(a.reduce((x, y) => x + (Number(y) || 0), 0) * 100) / 100;
const rowne = (a, b) => a !== null && b !== null && Math.abs(a - b) <= 0.011;

/**
 * @param {object} p0        wynik głównego odczytu (dane wg SCHEMAT_KARTY)
 * @param {object} nazwisko2 wynik ślepego odczytu nagłówka {zapis, pewnosc}
 * @param {object} okres     {rok, miesiac, nazwiska} narzucone z zewnątrz (opcjonalne)
 */
function zszyjIKontroluj(p0, nazwisko2, okres = {}, strona = null) {
  const problemy = [], ostrzezenia = [], sporne = [];
  if (!p0 || !p0.naglowek || !Array.isArray(p0.dni)) {
    return { strona, ok: false, status: 'do_weryfikacji',
      problemy: ['glowny odczyt nie zwrocil kompletnych danych'], ostrzezenia, sporne };
  }

  /* okres — naglowek niesie stringi (schemat bez unii typow), wiec koercja na liczby */
  const mies = Number(okres.miesiac || p0.naglowek.miesiac) || null;
  let rok = Number(okres.rok || p0.naglowek.rok) || null;
  let rokDomyslny = false;
  if (!mies) problemy.push('nie odczytano miesiaca z naglowka');
  if (!rok && mies) { rok = domyslnyRok(mies); rokDomyslny = true; }

  /* nazwisko: dwa zdekorelowane odczyty -> ta sama pozycja listy.
     "?" to konwencja "nieczytelne" (schemat bez null-i) — traktowane jak brak. */
  const czysc = v => { const t = String(v || '').trim(); return t && t !== '?' ? t : null; };
  const n1 = czysc(p0.naglowek.nazwisko);
  const n2 = czysc(nazwisko2 && nazwisko2.zapis);
  const lista = Array.isArray(okres.nazwiska) && okres.nazwiska.length ? okres.nazwiska : null;
  let nazwisko = '', nazwiskoOk = false;
  if (!n1 && !n2) {
    problemy.push('zaden z dwoch odczytow nie odczytal nazwiska - nie wiem, komu przypisac godziny');
  } else if (lista) {
    const d1 = dopasujDoListy(n1, lista), d2 = dopasujDoListy(n2, lista);
    if (d1 && d2 && d1.pozycja === d2.pozycja) { nazwisko = d1.pozycja; nazwiskoOk = true; }
    else if (d1 && !n2) { nazwisko = d1.pozycja; problemy.push('nazwisko potwierdzone tylko jednym odczytem (drugi pusty)'); }
    else problemy.push(`odczyty nazwiska nie wskazuja zgodnie jednej pozycji listy: "${n1}" vs "${n2}"`);
  } else {
    // bez listy nie ma jak potwierdzic przynaleznosci - zgodnosc odczytow to minimum
    if (n1 && n2 && klucz(n1) === klucz(n2)) { nazwisko = n1; nazwiskoOk = true; }
    else if (n1 && n2 && odlegloscEdycyjna(klucz(n1), klucz(n2)) <= 2) {
      nazwisko = n1; nazwiskoOk = true;
      ostrzezenia.push(`odczyty nazwiska roznia sie drobnie: "${n1}" vs "${n2}"`);
    } else {
      nazwisko = n1 || n2 || '';
      problemy.push(`odczyty nazwiska rozne: "${n1}" vs "${n2}"`);
    }
    ostrzezenia.push('brak zamknietej listy pracownikow - przynaleznosc nazwiska niezweryfikowana');
  }

  /* dni: kanały zapis/wniosek + kontrole per wiersz */
  const dniWMies = (rok && mies) ? dniMiesiaca(rok, mies) : 31;
  const swieta = (rok && mies) ? swietaMiesiaca(rok, mies) : [];
  if (p0.dni.length !== dniWMies) {
    problemy.push(`tabela ma ${p0.dni.length} dni, a ${mies}/${rok} ma ${dniWMies}`);
  }

  const dni = [];
  let zgodneOdDo = 0, niezgodneOdDo = 0, brakOdDo = 0;
  for (let i = 0; i < p0.dni.length; i++) {
    const w = p0.dni[i];
    const d = Number(w.d) || i + 1;
    const zapis = w.zapis || {}, wniosek = w.wniosek || {};
    const razem = L(wniosek.razem);
    const razemZapis = L(zapis.razem && String(zapis.razem).includes('/')
      ? String(zapis.razem).split('/').reduce((s, x) => s + (L(x) || 0), 0)
      : zapis.razem);

    if (razem !== null) {
      if (razem < 0 || razem > 24) problemy.push(`dzien ${d}: RAZEM poza zakresem 0-24 (${razem})`);
      if (Math.abs(razem * 2 - Math.round(razem * 2)) > 1e-9) ostrzezenia.push(`dzien ${d}: RAZEM nie jest wielokrotnoscia 0,5 (${razem})`);
      if (wniosek.kod) problemy.push(`dzien ${d}: kod "${wniosek.kod}" i jednoczesnie ${razem} h`);
    }
    // K10: wniosek != zapis wymaga uwagi
    if (razemZapis !== null && razem !== null && !rowne(razemZapis, razem) && !w.uwaga) {
      problemy.push(`dzien ${d}: wniosek (${razem}) rozni sie od zapisu (${zapis.razem}) bez uwagi - naruszenie polityki odczytu`);
    }
    // K1 (informacyjnie): od/do vs RAZEM
    const zCzasu = czasZOdDo(zapis.od, zapis.do);
    if (zCzasu !== null && razem !== null) {
      if (rowne(zCzasu, razem)) zgodneOdDo++;
      else { niezgodneOdDo++; ostrzezenia.push(`dzien ${d}: od/do daje ${zCzasu}, RAZEM ${razem} (przerwa nieplatna? sprawdz przy sporze)`); }
    } else if (razem !== null && razem > 0) brakOdDo++;

    // 100% tylko w swieta
    const sto = L(wniosek.sto);
    if (sto !== null && sto !== 0 && rok && mies) {
      if (!swieta.includes(d)) ostrzezenia.push(`dzien ${d}: godziny 100% w dniu, ktory nie jest swietem`);
      else if (razem !== null && !rowne(sto, razem)) ostrzezenia.push(`dzien ${d}: 100% (${sto}) rozni sie od RAZEM (${razem})`);
    }
    if (razem !== null && razem > 0 && swieta.includes(d) && (sto === null || sto === 0)) {
      ostrzezenia.push(`dzien ${d} to swieto, przepracowano ${razem} h, kolumna 100% pusta - sprawdz`);
    }
    if (w.pewnosc === 'niska' && !(zCzasu !== null && razem !== null && rowne(zCzasu, razem))) {
      sporne.push({ dzien: d, pole: 'RAZEM', zapis: zapis.razem ?? null, wniosek: razem, uwaga: w.uwaga || null });
    }

    dni.push({ d, razem, razemZapis, kod: wniosek.kod || null,
      sto, nocne: L(wniosek.nocne), uw: L(wniosek.uw), chor: L(wniosek.chor),
      od: zapis.od ?? null, do: zapis.do ?? null, zCzasu, pewnosc: w.pewnosc, uwaga: w.uwaga || null });
  }

  /* sumy i ścieżki dowodowe */
  const sumaDni = sumuj(dni.map(x => x.razem));            // WYNIK (z wniosków)
  const sciezkaA = dni.every(x => x.razem === null || x.razemZapis !== null)
    ? sumuj(dni.map(x => x.razemZapis)) : null;            // a) literalne zapisy
  const s = p0.suma || {};
  const sciezkaB = L(s.wniosek && s.wniosek.razem);        // b) wiersz SUMA
  const pokrycieOdDo = (zgodneOdDo + niezgodneOdDo + brakOdDo) > 0
    ? (zgodneOdDo + niezgodneOdDo) / (zgodneOdDo + niezgodneOdDo + brakOdDo) : 0;
  const sciezkaC = (pokrycieOdDo === 1 && niezgodneOdDo === 0)
    ? sumuj(dni.map(x => x.zCzasu ?? x.razem)) : null;     // c) czasy od/do (tylko pelne pokrycie)

  const sciezki = {
    zapisyDni: sciezkaA, wierszSuma: sciezkaB, czasyOdDo: sciezkaC,
    zgodne: [
      ['zapisyDni', sciezkaA], ['wierszSuma', sciezkaB], ['czasyOdDo', sciezkaC],
    ].filter(([, v]) => rowne(v, sumaDni)).map(([k]) => k),
  };
  const brakWierszaSumy = sciezkaB === null;
  if (!brakWierszaSumy && !rowne(sciezkaB, sumaDni)) {
    sporne.push({ dzien: 'SUMA', pole: 'RAZEM', zapis: s.zapis && s.zapis.razem, wniosek: sciezkaB, sumaDni });
    problemy.push(`suma dni (${sumaDni}) nie zgadza sie z wierszem SUMA (${sciezkaB})`);
  }

  /* kolumny dodatków: wiersz SUMA gdy jest, inaczej suma z dni; rozjazd = problem */
  const zDni = pole => sumuj(dni.map(x => x[pole]));
  const kolumna = pole => {
    const zSumy = L(s.wniosek && s.wniosek[pole]);
    const zDni_ = zDni(pole);
    if (zSumy === null) return zDni_;
    if (!rowne(zSumy, zDni_) && zDni_ !== 0) {
      problemy.push(`kolumna ${pole}: suma z dni (${zDni_}) nie zgadza sie z wierszem SUMA (${zSumy})`);
    }
    return zSumy;
  };
  const sto = kolumna('sto') || 0;
  const uw = kolumna('uw') || 0;
  const chor = kolumna('chor') || 0;
  const nocne = kolumna('nocne') || 0;

  /* C i G */
  const maDni = dni.some(x => x.razem !== null);
  const C = maDni ? Math.round((sumaDni + sto + uw + chor) * 100) / 100 : null;
  const G = nocne || null;
  if (!maDni) problemy.push('nie odczytano ani jednego dnia z tabeli');

  /* norma */
  const normaZKarty = L(p0.naglowek.norma);
  if (rok && mies) {
    const norma = wymiarCzasuPracy(rok, mies);
    if (normaZKarty && normaZKarty !== norma && normaZKarty !== norma * 0.75) {
      ostrzezenia.push(`norma z karty (${normaZKarty}) nie zgadza sie z wyliczona z KP (${norma})`);
    }
    if (C !== null && (C < norma * 0.4 || C > norma * 1.6)) {
      problemy.push(`suma miesiaca (${C}) mocno odbiega od normy ${norma} - sprawdz odczyt`);
    }
  }

  /* decyzja: auto wymaga nazwiska + >=2 zgodnych ścieżek + zera spornych/problemów */
  const potwierdzenia = sciezki.zgodne.length;
  let status = 'do_weryfikacji';
  if (nazwiskoOk && potwierdzenia >= 2 && problemy.length === 0 && sporne.length === 0) status = 'auto';
  else if (nazwiskoOk && potwierdzenia >= 1 && problemy.length === 0 && sporne.length === 0) status = 'auto_slabe'; // 1 ścieżka: do decyzji progowej po korpusie

  return {
    strona, ok: status === 'auto',
    status, nazwisko, nazwiskoOk,
    nazwiskaOdczytane: [n1, n2].filter(Boolean),
    rok, rokDomyslny, miesiac: mies, normaZKarty,
    C, G, sumaDni, wierszSuma: sciezkaB, brakWierszaSumy, sto, uw, chor,
    sciezki, potwierdzenia,
    problemy, ostrzezenia, sporne,
    rozbieznosci: p0.rozbieznosci || [],
    dni,
  };
}

module.exports = { zszyjIKontroluj, L, parseCzasy, czasZOdDo, klucz, dopasujDoListy, odlegloscEdycyjna };
