'use strict';
/**
 * zlecenia.js — odczyt teczki kart „umowa zlecenie".
 *
 * CZYM SIĘ RÓŻNI OD KARTY PRACY (i dlaczego to osobna ścieżka, a nie flaga):
 *  - inny formularz: Dzień | Liczba godzin | Podpis, dni pionowo, bez kolumn
 *    100%/nocne/UW/Chor.,
 *  - w rubryce godzin jest PRZEDZIAŁ ("7:00 - 15:00"), nie liczba — sumę robi
 *    KOD z godzin od/do, model tylko przepisuje,
 *  - wiersz SUMA jest zwykle pusty (38 kart sierpnia 2026: ani jednego wpisu),
 *    więc odpada kontrola „suma z karty",
 *  - NIE MA zamkniętej listy nazwisk: zleceniobiorcy zmieniają się co miesiąc,
 *  - nie ma urlopów, chorobowego ani godzin 100% — nie ma czego doliczać.
 *
 * Skoro odpadły dwie z trzech ścieżek dowodowych karty pracy, potwierdzeniem
 * jest DRUGI CZYTELNIK innego dostawcy: obaj czytają tę samą kartę osobno,
 * a kod porównuje dzień po dniu. Priorytet od użytkownika: „literówki w nazwisku
 * nie są straszne, najważniejsze żeby suma godzin się zgadzała" — więc bramką
 * `auto` jest zgodność GODZIN, a rozjazd w nazwisku to tylko ostrzeżenie.
 */

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { pdfPageCount, renderPage } = require('./render');
const { obrazyZlecenia, obrazyZleceniaPaski } = require('./obrazy');
const { zapytaj } = require('./silnik');
const silnikOpenai = require('./silnik-openai');
const { SCHEMAT_ZLECENIE, PROMPT_ZLECENIE, PROMPT_ZLECENIE_PASKI } = require('./prompty-zlecenie');
const { czasZOdDo, L } = require('./walidacja');
const { dniMiesiaca } = require('./kalendarz');

const CENY_USD_MTOK = { we: 5, wy: 25 };
const CENY_DRUGI_MTOK = { we: 0.2, wy: 1.2 };
const MIESIACE = ['STYCZEN', 'LUTY', 'MARZEC', 'KWIECIEN', 'MAJ', 'CZERWIEC', 'LIPIEC',
  'SIERPIEN', 'WRZESIEN', 'PAZDZIERNIK', 'LISTOPAD', 'GRUDZIEN'];

const bezOgonkow = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toUpperCase().replace(/Ł/g, 'L');

/** "SIERPIEŃ" -> 8; liczba -> liczba; null gdy nie wiadomo */
function numerMiesiaca(v) {
  const t = bezOgonkow(v).trim();
  if (!t) return null;
  const n = Number(t);
  if (Number.isFinite(n) && n >= 1 && n <= 12) return n;
  const i = MIESIACE.findIndex(m => t.startsWith(m.slice(0, 6)));
  return i >= 0 ? i + 1 : null;
}

/* JAK LUDZIE WYPELNIAJA RUBRYKE "Liczba godzin" - policzone na 593 wypelnionych
   rubrykach sierpnia 2026, nie wymyslone:
     173x  sama liczba godzin ("8", "9,5")
     ~200x sam przedzial ("7 00 - 15 00", "9:00-17:00", "8 14")
     211x  PRZEDZIAL I WYPISANA LICZBA naraz ("15.30 - 24.00 - 8,5h", "11 - 23 30 /12,5h")
   Tej trzeciej postaci pierwsza wersja w ogole nie widziala i liczyla wszystko
   z przedzialu - stad na karcie Lugowskiego wyszlo 153,16 h zamiast 8,5 h w dniu,
   gdzie czlowiek sam napisal "8,5h" obok zapisu 9:00-18:20.

   ZASADA (ta sama, co przy stajni): WYPISANA PRZEZ CZLOWIEKA LICZBA JEST ZRODLEM,
   przedzial jest kontrola. Gdy oba sa i sie nie zgadzaja - karta sama sobie
   przeczy i idzie do czlowieka, bez zgadywania ktore ma racje. */

