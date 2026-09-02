'use strict';
/**
 * walidacja.js — cała nadmiarowość karty egzekwowana DETERMINISTYCZNIE, poza modelem.
 *
 * Zasada asymetrii (ustalona z użytkownikiem): błędna liczba w wypłacie jest gorsza
 * niż karta wstrzymana; przypisanie godzin złej osobie to błąd najgorszy z możliwych.
 * Dlatego:
 *  - C liczy wyłącznie ten kod, nigdy model,
 *  - godziny dnia bierzemy z kolumny RAZEM, ale NIGDY więcej niż wynika z czasu
 *    między wejściem a wyjściem: wpis mniejszy = odliczona przerwa (normalne,
 *    tak wypełnia karty stajnia), wpis większy = alarm i karta do człowieka,
 *  - karta wychodzi jako "auto" tylko, gdy sumę potwierdzi ścieżka NIEZALEŻNA od
 *    głównego odczytu: ślepa transkrypcja kolumny RAZEM albo wiersz SUMA
 *    (wiersza SUMA może nie być — to nie blokuje karty),
 *  - nazwisko: dwa zdekorelowane odczyty muszą wskazać TĘ SAMĄ pozycję zamkniętej
 *    listy; cokolwiek innego => człowiek, bez wyjątków,
 *  - brak danych != konflikt: pusty wiersz SUMA to brak ścieżki, nie problem.
 */

const { swietaMiesiaca, wymiarCzasuPracy, domyslnyRok, dniMiesiaca } = require('./kalendarz');

/* ------------------------------------------------------------------ parsery */

