'use strict';
/**
 * karty-pracy-odczyt.js — odczyt teczki KART EWIDENCJI CZASU PRACY.
 *
 * Podzial pracy: tutaj dzieje sie wszystko, co ciezkie (ciecie skanow, dwa niezalezne
 * odczyty modelem, kontrola spojnosci). n8n dostaje z powrotem kilka kilobajtow JSON-a
 * i robi to, w czym jest dobry: zapis do Google Sheets i maile.
 *
 * Powod przeniesienia: teczka 30 kart to ~20 MB obrazow. n8n zapisuje wejscie i wyjscie
 * KAZDEGO node'a, wiec te same obrazy lezaly w pamieci kilka razy i przebieg byl ubijany
 * bez zapisanych logow. Tutaj obrazy zyja tylko w trakcie jednego wywolania i nie wracaja.
 *
 * POST /karty-pracy/odczytaj
 *   body: { data: "<base64 pdf>", rownolegle?: 4, dpi?: 300, strony?: [1,2,3],
 *           rok?: 2026, miesiac?: 6, nazwiska?: ["Patrycja Żak", ...],
 *           model?: "claude-opus-5" }
 *   -> { stron, przetworzone, rok, miesiac, norma, problemyOgolne: [], karty: [...] }
 *
 * Wymaga: ANTHROPIC_API_KEY oraz PREPROCESS_TOKEN w srodowisku.
 */

const { cropCard } = require('./karta-pracy');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const run = promisify(execFile);

const API = 'https://api.anthropic.com/v1/messages';
const MODEL_DOM = 'claude-opus-5';
const MAX_TOKENS = 8000;   // 31 dni JSON-a to ~1400 tokenow, ale model bywa gadatliwy
const ROWNOLEGLE_DOM = 2;   // 8-9 wywolan na karte, wiec 2 strony naraz to juz ~18 zapytan

/* ------------------------------------------------------------------ prompty */

const WSPOLNE = `Dostajesz wycinki JEDNEJ karty "KARTA EWIDENCJI CZASU PRACY" (polski formularz wypelniany odrecznie).

Obrazy w kolejnosci:
1) naglowek karty (miesiac/rok, nazwisko, "Ilosc godzin do przepracowania")
2,3,4) trzy pasma tabeli, kolumny sklejone obok siebie w kolejnosci:
   [dzien miesiaca] [Godz. rozpocz. pracy] [Godz. zakoncz. pracy] [Ilosc godzin RAZEM]
   pasmo 2 = dni 1-11, pasmo 3 = dni 12-21, pasmo 4 = dni 22-31 oraz wiersz SUMA
5,6,7) te same trzy pasma, kolumny:
   [dzien miesiaca] [Ilosc godzin RAZEM] [normalne] [50%] [100%] [nocne] [UW] [Chor.]

ZASADY ODCZYTU
- Zamiast godziny rozpoczecia w wierszu moze byc litera: W (wolne), U (urlop), C (chorobowe),
  albo pozioma kreska. Wtedy razem = null, a litere wpisz w pole "kod".
- Kolumna "normalne" bywa uzywana jako brudnopis: ludzie wpisuja tam narastajace sumy
  posrednie (np. 144 przy dniu 26, 127.5 przy dniu 22). TO NIE SA GODZINY TEGO DNIA.
  Takiej liczby nie wpisuj do "razem" ani do "normalne" - wrzuc ja do pola "notatka".
- Godziny sa wielokrotnosciami 0.5. Przecinek dziesietny zapisuj KROPKA.
- Zapis "7/17" w rozpoczeciu, "15/19" w zakonczeniu i "8/2" w RAZEM oznacza DWIE zmiany
  tego samego dnia. Wtedy razem = suma obu (8/2 daje 10), a w "razem_rozbite" podaj [8,2].
- Ostatni wiersz pasma 4 to SUMA - to podsumowanie miesiaca, NIE dzien. Idzie do pola "suma".
- Na gornej i dolnej krawedzi pasma bywa widoczny scinek sasiedniego wiersza - zignoruj go.
- Ponizej tabeli i obok sumy jest odreczna parafka przelozonego. To NIE jest liczba.
- Czego nie da sie odczytac -> null. NIGDY nie zgaduj i nie wyliczaj brakujacej wartosci.

ZWROC WYLACZNIE CZYSTY JSON, bez markdown, bez komentarzy, bez zdan przed ani po:
{"nazwisko":"IMIE NAZWISKO","miesiac":6,"rok":2026,"norma":168,
 "dni":[{"d":1,"od":"9:00","do":"18:00","razem":9,"razem_rozbite":null,"kod":null,"sto":null,"nocne":null,"uw":null,"chor":null,"notatka":null}],
 "suma":{"razem":175,"sto":10,"nocne":null,"uw":null,"chor":null}}
Tablica "dni" ma miec po jednym wpisie na kazdy wiersz dnia widoczny w tabeli, po kolei od 1.`;

function zListaNazwisk(prompt, nazwiska) {
  if (!Array.isArray(nazwiska) || !nazwiska.length) return prompt;
  return prompt + `

LISTA PRACOWNIKOW (zamkniety zbior)
Nazwisko na karcie NALEZY do tej listy. Wybierz z niej dokladnie jedna pozycje
i przepisz ja ZNAK W ZNAK do pola "nazwisko". Nie poprawiaj, nie skracaj, nie
tworz nowych wariantow. Jesli zadna pozycja nie pasuje do tego, co widzisz,
wpisz null - lepiej nic niz zla osoba.
${nazwiska.map(n => '- ' + n).join('\n')}`;
}

