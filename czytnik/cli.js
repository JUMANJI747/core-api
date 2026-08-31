'use strict';
/**
 * cli.js — testy z ręki, bez HTTP.
 *
 *   node cli.js obrazy <plik.pdf> <strona> [katalog]   — zrzuca 4 obrazy (bez modelu)
 *   node cli.js odczyt <plik.pdf> [strony np. 1,2,5]   — pełny odczyt (wymaga ANTHROPIC_API_KEY)
 *   node cli.js karty <katalog|plik.pdf> [2026-09] [ile]  — PUSTE karty do wydruku dla całej listy
 *       (katalog -> jeden PDF na miesiąc, nazwa z .pdf -> wszystko w jednym pliku)
 */

const fs = require('fs/promises');
const os = require('os');
const path = require('path');

(async () => {
  const [tryb, plik, ...reszta] = process.argv.slice(2);
  if (!tryb || !plik) {
    console.error('uzycie: node cli.js obrazy <pdf> <strona> [out] | node cli.js odczyt <pdf> [strony]'
      + ' | node cli.js karty <pdf> [2026-09] [ile]');
    process.exit(1);
  }

  if (tryb === 'karty') {
    const { kartyDoDruku } = require('./src/karta-druk');
    const [rok, mies] = String(reszta[0] || '').split('-').map(Number);
    const jedenPlik = plik.toLowerCase().endsWith('.pdf');
    const w = await kartyDoDruku({
      od: rok && mies ? { rok, miesiac: mies } : null,
      miesiecy: Number(reszta[1]) || 3,
      podziel: jedenPlik ? 'nie' : 'miesiac',
    });
    if (!jedenPlik) await fs.mkdir(plik, { recursive: true });
    const osoby = new Set(w.karty.map(k => k.osoba));
    console.log(`${w.karty.length} kart (${osoby.size} osob x ${w.okresy.length} mies.)`);
    for (const p of w.pliki) {
      const cel = jedenPlik ? plik : path.join(plik, p.nazwa);
      await fs.writeFile(cel, p.pdf);
      const norma = w.karty.find(k => !p.okres || (k.rok === p.okres.rok && k.miesiac === p.okres.miesiac)).norma;
      console.log(`  ${cel}: ${p.stron} stron${p.okres ? `, norma ${norma} h` : ''}`);
    }
    return;
  }

  if (tryb === 'obrazy') {
    const { renderPage } = require('./src/render');
    const { przygotujObrazy } = require('./src/obrazy');
    const strona = Number(reszta[0]) || 1;
    const out = reszta[1] || './out';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'czytnik-cli-'));
    const pdfPath = path.join(dir, 'in.pdf');
    await fs.writeFile(pdfPath, await fs.readFile(plik));
    const png = await renderPage(pdfPath, strona, dir);
    const o = await przygotujObrazy(png);
    await fs.mkdir(out, { recursive: true });
    for (const k of ['calaStrona', 'naglowek', 'gornaPolowka', 'dolnaPolowka']) {
      await fs.writeFile(`${out}/s${strona}_${k}.jpg`, Buffer.from(o[k], 'base64'));
    }
    console.log(JSON.stringify(o.meta, null, 2));
    await fs.rm(dir, { recursive: true, force: true });
    return;
  }

  if (tryb === 'odczyt') {
    const { odczytajTeczke } = require('./src/czytnik');
    const strony = reszta[0] ? reszta[0].split(',').map(Number) : undefined;
    const t0 = Date.now();
    const w = await odczytajTeczke(await fs.readFile(plik), { strony });
    console.log(`\nstron: ${w.stron} | okres: ${w.miesiac}/${w.rok} | norma: ${w.norma} | auto: ${w.kartOk}/${w.przetworzone.length}`);
    for (const k of w.karty) {
      console.log(`str.${String(k.strona).padStart(2)} ${String(k.status || '?').padEnd(15)} ${String(k.nazwisko || '?').padEnd(24)} C=${k.C ?? '-'} G=${k.G ?? '-'} sciezki=[${(k.sciezki && k.sciezki.zgodne || []).join(',')}]`);
      (k.problemy || []).forEach(p => console.log('   ! ' + p));
      (k.sporne || []).forEach(s => console.log('   ? ' + JSON.stringify(s)));
    }
    console.log(`\nczas: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return;
  }

  console.error('nieznany tryb: ' + tryb);
  process.exit(1);
})().catch(e => { console.error('BLAD:', e.message); process.exit(1); });
