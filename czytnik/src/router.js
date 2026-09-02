'use strict';
/**
 * router.js — HTTP Czytnika. Fabryka routera, używana w DWÓCH miejscach:
 *  1. czytnik/src/index.js — samodzielny serwis (docelowy),
 *  2. core-api/src/index.js — TYMCZASOWY montaż pod /czytnik/* na czas pomiarów
 *     (produkcja core-api ma klucz Anthropic; po powstaniu osobnego serwisu
 *     Railway montaż znika).
 *
 * Tryby:
 *  - synchroniczny (małe porcje stron): POST /czytnik/odczytaj -> wynik w odpowiedzi,
 *  - asynchroniczny: body {async:true} -> 202 {przebiegId}; odbiór:
 *    GET /czytnik/przebieg/:id. Teczka może liczyć się całą noc — nikt nie czeka
 *    na HTTP. Przebiegi trzymane w pamięci (baza dojdzie w następnym etapie;
 *    restart procesu = przebieg do powtórzenia, n8n dostanie 404 i ponowi).
 *
 * Alias /karty-pracy/odczytaj jest wystawiany TYLKO w samodzielnym serwisie
 * (żeby przełączenie n8n było samą zmianą URL-a) — patrz index.js.
 */

const crypto = require('crypto');
const { odczytajTeczke } = require('./czytnik');
const { nowaZakladka } = require('./arkusz');
const { wymiarCzasuPracy } = require('./kalendarz');
const { kartyDoDruku, domyslniPracownicy } = require('./karta-druk');
const { spakuj } = require('./zip');
const { MODEL_DOM } = require('./silnik');

const przebiegi = new Map();   // id -> {status, start, wynik?, blad?}

function sprzatajPrzebiegi() {
  const doba = 24 * 3600 * 1000;
  for (const [id, p] of przebiegi) if (Date.now() - p.start > doba) przebiegi.delete(id);
}

function wyciagnijOpcje(body) {
  const { strony, rok, miesiac, nazwiska, rownolegle, model, dpi,
    stawkiDnia, domyslnaStawkaDnia, zapiszSurowe, zrodloGodzin, grafikZmianowy, grafik, grafikArkusze, imionaGrafiku } = body || {};
  return { strony, rok, miesiac, nazwiska, rownolegle, model, dpi,
    stawkiDnia, domyslnaStawkaDnia, zapiszSurowe, zrodloGodzin, grafikZmianowy,
    grafik, grafikArkusze, imionaGrafiku };
}

