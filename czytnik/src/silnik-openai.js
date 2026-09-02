'use strict';
/**
 * silnik-openai.js — DRUGI CZYTELNIK karty, innego dostawcy.
 *
 * PO CO: przebieg kontrolny sierpnia 2026 pokazał, że ta sama karta czytana
 * DWA RAZY tym samym modelem daje inną liczbę na 2 z 27 kart (Wołoch dzień 9,
 * Korejwo dzień 2). Powtórka tym samym modelem dziedziczy te same skłonności —
 * przy niewyraźnej cyfrze „10 czy 11" oba odczyty ciągną w tę samą stronę.
 * Drugi dostawca ma inny enkoder obrazu i inny trening, więc jego pomyłki są
 * w innych miejscach. Dopiero zgoda DWÓCH NIEZALEŻNYCH czytelników znaczy tyle,
 * ile chcemy, żeby znaczyła, zanim liczba pójdzie na listę płac.
 *
 * Interfejs celowo identyczny jak `silnik.zapytaj` — ten sam prompt, ten sam
 * JSON Schema, ta sama walidacja po stronie kodu. Zmienia się wyłącznie ten,
 * kto patrzy na obrazek.
 *
 * Model domyślny: `gpt-5.6-luna` (cennik 09/2026: 0,20 USD/1M wejścia,
 * 1,20 USD/1M wyjścia — czyli ~25× taniej od odczytu głównego). Gdyby okazał
 * się za słaby na pismo odręczne, `CZYTNIK_MODEL_OPENAI` przełącza na mocniejszy
 * (np. gpt-5.6-sol) bez zmiany kodu.
 */

const https = require('https');

const MODEL_DOM_OPENAI = process.env.CZYTNIK_MODEL_OPENAI || 'gpt-5.6-luna';
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const MAX_TOKENS = 32000;

const spij = ms => new Promise(r => setTimeout(r, ms));
const skonfigurowany = () => !!process.env.OPENAI_API_KEY;

function post(body, klucz) {
  return new Promise((resolve, reject) => {
    const dane = JSON.stringify(body);
    const req = https.request(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${klucz}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(dane),
      },
      timeout: 10 * 60 * 1000,
    }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const e = new Error(`OpenAI HTTP ${res.statusCode}: ${buf.slice(0, 300)}`);
          e.status = res.statusCode;
          e.retryAfter = res.headers['retry-after'];
          return reject(e);
        }
        try { resolve(JSON.parse(buf)); } catch (err) { reject(new Error('odpowiedz OpenAI nie jest JSON-em')); }
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout OpenAI'), { status: 0 })));
    req.on('error', e => reject(Object.assign(e, { status: e.status || 0 })));
    req.end(dane);
  });
}

/**
 * Ten sam kontrakt co `silnik.zapytaj`.
 * @param {string[]} obrazyB64
 * @param {string} prompt
 * @param {object} schemat  JSON Schema — u OpenAI idzie jako response_format
 *                          json_schema ze `strict: true`
 */
async function zapytaj(obrazyB64, prompt, schemat, o = {}) {
  if (!skonfigurowany()) throw new Error('brak OPENAI_API_KEY w srodowisku');
  const body = {
    model: o.model || MODEL_DOM_OPENAI,
    max_completion_tokens: o.maxTokens || MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [
        ...obrazyB64.map(b64 => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } })),
        { type: 'text', text: prompt },
      ],
    }],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'karta', strict: true, schema: schemat },
    },
  };

  const proby = o.proby || 4;
  let ostatni = null;
  for (let i = 0; i < proby; i++) {
    const t0 = Date.now();
    try {
      const odp = await post(body, process.env.OPENAI_API_KEY);
      const wybor = (odp.choices || [])[0] || {};
      if (wybor.finish_reason === 'length') {
        const e = new Error(`odpowiedz ucieta na limicie ${body.max_completion_tokens} tokenow`);
        e.nieponawialny = true; throw e;
      }
      const tekst = (wybor.message && wybor.message.content) || '';
      if (wybor.message && wybor.message.refusal) {
        const e = new Error('model odmowil odczytu (refusal)');
        e.nieponawialny = true; throw e;
      }
      let dane;
      try { dane = JSON.parse(tekst); }
      catch (e) { throw new Error('odpowiedz nie jest poprawnym JSON mimo json_schema: ' + tekst.slice(0, 200)); }
      return {
        dane, thinking: '',
        stop: wybor.finish_reason,
        model: odp.model,
        tokeny: odp.usage
          ? { we: odp.usage.prompt_tokens, wy: odp.usage.completion_tokens }
          : null,
        czasMs: Date.now() - t0,
      };
    } catch (e) {
      ostatni = e;
      if (e.nieponawialny) throw e;
      const ponawialny = e.status === 429 || e.status >= 500 || !e.status;
      if (!ponawialny || i === proby - 1) throw e;
      const czekaj = e.retryAfter ? Number(e.retryAfter) * 1000 : 3000 * Math.pow(3, i);
      await spij(Math.min(czekaj, 120000));
    }
  }
  throw ostatni;
}

module.exports = { zapytaj, skonfigurowany, MODEL_DOM_OPENAI };