const PROMPT_A = `Czytaj WIERSZ PO WIERSZU, od dnia 1 do konca miesiaca. Dla kazdego dnia odczytaj
najpierw godzine rozpoczecia, potem zakonczenia, potem RAZEM, potem kolumny po prawej.

${WSPOLNE}`;

const PROMPT_B = `Czytaj KOLUMNAMI, nie wierszami. Kolejnosc pracy:
1. Przejdz cala kolumne "Ilosc godzin RAZEM" z gory na dol i zapisz wartosc dla kazdego dnia.
2. Potem kolumne 100%, potem nocne, potem UW, potem Chor.
3. Potem wiersz SUMA.
4. Dopiero na koncu wroc na poczatek i odczytaj godziny rozpoczecia i zakonczenia.

Ten odczyt jest NIEZALEZNA kontrola innego odczytu tej samej karty. Czytanie w innej
kolejnosci ma rozbic bledy polegajace na przesunieciu sie o wiersz. Nie wyliczaj niczego
z godzin - RAZEM odczytaj z kolumny takie, jakie jest napisane, nawet jesli nie zgadza sie
z roznica godzin.

${WSPOLNE}`;

/* ------------------------------------------------------- kalendarz i wymiar */

function wielkanoc(r) {
  const a = r % 19, b = Math.floor(r / 100), c = r % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return new Date(Date.UTC(r, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1));
}
const plusDni = (d, n) => new Date(d.getTime() + n * 86400000);

function swietaRoku(rok) {
  const w = wielkanoc(rok);
  return [new Date(Date.UTC(rok, 0, 1)), new Date(Date.UTC(rok, 0, 6)), w, plusDni(w, 1),
    new Date(Date.UTC(rok, 4, 1)), new Date(Date.UTC(rok, 4, 3)), plusDni(w, 49), plusDni(w, 60),
    new Date(Date.UTC(rok, 7, 15)), new Date(Date.UTC(rok, 10, 1)), new Date(Date.UTC(rok, 10, 11)),
    new Date(Date.UTC(rok, 11, 25)), new Date(Date.UTC(rok, 11, 26))];
}
const swietaMiesiaca = (rok, m) => swietaRoku(rok)
  .filter(d => d.getUTCFullYear() === rok && d.getUTCMonth() === m - 1).map(d => d.getUTCDate());

/** art. 130 KP: 8 h x dni pn-pt minus 8 h za kazde swieto w dniu innym niz niedziela */
function wymiarCzasuPracy(rok, mies) {
  const dni = new Date(Date.UTC(rok, mies, 0)).getUTCDate();
  let rob = 0;
  for (let d = 1; d <= dni; d++) {
    const w = new Date(Date.UTC(rok, mies - 1, d)).getUTCDay();
    if (w >= 1 && w <= 5) rob++;
  }
  const obn = swietaRoku(rok)
    .filter(d => d.getUTCFullYear() === rok && d.getUTCMonth() === mies - 1 && d.getUTCDay() !== 0).length;
  return rob * 8 - obn * 8;
}

/**
 * Na karcie NIE MA roku - rubryka "Miesiac/rok" zawiera samo slowo, np. CZERWIEC.
 * Karta trafia do nas po zakonczeniu miesiaca, wiec bierzemy najswiezszy rok,
 * w ktorym ten miesiac zdazyl sie skonczyc. Zalozenie jest zapisywane w wyniku,
 * zeby nie bylo cichym domyslem.
 */
function domyslnyRok(miesiac, dzisiaj = new Date()) {
  const r = dzisiaj.getUTCFullYear();
  const koniecMiesiaca = new Date(Date.UTC(r, miesiac, 0, 23, 59, 59));
  return koniecMiesiaca <= dzisiaj ? r : r - 1;
}

/* -------------------------------------------------------------- model + JSON */

/** wyciaga pierwszy ZBALANSOWANY obiekt JSON - model lubi dopisac zdanie po odpowiedzi */
function jsonZTekstu(tekst) {
  const t = String(tekst || '').replace(/```json|```/g, '').trim();
  const start = t.indexOf('{');
  if (start < 0) return null;
  let d = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === '{') d++;
    else if (t[i] === '}') {
      d--;
      if (d === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch (e) { return null; } }
    }
  }
  return null;
}

const spij = ms => new Promise(r => setTimeout(r, ms));

async function zapytajModel(obrazy, prompt, model, proby = 3) {
  const body = {
    model, max_tokens: MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [
        ...obrazy.map(b64 => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } })),
        { type: 'text', text: prompt },
      ],
    }],
  };
  let ostatni = null;
  for (let i = 0; i < proby; i++) {
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (r.status === 429 || r.status >= 500) {
        ostatni = new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
        await spij(2000 * (i + 1));
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const j = await r.json();
      return {
        tekst: (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'),
        powodStopu: j.stop_reason || null,
        zuzyte: j.usage ? j.usage.output_tokens : null,
      };
    } catch (e) {
      ostatni = e;
      if (i < proby - 1) await spij(2000 * (i + 1));
    }
  }
  throw ostatni || new Error('nieznany blad wywolania modelu');
}

