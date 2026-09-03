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
const { obrazyZlecenia } = require('./obrazy');
const { zapytaj } = require('./silnik');
const silnikOpenai = require('./silnik-openai');
const { SCHEMAT_ZLECENIE, PROMPT_ZLECENIE } = require('./prompty-zlecenie');
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

/** godziny jednego dnia: z przedziału od-do, a gdy go nie ma - z samej liczby */
function godzinyDnia(w) {
  const z = czasZOdDo(w.od, w.do);
  if (z !== null) return z;
  const liczba = L(w.zapis);
  // sam "7-15" bez rozbicia na od/do tez umiemy
  if (liczba === null && /\d/.test(String(w.zapis || ''))) {
    const m = String(w.zapis).replace(/\s/g, '').match(/^(\d{1,2}(?:[:.]\d{2})?)-(\d{1,2}(?:[:.]\d{2})?)$/);
    if (m) return czasZOdDo(m[1], m[2]);
  }
  return liczba !== null && liczba >= 0 && liczba <= 24 ? liczba : null;
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
    obrazy = await obrazyZlecenia(png);
  } catch (e) {
    return { strona, ok: false, status: 'do_weryfikacji',
      problemy: [`przygotowanie obrazow nie powiodlo sie: ${e.message}`], ostrzezenia: [], sporne: [] };
  }
  const komplet = [obrazy.calaStrona, obrazy.naglowek, obrazy.gornaPolowka, obrazy.dolnaPolowka];
  try {
    const chceDrugi = opcje.drugiOdczyt !== false && silnikOpenai.skonfigurowany();
    const [glowny, drugi] = await Promise.all([
      zapytaj(komplet, PROMPT_ZLECENIE, SCHEMAT_ZLECENIE, { model: opcje.model, effort: 'high' }),
      chceDrugi
        ? silnikOpenai.zapytaj(komplet, PROMPT_ZLECENIE, SCHEMAT_ZLECENIE, { model: opcje.modelDrugi })
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

module.exports = { odczytajTeczkeZlecen, przetworzStroneZlecenia, walidujZlecenie, godzinyDnia, numerMiesiaca };
