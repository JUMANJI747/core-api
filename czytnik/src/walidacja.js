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

// Aliasy imion: w arkuszu kadrowym bywa zdrobnienie, na karcie pelne imie.
const ALIASY = { PRZEMEK: 'PRZEMYSLAW', PRZEMO: 'PRZEMYSLAW' };

const tokeny = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/Ł/g, 'L').replace(/[^A-Z ]+/g, ' ')
  .trim().split(/\s+/).filter(Boolean).map(x => ALIASY[x] || x).sort();

const klucz = t => tokeny(t).join(' ');

/**
 * Dopasowanie dwoch nazwisk PER SLOWO (kazdy token znajduje odpowiednik
 * w odleglosci <=2). Porownanie calych sklejonych kluczy zawodzilo, gdy zmiana
 * jednej litery zmieniala porzadek sortowania (Andriichuk vs Andrichuk).
 */
function pasujeOsoba(a, b) {
  const ta = tokeny(a), tb = tokeny(b);
  if (!ta.length || ta.length !== tb.length) return false;
  const uzyte = new Set();
  for (const x of ta) {
    let naj = null;
    for (let i = 0; i < tb.length; i++) {
      if (uzyte.has(i)) continue;
      const d = odlegloscEdycyjna(x, tb[i]);
      if (naj === null || d < naj.d) naj = { i, d };
    }
    if (!naj || naj.d > 2) return false;
    uzyte.add(naj.i);
  }
  return true;
}

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

/** dopasowanie odczytu do zamkniętej listy: dokładne po kluczu, potem per słowo */
function dopasujDoListy(odczyt, lista) {
  if (!odczyt || !Array.isArray(lista) || !lista.length) return null;
  const k = klucz(odczyt);
  if (!k) return null;
  const dokladne = lista.find(n => klucz(n) === k);
  if (dokladne) return { pozycja: dokladne, odleglosc: 0 };
  const pasujace = lista.filter(n => pasujeOsoba(odczyt, n));
  // dopasowanie musi byc JEDNOZNACZNE - dwie pasujace pozycje to brak dopasowania
  return pasujace.length === 1 ? { pozycja: pasujace[0], odleglosc: 1 } : null;
}

/* -------------------------------------------------------------------- główna */

const sumuj = a => Math.round(a.reduce((x, y) => x + (Number(y) || 0), 0) * 100) / 100;
const rowne = (a, b) => a !== null && b !== null && Math.abs(a - b) <= 0.011;

/**
 * @param {object} p0        wynik głównego odczytu (dane wg SCHEMAT_KARTY)
 * @param {object} nazwisko2 wynik ślepego odczytu nagłówka {zapis, pewnosc}
 * @param {object} okres     {rok, miesiac, nazwiska} narzucone z zewnątrz (opcjonalne)
 * @param {*} strona
 * @param {object} [slepy]   ślepa transkrypcja kolumny RAZEM {dni:[{d,razem}], suma}
 *                           — NIEZALEŻNE wywołanie; jedyna ścieżka (obok wiersza
 *                           SUMA), która widzi dzień zgubiony przez odczyt główny
 */