const PROMPT_SUMA = `Dostajesz wycinek z DOLU karty "KARTA EWIDENCJI CZASU PRACY":
ostatni wiersz dnia (numer 31) oraz pod nim wiersz podsumowania z napisem SUMA.

Interesuje Cie WYLACZNIE wiersz SUMA. Kolumny w nim, liczac od napisu "SUMA" w prawo:
  1. Ilosc godzin RAZEM
  2. normalne
  3. 50%
  4. 100%
  5. nocne
  6. UW   (urlop wypoczynkowy)
  7. Chor. (chorobowe)
Wiekszosc rubryk bywa pusta - to normalne, wpisz wtedy null.

UWAGA
- Nie mylic z wierszem dnia 31, ktory jest NAD wierszem SUMA.
- Ponizej tabeli jest drukowana legenda i odreczna parafka przelozonego - to NIE sa liczby.
- PRZECINEK DZIESIETNY. Odreczne "6,5" bywa mylone z "60" albo "66" - przecinek
  to NIE jest cyfra. Jesli miedzy cyframi widzisz mala kreske, kropke lub ogonek
  przy dole linii, to separator dziesietny. Godziny sa wielokrotnosciami 0.5,
  wiec po separatorze moze stac WYLACZNIE 5 albo 0.
- WIDELKI: RAZEM w calym miesiacu to zwykle 100-250. Kolumny 100%, nocne, UW i Chor.
  sa zawsze MNIEJSZE albo rowne RAZEM - czesto to pojedyncze godziny, np. 6.5 albo 16.
- Przecinek dziesietny zapisuj KROPKA. Czego nie widzisz -> null. NIGDY nie zgaduj.

ZWROC WYLACZNIE CZYSTY JSON:
{"razem":152,"normalne":null,"p50":null,"sto":null,"nocne":null,"uw":16,"chor":null}`;

const PROMPT_SUMA_B = `Zanim odczytasz wartosci, USTAL POLOZENIE KOLUMN: znajdz napis
"SUMA" i licz rubryki w prawo od niego. Pierwsza to RAZEM, szosta to UW. Dopiero
potem odczytaj liczby, kazda osobno, patrzac tylko na jedna rubryke naraz.

`;

const PROMPT_NAGLOWEK = `Dostajesz naglowek JEDNEJ karty "KARTA EWIDENCJI CZASU PRACY".
Odczytaj z niego tylko cztery rzeczy. Rubryka "Miesiac/rok" na tym formularzu
zawiera zwykle SAM MIESIAC, bez roku - wtedy rok zwroc jako null, to normalne.

ZWROC WYLACZNIE CZYSTY JSON:
{"nazwisko":"IMIE NAZWISKO","miesiac":6,"rok":null,"norma":168}
miesiac jako liczba 1-12. norma to "Ilosc godzin do przepracowania".
Czego nie widzisz -> null. NIGDY nie zgaduj.`;

const PROMPT_PASMO_B = `Czytaj to pasmo KOLUMNAMI, nie wierszami. Najpierw przejdz cala
kolumne "Ilosc godzin RAZEM" z gory na dol i zapisz wartosc dla kazdego dnia, potem
kolumne 100%, potem nocne, UW i Chor., a na koncu wiersz SUMA jesli jest w tym pasmie.
Nie wyliczaj RAZEM z godzin - odczytaj to, co jest napisane w kolumnie.

`;

const PROMPT_PASMO = `Dostajesz wycinki JEDNEJ karty "KARTA EWIDENCJI CZASU PRACY" - ale
tylko FRAGMENT tabeli, nie calosc. Obrazy:
1) pasmo tabeli, kolumny: [dzien] [Godz. rozpocz.] [Godz. zakoncz.] [Ilosc godzin RAZEM]
2) to samo pasmo, kolumny: [dzien] [RAZEM] [normalne] [50%] [100%] [nocne] [UW] [Chor.]

Odczytaj TYLKO te dni, ktore widzisz w tym pasmie. Jesli w pasmie jest wiersz SUMA
(ostatni, bez numeru dnia), odczytaj go do pola "suma"; jesli go nie ma, daj suma: null.

Masz przed soba tylko kilkanascie wierszy - przeczytaj kazdy z osobna i uwaznie.
Szczegolnie latwo pomylic cyfry 1/7, 4/9, 3/8 i 0/6.

ZASADY (te same co zwykle)
- Litera W/U/C zamiast godziny rozpoczecia -> razem: null, litera do pola "kod".
- Kolumna "normalne" bywa brudnopisem z sumami narastajacymi - to NIE sa godziny dnia.
- Godziny sa wielokrotnosciami 0.5, przecinek zapisuj KROPKA.
- "8/2" w RAZEM to dwie zmiany tego dnia - razem = 10.
- Scinek sasiedniego wiersza na krawedzi pasma - zignoruj.
- Czego nie da sie odczytac -> null. NIGDY nie zgaduj.

ZWROC WYLACZNIE CZYSTY JSON:
{"dni":[{"d":1,"razem":9,"kod":null,"sto":null,"nocne":null,"uw":null,"chor":null}],
 "suma":{"razem":175,"sto":10,"nocne":null,"uw":null,"chor":null}}`;

