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
const { MODEL_DOM } = require('./silnik');

const przebiegi = new Map();   // id -> {status, start, wynik?, blad?}

function sprzatajPrzebiegi() {
  const doba = 24 * 3600 * 1000;
  for (const [id, p] of przebiegi) if (Date.now() - p.start > doba) przebiegi.delete(id);
}

function wyciagnijOpcje(body) {
  const { strony, rok, miesiac, nazwiska, rownolegle, model, dpi,
    stawkiDnia, domyslnaStawkaDnia } = body || {};
  return { strony, rok, miesiac, nazwiska, rownolegle, model, dpi, stawkiDnia, domyslnaStawkaDnia };
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