/** "15 30" | "15:30" | "15.30" | "1530" | "9" -> "15:30" (albo null) */
function czasToken(t) {
  const x = String(t || '').trim().replace(/\s+/g, ' ');
  if (!x) return null;
  let m = x.match(/^(\d{1,2})\s*[:.]\s*(\d{2})$/) || x.match(/^(\d{1,2})\s+(\d{2})$/);
  if (m) return `${m[1]}:${m[2]}`;
  /* PRZECINEK W GODZINIE ZNACZY DWIE ROZNE RZECZY - i obie sa na tych kartach:
       "22,30" -> 22:30 (minuty),      "13,5" -> 13:30 (polowa godziny).
     Bez tego "7 - 13,5" czytalo sie jako 7:00-13:00, wiec zamiast 6,5 h
     wychodzilo 6 i karta Subotowicz dostawala siedem falszywych sprzecznosci. */
  m = x.match(/^(\d{1,2})\s*,\s*(\d{1,2})$/);
  if (m && Number(m[1]) <= 24) {
    const min = m[2].length === 1 ? Math.round(Number(m[2]) / 10 * 60) : Number(m[2]);
    if (min < 60) return `${m[1]}:${String(min).padStart(2, '0')}`;
  }
  m = x.match(/^(\d{1,2})(\d{2})$/);            // "700", "1530" - male zera zlaly sie z godzina
  if (m && Number(m[1]) <= 24 && Number(m[2]) < 60) return `${m[1]}:${m[2]}`;
  m = x.match(/^(\d{1,2})$/);
  return (m && Number(m[1]) <= 24) ? `${m[1]}:00` : null;
}

// czas w przedziale: "9", "900", "9:00", "9.00", "9 00"
const CZAS = '\\d{1,2}(?:\\s*[:.,]\\s*\\d{1,2}|\\s\\d{2}|\\d{2})?';

/**
 * Rozbiera rubryke na to, co w niej naprawde jest: przedzial i/albo wypisana
 * liczbe godzin. Wzorce wziete z 593 wypelnionych rubryk sierpnia 2026.
 * @returns {{zakres: number|null, deklarowane: number|null, od: string, do: string}}
 */
