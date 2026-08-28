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
const { przygotujObrazy } = require('./obrazy');
const { zapytaj, MODEL_DOM } = require('./silnik');
const { PROMPT_KARTA, PROMPT_NAZWISKO, SCHEMAT_KARTY, SCHEMAT_NAZWISKO } = require('./prompty');
const { zszyjIKontroluj } = require('./walidacja');
const { wymiarCzasuPracy } = require('./kalendarz');

// Cennik claude-opus-5 (USD za 1M tokenów, stan 2026-06). Przy zmianie modelu
// domyślnego zaktualizować — koszt w odpowiedzi ma być prawdziwy, nie ozdobny.
const CENY_USD_MTOK = { we: 5, wy: 25 };

async function przetworzStrone(pdfPath, dir, strona, opcje) {
  const t0 = Date.now();
  let obrazy, sha;
  try {
    const png = await renderPage(pdfPath, strona, dir, opcje.dpi || 300);
    sha = crypto.createHash('sha256').update(png).digest('hex').slice(0, 16);
    obrazy = await przygotujObrazy(png);
  } catch (e) {
    return { strona, ok: false, status: 'do_weryfikacji',
      problemy: [`przygotowanie obrazow nie powiodlo sie: ${e.message}`], ostrzezenia: [], sporne: [] };
  }
  try {
    const [glowny, nazwisko2] = await Promise.all([
      zapytaj([obrazy.calaStrona, obrazy.naglowek, obrazy.gornaPolowka, obrazy.dolnaPolowka],
        PROMPT_KARTA, SCHEMAT_KARTY, { model: opcje.model, effort: 'high' }),
      zapytaj([obrazy.naglowek], PROMPT_NAZWISKO, SCHEMAT_NAZWISKO,
        { model: opcje.model, effort: 'low', maxTokens: 2000 }),
    ]);
    const wynik = zszyjIKontroluj(glowny.dane, nazwisko2.dane, opcje, strona);
    wynik.sha = sha;
    wynik.obrazyMeta = obrazy.meta;
    wynik.slad = {
      model: glowny.model,
      tokeny: { glowny: glowny.tokeny, nazwisko: nazwisko2.tokeny },
      czasMs: Date.now() - t0,
      thinking: (glowny.thinking || '').slice(0, 4000) || null,
    };
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
