'use strict';

// Preprocessing skanów paragonów dla n8n (przed wysłaniem do OCR).
// POST /preprocess-scan  body: { data: <base64>, mime: 'application/pdf'|'image/jpeg'|... }
//  - cyfrowy PDF (pdftotext > 200 znaków) → { skip: true } (nie ruszamy),
//  - skan-PDF → pdftoppm -r 300 -png (strony 1-3); obraz → convert do PNG,
//  - per strona: tesseract --psm 0 (OSD "Rotate: N", pad → 0), convert
//    -rotate N -deskew 40% -normalize, potem PRZYCIĘCIE DO TREŚCI i
//    powiększenie do limitu API (services/kadr-skanu.js),
//  - wynik: { pages: ["<base64 PNG>", ...], kadry: [{przyciete, udzialTresci, wymiary}] }.
// Auth: nagłówek x-token == PREPROCESS_TOKEN (brak env = endpoint otwarty).
// Montowany POZA /api (nie podlega x-api-key) i PRZED globalnym express.json —
// ma WŁASNY parser z limitem 25 MB. Wymaga: poppler-utils, imagemagick,
// tesseract-ocr (nixpacks.toml aptPkgs).

const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { kadrujDoTresci } = require('../services/kadr-skanu');

const router = express.Router();

const MAX_PAGES = 3;