function rozbierzZapis(zapis) {
  let t = String(zapis || '').replace(/[⁰°]/g, '0').replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ').trim();
  if (!t || t === '-') return { zakres: null, deklarowane: null, od: '', do: '' };

  // 1. jawnie wypisane godziny: "8,5h" albo "/ 12,5"
  let deklarowane = null;
  /* "8h30min", "6h30", "7h 30 m" - godziny I MINUTY. Bez tego z "8h30min"
     zostawalo samo 8 i karta Kopinskiego dostawala dziesiec falszywych
     sprzecznosci po pol godziny kazda. */
  const zHiMin = t.match(/(\d{1,2})\s*h\s*(\d{1,2})\s*(?:min|m)?\b/i);
  if (zHiMin && Number(zHiMin[2]) < 60) {
    deklarowane = Number(zHiMin[1]) + Number(zHiMin[2]) / 60;
    deklarowane = Math.round(deklarowane * 100) / 100;
    t = t.replace(zHiMin[0], ' ');
  }
  const zH = deklarowane === null && t.match(/(\d{1,2}(?:[.,]\d+)?)\s*(?:h|godz\.?)\b/i);
  if (zH) { deklarowane = Number(zH[1].replace(',', '.')); t = t.replace(zH[0], ' '); }
  else if (deklarowane === null) {
    const zUkosnikiem = t.match(/\/\s*(\d{1,2}(?:[.,]\d+)?)/);
    if (zUkosnikiem) { deklarowane = Number(zUkosnikiem[1].replace(',', '.')); t = t.replace(zUkosnikiem[0], ' '); }
  }

  /* 2. przedzial "od - do". Trudnosc: liczba godzin bywa wpisana PRZED albo PO
     przedziale, bez zadnego separatora ("11   11-22", "10 - 22  12"), a zapis
     godziny bywa "7 00". Same wzorce sa nierozstrzygalne w oderwaniu:
     "7 00 - 15 00" to 7:00-15:00, ale "11 11-22" to 11 godzin i przedzial 11-22.
     Dlatego zamiast zgadywac generujemy WARIANTY ROZBIORU i wybieramy ten,
     w ktorym wypisana liczba zgadza sie z przedzialem - karta sama sobie
     odpowiada, ktora interpretacja jest wlasciwa. */
  let od = '', doo = '';
  const grupy = t.split('-').map(x => x.trim()).filter(Boolean);
  if (grupy.length >= 2) {
    /* Trzecia grupa to wypisana liczba godzin: "6 - 14 - 8" znaczy 6:00-14:00
       i osiem godzin. Bez tego (branie pierwszego myslnika zamiast podzialu na
       grupy) karta Bobrowicz gubila 55 h - przedzial przepadal, a zostawala
       sama "6" jako liczba godzin. */
    if (grupy.length >= 3 && deklarowane === null) {
      const d = Number(String(grupy[grupy.length - 1]).replace(',', '.'));
      if (Number.isFinite(d) && d >= 0 && d <= 24) deklarowane = d;
    }
    const lewo = grupy[0].split(/\s+/).filter(Boolean);
    const prawo = grupy[1].split(/\s+/).filter(Boolean);
    const wariantyL = [{ czas: lewo.join(' '), extra: null }];
    if (lewo.length > 1) wariantyL.push({ czas: lewo.slice(1).join(' '), extra: lewo[0] });
    const wariantyP = [{ czas: prawo.join(' '), extra: null }];
    if (prawo.length > 1) wariantyP.push({ czas: prawo.slice(0, -1).join(' '), extra: prawo[prawo.length - 1] });

    let najlepszy = null;
    for (const l of wariantyL) {
      for (const pr of wariantyP) {
        const a = czasToken(l.czas), b = czasToken(pr.czas);
        if (!a || !b) continue;
        const zak = czasZOdDo(a, b);
        if (zak === null || zak <= 0 || zak > 24) continue;
        const extra = l.extra ?? pr.extra;
        const dekl = deklarowane !== null ? deklarowane
          : (extra !== null ? Number(String(extra).replace(',', '.')) : null);
        let punkty = 0;
        if (dekl !== null && Number.isFinite(dekl) && Math.abs(dekl - zak) <= 0.011) punkty += 3;
        if (Math.abs(zak * 4 - Math.round(zak * 4)) < 1e-9) punkty += 1;   // pelne kwadranse
        if (l.extra === null && pr.extra === null) punkty += 0.5;          // bez naddatkow
        if (!najlepszy || punkty > najlepszy.punkty) najlepszy = { a, b, zak, dekl, punkty };
      }
    }
    if (najlepszy) {
      od = najlepszy.a; doo = najlepszy.b;
      if (deklarowane === null && najlepszy.dekl !== null && Number.isFinite(najlepszy.dekl)
          && najlepszy.dekl >= 0 && najlepszy.dekl <= 24) deklarowane = najlepszy.dekl;
      t = '';
    }
  } else if (grupy.length === 1) {
    const bezMyslnika = t.match(new RegExp(`^(${CZAS})\\s+(${CZAS})$`));
    if (bezMyslnika) {
      od = czasToken(bezMyslnika[1]) || ''; doo = czasToken(bezMyslnika[2]) || '';
      if (od && doo) t = '';
    }
  }

  // 3. co zostalo po wycieciu przedzialu to wypisana liczba godzin.
  //    ALE: jesli w resztce nadal siedzi cos wygladajacego na GODZINE ZEGAROWA
  //    ("8:30"), to znaczy, ze nie zrozumielismy rubryki - lepiej oddac null
  //    i wyslac karte do czlowieka, niz wziac "8" z "8:30" jako osiem godzin.
  const reszta = t.replace(/[-\/]/g, ' ').trim();
  if (deklarowane === null && reszta) {
    if (/\d{1,2}\s*[:.]\s*\d{2}/.test(reszta)) {
      return { zakres: null, deklarowane: null, od: '', do: '', nieczytelne: true };
    }
    const liczba = reszta.match(/(\d{1,2}(?:[.,]\d+)?)/);
    if (liczba) {
      const d = Number(liczba[1].replace(',', '.'));
      if (Number.isFinite(d) && d >= 0 && d <= 24) deklarowane = d;
    }
  }
  const zakres = (od && doo) ? czasZOdDo(od, doo) : null;
  return { zakres, deklarowane, od, do: doo };
}

