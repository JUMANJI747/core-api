'use strict';
/**
 * czytnik.js — orkiestracja odczytu teczki: render → obrazy → model → walidacja.
 *
 * P0 na kartę = DWA wywołania modelu naraz:
 *   1. odczyt główny: 4 obrazy (cała strona + nagłówek + 2 połówki), effort high,
 *      polityka zapis/wniosek, structured output,
 *   2. ślepy odczyt nazwiska: sam nagłówek, effort low, BEZ listy pracowników
 *      w prompcie (dopasowanie do listy robi kod) — dekorelacja od odczytu 1.
 *
 * Drabina eskalacji (P1 zoom spornych pól, P2 drugi pełny odczyt) — NASTĘPNY etap;
 * na razie karta niedomknięta wychodzi ze statusem do_weryfikacji z pełnym śladem.
 */

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { pdfPageCount, renderPage } = require('./render');
const { przygotujObrazy, detectGrid, wytnijKomorke } = require('./obrazy');
const { zapytaj, MODEL_DOM } = require('./silnik');
const { PROMPT_KARTA, PROMPT_NAZWISKO, SCHEMAT_KARTY, SCHEMAT_NAZWISKO,
  SCHEMAT_ZOOM, PROMPT_ZOOM, PROMPT_ZOOM_SUMA, SCHEMAT_KOLUMNA, PROMPT_KOLUMNA } = require('./prompty');
const { zszyjIKontroluj } = require('./walidacja');
const { zbudujGrafikMiesiaca } = require('./grafik');
const { wymiarCzasuPracy } = require('./kalendarz');

// pola sporne, które umiemy dograć zoomem (mapa: nazwa z walidacji -> kolumna)
const POLA_ZOOM = { 'RAZEM': 'razem', '100%': 'sto', 'nocne': 'nocne', 'UW': 'uw', 'Chor.': 'chor' };
const MAX_POL_ZOOM = 6;

/**
 * Dogrywka P1: każde sporne pole wycinamy ×4 i czytamy PONOWNIE, neutralnie
 * (model nie zna hipotez — zero kotwiczenia), z kolumną numeru dnia jako
 * kontrolą tożsamości wiersza. Zoom to TRANSKRYPCJA: wynik wchodzi do OBU
 * kanałów (zapis i wniosek), a potem karta przechodzi PEŁNĄ walidację od nowa —
 * dogrywka niczego nie "przepycha", tylko dostarcza lepszy odczyt; o statusie
 * auto nadal decydują ścieżki dowodowe.
 */
