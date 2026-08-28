'use strict';
/**
 * index.js — samodzielny serwis Czytnika (osobny serwis Railway, root directory: czytnik).
 *
 * Env: ANTHROPIC_API_KEY (wymagany), CZYTNIK_TOKEN lub PREPROCESS_TOKEN (auth x-token),
 *      CZYTNIK_MODEL (domyślnie claude-opus-5), PORT (wstrzykuje Railway).
 */

process.on('unhandledRejection', r => console.error('[unhandledRejection]', (r && r.stack) || r));
process.on('uncaughtException', e => console.error('[uncaughtException]', (e && e.stack) || e));

const express = require('express');
const { router } = require('./router');
const { odczytajTeczke } = require('./czytnik');

const app = express();
const token = (process.env.CZYTNIK_TOKEN || process.env.PREPROCESS_TOKEN || '').trim() || undefined;
if (!token) console.warn('[start] BRAK CZYTNIK_TOKEN/PREPROCESS_TOKEN - endpointy bez autoryzacji');
if (!process.env.ANTHROPIC_API_KEY) console.warn('[start] BRAK ANTHROPIC_API_KEY - odczyt nie zadziala');

app.use('/', router(express, token));

// Alias zgodny z dzisiejszym kontraktem core-api: przełączenie n8n = zmiana URL-a.
app.post('/karty-pracy/odczytaj', express.json({ limit: '48mb' }), async (req, res) => {
  if (token && req.get('x-token') !== token) return res.status(401).json({ blad: 'zly token' });
  try {
    const { data, strony, rok, miesiac, nazwiska, rownolegle, model, dpi } = req.body || {};
    if (!data) return res.status(400).json({ blad: 'brak pola data' });
    res.json(await odczytajTeczke(Buffer.from(data, 'base64'), { strony, rok, miesiac, nazwiska, rownolegle, model, dpi }));
  } catch (e) {
    res.status(500).json({ blad: e.message });
  }
});

app.get('/zdrowie', (req, res) => res.json({ ok: true, serwis: 'czytnik' }));

const PORT = process.env.PORT || 3100;
app.listen(PORT, () => console.log(`Czytnik na porcie ${PORT}`));
