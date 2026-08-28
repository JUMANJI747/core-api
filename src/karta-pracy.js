'use strict';
/**
 * karta-pracy.js — przygotowanie skanów KARTY EWIDENCJI CZASU PRACY pod odczyt modelem.
 *
 * Po co to jest:
 *   Model dostający całą stronę A4 i tak przeskaluje ją do ~1,15 Mpx, przez co wiersz
 *   tabeli ma ~35 px wysokości i cyfry są na granicy czytelności. Tniemy więc stronę na
 *   pasma po 10-11 wierszy, każde mieszczące się w budżecie ~1,15 Mpx osobno. Ten sam
 *   piksel karty jest wtedy wart 2-3x więcej.
 *
 * Wejście : PDF (jedna karta = jedna strona) w base64.
 * Wyjście : dla każdej strony zestaw PNG-ów w base64:
 *             naglowek        - miesiac/rok, nazwisko, norma godzin
 *             lewa[0..2]      - dzien | rozpocz | podpis | zakoncz | podpis | RAZEM
 *             prawa[0..2]     - dzien | RAZEM | normalne | 50% | 100% | nocne | UW | Chor.
 *             pod             - pasek pod tabela (odreczne dopiski)
 *           Pasma 0/1/2 to dni 1-11, 12-21 oraz 22-31 razem z wierszem SUMA.
 *           Kolumna "dzien" jest w KAZDYM wycinku - dzieki temu model nie ma jak
 *           pomylic wiersza, a odczyt lewej i prawej strony da sie zszyc po numerze dnia.
 *
 * Wymaga: poppler-utils (pdftoppm) w obrazie + npm i sharp
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const run = promisify(execFile);

const DPI = 300;              // 200 tez dziala, 300 daje ~84 px na wiersz
const ROWS = 32;              // 31 dni + wiersz SUMA
const BANDS = [11, 10, 11];   // dni 1-11, 12-21, 22-31 + SUMA

/**
 * Udzialy szerokosci tabeli, zmierzone na formularzu. Uzywane, bo cienkie linie
 * wewnetrzne bywaja niewykrywalne na slabym skanie, a ramka zewnetrzna zawsze jest.
 */
const FR = {
  dzienEnd: 0.0395,
  rozpoczStart: 0.0395, rozpoczEnd: 0.1110,
  zakonczStart: 0.2156, zakonczEnd: 0.2927,
  razemStart: 0.3960,
  razemEnd: 0.4738,
  chorEnd: 0.8248,   // koniec kolumny "Chor." (dalej same puste rubryki)
};

const JAKOSC = 82;   // JPEG zamiast PNG: ~12x mniej bajtow, bez widocznej straty na piśmie

/* ---------------------------------------------------------------- narzedzia */

async function pdfPageCount(pdfPath) {
  const { stdout } = await run('pdfinfo', [pdfPath]);
  const m = stdout.match(/^Pages:\s+(\d+)/m);
  if (!m) throw new Error('nie umiem odczytac liczby stron PDF');
  return parseInt(m[1], 10);
}

async function renderPage(pdfPath, page, dir) {
  const base = path.join(dir, `p${page}`);
  // JPEG jako format posredni zamiast PNG: 5 s na strone zamiast 12, a wykrycie
  // siatki wychodzi co do piksela tak samo (sprawdzone na wszystkich kartach).
  await run('pdftoppm', ['-f', String(page), '-l', String(page),
    '-r', String(DPI), '-jpeg', '-jpegopt', 'quality=92', '-singlefile', pdfPath, base]);
  // Prostowanie jest obowiazkowe, nie kosmetyczne: przy przekrzywieniu o 1 stopien
  // pionowa linia rozmazuje sie na kilkanascie kolumn i ramka tabeli znika z profilu.
  const straight = `${base}_d.jpg`;
  try {
    await run('convert', [`${base}.jpg`, '-deskew', '40%', '-background', 'white',
      '+repage', '-quality', '92', straight]);
    return await fs.readFile(straight);
  } catch (e) {
    return fs.readFile(`${base}.jpg`);
  }
}

/** profil ciemnych pikseli wzdluz osi -> pozycje linii siatki */
function findLines(profile, minHits, minGap) {
  const hits = [];
  for (let i = 0; i < profile.length; i++) if (profile[i] >= minHits) hits.push(i);
  const groups = [];
  for (const x of hits) {
    const last = groups[groups.length - 1];
    if (last && x - last[last.length - 1] <= minGap) last.push(x);
    else groups.push([x]);
  }
  return groups.map(g => Math.round(g.reduce((a, b) => a + b, 0) / g.length));
}

/**
 * Ramka tabeli + siatka wierszy. Wiersze liczymy z pierwszej i ostatniej poziomej
 * linii tabeli, nie z kazdej po kolei - pojedyncza urwana linia nie rozwala wtedy
 * przypisania dni.
 */