const czySkreslone = w => /^tak$/i.test(String((w && w.skreslone) || '').trim());

/**
 * Dopisek z kolumny podpisu albo druga zmiana: sama liczba ("9"), jeden przedzial
 * ("11 - 22") albo dwa przedzialy ("6-8 30  11-22" = 13,5 h). Zwraca liczbe godzin
 * albo null, gdy nic sensownego z tego nie wychodzi.
 *
 * Po co: na czesci kart TO JEST jedyne miejsce, gdzie czlowiek podal wynik.
 * Stepnowski dzien 17: w rubryce "11-19 kl. 11-20", przy podpisie jego "9".
 */
function wartoscZDopisku(tekst) {
  const t = String(tekst || '').replace(/[⁰°]/g, '0').replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ').trim();
  if (!t || t === '-') return null;
  /* Skanujemy PRZEDZIALY, a nie oddajemy tego rozbierzZapis - tam podzial na
     grupy po myslniku bierze ostatnia grupe za wypisana liczbe godzin, wiec
     "6 - 8 30  11 - 22" konczylo sie jako 22 h zamiast 13,5 h. */
  const re = new RegExp(`(${CZAS})\\s*-\\s*(${CZAS})`, 'g');
  let suma = null, m;
  while ((m = re.exec(t)) !== null) {
    const a = czasToken(m[1]), b = czasToken(m[2]);
    const z = (a && b) ? czasZOdDo(a, b) : null;
    if (z === null || z <= 0 || z > 24) continue;
    suma = (suma || 0) + z;
  }
  if (suma !== null) return Math.round(suma * 100) / 100;
  const liczba = L(t);
  return (liczba !== null && liczba >= 0 && liczba <= 24) ? liczba : null;
}

/** godziny jednego dnia: wypisana liczba ma pierwszenstwo, przedzial to kontrola */
function godzinyDnia(w) {
  // Wiersz przekreslony = dzien anulowany. Model przepisuje tresc, odlicza kod.
  if (czySkreslone(w)) return 0;
  const r = rozbierzZapis(w.zapis);
  let g = null;
  if (r.deklarowane !== null) g = r.deklarowane;
  else if (r.zakres !== null) g = r.zakres;
  else {
    // model rozbil przedzial na pola od/do, a w "zapis" nic sensownego nie zostalo
    const z = czasZOdDo(w.od, w.do);
    if (z !== null) g = z;
    else {
      const liczba = L(w.zapis);
      if (liczba !== null && liczba >= 0 && liczba <= 24) g = liczba;
    }
  }
  /* DRUGA ZMIANA TEGO SAMEGO DNIA - doliczamy, nie zastepujemy. */
  const g2 = wartoscZDopisku(w.zapis2);
  if (g2 !== null) g = Math.round(((g || 0) + g2) * 100) / 100;
  /* Rubryka pusta albo nieczytelna, a przy podpisie czlowiek napisal ile
     przepracowal - to jest wtedy jedyne zrodlo. */
  if (g === null) g = wartoscZDopisku(w.zapisPodpis);
  return g;
}