/** Trzeci odczyt: pasmo po pasmie. 10-11 dni naraz zamiast 31 - uwaga modelu
 *  rozklada sie znacznie lepiej, a to wlasnie na dlugich tabelach gubil pojedyncze
 *  dni albo wiersz SUMA. */
async function czytajPasmami(crops, model, nazwiska, wariantB = false) {
  const wstep = wariantB ? PROMPT_PASMO_B : '';
  const wyniki = await Promise.all([0, 1, 2].map(async i => {
    const obrazy = [crops.lewa[i].toString('base64'), crops.prawa[i].toString('base64')];
    const o = await zapytajModel(obrazy, wstep + PROMPT_PASMO, model);
    return jsonZTekstu(o.tekst);
  }));
  if (wyniki.every(w => !w)) return null;
  const dni = [];
  let suma = null;
  for (const w of wyniki) {
    if (!w) continue;
    for (const d of (w.dni || [])) dni.push(d);
    if (w.suma && w.suma.razem !== null && w.suma.razem !== undefined) suma = w.suma;
  }
  return { nazwisko: null, miesiac: null, rok: null, norma: null, dni, suma: suma || {} };
}

async function czytajSume(crops, model, wariantB = false) {
  if (!crops.suma) return null;
  const o = await zapytajModel([crops.suma.toString('base64')],
    (wariantB ? PROMPT_SUMA_B : '') + PROMPT_SUMA, model);
  const j = jsonZTekstu(o.tekst);
  return j ? { razem: j.razem, sto: j.sto, nocne: j.nocne, uw: j.uw, chor: j.chor } : null;
}

async function czytajNaglowek(crops, model, nazwiska) {
  const o = await zapytajModel([crops.naglowek.toString('base64')],
    zListaNazwisk(PROMPT_NAGLOWEK, nazwiska), model);
  return jsonZTekstu(o.tekst) || {};
}

/**
 * Jeden pelny odczyt karty = naglowek + trzy pasma. Kazde wywolanie widzi
 * kilkanascie wierszy zamiast trzydziestu jeden, przez co model nie gubi
 * pojedynczych dni ani wiersza SUMA - to byla przyczyna wszystkich wpadek
 * w przebiegach na prawdziwych kartach.
 */
async function czytajKarte(crops, model, nazwiska, wariantB) {
  // Trzy zadania o roznym charakterze, kazde osobno: naglowek to drukowany tekst,
  // pasma to kolumna liczb, wiersz SUMA to jeden wiersz o innej strukturze niz dni.
  // Doklejony do konca trzeciego pasma byl czytany najgorzej z calej karty.
  const [nag, tabela, suma] = await Promise.all([
    czytajNaglowek(crops, model, nazwiska),
    czytajPasmami(crops, model, nazwiska, wariantB),
    czytajSume(crops, model, wariantB),
  ]);
  if (!tabela) return null;
  return {
    nazwisko: nag.nazwisko || null,
    miesiac: nag.miesiac || null,
    rok: nag.rok || null,
    norma: nag.norma || null,
    dni: tabela.dni || [],
    suma: suma || tabela.suma || {},   // dedykowany odczyt ma pierwszenstwo
  };
}

/* ------------------------------------------------- zszycie i kontrola karty */

const L = v => (v === null || v === undefined || v === '') ? null : Number(String(v).replace(',', '.'));
const sumuj = a => a.reduce((x, y) => x + (Number(y) || 0), 0);

/**
 * Zasada: nie ufamy modelowi, ufamy nadmiarowosci karty. Kazdy wiersz ma trzy
 * niezaleznie napisane liczby, karta ma wiersz SUMA i nadrukowana norme.
 * Model nie musi byc nieomylny - musi byc sprawdzalny.
 */
/** wartosc wygrywa, gdy powtorzy sie u co najmniej dwoch czytajacych */
function wiekszosc(wartosci) {
  const licz = new Map();
  for (const v of wartosci) {
    if (v === undefined) continue;
    const k = JSON.stringify(v);
    licz.set(k, (licz.get(k) || 0) + 1);
  }
  let najlepszy = null, ile = 0;
  for (const [k, n] of licz) if (n > ile) { ile = n; najlepszy = k; }
  return { wartosc: ile >= 2 ? JSON.parse(najlepszy) : undefined, glosy: ile, roznych: licz.size };
}