function zszyjIKontroluj(p0, nazwisko2, okres = {}, strona = null, slepy = null) {
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
    else if (n1 && n2 && pasujeOsoba(n1, n2)) {
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

  /* ścieżka D: ślepa kolumna RAZEM — porównanie DZIEŃ PO DNIU z odczytem
     głównym. To jedyna kontrola (obok wiersza SUMA), która jest naprawdę
     niezależna: zapisyDni i czasyOdDo pochodzą z tego samego wywołania co
     wynik, więc zgubiony dzień psuje je WSZYSTKIE zgodnie (lekcja: Żuk 7/2026,
     odczyt główny zgubił dzień 4 i trzy "ścieżki" potwierdziły błąd). */
  let sciezkaD = null;
  if (slepy && Array.isArray(slepy.dni) && slepy.dni.length) {
    const mapaSlepa = new Map();
    for (const w of slepy.dni) {
      const d = Number(w.d);
      if (d >= 1 && d <= 31 && !mapaSlepa.has(d)) mapaSlepa.set(d, w.razem);
    }
    let suma = 0, kompletna = true;
    for (let d = 1; d <= dniWMies; d++) {
      const sv = mapaSlepa.has(d) ? String(mapaSlepa.get(d)) : '';
      const sn = sv.includes('/')
        ? sv.split('/').reduce((a, x) => a + (L(x) || 0), 0)
        : L(sv);
      if (sv === '?') { kompletna = false; continue; }
      const wiersz = dni.find(x => x.d === d);
      const pv = wiersz ? wiersz.razem : null;
      const zgodne = (sn === null && pv === null) || rowne(sn, pv);
      if (!zgodne) {
        sporne.push({ dzien: d, pole: 'RAZEM', wniosek: pv, slepaKolumna: sv,
          uwaga: 'slepa transkrypcja kolumny RAZEM rozni sie od odczytu glownego' });
      }
      suma += sn || 0;
    }
    sciezkaD = kompletna ? Math.round(suma * 100) / 100 : null;
    // wiersz SUMA wg ślepej transkrypcji — drugi głos przy spornym wierszu SUMA
    const slepaSuma = L(slepy.suma);
    if (slepaSuma !== null && sciezkaB !== null && !rowne(slepaSuma, sciezkaB)) {
      sporne.push({ dzien: 'SUMA', pole: 'RAZEM', wniosek: sciezkaB, slepaKolumna: slepy.suma,
        uwaga: 'slepa transkrypcja wiersza SUMA rozni sie od odczytu glownego' });
    }
  }

  const sciezki = {
    zapisyDni: sciezkaA, wierszSuma: sciezkaB, czasyOdDo: sciezkaC, slepaKolumna: sciezkaD,
    zgodne: [
      ['zapisyDni', sciezkaA], ['wierszSuma', sciezkaB], ['czasyOdDo', sciezkaC],
      ['slepaKolumna', sciezkaD],
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
  const nocne = kolumna('nocne') || 0;

  /* UW i Chor. bywaja wypelniane DNIAMI (ptaszek/kod na dzien, w SUMIE liczba
     dni - karta Korgul 6/2026: 6 ptaszkow i "6" w SUMIE), a bywaja GODZINAMI
     (Kuleta 7/2026: "56" = 7 dni x 8 h). Regula od kadr (Ala, 2026-08-29):
     dzien nieobecnosci = 8 h; wyjatki w okres.stawkiDnia (3/4 etatu = 6 h). */
  const stawkaDnia = (okres.stawkiDnia && nazwisko && okres.stawkiDnia[nazwisko])
    || Number(okres.domyslnaStawkaDnia) || 8;
  const dniZKodem = lit => dni.filter(x => String(x.kod || '').toUpperCase().startsWith(lit)).length;
  const kolumnaNieobecnosci = (pole, lit, etykieta) => {
    const zSumy = L(s.wniosek && s.wniosek[pole]);
    const zDni_ = zDni(pole);
    const ileDni = dniZKodem(lit);
    if (zSumy === null) {
      if (zDni_ > 0) return zDni_;
      if (ileDni > 0) {
        ostrzezenia.push(`${etykieta}: ${ileDni} dni x ${stawkaDnia} h = ${ileDni * stawkaDnia} h (SUMA pusta, przeliczono z kodow dziennych)`);
        return ileDni * stawkaDnia;
      }
      return 0;
    }
    if (ileDni > 0) {
      if (rowne(zSumy, ileDni)) {
        ostrzezenia.push(`${etykieta}: rubryka SUMA zawiera liczbe DNI (${ileDni}) - przeliczono ${ileDni} x ${stawkaDnia} h = ${ileDni * stawkaDnia} h`);
        return ileDni * stawkaDnia;
      }
      if (rowne(zSumy, ileDni * stawkaDnia)) return zSumy;
      sporne.push({ dzien: 'SUMA', pole: etykieta, wniosek: zSumy,
        uwaga: `${ileDni} dni z kodem ${lit}, a w SUMIE ${zSumy} - nie pasuje ani do liczby dni, ani do ${ileDni}x${stawkaDnia} h` });
      return zSumy;
    }
    if (zDni_ !== 0 && !rowne(zSumy, zDni_)) {
      problemy.push(`kolumna ${etykieta}: suma z dni (${zDni_}) nie zgadza sie z wierszem SUMA (${zSumy})`);
    }
    return zSumy;
  };
  const uw = kolumnaNieobecnosci('uw', 'U', 'UW') || 0;
  const chor = kolumnaNieobecnosci('chor', 'C', 'Chor.') || 0;

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

  /* Decyzja: auto wymaga nazwiska + >=2 zgodnych ścieżek, w tym CO NAJMNIEJ
     JEDNEJ NIEZALEŻNEJ od odczytu głównego (wiersz SUMA albo ślepa kolumna).
     zapisyDni i czasyOdDo pochodzą z tego samego wywołania co wynik — same
     siebie nie potwierdzają (zgubiony dzień psuje je zgodnie; case Żuk 7/2026). */
  const potwierdzenia = sciezki.zgodne.length;
  const niezalezne = sciezki.zgodne.filter(k => k === 'wierszSuma' || k === 'slepaKolumna').length;
  let status = 'do_weryfikacji';
  if (nazwiskoOk && potwierdzenia >= 2 && niezalezne >= 1 && problemy.length === 0 && sporne.length === 0) status = 'auto';
  else if (nazwiskoOk && potwierdzenia >= 1 && problemy.length === 0 && sporne.length === 0) status = 'auto_slabe'; // bez niezależnego potwierdzenia — nie wchodzi samo

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