const L = v => {
  if (v === null || v === undefined || v === '') return null;
  /* Jednostka po liczbie jest do wyrzucenia, nie do potkniecia sie o nia:
     slepa transkrypcja kolumny RAZEM w stajni 8/2026 zwrocila "8.5h", a
     Number("8.5h") to NaN - przez co cztery dni karty Rynkiewicz zostaly
     zgloszone jako rozjazd miedzy odczytami i karta poszla do czlowieka,
     mimo ze OBA odczyty mowily to samo. */
  const t = String(v).replace(',', '.').replace(/\s/g, '')
    .replace(/−/g, '-').replace(/(godz\.?|h)$/i, '');
  const n = Number(t);
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

/* KODY OZNACZAJACE PRACE, NIE NIEOBECNOSC.
   Legenda na dole karty miesza jedno z drugim: wiekszosc kodow to nieobecnosci
   (C choroba, Uw urlop, Ub bezplatny, Op opieka, X wychowawczy, NUP, NN, O, SW),
   ale PZ (praca zdalna) i D (delegacja sluzbowa) to DNI PRZEPRACOWANE - godziny
   sa wpisane normalnie w RAZEM i tak maja byc liczone. Bez tego rozroznienia
   karta Biziewskiej za 8/2026 dostala 19 falszywych problemow "kod PZ i
   jednoczesnie N h" i poszla do czlowieka bez powodu. */
const KODY_PRACY = new Set(['PZ', 'D']);
const czyKodPracy = k => KODY_PRACY.has(String(k || '').trim().toUpperCase());

/* ------------------------------------------------- nazwiska (zamknięta lista) */

/* Aliasy: w arkuszu kadrowym bywa zdrobnienie, na karcie pelne imie
   (Przemek/Przemyslaw), a jedno nazwisko ma po prostu dwie pisownie —
   ANDRICHUK na kartach i Andriichuk w arkuszu GODZINY to ta sama osoba
   (potwierdzone przez uzytkownika: „andrii jest jeden"). Sklejamy je tutaj na
   stale, zeby dopasowanie bylo dokladne, a nie zalezalo od tolerancji
   odleglosci edycyjnej. */
const ALIASY = { PRZEMEK: 'PRZEMYSLAW', PRZEMO: 'PRZEMYSLAW', ANDRICHUK: 'ANDRIICHUK' };

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

  /* GRAFIK ZMIAN — POMOC, NIE ZRODLO. Zrodlem prawdy jest karta; grafik mowi
     tylko, KTORE dni byly zmianami (i po ile godzin), czego z karty nie widac
     przy nieobecnosciach osob na 12/12. */
  const grafikOsoby = (okres.grafik && nazwisko && okres.grafik[nazwisko]) || null;
  const grafikDni = (grafikOsoby && grafikOsoby.dni) || null;

  /* dni: kanały zapis/wniosek + kontrole per wiersz */
  const dniWMies = (rok && mies) ? dniMiesiaca(rok, mies) : 31;
  const swieta = (rok && mies) ? swietaMiesiaca(rok, mies) : [];
  if (p0.dni.length !== dniWMies) {
    problemy.push(`tabela ma ${p0.dni.length} dni, a ${mies}/${rok} ma ${dniWMies}`);
  }

  const dni = [];
  let zgodneOdDo = 0, niezgodneOdDo = 0, brakOdDo = 0, odliczonePrzerwy = 0;
  const bledySumowania = [], brakujaceWpisy = [];
  // stajnia liczy z kolumny RAZEM, reszta z godzin wejscia/wyjscia
  const zrodloRazem = (okres.zrodloGodzin || 'odDo') === 'razem';
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
      if (wniosek.kod && !czyKodPracy(wniosek.kod)) problemy.push(`dzien ${d}: kod "${wniosek.kod}" i jednoczesnie ${razem} h`);
    }
    // K10: wniosek != zapis wymaga uwagi
    if (razemZapis !== null && razem !== null && !rowne(razemZapis, razem) && !w.uwaga) {
      problemy.push(`dzien ${d}: wniosek (${razem}) rozni sie od zapisu (${zapis.razem}) bez uwagi - naruszenie polityki odczytu`);
    }
    /* K1 — GODZINY WEJSCIA/WYJSCIA JAKO SUFIT (regula ustalona z uzytkownikiem):
       wpisane RAZEM moze byc MNIEJSZE niz czas obecnosci (odliczona przerwa -
       tak wypelniaja karty w stajni, to normalne i nie alarmujemy), ale nigdy
       WIEKSZE - nie da sie przepracowac wiecej, niz sie bylo. RAZEM > rozpietosc
       to alarm: pole sporne i karta do czlowieka. */
    const zCzasu = czasZOdDo(zapis.od, zapis.do);
    let przekroczenie = false;
    if (zCzasu !== null && razem !== null) {
      if (rowne(zCzasu, razem)) zgodneOdDo++;
      else if (razem > zCzasu + 0.011) {
        przekroczenie = true; niezgodneOdDo++;
        sporne.push({ dzien: d, pole: 'RAZEM', zapis: zapis.razem ?? null, wniosek: razem, zGodzin: zCzasu,
          uwaga: `wpisano ${razem} h, a z godzin ${zapis.od}-${zapis.do} wychodzi ${zCzasu} h - nie da sie przepracowac wiecej niz obecnosc` });
      } else {
        odliczonePrzerwy += Math.round((zCzasu - razem) * 100) / 100;
      }
    } else if (razem !== null && razem > 0) brakOdDo++;

    // Brakujacy wpis: jest godzina rozpoczecia, a nie ma ani zakonczenia, ani RAZEM.
    // To nie jest dzien wolny - ktos po prostu nie dokonczyl wiersza (Czurylowicz
    // 6/2026 dz.28: przepracowane 8 h, ktorych na karcie nie ma wcale).
    if (razem === null && zCzasu === null && String(zapis.od || '').trim()
        && !String(zapis.do || '').trim() && !wniosek.kod) {
      brakujaceWpisy.push(d);
      sporne.push({ dzien: d, pole: 'RAZEM', zapis: zapis.od, wniosek: null,
        uwaga: `wpisano godzine rozpoczecia (${zapis.od}), brak zakonczenia i sumy - ile godzin tego dnia?` });
    }

    // 100% tylko w swieta
    const sto = L(wniosek.sto);
    if (sto !== null && sto !== 0 && rok && mies) {
      if (!swieta.includes(d)) ostrzezenia.push(`dzien ${d}: godziny 100% w dniu, ktory nie jest swietem`);
      else if (razem !== null && !rowne(sto, razem)) ostrzezenia.push(`dzien ${d}: 100% (${sto}) rozni sie od RAZEM (${razem})`);
    }
    /* PRACA W SWIETO BEZ WPISU W KOLUMNIE 100% -> POLE SPORNE, nie ostrzezenie.
       Ostrzezenie nie blokuje bramki `auto`, a wlasnie tedy uciekl blad: karta
       Malag 8/2026 przeszla automatem z 155,5 h, bo silnik zgubil 12,5 h
       wpisane w kolumnie 100% przy 15 sierpnia (poprawnie: 168 h). Niezalezne
       potwierdzenie sprawdza WYLACZNIE kolumne RAZEM i wiersz SUMA, wiec
       zgubiona setka przechodzila bez sladu. Swiat w miesiacu jest jeden lub
       zaden, a wpis 100% zwykle jest - w sierpniu 2026 na 12 osob pracujacych
       15.08 brakowalo go w dwoch przypadkach, wiec regula nie zaleje czlowieka
       pytaniami, a lapie dokladnie ten rodzaj cichej straty. */
    if (razem !== null && razem > 0 && swieta.includes(d) && (sto === null || sto === 0)) {
      sporne.push({ dzien: d, pole: '100%', zapis: zapis.sto ?? null, wniosek: sto,
        uwaga: `dzien ${d} to swieto ustawowe, przepracowano ${razem} h, `
          + 'a kolumna 100% jest pusta - czy naleza sie godziny 100%?' });
    }
    if (w.pewnosc === 'niska' && !(zCzasu !== null && razem !== null && rowne(zCzasu, razem))) {
      sporne.push({ dzien: d, pole: 'RAZEM', zapis: zapis.razem ?? null, wniosek: razem, uwaga: w.uwaga || null });
    }

    // Godziny dnia: wpisane RAZEM, ale NIGDY wiecej niz czas obecnosci.
    // Przekroczenie i tak jest juz zgloszone jako sporne wyzej.
    /* ZRODLO GODZIN zalezy od obiektu (ustalenie z uzytkownikiem):
       - stajnia: liczy sie WPISANE RAZEM (ludzie odliczaja tam przerwy), a czas
         obecnosci jest tylko sufitem,
       - reszta (hotel, kuchnia, bar): zrodlem prawdy sa GODZINY WEJSCIA/WYJSCIA,
         a rozjazd z kolumna RAZEM to blad w sumowaniu - do raportu. */
    let godziny;
    if (zrodloRazem) {
      godziny = (razem !== null && zCzasu !== null) ? Math.min(razem, zCzasu)
        : (razem !== null ? razem : zCzasu);
      /* SUFIT UCIAL CZYSTA LICZBE NA BRZYDKI UŁAMEK -> pytamy.
         Karty wypelnia sie w polowkach godziny. Gdy z godzin obecnosci wychodzi
         wartosc, ktora polowka nie jest (Zak 8/2026 dzien 20: wpisane 9 h,
         a 9:40-18:30 daje 8,83), to zwykle zle odczytane MINUTY, nie realny
         czas pracy - a wynik i tak podmienia czysta liczbe z karty. */
      if (razem !== null && zCzasu !== null && godziny < razem
          && Math.abs(godziny * 2 - Math.round(godziny * 2)) > 1e-9) {
        sporne.push({ dzien: d, pole: 'RAZEM', zapis: zapis.razem ?? null, wniosek: godziny, zGodzin: zCzasu,
          uwaga: `wpisano ${razem} h, ale z godzin ${zapis.od}-${zapis.do} wychodzi ${godziny} h `
            + '- to nie jest pelna polowka godziny, wiec minuty moga byc zle odczytane' });
      }
    } else {
      godziny = zCzasu !== null ? zCzasu : razem;
      if (zCzasu !== null && razem !== null && !rowne(zCzasu, razem) && !przekroczenie) {
        const roz = Math.round((razem - zCzasu) * 100) / 100;
        if (Math.abs(roz) > 2) {
          // duza roznica to raczej zle odczytana godzina niz pomylka w dodawaniu
          sporne.push({ dzien: d, pole: 'RAZEM', zapis: zapis.razem ?? null, wniosek: razem, zGodzin: zCzasu,
            uwaga: `godziny ${zapis.od}-${zapis.do} daja ${zCzasu} h, a wpisano ${razem} - roznica ${roz} h jest za duza na pomylke w dodawaniu` });
        } else {
          bledySumowania.push({ dzien: d, wpisano: razem, zGodzin: zCzasu, roznica: roz });
          ostrzezenia.push(`dzien ${d}: blad w sumowaniu - z godzin ${zapis.od}-${zapis.do} wychodzi ${zCzasu} h, wpisano ${razem}`);
        }
      }
    }
    dni.push({ d, razem: godziny, razemWpisane: razem, razemZapis, kod: wniosek.kod || null,
      sto, nocne: L(wniosek.nocne), uw: L(wniosek.uw), chor: L(wniosek.chor),
      od: zapis.od ?? null, do: zapis.do ?? null, zCzasu, przekroczenie,
      pewnosc: w.pewnosc, uwaga: w.uwaga || null });
  }

  /* Dni, ktore grafik zna jako ZMIANE, a karta ma pusty wiersz. Nie doliczamy
     ich - zrodlem jest karta - ale zglaszamy, bo to zwykle zapomniany wpis
     (Korgul 6/2026 dzien 17: 12 h w grafiku, na karcie nic). */
  if (grafikDni) {
    for (const [dStr, g] of Object.entries(grafikDni)) {
      const d = Number(dStr);
      if (!g || g.kod || !(g.godziny > 0)) continue;
      const w = dni.find(x => x.d === d);
      const pustyNaKarcie = !w || (w.razem === null && !w.kod);
      if (pustyNaKarcie) {
        sporne.push({ dzien: d, pole: 'RAZEM', wniosek: null, zGrafiku: g.godziny,
          uwaga: `grafik ma tego dnia zmiane ${g.godziny} h, a na karcie pusty wiersz `
            + `- czy pracowala i zapomniala wpisac?` });
      }
    }
  }

  /* sumy i ścieżki dowodowe */
  const sumaDni = sumuj(dni.map(x => x.razem));            // WYNIK (z wniosków)
  const sciezkaA = dni.every(x => x.razem === null || x.razemZapis !== null)
    ? sumuj(dni.map(x => x.razemZapis)) : null;            // a) literalne zapisy
  const s = p0.suma || {};
  const sciezkaB = L(s.wniosek && s.wniosek.razem);        // b) wiersz SUMA
  // Czasy od/do NIE sa juz osobna sciezka dowodowa: sluza jako SUFIT dla kazdego
  // dnia (patrz K1 wyzej). Przerwa odliczona w dol jest normalna i nie alarmuje,
  // przekroczenie w gore od razu ladowalo w "sporne".
  const przekroczen = dni.filter(x => x.przekroczenie).length;

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
      // porownujemy z tym, co WPISANO w kolumnie RAZEM (slepy odczyt transkrybuje
      // te sama kolumne), a nie z wartoscia po ograniczeniu sufitem od/do
      const pv = wiersz ? (wiersz.razemWpisane !== undefined ? wiersz.razemWpisane : wiersz.razem) : null;
      const zgodne = (sn === null && pv === null) || rowne(sn, pv);
      if (!zgodne) {
        sporne.push({ dzien: d, pole: 'RAZEM', wniosek: pv, slepaKolumna: sv,
          uwaga: 'slepa transkrypcja kolumny RAZEM rozni sie od odczytu glownego' });
      }
      suma += sn || 0;
    }
    sciezkaD = kompletna ? Math.round(suma * 100) / 100 : null;
    // slepa kolumna sumuje WPISANE RAZEM; gdy odliczylismy przerwy, jej suma
    // bedzie wyzsza o dokladnie te przerwy - wtedy tez uznajemy ja za zgodna
    if (sciezkaD !== null && odliczonePrzerwy > 0
        && Math.abs(sciezkaD - odliczonePrzerwy - sumaDni) <= 0.011) sciezkaD = sumaDni;
    // wiersz SUMA wg ślepej transkrypcji — drugi głos przy spornym wierszu SUMA
    const slepaSuma = L(slepy.suma);
    if (slepaSuma !== null && sciezkaB !== null && !rowne(slepaSuma, sciezkaB)) {
      sporne.push({ dzien: 'SUMA', pole: 'RAZEM', wniosek: sciezkaB, slepaKolumna: slepy.suma,
        uwaga: 'slepa transkrypcja wiersza SUMA rozni sie od odczytu glownego' });
    }

    /* KOLUMNY 100% I NOCNE TEZ MAJA MIEC DRUGI GLOS.
       Godziny 100% DOLICZAJA sie do miesiaca, a do sierpnia 2026 zadna sciezka
       ich nie sprawdzala: slepa transkrypcja czytala wylacznie RAZEM. Karta
       Malag przeszla przez to automatem z 155,5 h zamiast 168 - silnik zgubil
       12,5 h wpisane w kolumnie 100% przy 15 sierpnia i nikt tego nie zauwazyl.
       Porownujemy dzien po dniu; rozjazd = pole sporne (idzie tez do zoomu). */
    for (const [pole, etykieta] of [['sto', '100%'], ['nocne', 'nocne']]) {
      const maKolumne = slepy.dni.some(w => w[pole] !== undefined);
      if (!maKolumne) continue;                 // starszy odczyt bez tych kolumn
      for (const w of slepy.dni) {
        const d = Number(w.d);
        if (!(d >= 1 && d <= dniWMies)) continue;
        const sv = String(w[pole] ?? '');
        if (sv === '?') continue;
        const sn = L(sv);
        const wiersz = dni.find(x => x.d === d);
        const pv = wiersz ? L(wiersz[pole]) : null;
        if ((sn === null && pv === null) || rowne(sn, pv)) continue;
        sporne.push({ dzien: d, pole: etykieta, wniosek: pv, slepaKolumna: sv,
          uwaga: `slepa transkrypcja kolumny ${etykieta} rozni sie od odczytu glownego` });
      }
    }
  }

  const sciezki = {
    zapisyDni: sciezkaA, wierszSuma: sciezkaB, slepaKolumna: sciezkaD,
    odliczonePrzerwy: Math.round(odliczonePrzerwy * 100) / 100, przekroczen,
    zgodne: [
      ['zapisyDni', sciezkaA], ['wierszSuma', sciezkaB], ['slepaKolumna', sciezkaD],
    ].filter(([, v]) => rowne(v, sumaDni)).map(([k]) => k),
  };
  const brakWierszaSumy = sciezkaB === null;
  if (!brakWierszaSumy && !rowne(sciezkaB, sumaDni)) {
    // Wiersz SUMA liczy pracownik i bywa po prostu zle policzony (albo zawiera
    // juz doliczona setke). Zglaszamy jako sporne do sprawdzenia, ale to nie
    // "problem" karty - naszym zrodlem sa dni, nie jego rachunek.
    sporne.push({ dzien: 'SUMA', pole: 'RAZEM', zapis: s.zapis && s.zapis.razem, wniosek: sciezkaB, sumaDni,
      uwaga: `pracownik podsumowal ${sciezkaB}, a z dni wychodzi ${sumaDni}` });
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
  const nadpisanaStawka = !!(okres.stawkiDnia && nazwisko && okres.stawkiDnia[nazwisko]);
  // Osoby w grafiku zmianowym (12/12): ptaszek stoi na kazdym dniu kalendarzowym
  // nieobecnosci, ale platne sa tylko te dni, w ktorych mialy zmiane - a tego
  // z karty nie widac. Zamiast zgadywac, pytamy.
  const grafikZmianowy = !!(okres.grafikZmianowy && nazwisko
    && okres.grafikZmianowy.includes(nazwisko));
  const stawkaDnia = (nadpisanaStawka && okres.stawkiDnia[nazwisko])
    || Number(okres.domyslnaStawkaDnia) || 8;
  const czyPtaszek = v => /^[vV+xX\u2713\u2714]$/.test(String(v || '').trim());
  const kolumnaNieobecnosci = (pole, lit, etykieta) => {
    const zSumy = L(s.wniosek && s.wniosek[pole]);
    const zDni_ = zDni(pole);                               // godziny wpisane liczbowo w dniach
    const ozn = p0.dni.filter(x => czyPtaszek(x.zapis && x.zapis[pole])
      || czyPtaszek(x.wniosek && x.wniosek[pole])).length;  // ptaszki w RUBRYCE
    const kodow = dni.filter(x => String(x.kod || '').toUpperCase().startsWith(lit)).length;
    if (ozn > 0) {
      // ptaszki = dni nieobecnosci (regula kadr: dzien x stawka)
      /* GRAFIK ZMIANOWY (12/12): ptaszek stoi przy KAZDYM dniu kalendarzowym
         nieobecnosci, ale platne sa tylko te dni, w ktorych osoba miala zmiane.
         Z karty tego nie widac (Korgul 6/2026: 6 ptaszkow, arkusz placi za 3),
         a rytm pracy bywa nieregularny - wiec nie zgadujemy, tylko pytamy. */
      /* Najpierw grafik: on wie, ktore z oznaczonych dni byly zmianami i po ile
         godzin. Dni bez zmiany daja 0 (i tak by nie pracowala), dni bez wpisu
         w grafiku zostaja pytaniem - nie zgadujemy. */
      if (grafikDni) {
        const oznaczone = p0.dni.filter(x => czyPtaszek(x.zapis && x.zapis[pole])
          || czyPtaszek(x.wniosek && x.wniosek[pole])).map(x => Number(x.d));
        let suma = 0; const bezDanych = [], zmiany = [];
        for (const d of oznaczone) {
          const g = grafikDni[d];
          if (!g || g.godziny === null || g.godziny === undefined) { bezDanych.push(d); continue; }
          if (g.godziny > 0) { suma += g.godziny; zmiany.push(d); }
        }
        if (bezDanych.length) {
          sporne.push({ dzien: 'SUMA', pole: etykieta, wniosek: suma, dniBezGrafiku: bezDanych,
            uwaga: `wg grafiku ${zmiany.length} zmian = ${suma} h, ale dni ${bezDanych.join(', ')} `
              + `nie maja godzin w grafiku - ile ich bylo?` });
        } else {
          ostrzezenia.push(`${etykieta}: ${ozn} dni oznaczonych, wg grafiku ${zmiany.length} to zmiany `
            + `(${zmiany.join(', ')}) = ${suma} h`);
        }
        return suma;
      }
      if (grafikZmianowy) {
        sporne.push({ dzien: 'SUMA', pole: etykieta, wniosek: null, dniOznaczone: ozn,
          uwaga: `${ozn} dni oznaczonych ptaszkiem, ale osoba pracuje w grafiku zmianowym `
            + `- ile z tych dni to jej zmiany? (brak grafiku dla tego miesiaca)` });
        return 0;
      }
      if (zSumy === null || rowne(zSumy, ozn)) {
        ostrzezenia.push(`${etykieta}: ${ozn} dni (ptaszki) x ${stawkaDnia} h = ${ozn * stawkaDnia} h`);
        return ozn * stawkaDnia;
      }
      if (rowne(zSumy, ozn * stawkaDnia)) return zSumy;
      sporne.push({ dzien: 'SUMA', pole: etykieta, wniosek: zSumy,
        uwaga: `${ozn} ptaszkow, a w SUMIE ${zSumy} - nie pasuje ani do dni, ani do ${ozn}x${stawkaDnia} h` });
      return zSumy;
    }
    /* REGULA KADR (uzytkownik, 2026-08-29): urlop i chorobowe licza sie
       WEDLUG STAWKI OSOBY, niezaleznie od tego, co pracownik wpisal w rubryce
       - ptaszek, "8", czy nic. Liczy sie LICZBA DNI oznaczonych. Dzieki temu
       Podolecki (3/4 etatu) dostaje 6 h za dzien, choc na karcie ma wpisane 8. */
    const dniZLiczba = p0.dni.filter(x => (L(x.wniosek && x.wniosek[pole]) || 0) > 0).length;
    if (dniZLiczba > 0) {
      // GODZINY WPISANE PRZY DNIACH SA WIAZACE - dzien nieobecnosci to dlugosc
      // zmiany danej osoby, a pracownik ja zna: 12-godzinne zmiany maja wpisane
      // po 12 h (Grenda, Kuleta - potwierdzone arkuszem), biurowe po 8.
      // WYJATEK: osoby z jawna stawka w stawkiDnia (3/4 etatu) - tam wpis bywa
      // zawyzony (Podolecki ma na karcie 8 h, a nalezy mu sie 6).
      if (nadpisanaStawka) {
        const godzin = dniZLiczba * stawkaDnia;
        if (!rowne(zDni_, godzin)) {
          ostrzezenia.push(`${etykieta}: ${dniZLiczba} dni oznaczonych, na karcie ${zDni_} h - liczymy wg stawki osoby ${stawkaDnia} h/dzien = ${godzin} h`);
        }
        return godzin;
      }
      if (zSumy !== null && !rowne(zSumy, zDni_) && !rowne(zSumy, dniZLiczba)) {
        sporne.push({ dzien: 'SUMA', pole: etykieta, wniosek: zSumy,
          uwaga: `przy dniach lacznie ${zDni_} h (${dniZLiczba} dni), a w wierszu SUMA ${zSumy}` });
      }
      return zDni_;
    }
    if (zSumy === null) {
      // litery U/C w kolumnie rozpoczecia BEZ oznaczen w rubryce: Ala ich nie
      // dolicza (Zak 6/2026), wiec my tez nie - tylko slad w ostrzezeniach
      if (kodow > 0) ostrzezenia.push(`${etykieta}: ${kodow} dni z litera ${lit} w kolumnie rozpoczecia, bez oznaczen w rubryce - NIE doliczono`);
      return 0;
    }
    if (zDni_ !== 0) {
      if (!rowne(zSumy, zDni_)) problemy.push(`kolumna ${etykieta}: suma z dni (${zDni_}) nie zgadza sie z wierszem SUMA (${zSumy})`);
      return zSumy;
    }
    // sama liczba w SUMIE, zero informacji z dni: mala calkowita moze byc
    // LICZBA DNI (Korgul 6/2026: "6" = 6 dni = 48 h, nie 6 h) - nie zgadujemy
    if (zSumy > 0 && zSumy <= 16 && Number.isInteger(zSumy)) {
      sporne.push({ dzien: 'SUMA', pole: etykieta, wniosek: zSumy,
        uwaga: `wartosc ${zSumy} moze byc liczba DNI (${zSumy * stawkaDnia} h) albo godzin - brak oznaczen dziennych, wymaga czlowieka` });
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
  if (nazwiskoOk && niezalezne >= 1 && problemy.length === 0 && sporne.length === 0) status = 'auto';
  else if (nazwiskoOk && potwierdzenia >= 1 && problemy.length === 0 && sporne.length === 0) status = 'auto_slabe';

  return {
    strona, ok: status === 'auto',
    status, nazwisko, nazwiskoOk,
    nazwiskaOdczytane: [n1, n2].filter(Boolean),
    rok, rokDomyslny, miesiac: mies, normaZKarty,
    C, G, sumaDni, wierszSuma: sciezkaB, brakWierszaSumy, sto, uw, chor,
    sciezki, potwierdzenia,
    problemy, ostrzezenia, sporne,
    bledySumowania, brakujaceWpisy,
    zrodloGodzin: zrodloRazem ? 'razem' : 'odDo',
    rozbieznosci: p0.rozbieznosci || [],
    dni,
  };
}

module.exports = { zszyjIKontroluj, L, parseCzasy, czasZOdDo, klucz, dopasujDoListy, odlegloscEdycyjna };
