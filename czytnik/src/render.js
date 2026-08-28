'use strict';
/**
 * render.js — PDF → wyprostowany JPEG strony.
 * KOPIA sprawdzonego renderu z core-api/src/karta-pracy.js (pdftoppm + deskew).
 * Wymaga w obrazie: poppler-utils, imagemagick.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');

const run = promisify(execFile);

async function pdfPageCount(pdfPath) {
  const { stdout } = await run('pdfinfo', [pdfPath]);
  const m = stdout.match(/^Pages:\s+(\d+)/m);
  if (!m) throw new Error('nie umiem odczytac liczby stron PDF');
  return parseInt(m[1], 10);
}

async function renderPage(pdfPath, page, dir, dpi = 300) {
  const base = `${dir}/p${page}`;
  await run('pdftoppm', ['-f', String(page), '-l', String(page), '-r', String(dpi),
    '-jpeg', '-jpegopt', 'quality=92', '-singlefile', pdfPath, base]);
  // Prostowanie obowiązkowe: 1 stopień przekrzywienia rozmazuje pionowe linie
  // na kilkanaście kolumn i detekcja ramki znika z profilu.
  const prosty = `${base}_d.jpg`;
  try {
    await run('convert', [`${base}.jpg`, '-deskew', '40%', '-background', 'white',
      '+repage', '-quality', '92', prosty]);
    return await fs.readFile(prosty);
  } catch (e) {
    return fs.readFile(`${base}.jpg`);
  }
}

module.exports = { pdfPageCount, renderPage };