function zszyj(A, B, strona, sha, okres = {}, T = null) {
  const problemy = [], sporne = [];
  if (!A || !B) {
    return {
      strona, sha, ok: false,
      problemy: ['nie udalo sie sparsowac odpowiedzi modelu (' +
        [!A && 'odczyt A', !B && 'odczyt B'].filter(Boolean).join(', ') + ')'],
      sporne: [],
    };
  }

  // NAZWISKO. Trzy niezalezne zabezpieczenia, bo wpisanie godzin nie tej osobie
  // jest najgorszym mozliwym bledem tego systemu:
  //  1) glosowanie - jeden czytajacy nie przegrywa z dwoma pozostalymi
  //  2) brak odczytu BLOKUJE karte (prompt pozwala zwrocic null, wiec to realna sciezka)
  //  3) przynaleznosc do listy pracownikow
  const klucz = t => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/\u0141/g, 'L').replace(/[^A-Z ]+/g, ' ')
    .trim().split(/\s+/).filter(Boolean).sort().join(' ');
  const nazwiskaCzyt = [A, B, T].filter(Boolean).map(x => (x.nazwisko || '').trim()).filter(Boolean);
  let nazwiskoWybrane = '';
  if (!nazwiskaCzyt.length) {
    problemy.push('nie odczytano nazwiska z karty - nie wiem, komu przypisac godziny');
  } else {
    const gNazw = wiekszosc(nazwiskaCzyt.map(klucz));
    if (gNazw.wartosc === undefined) {
      sporne.push({ dzien: 'NAGLOWEK', pole: 'nazwisko', odczyty: [...new Set(nazwiskaCzyt)] });
      problemy.push('odczyty roznia sie nazwiskiem: ' + [...new Set(nazwiskaCzyt)].join(' / '));
    } else {
      nazwiskoWybrane = nazwiskaCzyt.find(n => klucz(n) === gNazw.wartosc) || '';
    }
    if (Array.isArray(okres.nazwiska) && okres.nazwiska.length) {
      const lista = new Set(okres.nazwiska.map(klucz));
      const obce = [...new Set(nazwiskaCzyt.filter(n => !lista.has(klucz(n))))];
      if (obce.length) problemy.push('nazwisko spoza listy pracownikow: ' + obce.join(' / ') + ' - nie wpisuje godzin nie tej osobie');
    }
  }
  const mies = okres.miesiac || A.miesiac || B.miesiac;
  let rok = okres.rok || A.rok || B.rok;
  let rokDomyslny = false;
  if (!mies) problemy.push('nie odczytano miesiaca z naglowka karty');
  if (!rok && mies) {
    // rubryka "Miesiac/rok" na tym formularzu zawiera sam miesiac - to norma, nie blad
    rok = domyslnyRok(mies);
    rokDomyslny = true;
  } else if (!rok) {
    problemy.push('nie odczytano ani miesiaca, ani roku - nie umiem ustalic okresu');
  }
  if (A.rok && B.rok && A.rok !== B.rok) problemy.push(`odczyty roznia sie rokiem: ${A.rok} vs ${B.rok}`);
  if (A.miesiac && B.miesiac && A.miesiac !== B.miesiac) problemy.push(`odczyty roznia sie miesiacem: ${A.miesiac} vs ${B.miesiac}`);

  const czytajacy = [A, B, T].filter(Boolean);
  const mapy = czytajacy.map(x => new Map((x.dni || []).map(d => [Number(d.d), d])));
  const mapA = mapy[0], mapB = mapy[1];
  const dniMies = (rok && mies) ? new Date(Date.UTC(rok, mies, 0)).getUTCDate() : 31;
  const swieta = (rok && mies) ? swietaMiesiaca(rok, mies) : [];
  const dni = [];

  for (let d = 1; d <= dniMies; d++) {
    const wiersze = mapy.map(m => m.get(d) || {});
    const glosuj = pole => wiekszosc(wiersze.map(w => L(w[pole])));
    const gr = glosuj('razem');
    if (gr.wartosc === undefined) {
      sporne.push({ dzien: d, pole: 'RAZEM', odczyty: wiersze.map(w => L(w.razem)) });
      continue;
    }
    const a = wiersze[0], b = wiersze[1] || {};
    const ra = gr.wartosc;
    const gs = glosuj('sto'), gn = glosuj('nocne');
    if (gs.wartosc === undefined) sporne.push({ dzien: d, pole: '100%', odczyty: wiersze.map(w => L(w.sto)) });
    if (gn.wartosc === undefined) sporne.push({ dzien: d, pole: 'nocne', odczyty: wiersze.map(w => L(w.nocne)) });
    const sa = gs.wartosc === undefined ? null : gs.wartosc;
    const na = gn.wartosc === undefined ? null : gn.wartosc;

    if (ra !== null) {
      if (ra < 0 || ra > 24) problemy.push(`dzien ${d}: RAZEM poza zakresem 0-24 (${ra})`);
      if (Math.abs(ra * 2 - Math.round(ra * 2)) > 1e-9) problemy.push(`dzien ${d}: RAZEM nie jest wielokrotnoscia 0.5 (${ra})`);
      if (a.kod) problemy.push(`dzien ${d}: jest kod "${a.kod}" i jednoczesnie ${ra} h`);
    }
    if (sa !== null && sa !== 0) {
      if (!swieta.includes(d)) problemy.push(`dzien ${d}: godziny 100% w dniu, ktory nie jest swietem ustawowym`);
      else if (sa !== ra) problemy.push(`dzien ${d}: 100% (${sa}) rozni sie od RAZEM (${ra})`);
    }
    if (ra !== null && ra > 0 && swieta.includes(d) && (sa === null || sa === 0)) {
      problemy.push(`dzien ${d} to swieto, przepracowano ${ra} h, a kolumna 100% jest pusta - sprawdz, czy nie zapomniano dopisac`);
    }
    dni.push({ d, razem: ra, kod: a.kod || b.kod || null, sto: sa, nocne: na,
               uw: wiekszosc(wiersze.map(w => L(w.uw))).wartosc ?? null,
               chor: wiekszosc(wiersze.map(w => L(w.chor))).wartosc ?? null,
               notatka: a.notatka || null });
  }

  const sumDni = sumuj(dni.map(x => x.razem));
  const sumy = czytajacy.map(x => x.suma || {});
  const glosSuma = pole => wiekszosc(sumy.map(x => L(x[pole])));
  const gSuma = glosSuma('razem');
  const wSuma = gSuma.wartosc === undefined ? null : gSuma.wartosc;
  if (gSuma.wartosc === undefined) sporne.push({ dzien: 'SUMA', pole: 'RAZEM', odczyty: sumy.map(x => L(x.razem)) });
  const sA = sumy[0], sB = sumy[1] || {};
  if (wSuma === null && gSuma.wartosc !== undefined) problemy.push('nie odczytano wiersza SUMA');
  if (gSuma.wartosc === undefined && sumy.every(x => L(x.razem) === null)) problemy.push('nie odczytano wiersza SUMA');
  else if (Math.abs(sumDni - wSuma) > 0.001) problemy.push(`suma dni (${sumDni}) nie zgadza sie z wierszem SUMA (${wSuma})`);
  const gSto = glosSuma('sto'), gNoc = glosSuma('nocne'), gUw = glosSuma('uw'), gChor = glosSuma('chor');
  if (gSto.wartosc === undefined) sporne.push({ dzien: 'SUMA', pole: '100%', odczyty: sumy.map(x => L(x.sto)) });
  if (gNoc.wartosc === undefined) sporne.push({ dzien: 'SUMA', pole: 'nocne', odczyty: sumy.map(x => L(x.nocne)) });
  // Bez tych dwoch linii rozjazd w UW/Chor. dawal po cichu zero i ZANIZAL C,
  // a karta wychodzila jako czysta. Najgrozniejszy rodzaj bledu: wiarygodna liczba.
  if (gUw.wartosc === undefined) sporne.push({ dzien: 'SUMA', pole: 'UW', odczyty: sumy.map(x => L(x.uw)) });
  if (gChor.wartosc === undefined) sporne.push({ dzien: 'SUMA', pole: 'Chor.', odczyty: sumy.map(x => L(x.chor)) });

  const sto = (gSto.wartosc ?? 0) || 0, uw = (gUw.wartosc ?? 0) || 0, chor = (gChor.wartosc ?? 0) || 0;
  // Kazda kolumna dodatkow ma dwa niezalezne zrodla: wpisy dzienne i wiersz SUMA.
  // Rozjazd znaczy, ze ktores z nich jest zle odczytane - wtedy nie zgadujemy.
  for (const [pole, wTotal] of [['sto', sto], ['uw', uw], ['chor', chor]]) {
    const zDni = sumuj(dni.map(x => x[pole]));
    if (Math.abs(zDni - wTotal) > 0.001) {
      problemy.push('kolumna ' + (pole === 'sto' ? '100%' : pole === 'uw' ? 'UW' : 'Chor.') +
        ': suma z dni (' + zDni + ') nie zgadza sie z wierszem SUMA (' + wTotal + ')');
    }
  }
  if (wSuma !== null && sto > wSuma) problemy.push('godziny 100% (' + sto + ') sa wieksze niz cale RAZEM (' + wSuma + ') - to niemozliwe');

  // C = RAZEM + godziny w swieto (100%) + platne nieprzepracowane (UW, Chor.)
  const C = wSuma === null ? null : wSuma + sto + uw + chor;
  const G = gNoc.wartosc ?? null;

  if (rok && mies) {
    const norma = wymiarCzasuPracy(rok, mies);
    if (A.norma && Number(A.norma) !== norma) {
      problemy.push(`norma z karty (${A.norma}) nie zgadza sie z wyliczona z Kodeksu pracy (${norma}) - sprawdz, czy to na pewno ten miesiac`);
    }
    if (C !== null && (C < norma * 0.4 || C > norma * 1.6)) {
      problemy.push(`suma miesiaca (${C}) mocno odbiega od normy ${norma} - sprawdz odczyt`);
    }
  }

  return {
    strona, sha,
    ok: problemy.length === 0 && sporne.length === 0,
    nazwisko: nazwiskoWybrane,
    nazwiskoB: String(B.nazwisko || '').trim(),
    nazwiskaOdczytane: czytajacy.map(x => (x.nazwisko || '').trim()).filter(Boolean),
    rok, rokDomyslny, miesiac: mies, normaZKarty: L(A.norma),
    C, G, sumaDni: sumDni, wierszSuma: wSuma, sto, uw, chor,
    problemy, sporne, dni,
  };
}