/**
 * Walidacja karty zlecenia. Wszystko liczy kod; model dostarcza wyłącznie
 * transkrypcję.
 * @param {object} p0     odczyt główny
 * @param {object} drugi  odczyt drugiego dostawcy (może być null)
 * @param {object} okres  {rok, miesiac} narzucone z zewnątrz
 */
function walidujZlecenie(p0, drugi, okres = {}, strona = null) {
  const problemy = [], ostrzezenia = [], sporne = [];
  if (!p0 || !Array.isArray(p0.dni)) {
    return { strona, ok: false, status: 'do_weryfikacji', problemy: ['odczyt nie zwrocil dni'],
      ostrzezenia, sporne };
  }
  const rok = Number(okres.rok || p0.rok) || null;
  const mies = Number(okres.miesiac) || numerMiesiaca(p0.miesiac) || null;
  const ileDni = (rok && mies) ? dniMiesiaca(rok, mies) : 31;

  const dni = [];
  let suma = 0;
  for (const w of p0.dni) {
    const d = Number(w.d);
    if (!(d >= 1 && d <= ileDni)) continue;
    if (dni.some(x => x.d === d)) continue;                 // ten sam dzien dwa razy
    const g = godzinyDnia(w);
    if (g !== null && (g < 0 || g > 24)) {
      problemy.push(`dzien ${d}: ${g} h poza zakresem 0-24`);
      continue;
    }
    if (String(w.zapis || '').includes('?')) {
      sporne.push({ dzien: d, pole: 'godziny', zapis: w.zapis, wniosek: g,
        uwaga: w.uwaga || 'rubryka nieczytelna' });
    }
    /* WIERSZ PRZEKRESLONY. Sam w sobie nie jest sporny - jest anulowany i tyle.
       Sporny robi sie wtedy, gdy kreska idzie przez godziny, ale podpis zostal
       nietkniety: wtedy nie wiadomo, czy dzien odwolano, czy poprawiono zapis. */
    if (czySkreslone(w)) {
      const podpisany = /tak/i.test(String(w.podpis || ''));
      /* Czy podpis tez jest przekreslony, MODEL MA POWIEDZIEC WPROST - osobnym
         polem, nie zdaniem w uwadze. Pierwsza wersja czytala to regexem z uwagi
         i na Dabrowskiej d6 ("wpis godzin przekreslony; podpis nieprzekreslony")
         wyszlo jej, ze podpis jest skreslony - czyli dokladnie odwrotnie.
         Karta przeszla jako auto zamiast trafic do czlowieka. */
      const podpisTezSkreslony = /^tak$/i.test(String(w.podpisSkreslony || '').trim());
      ostrzezenia.push(`dzien ${d}: wiersz przekreslony, nie wliczony do sumy`);
      if (podpisany && !podpisTezSkreslony) {
        sporne.push({ dzien: d, pole: 'godziny', zapis: w.zapis, wniosek: 0,
          uwaga: 'godziny przekreslone, ale podpis w wierszu zostal - dzien anulowany czy poprawiony?' });
      }
    }
    /* LICZBA GODZIN PRZY PODPISIE. Gdy rubryka i dopisek daja co innego, karta
       przeczy sama sobie tak samo, jak przy przedziale kontra wypisana liczba. */
    const zPodpisu = wartoscZDopisku(w.zapisPodpis);
    if (!czySkreslone(w) && zPodpisu !== null && g !== null
        && Math.abs(zPodpisu - g) > 0.011) {
      sporne.push({ dzien: d, pole: 'godziny', zapis: w.zapis, wniosek: g,
        przyPodpisie: zPodpisu,
        uwaga: `z rubryki wychodzi ${g} h, a przy podpisie napisano ${zPodpisu}` });
    }
    /* KARTA PRZECZY SAMA SOBIE: wypisana liczba godzin nie zgadza sie
       z przedzialem obok niej. Nie zgadujemy, ktore ma racje. */
    const r = rozbierzZapis(w.zapis);
    if (r.deklarowane !== null && r.zakres !== null && Math.abs(r.deklarowane - r.zakres) > 0.011) {
      sporne.push({ dzien: d, pole: 'godziny', zapis: w.zapis, wniosek: r.deklarowane,
        zZakresu: r.zakres,
        uwaga: `wypisano ${r.deklarowane} h, a z godzin ${r.od}-${r.do} wychodzi ${r.zakres} h` });
    }
    // godziny bez podpisu i podpis bez godzin: zapisujemy, nie alarmujemy —
    // to normalne na tych kartach, ale idzie do sladu
    dni.push({ d, godziny: g, zapis: w.zapis || '', od: w.od || '', do: w.do || '',
      podpis: /tak/i.test(String(w.podpis || '')) });
    suma += g || 0;
  }
  suma = Math.round(suma * 100) / 100;

  /* Wiersz SUMA z karty - gdy ktos go wypelnil, to darmowa kontrola. */
  const sumaZKarty = L(p0.suma);
  if (sumaZKarty !== null && Math.abs(sumaZKarty - suma) > 0.011) {
    sporne.push({ dzien: 'SUMA', pole: 'godziny', zapis: p0.suma, wniosek: suma,
      uwaga: `na karcie wpisano ${sumaZKarty}, a z dni wychodzi ${suma}` });
  }

  /* DRUGI CZYTELNIK - jedyne mocne potwierdzenie, jakie tu mamy. */
  let sumaDrugiego = null;
  const rozjazdy = [];
  if (drugi && Array.isArray(drugi.dni)) {
    sumaDrugiego = 0;
    for (let d = 1; d <= ileDni; d++) {
      const a = dni.find(x => x.d === d);
      const b = drugi.dni.find(x => Number(x.d) === d);
      const ga = a ? a.godziny : null;
      const gb = b ? godzinyDnia(b) : null;
      sumaDrugiego += gb || 0;
      if (ga === null && gb === null) continue;
      if (ga === null || gb === null || Math.abs(ga - gb) > 0.011) {
        rozjazdy.push(d);
        sporne.push({ dzien: d, pole: 'godziny', wniosek: ga, drugiOdczyt: gb,
          zapis: a ? a.zapis : null,
          uwaga: 'drugi czytelnik (inny dostawca) odczytal ten dzien inaczej' });
      }
    }
    sumaDrugiego = Math.round(sumaDrugiego * 100) / 100;
    const nazwA = bezOgonkow(p0.imieNazwisko).replace(/[^A-Z ]+/g, ' ').trim();
    const nazwB = bezOgonkow(drugi.imieNazwisko).replace(/[^A-Z ]+/g, ' ').trim();
    if (nazwA && nazwB && nazwA !== nazwB) {
      // nazwisko pisane recznie, bez listy do dopasowania - literowka nie blokuje,
      // ale czlowiek ma widziec obie wersje
      ostrzezenia.push(`nazwisko: glowny "${p0.imieNazwisko}", drugi "${drugi.imieNazwisko}"`);
    }
  }

  if (!dni.length) problemy.push('nie odczytano ani jednego dnia z godzinami');
  if (mies && okres.miesiac && mies !== Number(okres.miesiac)) {
    problemy.push(`karta jest za miesiac ${mies}, a teczka za ${okres.miesiac}`);
  }

  const potwierdzona = sumaDrugiego !== null && Math.abs(sumaDrugiego - suma) <= 0.011 && !rozjazdy.length;
  const status = (potwierdzona && !problemy.length && !sporne.length) ? 'auto' : 'do_weryfikacji';

  return {
    strona, ok: status === 'auto', status,
    imieNazwisko: (p0.imieNazwisko || '').trim(),
    imieNazwiskoDrugi: drugi ? (drugi.imieNazwisko || '').trim() : null,
    rok, miesiac: mies,
    godziny: suma,
    godzinyDrugiego: sumaDrugiego,
    sumaZKarty,
    dniZGodzinami: dni.filter(x => x.godziny !== null).length,
    problemy, ostrzezenia, sporne, dni,
  };
}