async function dogrywkaZoom(png, p0, wynik, opcje, slad) {
  // deduplikacja po (dzien, pole): to samo pole bywa sporne z dwóch powodów
  // (niska pewność P0 + rozjazd ze ślepą kolumną) — zoomujemy raz
  const widziane = new Set();
  const sporneZoom = (wynik.sporne || []).filter(s => {
    if (!POLA_ZOOM[s.pole]) return false;
    if (s.dzien !== 'SUMA' && !(Number(s.dzien) >= 1 && Number(s.dzien) <= 31)) return false;
    const k = s.dzien + '|' + s.pole;
    if (widziane.has(k)) return false;
    widziane.add(k);
    return true;
  });
  if (!sporneZoom.length || sporneZoom.length > MAX_POL_ZOOM) return null;
  let g;
  try { g = await detectGrid(png); } catch (e) { return null; }   // bez siatki nie ma zoomu

  const poprawki = [];
  for (const s of sporneZoom) {
    const pole = POLA_ZOOM[s.pole];
    try {
      const obraz = await wytnijKomorke(png, g, s.dzien, pole);
      const o = await zapytaj([obraz],
        s.dzien === 'SUMA' ? PROMPT_ZOOM_SUMA(pole) : PROMPT_ZOOM(pole),
        SCHEMAT_ZOOM, { model: opcje.model, effort: 'low', maxTokens: 1500 });
      slad.zoomy = (slad.zoomy || 0) + 1;
      // zoom w slad.tokeny, żeby wchodził do kosztUSD przebiegu
      if (o.tokeny) {
        slad.tokeny.zoom = slad.tokeny.zoom || { we: 0, wy: 0 };
        slad.tokeny.zoom.we += o.tokeny.we; slad.tokeny.zoom.wy += o.tokeny.wy;
      }
      const d = o.dane || {};
      // kontrola tożsamości wiersza: niezgodny numer dnia = błąd cięcia, zoom nieważny
      if (s.dzien !== 'SUMA' && String(d.dzien).trim() !== String(s.dzien)) continue;
      if (d.wartosc === '?' || d.wartosc === undefined) continue;   // nadal nieczytelne
      // sanity zakresu: dzień to 0-24 h, SUMA do 400 — wartość spoza zakresu
      // to błąd odczytu zoomu (np. "8,5" jako 85), nie dane
      if (d.wartosc !== '') {
        const n = Number(String(d.wartosc).replace(',', '.'));
        if (!Number.isFinite(n) || n < 0 || n > (s.dzien === 'SUMA' ? 400 : 24)) continue;
      }
      if (s.dzien === 'SUMA') {
        if (p0.suma) { p0.suma.zapis[pole] = d.wartosc; p0.suma.wniosek[pole] = d.wartosc; }
      } else {
        const w = p0.dni.find(x => Number(x.d) === Number(s.dzien));
        if (!w) continue;
        w.zapis[pole] = d.wartosc; w.wniosek[pole] = d.wartosc;
        if (d.pewnosc === 'wysoka') w.pewnosc = 'wysoka';
        w.uwaga = (w.uwaga ? w.uwaga + '; ' : '') + `dogrywka zoom ${s.pole}: "${d.wartosc}"`;
      }
      poprawki.push({ dzien: s.dzien, pole: s.pole, przed: s.wniosek ?? s.zapis ?? null, zoom: d.wartosc });
    } catch (e) {
      // pojedynczy nieudany zoom nie przerywa dogrywki
    }
  }
  return poprawki.length ? poprawki : null;
}

/** wycinki spornych pól dla człowieka — do maila z formularzem (n8n) */
async function paczkaRewizyjna(png, wynik) {
  const sporne = (wynik.sporne || []).filter(s => POLA_ZOOM[s.pole]).slice(0, MAX_POL_ZOOM);
  if (!sporne.length) return null;
  let g;
  try { g = await detectGrid(png); } catch (e) { return null; }
  const paczka = [];
  for (const s of sporne) {
    try {
      paczka.push({
        dzien: s.dzien, pole: s.pole,
        odczyty: { zapis: s.zapis ?? null, wniosek: s.wniosek ?? null, uwaga: s.uwaga || null },
        obraz: await wytnijKomorke(png, g, s.dzien, POLA_ZOOM[s.pole]),
      });
    } catch (e) { /* pojedynczy wycinek moze sie nie udac */ }
  }
  return paczka.length ? paczka : null;
}

// Cennik claude-opus-5 (USD za 1M tokenów, stan 2026-06). Przy zmianie modelu
// domyślnego zaktualizować — koszt w odpowiedzi ma być prawdziwy, nie ozdobny.
const CENY_USD_MTOK = { we: 5, wy: 25 };