function router(express, token) {
  const r = express.Router();
  const auth = (req, res) => {
    if (token && req.get('x-token') !== String(token).trim()) {
      res.status(401).json({ blad: 'zly token' });
      return false;
    }
    return true;
  };

  r.get('/czytnik/zdrowie', (req, res) => {
    res.json({
      ok: true, silnik: 'czytnik-p0', model: MODEL_DOM,
      maKlucz: !!process.env.ANTHROPIC_API_KEY,
      przebiegiWPamieci: przebiegi.size,
      commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    });
  });

  r.post('/czytnik/odczytaj', express.json({ limit: '48mb' }), async (req, res) => {
    if (!auth(req, res)) return;
    const { data, async: tryb } = req.body || {};
    if (!data) return res.status(400).json({ blad: 'brak pola data' });
    const pdf = Buffer.from(data, 'base64');
    const opcje = wyciagnijOpcje(req.body);
    if (tryb) {
      sprzatajPrzebiegi();
      const id = crypto.randomBytes(8).toString('hex');
      przebiegi.set(id, { status: 'w_toku', start: Date.now() });
      odczytajTeczke(pdf, opcje)
        .then(w => przebiegi.set(id, { status: 'gotowy', start: Date.now(), wynik: w }))
        .catch(e => przebiegi.set(id, { status: 'blad', start: Date.now(), blad: e.message }));
      return res.status(202).json({ przebiegId: id });
    }
    try {
      res.json(await odczytajTeczke(pdf, opcje));
    } catch (e) {
      res.status(500).json({ blad: e.message });
    }
  });

  /* Wymiar czasu pracy miesiaca z art. 130 KP — to samo, co Ala trzyma w I1.
     Nie pobieramy tego z sieci: wyliczenie zgadza sie z 42 z 43 zakladek arkusza
     GODZINY (jedyny wyjatek to Grudzien 2025, gdzie arkusz ma 160 zamiast 168). */
  r.get('/czytnik/norma', (req, res) => {
    const rok = Number(req.query.rok), miesiac = Number(req.query.miesiac);
    if (!(rok > 2000) || !(miesiac >= 1 && miesiac <= 12)) {
      return res.status(400).json({ blad: 'podaj ?rok=2026&miesiac=8' });
    }
    res.json({ rok, miesiac, norma: wymiarCzasuPracy(rok, miesiac), zrodlo: 'art. 130 Kodeksu pracy' });
  });

  /* Nowa zakladka miesiaca w arkuszu GODZINY: przenosi salda (TOTAL ->
     POPRZEDNI OKRES, NOCNE TOTAL -> NOCNE POPRZEDNI), wstawia norme i formuly.
     Zaklada ja TYLKO gdy zamykany miesiac jest kompletny - inaczej saldo
     przeszloby niepelne (mozna wymusic: wymuszaj: true). */
  r.post('/czytnik/nowa-zakladka', express.json({ limit: '8mb' }), (req, res) => {
    if (!auth(req, res)) return;
    try {
      const { poprzedniaSiatka, wyniki, rok, miesiac, wymuszaj } = req.body || {};
      if (!Array.isArray(poprzedniaSiatka) || !poprzedniaSiatka.length) {
        return res.status(400).json({ blad: 'brak poprzedniaSiatka (wiersze zamykanej zakladki)' });
      }
      if (!(Number(rok) > 2000) || !(Number(miesiac) >= 1 && Number(miesiac) <= 12)) {
        return res.status(400).json({ blad: 'podaj rok i miesiac NOWEJ zakladki' });
      }
      res.json(nowaZakladka({ poprzedniaSiatka, wyniki: wyniki || [],
        rok: Number(rok), miesiac: Number(miesiac), wymuszaj: !!wymuszaj }));
    } catch (e) {
      res.status(500).json({ blad: e.message });
    }
  });

  /* PUSTE karty do wydruku — druga strona Czytnika (zanim karty przeczytamy,
     trzeba je rozdać). Jedna karta = jedna strona A4, wypełnione: miesiąc,
     wymiar godzin z art. 130 KP, nazwisko i dział. Domyślnie cała lista umów
     o pracę na 3 miesiące do przodu. */
  const parametryDruku = (zr) => {
    const [rok, mies] = String(zr.od || '').split('-').map(Number);
    return {
      od: rok && mies ? { rok, miesiac: mies } : null,
      miesiecy: Number(zr.miesiecy) > 0 ? Number(zr.miesiecy) : 3,
      osoby: Array.isArray(zr.osoby) ? zr.osoby
        : (typeof zr.osoby === 'string' && zr.osoby ? zr.osoby.split(';').map(s => s.trim()) : null),
      dzialy: zr.dzialy || {},
      zDzialem: zr.zDzialem === true || zr.zDzialem === 'true',
      nrEwid: zr.nrEwid || {},
      kolejnosc: zr.kolejnosc === 'miesiac' ? 'miesiac' : 'osoba',
      podziel: zr.podziel === 'nie' ? 'nie' : 'miesiac',
    };
  };
  const autoQuery = (req, res) => {
    if (token && req.get('x-token') !== String(token).trim() && req.query.token !== String(token).trim()) {
      res.status(401).json({ blad: 'zly token' });
      return false;
    }
    return true;
  };

  /* Domyślnie JEDEN PDF NA MIESIĄC (`pliki`), bo tak karty idą do obiegu:
     teczka na miesiąc, drukowana i rozdawana naraz. `podziel: "nie"` skleja
     wszystko w jeden plik; `plik` jest wtedy dla zgodności ustawiony też. */
  r.post('/czytnik/karty-do-druku', express.json({ limit: '1mb' }), async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const w = await kartyDoDruku(parametryDruku(req.body || {}));
      const pliki = w.pliki.map(p => ({ nazwa: p.nazwa, mime: 'application/pdf',
        okres: p.okres, stron: p.stron, data: p.pdf.toString('base64') }));
      res.json({
        ok: true, stron: w.karty.length, okresy: w.okresy, karty: w.karty,
        pliki, ...(pliki.length === 1 ? { plik: pliki[0] } : {}),
      });
    } catch (e) {
      res.status(400).json({ blad: e.message });
    }
  });

  /* Prosto do przeglądarki i na drukarkę (token w nagłówku albo ?token=):
     .pdf daje JEDEN miesiąc, .zip cały komplet po jednym PDF na miesiąc. */
  r.get('/czytnik/karty-do-druku.pdf', async (req, res) => {
    if (!autoQuery(req, res)) return;
    try {
      const w = await kartyDoDruku({ ...parametryDruku(req.query || {}), podziel: 'nie' });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="${w.nazwa}"`);
      res.send(w.pdf);
    } catch (e) {
      res.status(400).json({ blad: e.message });
    }
  });

  r.get('/czytnik/karty-do-druku.zip', async (req, res) => {
    if (!autoQuery(req, res)) return;
    try {
      const w = await kartyDoDruku(parametryDruku(req.query || {}));
      const zip = spakuj(w.pliki.map(p => ({ nazwa: p.nazwa, dane: p.pdf })));
      const o = w.okresy[0], z = w.okresy[w.okresy.length - 1];
      const nazwa = `karty-${o.rok}-${String(o.miesiac).padStart(2, '0')}`
        + (w.okresy.length > 1 ? `_${z.rok}-${String(z.miesiac).padStart(2, '0')}` : '') + '.zip';
      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', `attachment; filename="${nazwa}"`);
      res.send(zip);
    } catch (e) {
      res.status(400).json({ blad: e.message });
    }
  });

  /* Kogo i z jakim działem wydrukujemy, gdy nie podamy listy w wywołaniu. */
  r.get('/czytnik/pracownicy', (req, res) => res.json(domyslniPracownicy()));

  /* PRÓBA TRZECIEGO GŁOSU: ta sama strona przeczytana przez Google Vision,
     złożona NASZĄ siatką. Osobna trasa, a nie element odczytu — najpierw
     chcemy ZMIERZYĆ, czy OCR zgadza się z modelem, a dopiero potem ewentualnie
     wpinać go jako ścieżkę dowodową. Klucz (konto serwisowe od Arkuszy) zostaje
     na Railway; tu tylko wołamy i oddajemy tabelę do porównania. */
  r.post('/czytnik/ocr-proba', express.json({ limit: '48mb' }), async (req, res) => {
    if (!auth(req, res)) return;
    const fsp = require('fs/promises'); const os = require('os'); const path = require('path');
    const { renderPage } = require('./render');
    const { detectGrid } = require('./obrazy');
    const { slowa, skonfigurowany } = require('./ocr-google');
    const { tabelaZOcr } = require('./ocr-tabela');
    const { dniMiesiaca } = require('./kalendarz');
    if (!skonfigurowany()) return res.status(400).json({ blad: 'brak GOOGLE_SERVICE_ACCOUNT_JSON' });
    const { data, strony, rok, miesiac } = req.body || {};
    if (!data) return res.status(400).json({ blad: 'brak pola data' });
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocr-'));
    try {
      const pdfPath = path.join(dir, 'in.pdf');
      await fsp.writeFile(pdfPath, Buffer.from(data, 'base64'));
      const dni = (rok && miesiac) ? dniMiesiaca(Number(rok), Number(miesiac)) : 31;
      const out = [];
      for (const p of (Array.isArray(strony) && strony.length ? strony : [1])) {
        try {
          const png = await renderPage(pdfPath, p, dir, 300);
          const g = await detectGrid(png).catch(() => null);
          if (!g) { out.push({ strona: p, blad: 'brak pewnej siatki' }); continue; }
          const w = await slowa(png);
          out.push({ strona: p, slow: w.length, tabela: tabelaZOcr(w, g, dni) });
        } catch (e) {
          out.push({ strona: p, blad: e.message });
        }
      }
      res.json({ ok: true, strony: out });
    } catch (e) {
      res.status(500).json({ blad: e.message });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  r.get('/czytnik/przebieg/:id', (req, res) => {
    if (!auth(req, res)) return;
    const p = przebiegi.get(req.params.id);
    if (!p) return res.status(404).json({ blad: 'nie ma takiego przebiegu (restart serwera?)' });
    if (p.status === 'w_toku') return res.json({ status: 'w_toku', sekund: Math.round((Date.now() - p.start) / 1000) });
    if (p.status === 'blad') return res.json({ status: 'blad', blad: p.blad });
    res.json({ status: 'gotowy', wynik: p.wynik });
  });

  return r;
}

module.exports = { router };