async function przetworzStroneZlecenia(pdfPath, dir, strona, opcje) {
  const t0 = Date.now();
  let png, obrazy, sha;
  try {
    png = await renderPage(pdfPath, strona, dir, opcje.dpi || 300);
    sha = crypto.createHash('sha256').update(png).digest('hex').slice(0, 16);
    obrazy = opcje.trybObrazow === 'paski'
      ? await obrazyZleceniaPaski(png, { wierszyNaPasek: opcje.wierszyNaPasek })
      : await obrazyZlecenia(png);
  } catch (e) {
    return { strona, ok: false, status: 'do_weryfikacji',
      problemy: [`przygotowanie obrazow nie powiodlo sie: ${e.message}`], ostrzezenia: [], sporne: [] };
  }
  /* PASKI: nagłówek + tabela pocięta na wąskie paski w powiększeniu.
   * Mierzone na sierpniu 2026: przy podziale na połówki model dostaje ~100
   * tokenów obrazu na wiersz, przy paskach ~414 — a 8 z 15 błędnych dni to
   * były czyste pomyłki cyfr (5/6, 8/9, 2/3), czyli brak pikseli, nie brak
   * reguły. Tokeny obrazu to płytki 28×28, a API i tak przycina dłuższy bok
   * do 2576 px, więc powiększamy DOKŁADNIE do tego limitu i obcinamy pustą
   * prawą część karty, żeby nie płacić tokenami za biel. */
  const komplet = opcje.trybObrazow === 'paski'
    ? [obrazy.naglowek, ...obrazy.paski.map(p => p.obraz)]
    : [obrazy.calaStrona, obrazy.naglowek, obrazy.gornaPolowka, obrazy.dolnaPolowka];
  const prompt = opcje.trybObrazow === 'paski' ? PROMPT_ZLECENIE_PASKI : PROMPT_ZLECENIE;
  try {
    const chceDrugi = opcje.drugiOdczyt !== false && silnikOpenai.skonfigurowany();
    const [glowny, drugi] = await Promise.all([
      zapytaj(komplet, prompt, SCHEMAT_ZLECENIE, { model: opcje.model, effort: 'high' }),
      chceDrugi
        ? silnikOpenai.zapytaj(komplet, prompt, SCHEMAT_ZLECENIE, { model: opcje.modelDrugi })
          .catch(e => ({ blad: e.message }))
        : Promise.resolve(null),
    ]);
    const daneDrugiego = drugi && !drugi.blad ? drugi.dane : null;
    const wynik = walidujZlecenie(glowny.dane, daneDrugiego, opcje, strona);
    wynik.sha = sha;
    wynik.slad = {
      model: glowny.model, modelDrugi: (drugi && drugi.model) || null,
      bladDrugiego: (drugi && drugi.blad) || null,
      tokeny: { glowny: glowny.tokeny, drugi: (drugi && drugi.tokeny) || null },
      czasMs: Date.now() - t0,
    };
    if (opcje.zapiszSurowe) wynik.surowe = { glowny: glowny.dane, drugi: daneDrugiego, okres: { rok: opcje.rok, miesiac: opcje.miesiac } };
    return wynik;
  } catch (e) {
    return { strona, sha, ok: false, status: 'do_weryfikacji',
      problemy: [`blad wywolania modelu: ${e.message}`], ostrzezenia: [], sporne: [] };
  }
}