async function detectGrid(png) {
  const { data, info } = await sharp(png).greyscale().raw()
    .toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const dark = (x, y) => data[y * W + x] < 200 ? 1 : 0;

  // pionowe: szukamy w pasie tabeli, z pominieciem naglowka i stopki
  const yA = Math.round(H * 0.16), yB = Math.round(H * 0.93);
  const colProfile = new Array(W).fill(0);
  for (let y = yA; y < yB; y += 2) for (let x = 0; x < W; x++) colProfile[x] += dark(x, y);
  // Prog schodzimy stopniowo - slaby skan ma ramke ledwo widoczna, ale nadal ciagla.
  let left = null, right = null;
  for (const frac of [0.55, 0.45, 0.35, 0.28]) {
    const vs = findLines(colProfile, (yB - yA) / 2 * frac, 8)
      .filter(x => x < W * 0.15 || x > W * 0.85);   // tylko kandydaci na ramke
    if (vs.length >= 2 && vs[vs.length - 1] - vs[0] >= W * 0.7) {
      left = vs[0]; right = vs[vs.length - 1]; break;
    }
  }
  if (left === null) throw new Error('nie znalazlem ramki tabeli');
  const tw = right - left;

  // poziome: liczymy tylko w lewej polowie, gdzie linie sa pelne
  const xA = left + Math.round(tw * 0.02), xB = left + Math.round(tw * 0.60);
  const rowProfile = new Array(H).fill(0);
  for (let x = xA; x < xB; x += 2) for (let y = 0; y < H; y++) rowProfile[y] += dark(x, y);
  let hs = [];
  for (const frac of [0.55, 0.45, 0.35, 0.28]) {
    hs = findLines(rowProfile, (xB - xA) / 2 * frac, 6).filter(y => y > H * 0.13);
    if (hs.length >= 20) break;
  }
  if (hs.length < 10) throw new Error('nie znalazlem siatki wierszy');

  const top = hs[0], bottom = hs[hs.length - 1];
  const rowH = (bottom - top) / ROWS;
  if (rowH < H * 0.018 || rowH > H * 0.032) {
    throw new Error(`wysokosc wiersza poza norma (${rowH.toFixed(1)} px) - zla strona albo zly skan`);
  }
  const y = i => Math.round(top + i * rowH);
  const x = f => Math.round(left + f * tw);

  return { W, H, left, right, tw, top, bottom, rowH, y, x };
}

/** sklejenie kilku wycinkow w poziomie (kolumna dnia + wlasciwy blok) */
async function glue(png, boxes, top, height) {
  const parts = [];
  let total = 0;
  for (const [x0, x1] of boxes) {
    const w = x1 - x0;
    parts.push({ input: await sharp(png)
      .extract({ left: x0, top, width: w, height }).toBuffer(), left: total, top: 0 });
    total += w + 4;
  }
  return sharp({ create: { width: total, height, channels: 3, background: '#fff' } })
    .composite(parts).normalise().jpeg({ quality: JAKOSC, mozjpeg: true }).toBuffer();
}

/* -------------------------------------------------------------------- glowne */

async function cropCard(png) {
  const g = await detectGrid(png);
  const pad = Math.round(g.rowH * 0.12);
  const colDzien   = [Math.max(0, g.left - 4), g.x(FR.dzienEnd) + 3];
  const colRozpocz = [g.x(FR.rozpoczStart) - 2, g.x(FR.rozpoczEnd) + 3];
  const colZakoncz = [g.x(FR.zakonczStart) - 2, g.x(FR.zakonczEnd) + 3];
  const colRazem   = [g.x(FR.razemStart) - 2, g.x(FR.razemEnd) + 4];
  const colPrawa   = [g.x(FR.razemStart) - 3, g.x(FR.chorEnd) + 4];
  // Kolumny z podpisami sa wycinane: to czysty szum, zjadaly ~40% pikseli pasma
  // i rozpraszaly model, a do liczenia godzin sa bezuzyteczne.

  const lewa = [], prawa = [];
  let r = 0;
  for (let bi = 0; bi < BANDS.length; bi++) {
    const n = BANDS[bi];
    const top = Math.max(0, g.y(r) - pad);
    // ostatnie pasmo konczy sie wierszem SUMA - dajemy mu wiecej luzu, zeby
    // odreczna suma nie zostala przycieta w polowie cyfr
    const dolem = bi === BANDS.length - 1 ? Math.round(g.rowH * 0.45) : pad;
    const height = Math.min(g.H - top, g.y(r + n) - top + dolem);
    lewa.push(await glue(png, [colDzien, colRozpocz, colZakoncz, colRazem], top, height));
    prawa.push(await glue(png, [colDzien, colPrawa], top, height));
    r += n;
  }

  // naglowek to duzy nadrukowany tekst - 1400 px w zupelnosci wystarcza,
  // a pelna szerokosc strony i tak zostalaby przeskalowana po stronie modelu
  // Wiersz SUMA dostaje wlasny wycinek: to jeden wiersz o innej strukturze niz dni,
  // a doklejony na koncu trzeciego pasma byl czytany najgorzej z calej karty.
  // Bierzemy go razem z wierszem 31 dla kontekstu i powiekszamy - jest maly.
  const sumaTop = Math.max(0, g.y(30) - pad);
  const sumaH = Math.min(g.H - sumaTop, g.y(32) - sumaTop + Math.round(g.rowH * 0.25));
  const suma = await sharp(png)
    .extract({ left: Math.max(0, g.left - 4), top: sumaTop,
               width: Math.min(g.W - Math.max(0, g.left - 4), g.x(FR.chorEnd) + 8 - Math.max(0, g.left - 4)),
               height: sumaH })
    .resize({ width: 2200, withoutEnlargement: false })
    .normalise().jpeg({ quality: JAKOSC, mozjpeg: true }).toBuffer();

  const naglowek = await sharp(png)
    .extract({ left: 0, top: 0, width: g.W, height: g.top })
    .resize({ width: Math.min(1400, g.W), withoutEnlargement: true })
    .normalise().jpeg({ quality: JAKOSC, mozjpeg: true }).toBuffer();
  const podTop = Math.min(g.H - 1, g.bottom + 4);
  const pod = await sharp(png)
    .extract({ left: 0, top: podTop, width: g.W, height: g.H - podTop })
    .normalise().jpeg({ quality: JAKOSC, mozjpeg: true }).toBuffer();

  return { naglowek, lewa, prawa, suma, pod, meta: { rowH: +g.rowH.toFixed(1), left: g.left, right: g.right } };
}