/* ------------------------------------------------------------------- glowne */

async function pdfPageCount(p) {
  const { stdout } = await run('pdfinfo', [p]);
  const m = stdout.match(/^Pages:\s+(\d+)/m);
  if (!m) throw new Error('nie umiem odczytac liczby stron PDF');
  return parseInt(m[1], 10);
}

async function renderPage(pdfPath, page, dir, dpi = 300) {
  const base = path.join(dir, `p${page}`);
  // JPEG posredni zamiast PNG: ~2,4x szybciej, wykrycie siatki identyczne
  await run('pdftoppm', ['-f', String(page), '-l', String(page), '-r', String(dpi),
    '-jpeg', '-jpegopt', 'quality=92', '-singlefile', pdfPath, base]);
  const prosty = `${base}_d.jpg`;
  try {
    await run('convert', [`${base}.jpg`, '-deskew', '40%', '-background', 'white', '+repage', '-quality', '92', prosty]);
    return await fs.readFile(prosty);
  } catch (e) {
    return fs.readFile(`${base}.jpg`);
  }
}

async function przetworzStrone(pdfPath, dir, strona, model, dpi, okres) {
  let crops;
  try {
    const png = await renderPage(pdfPath, strona, dir, dpi);
    crops = await cropCard(png);
  } catch (e) {
    return { strona, ok: false, problemy: [`nie udalo sie przygotowac wycinkow: ${e.message}`], sporne: [] };
  }
  const obrazy = [crops.naglowek, ...crops.lewa, ...crops.prawa].map(b => b.toString('base64'));
  try {
    // Dwa niezalezne odczyty, oba PASMAMI: A wierszami, B kolumnami.
    // Kazde wywolanie obejmuje ~11 dni, nie cala tabele.
    const [A, B] = await Promise.all([
      czytajKarte(crops, model, okres.nazwiska, false),
      czytajKarte(crops, model, okres.nazwiska, true),
    ]);
    let wynik = zszyj(A, B, strona, null, okres);
    // Trzeci odczyt tylko wtedy, gdy pierwsze dwa sie nie domykaja. Idzie pasmami
    // (10-11 dni naraz zamiast 31), wiec patrzy uwazniej tam, gdzie tamte gubily
    // pojedyncze dni albo wiersz SUMA. Potem decyduje wiekszosc z trzech.
    if (!wynik.ok && (A || B)) {
      try {
        // Rozjemca czyta CALA karte naraz - inna ziarnistosc to inne bledy,
        // wiec jego glos realnie rozstrzyga, a nie powiela pomylki pasm.
        const oT = await zapytajModel(obrazy, zListaNazwisk(PROMPT_A, okres.nazwiska), model);
        const T = jsonZTekstu(oT.tekst);
        if (T) {
          const poprawiony = zszyj(A, B, strona, null, okres, T);
          poprawiony.trzeciOdczyt = true;
          poprawiony.przedTrzecim = { problemy: wynik.problemy, sporne: wynik.sporne };
          wynik = poprawiony;
        }
      } catch (e) {
        wynik.problemy.push('trzeci odczyt nie doszedl do skutku: ' + e.message);
      }
    }
    // Diagnostyka przy nieudanym parsowaniu: bez surowej odpowiedzi i powodu
    // zatrzymania komunikat "nie udalo sie sparsowac" nic nie mowi - nie wiadomo,
    // czy odpowiedz zostala ucieta na limicie, czy model napisal cos innego.
    if (!A || !B) {
      wynik.diagnostyka = { A: { sparsowane: !!A }, B: { sparsowane: !!B },
        uwaga: 'ktorys z odczytow pasmami nie zwrocil poprawnego JSON - patrz logi serwera' };
    }
    return wynik;
  } catch (e) {
    return { strona, ok: false, problemy: [`blad wywolania modelu: ${e.message}`], sporne: [] };
  }
}