async function pula(zadania, n) {
  const wyniki = new Array(zadania.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, zadania.length) }, async () => {
    while (i < zadania.length) {
      const moj = i++;
      wyniki[moj] = await zadania[moj]();
    }
  }));
  return wyniki;
}

/**
 * Cała teczka zleceń → tabela dla kadr: imię i nazwisko + godziny miesiąca.
 */
async function odczytajTeczkeZlecen(pdfBuf, opcje = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zlec-'));
  try {
    const pdfPath = path.join(dir, 'in.pdf');
    await fs.writeFile(pdfPath, pdfBuf);
    const stron = await pdfPageCount(pdfPath);
    const wybrane = Array.isArray(opcje.strony) && opcje.strony.length
      ? opcje.strony.map(Number).filter(p => p >= 1 && p <= stron)
      : Array.from({ length: stron }, (_, i) => i + 1);
    if (!wybrane.length) throw new Error('zadna z podanych stron nie miesci sie w zakresie 1-' + stron);

    const rownolegle = Math.min(Math.max(Number(opcje.rownolegle) || 4, 1), 8);
    const karty = await pula(wybrane.map(p => () => przetworzStroneZlecenia(pdfPath, dir, p, opcje)), rownolegle);

    let we = 0, wy = 0, drWe = 0, drWy = 0;
    for (const k of karty) {
      const t = k.slad && k.slad.tokeny;
      if (!t) continue;
      if (t.glowny) { we += t.glowny.we || 0; wy += t.glowny.wy || 0; }
      if (t.drugi) { drWe += t.drugi.we || 0; drWy += t.drugi.wy || 0; }
    }
    const kosztGlowny = we / 1e6 * CENY_USD_MTOK.we + wy / 1e6 * CENY_USD_MTOK.wy;
    const kosztDrugi = drWe / 1e6 * CENY_DRUGI_MTOK.we + drWy / 1e6 * CENY_DRUGI_MTOK.wy;

    /* Te same nazwisko na dwoch kartach = ta sama osoba na dwoch drukach.
       Nie sklejamy tego po cichu: sumujemy, ale zaznaczamy. */
    const wgOsoby = new Map();
    for (const k of karty) {
      if (!k.imieNazwisko) continue;
      const kl = bezOgonkow(k.imieNazwisko).replace(/[^A-Z]+/g, '');
      const poz = wgOsoby.get(kl) || { imieNazwisko: k.imieNazwisko, godziny: 0, strony: [], statusy: [] };
      poz.godziny = Math.round((poz.godziny + (k.godziny || 0)) * 100) / 100;
      poz.strony.push(k.strona);
      poz.statusy.push(k.status);
      wgOsoby.set(kl, poz);
    }
    const osoby = [...wgOsoby.values()]
      .map(o => ({ ...o, status: o.statusy.every(s => s === 'auto') ? 'auto' : 'do_weryfikacji',
        naWieluKartach: o.strony.length > 1 }))
      .sort((a, b) => a.imieNazwisko.localeCompare(b.imieNazwisko, 'pl'));

    return {
      silnik: 'czytnik-zlecenia', formularz: 'zlecenie',
      stron, przetworzone: wybrane,
      rok: Number(opcje.rok) || null, miesiac: Number(opcje.miesiac) || null,
      kartOk: karty.filter(k => k.ok).length,
      tokeny: { we, wy, drugiCzytelnik: { we: drWe, wy: drWy } },
      kosztUSD: +(kosztGlowny + kosztDrugi).toFixed(3),
      kosztRozbicie: { odczytGlowny: +kosztGlowny.toFixed(3), drugiCzytelnik: +kosztDrugi.toFixed(3) },
      sumaGodzin: Math.round(karty.reduce((a, k) => a + (k.godziny || 0), 0) * 100) / 100,
      osoby, karty,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { odczytajTeczkeZlecen, przetworzStroneZlecenia, walidujZlecenie, godzinyDnia,
  rozbierzZapis, wartoscZDopisku, czasToken, numerMiesiaca };