/**
 * @param {Buffer} pdf        cala teczka kart, jedna karta = jedna strona
 * @param {number[]} [pages]  ktore strony (domyslnie wszystkie)
 */
async function przygotujKarty(pdf, pages, tylkoInfo) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kp-'));
  const pdfPath = path.join(dir, 'in.pdf');
  try {
    await fs.writeFile(pdfPath, pdf);
    const n = await pdfPageCount(pdfPath);
    // n8n najpierw pyta o liczbe stron, potem tnie strona po stronie - dzieki temu
    // pojedyncza odpowiedz HTTP wazy ~0,6 MB zamiast kilkunastu megabajtow naraz
    if (tylkoInfo) return { stron: n, strony: [] };
    const list = pages && pages.length ? pages : Array.from({ length: n }, (_, i) => i + 1);
    const out = [];
    for (const p of list) {
      if (p < 1 || p > n) { out.push({ page: p, blad: 'strona poza zakresem' }); continue; }
      try {
        const png = await renderPage(pdfPath, p, dir);
        const c = await cropCard(png);
        out.push({
          page: p,
          sha: crypto.createHash('sha1').update(png).digest('hex').slice(0, 12),
          naglowek: c.naglowek.toString('base64'),
          suma: c.suma.toString('base64'),
          lewa: c.lewa.map(b => b.toString('base64')),
          prawa: c.prawa.map(b => b.toString('base64')),
          pod: c.pod.toString('base64'),
          meta: c.meta,
        });
      } catch (e) {
        // fail-closed: strona bez pewnej siatki nie idzie do modelu na oslep
        out.push({ page: p, blad: e.message });
      }
    }
    return { stron: n, strony: out };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------- router expressa */

function router(express, token) {
  const r = express.Router();
  r.post('/karta-pracy/crop', express.json({ limit: '40mb' }), async (req, res) => {
    if (token && req.get('x-token') !== token) return res.status(401).json({ blad: 'zly token' });
    try {
      const { data, pages, tylkoInfo } = req.body || {};
      if (!data) return res.status(400).json({ blad: 'brak pola data' });
      res.json(await przygotujKarty(Buffer.from(data, 'base64'), pages, !!tylkoInfo));
    } catch (e) {
      res.status(500).json({ blad: e.message });
    }
  });
  return r;
}

module.exports = { przygotujKarty, cropCard, detectGrid, router };

/* ------------------------------------------------------------------- CLI test */
if (require.main === module) {
  (async () => {
    const [pdf, outDir = './out'] = process.argv.slice(2);
    const res = await przygotujKarty(await fs.readFile(pdf));
    await fs.mkdir(outDir, { recursive: true });
    for (const s of res.strony) {
      if (s.blad) { console.log(`strona ${s.page}: BLAD ${s.blad}`); continue; }
      for (let i = 0; i < s.lewa.length; i++) {
        await fs.writeFile(`${outDir}/s${s.page}_L${i + 1}.jpg`, Buffer.from(s.lewa[i], 'base64'));
        await fs.writeFile(`${outDir}/s${s.page}_P${i + 1}.jpg`, Buffer.from(s.prawa[i], 'base64'));
      }
      await fs.writeFile(`${outDir}/s${s.page}_naglowek.jpg`, Buffer.from(s.naglowek, 'base64'));
      await fs.writeFile(`${outDir}/s${s.page}_suma.jpg`, Buffer.from(s.suma, 'base64'));
      await fs.writeFile(`${outDir}/s${s.page}_pod.jpg`, Buffer.from(s.pod, 'base64'));
      console.log(`strona ${s.page}: ok, wiersz ${s.meta.rowH} px`);
    }
  })().catch(e => { console.error(e); process.exit(1); });
}