async function przetworzStrone(pdfPath, dir, strona, opcje) {
  const t0 = Date.now();
  let obrazy, sha, png;
  try {
    png = await renderPage(pdfPath, strona, dir, opcje.dpi || 300);
    sha = crypto.createHash('sha256').update(png).digest('hex').slice(0, 16);
    obrazy = await przygotujObrazy(png);
  } catch (e) {
    return { strona, ok: false, status: 'do_weryfikacji',
      problemy: [`przygotowanie obrazow nie powiodlo sie: ${e.message}`], ostrzezenia: [], sporne: [] };
  }
  try {
    const [glowny, nazwisko2, slepaKolumna] = await Promise.all([
      zapytaj([obrazy.calaStrona, obrazy.naglowek, obrazy.gornaPolowka, obrazy.dolnaPolowka],
        PROMPT_KARTA, SCHEMAT_KARTY, { model: opcje.model, effort: 'high' }),
      zapytaj([obrazy.naglowek], PROMPT_NAZWISKO, SCHEMAT_NAZWISKO,
        { model: opcje.model, effort: 'low', maxTokens: 2000 }),
      // niezależna ścieżka dowodowa: ślepa transkrypcja kolumny RAZEM
      zapytaj([obrazy.gornaPolowka, obrazy.dolnaPolowka], PROMPT_KOLUMNA, SCHEMAT_KOLUMNA,
        { model: opcje.model, effort: 'low', maxTokens: 4000 }),
    ]);
    const slad = {
      model: glowny.model,
      tokeny: { glowny: glowny.tokeny, nazwisko: nazwisko2.tokeny, slepaKolumna: slepaKolumna.tokeny },
      thinking: (glowny.thinking || '').slice(0, 4000) || null,
    };
    let wynik = zszyjIKontroluj(glowny.dane, nazwisko2.dane, opcje, strona, slepaKolumna.dane);

    // P1: sporne pola dogrywamy zoomem NA KOPII danych i walidujemy od nowa.
    // Werdykt zoomu przyjmujemy TYLKO, gdy karta po nim jest lepsza (mniej
    // problemów+spornych albo pełne auto) — zoom też bywa omylny ("8,5" vs 85)
    // i nie wolno mu psuć dobrego odczytu głównego.
    if (wynik.status !== 'auto' && (wynik.sporne || []).length) {
      const kopia = JSON.parse(JSON.stringify(glowny.dane));
      const poprawki = await dogrywkaZoom(png, kopia, wynik, opcje, slad);
      if (poprawki) {
        const wynik2 = zszyjIKontroluj(kopia, nazwisko2.dane, opcje, strona, slepaKolumna.dane);
        const kara = w => (w.problemy || []).length + (w.sporne || []).length;
        if (wynik2.status === 'auto' || kara(wynik2) < kara(wynik)) {
          wynik = wynik2;
          wynik.dogrywka = poprawki;
        } else {
          wynik.dogrywkaOdrzucona = poprawki;   // ślad: zoom nie poprawił karty
        }
      }
    }
    // co zostało sporne po dogrywce, idzie do człowieka z wycinkami
    if (wynik.status !== 'auto' && (wynik.sporne || []).length) {
      wynik.paczkaRewizyjna = await paczkaRewizyjna(png, wynik);
    }

    wynik.sha = sha;
    wynik.obrazyMeta = obrazy.meta;
    slad.czasMs = Date.now() - t0;
    wynik.slad = slad;
    /* SUROWY ODCZYT DO PONOWNEGO UZYCIA (opcja zapiszSurowe).
       Powod: strojenie regul walidacji (przerwy, stawki nieobecnosci, bramka
       auto) NIE wymaga ponownego czytania obrazow - a wlasnie na tym przepalilismy
       ~$100 przy dopracowywaniu regul, czytajac te same karty 13 razy. Z surowym
       odczytem na dysku kazda kolejna zmiana reguly kosztuje ZERO: `npm run eval`
       przepuszcza zapisane odczyty przez aktualna walidacje offline. */
    if (opcje.zapiszSurowe) {
      wynik.surowe = {
        glowny: glowny.dane,
        nazwisko: nazwisko2.dane,
        slepaKolumna: slepaKolumna.dane,
        model: glowny.model,
        okres: { rok: opcje.rok, miesiac: opcje.miesiac, nazwiska: opcje.nazwiska,
                 stawkiDnia: opcje.stawkiDnia, domyslnaStawkaDnia: opcje.domyslnaStawkaDnia,
                 zrodloGodzin: opcje.zrodloGodzin, grafikZmianowy: opcje.grafikZmianowy },
      };
    }
    return wynik;
  } catch (e) {
    return { strona, sha, ok: false, status: 'do_weryfikacji',
      problemy: [`blad wywolania modelu: ${e.message}`], ostrzezenia: [], sporne: [],
      obrazyMeta: obrazy.meta };
  }
}