/** prosta pula - kilka kart naraz, zeby 30 stron nie zajelo dziesieciu minut */
async function pula(zadania, ile) {
  const wyniki = new Array(zadania.length);
  let nast = 0;
  const robotnik = async () => {
    while (true) {
      const i = nast++;
      if (i >= zadania.length) return;
      wyniki[i] = await zadania[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(ile, zadania.length) }, robotnik));
  return wyniki;
}

async function odczytajTeczke(pdf, opcje = {}) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('brak ANTHROPIC_API_KEY w srodowisku');
  const model = opcje.model || MODEL_DOM;
  const rownolegle = Math.max(1, Math.min(8, Number(opcje.rownolegle) || ROWNOLEGLE_DOM));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kpo-'));
  const pdfPath = path.join(dir, 'in.pdf');
  try {
    await fs.writeFile(pdfPath, pdf);
    const stron = await pdfPageCount(pdfPath);
    // Domyslnie cala teczka. Podanie "strony" pozwala n8n wolac endpoint porcjami,
    // gdyby proxy Railway ucinalo zadania trwajace kilka minut - wtedy kazde
    // wywolanie schodzi w kilkadziesiat sekund, a wyniki skleja sie po stronie n8n.
    const wybrane = Array.isArray(opcje.strony) && opcje.strony.length
      ? opcje.strony.map(Number).filter(p => p >= 1 && p <= stron)
      : Array.from({ length: stron }, (_, i) => i + 1);
    if (!wybrane.length) throw new Error('zadna z podanych stron nie miesci sie w zakresie 1-' + stron);
    const zadania = [];
    const dpi = Math.max(150, Math.min(400, Number(opcje.dpi) || 300));
    // okres mozna narzucic z zewnatrz (np. z tematu maila "karty pracy czerwiec 2026")
    const okres = { rok: Number(opcje.rok) || null, miesiac: Number(opcje.miesiac) || null,
                    nazwiska: Array.isArray(opcje.nazwiska) ? opcje.nazwiska : null };
    // Lista nazwisk idzie do promptu, wiec zepsute kodowanie po stronie klienta
    // (PowerShell 5.1 wysyla body w latin1) zatruwa caly odczyt, a nie tylko
    // dopasowanie. Lepiej krzyknac, niz po cichu czytac gorzej.
    const zepsute = (okres.nazwiska || []).filter(n => /[\uFFFD]|[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(String(n)));
    if (zepsute.length) {
      throw new Error('lista nazwisk dotarla z uszkodzonym kodowaniem (' + zepsute.length +
        ' z ' + okres.nazwiska.length + ' pozycji, np. "' + zepsute[0] +
        '") - wyslij body jako UTF-8, inaczej model dostanie bezsensowna liste');
    }
    for (const p of wybrane) zadania.push(() => przetworzStrone(pdfPath, dir, p, model, dpi, okres));
    const karty = await pula(zadania, rownolegle);

    // wszystkie karty w teczce musza dotyczyc tego samego miesiaca
    const zOkresem = karty.filter(k => k.rok && k.miesiac);
    const lata = [...new Set(zOkresem.map(k => k.rok))];
    const mies = [...new Set(zOkresem.map(k => k.miesiac))];
    const problemyOgolne = [];
    if (!zOkresem.length) problemyOgolne.push('zadna karta nie dala sie przypisac do miesiaca i roku');
    if (lata.length > 1 || mies.length > 1) {
      problemyOgolne.push('karty w teczce wskazuja rozne okresy: ' +
        zOkresem.map(k => `str.${k.strona}=${k.miesiac}/${k.rok}`).join(', '));
    }
    const rok = lata.length === 1 ? lata[0] : null;
    const miesiac = mies.length === 1 ? mies[0] : null;

    return {
      stron, przetworzone: wybrane, rok, miesiac,
      norma: (rok && miesiac) ? wymiarCzasuPracy(rok, miesiac) : null,
      normaCzesc: (rok && miesiac) ? wymiarCzasuPracy(rok, miesiac) * 0.75 : null,
      kartOk: karty.filter(k => k.ok).length,
      problemyOgolne,
      // "dni" zostaja po stronie serwera - n8n dostaje same wyniki, nie surowe odczyty
      karty: karty.map(({ dni, ...reszta }) => reszta),
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------- router expressa */

function router(express, token) {
  const r = express.Router();
  r.post('/karty-pracy/odczytaj', express.json({ limit: '40mb' }), async (req, res) => {
    if (token && req.get('x-token') !== String(token).trim()) return res.status(401).json({ blad: 'zly token' });
    try {
      const { data, rownolegle, model, dpi, strony, rok, miesiac, nazwiska } = req.body || {};
      if (!data) return res.status(400).json({ blad: 'brak pola data' });
      res.json(await odczytajTeczke(Buffer.from(data, 'base64'), { rownolegle, model, dpi, strony, rok, miesiac, nazwiska }));
    } catch (e) {
      res.status(500).json({ blad: e.message });
    }
  });
  return r;
}

module.exports = { odczytajTeczke, zszyj, wymiarCzasuPracy, swietaMiesiaca, jsonZTekstu, router,
  PROMPT_A, PROMPT_B };

/* ------------------------------------------------------------------- CLI test */
if (require.main === module) {
  (async () => {
    const plik = process.argv[2];
    if (!plik) { console.error('uzycie: node karty-pracy-odczyt.js <plik.pdf> [rownolegle] [dpi]'); process.exit(1); }
    const t0 = Date.now();
    const w = await odczytajTeczke(await fs.readFile(plik), {
      rownolegle: Number(process.argv[3]) || 4,
      dpi: Number(process.argv[4]) || 300,
    });
    const dom = w.karty.some(k => k.rokDomyslny) ? ' (rok domyslony - nie ma go na karcie)' : '';
    console.log(`\nstron: ${w.stron} | okres: ${w.miesiac}/${w.rok}${dom} | norma: ${w.norma} | czystych kart: ${w.kartOk}/${w.przetworzone.length}`);
    if (w.problemyOgolne.length) console.log('PROBLEMY OGOLNE:', w.problemyOgolne.join('; '));
    console.log();
    for (const k of w.karty) {
      console.log(`str.${String(k.strona).padStart(2)} ${k.ok ? 'OK  ' : 'UWAGA'} ${String(k.nazwisko || '?').padEnd(24)} C=${k.C ?? '-'}  G=${k.G ?? '-'}   [RAZEM ${k.wierszSuma ?? '-'}${k.sto ? ' +100% ' + k.sto : ''}${k.uw ? ' +UW ' + k.uw : ''}]`);
      (k.problemy || []).forEach(p => console.log('        ! ' + p));
      (k.sporne || []).forEach(s => console.log(`        ? dzien ${s.dzien}, ${s.pole}: A=${s.A} B=${s.B}`));
      if (k.diagnostyka) {
        for (const w of ['A', 'B']) {
          const d = k.diagnostyka[w];
          console.log(`        [${w}] stop=${d.powodStopu} tokeny=${d.tokeny} json=${d.sparsowane ? 'ok' : 'BRAK'}`);
          if (!d.sparsowane) {
            console.log(`            poczatek: ${JSON.stringify(d.poczatek)}`);
            console.log(`            koniec:   ${JSON.stringify(d.koniec)}`);
          }
        }
      }
    }
    console.log(`\nczas: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  })().catch(e => { console.error('BLAD: ' + e.message); process.exit(1); });
}