function run(cmd, args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${cmd} failed: ${err.message}${stderr ? ` | stderr: ${String(stderr).slice(0, 300)}` : ''}`;
        return reject(err);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function authOk(req) {
  const expected = (process.env.PREPROCESS_TOKEN || '').trim();
  if (!expected) return true; // brak env = bez autoryzacji (świadomie)
  return String(req.headers['x-token'] || '').trim() === expected;
}

router.post('/preprocess-scan', express.json({ limit: '25mb' }), async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { data, mime } = req.body || {};
  if (!data || !mime) return res.status(400).json({ error: 'data (base64) i mime są wymagane' });

  let tmp = null;
  try {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prescan-'));
    const buf = Buffer.from(String(data), 'base64');
    if (!buf.length) return res.status(400).json({ error: 'pusty plik po dekodowaniu base64' });
    /* Log wejścia. Gdy n8n zgłosi 500, w mailu jest sam kod statusu — bez tej
       linii w logu Railway nie da się nawet powiedzieć, JAK DUŻY plik poległ. */
    console.log(`[preprocess-scan] wejście: ${mime}, ${(buf.length / 1048576).toFixed(1)} MB`);

    const pagePaths = [];
    if (/pdf/i.test(String(mime))) {
      const pdfPath = path.join(tmp, 'in.pdf');
      await fs.writeFile(pdfPath, buf);

      // a) Cyfrowy PDF (ma warstwę tekstu) → OCR zbędny, nie przetwarzamy.
      try {
        const { stdout } = await run('pdftotext', [pdfPath, '-'], { timeout: 20000 });
        if (stdout.replace(/\s+/g, '').length > 200) {
          return res.json({ skip: true });
        }
      } catch (e) {
        console.warn('[preprocess-scan] pdftotext padł — traktuję jak skan:', e.message);
      }

      // b) Skan-PDF → render stron do PNG (300 dpi, strony 1..MAX_PAGES).
      await run('pdftoppm', ['-r', '300', '-png', '-f', '1', '-l', String(MAX_PAGES), pdfPath, path.join(tmp, 'page')], { timeout: 60000 });
      const rendered = (await fs.readdir(tmp)).filter(f => f.startsWith('page') && f.endsWith('.png')).sort();
      if (!rendered.length) return res.status(500).json({ error: 'pdftoppm nie wyrenderował żadnej strony' });
      pagePaths.push(...rendered.map(f => path.join(tmp, f)));
    } else {
      // b) Obraz (jpg/png/webp/...) → jednolicie do PNG.
      const inPath = path.join(tmp, 'in.img');
      await fs.writeFile(inPath, buf);
      const outPath = path.join(tmp, 'page-1.png');
      await run('convert', [inPath, outPath], { timeout: 30000 });
      pagePaths.push(outPath);
    }

    // c) Per strona: detekcja obrotu (tesseract OSD) + korekta/czyszczenie.
    const pages = [];
    const kadry = []; // per strona: czy przycięto i do jakich wymiarów — widać w n8n
    /* JEDNA STRONA NIE MOŻE ZABRAĆ CAŁEGO SKANU. Wcześniej `convert` stał tu
       goły: awaria albo timeout na DOWOLNEJ stronie leciała do zewnętrznego
       catch i całe żądanie kończyło się 500 — także wtedy, gdy strona 1 była
       już gotowa. n8n dostawał zero stron i szedł do modelu z oryginałem
       (raport BAR z 07.09.2026). Surowy render z pdftoppm już leży na dysku
       i jest lepszy niż nic: bez prostowania, ale czytelny. */
    for (const p of pagePaths.slice(0, MAX_PAGES)) {
      try {
        let rotate = 0;
        try {
          const { stdout, stderr } = await run('tesseract', [p, 'stdout', '--psm', '0'], { timeout: 30000 });
          const m = (stdout + '\n' + stderr).match(/Rotate:\s*(\d+)/i);
          if (m) rotate = parseInt(m[1], 10) || 0;
        } catch (e) {
          console.warn('[preprocess-scan] OSD padł (rotate=0):', e.message);
        }
        const cleaned = p.replace(/\.png$/, '-clean.png');
        // Bez -resize: rozmiar ustala kadrowanie niżej (do limitu API), a nie
        // stała, która na skanie A4 i tak nie działała ('2000x2000<' = tylko powiększ).
        await run('convert', [p, '-rotate', String(rotate), '-deskew', '40%', '-normalize', cleaned], { timeout: 60000 });
        const wyprostowana = await fs.readFile(cleaned);

        /* d) PRZYCIĘCIE DO TREŚCI + powiększenie do limitu API. Paragon z 04.09.2026
           zajmował 11% kartki — model dostawał białą stronę z drobnym drukiem i
           pomylił cyfrę. Wyłączalne przez PREPROCESS_BEZ_KADRU=1 (awaryjnie). */
        if (process.env.PREPROCESS_BEZ_KADRU === '1') {
          pages.push(wyprostowana.toString('base64'));
          kadry.push({ przyciete: false, powod: 'wyłączone przez PREPROCESS_BEZ_KADRU' });
        } else {
          try {
            const k = await kadrujDoTresci(wyprostowana);
            pages.push(k.png.toString('base64'));
            kadry.push({ przyciete: k.przyciete, udzialTresci: k.udzialTresci, wymiary: k.wymiary });
          } catch (e) {
            // kadrowanie nie może zatrzymać odczytu — oddajemy stronę bez kadru i mówimy o tym
            console.warn('[preprocess-scan] kadrowanie padło, strona bez kadru:', e.message);
            pages.push(wyprostowana.toString('base64'));
            kadry.push({ przyciete: false, blad: e.message });
          }
        }
      } catch (e) {
        console.warn(`[preprocess-scan] strona ${path.basename(p)} bez obróbki:`, e.message);
        try {
          pages.push((await fs.readFile(p)).toString('base64'));
          kadry.push({ przyciete: false, surowa: true, blad: e.message });
        } catch (e2) {
          // renderu też nie da się odczytać — tej jednej strony po prostu nie ma
          console.error(`[preprocess-scan] strona ${path.basename(p)} stracona:`, e2.message);
          kadry.push({ przyciete: false, stracona: true, blad: `${e.message} | render: ${e2.message}` });
        }
      }
    }

    /* 500 dopiero wtedy, gdy NAPRAWDĘ nie ma czego oddać. Częściowy wynik jest
       wart więcej niż błąd: n8n dostaje strony, które się udały, i widzi
       w `kadry`, co poszło nie tak z resztą. */
    if (!pages.length) {
      return res.status(500).json({ error: 'żadnej strony nie udało się przygotować', kadry });
    }
    res.json({ pages, kadry });
  } catch (e) {
    console.error('[preprocess-scan]', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    if (tmp) fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

module.exports = router;