/** prosta pula — kilka kart naraz */
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
  const rownolegle = Math.max(1, Math.min(3, Number(opcje.rownolegle) || 2));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'czytnik-'));
  const pdfPath = path.join(dir, 'in.pdf');
  try {
    await fs.writeFile(pdfPath, pdf);
    const stron = await pdfPageCount(pdfPath);
    const wybrane = Array.isArray(opcje.strony) && opcje.strony.length
      ? opcje.strony.map(Number).filter(p => p >= 1 && p <= stron)
      : Array.from({ length: stron }, (_, i) => i + 1);
    if (!wybrane.length) throw new Error('zadna z podanych stron nie miesci sie w zakresie 1-' + stron);

    const okres = {
      rok: Number(opcje.rok) || null, miesiac: Number(opcje.miesiac) || null,
      nazwiska: Array.isArray(opcje.nazwiska) ? opcje.nazwiska : null,
      // stawki dnia nieobecnosci (UW/Chor. oznaczane ptaszkiem = dzien):
      // domyslnie 8 h, wyjatki per osoba (3/4 etatu = 6 h)
      stawkiDnia: opcje.stawkiDnia && typeof opcje.stawkiDnia === 'object' ? opcje.stawkiDnia : null,
      domyslnaStawkaDnia: Number(opcje.domyslnaStawkaDnia) || 8,
      // 'razem' = stajnia (ludzie odliczaja przerwy), 'odDo' = reszta obiektow
      zrodloGodzin: opcje.zrodloGodzin === 'razem' ? 'razem' : 'odDo',
      // osoby w grafiku zmianowym 12/12 - ptaszek nieobecnosci wymaga grafiku
      grafikZmianowy: Array.isArray(opcje.grafikZmianowy) ? opcje.grafikZmianowy : null,
      // grafik zmian: gotowa mapa albo surowe arkusze z Google Sheets do sparsowania
      grafik: opcje.grafik && typeof opcje.grafik === 'object' ? opcje.grafik
        : (Array.isArray(opcje.grafikArkusze) && Array.isArray(opcje.nazwiska)
            ? zbudujGrafikMiesiaca(opcje.grafikArkusze, opcje.nazwiska).grafik : null),
      model: opcje.model || MODEL_DOM, dpi: opcje.dpi,
    };
        const zepsute = (okres.nazwiska || []).filter(n => /[\uFFFD]|[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(String(n)));
    if (zepsute.length) throw new Error('lista nazwisk dotarla z uszkodzonym kodowaniem - wyslij body jako UTF-8');

    const zadania = wybrane.map(p => () => przetworzStrone(pdfPath, dir, p, okres));
    const karty = await pula(zadania, rownolegle);

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

    // Podliczenie kosztu przebiegu z realnego zużycia (user chce widzieć,
    // ile kosztuje miesiąc — każda odpowiedź niesie tokeny i USD).
    let tokWe = 0, tokWy = 0;
    for (const k of karty) {
      const t = k.slad && k.slad.tokeny;
      if (t) for (const x of Object.values(t)) if (x) { tokWe += x.we || 0; tokWy += x.wy || 0; }
    }

    return {
      silnik: 'czytnik-p0', stron, przetworzone: wybrane, rok, miesiac,
      norma: (rok && miesiac) ? wymiarCzasuPracy(rok, miesiac) : null,
      normaCzesc: (rok && miesiac) ? wymiarCzasuPracy(rok, miesiac) * 0.75 : null,
      kartOk: karty.filter(k => k.ok).length,
      tokeny: { we: tokWe, wy: tokWy },
      kosztUSD: +(tokWe / 1e6 * CENY_USD_MTOK.we + tokWy / 1e6 * CENY_USD_MTOK.wy).toFixed(3),
      problemyOgolne,
      // "dni" zostaja po stronie serwera w wersji z baza; na razie zwracamy je,
      // bo pelnia role sladu (eval porownuje per pole)
      karty,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { odczytajTeczke, przetworzStrone };
