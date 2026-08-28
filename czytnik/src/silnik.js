'use strict';
/**
 * silnik.js — wywołania modelu przez oficjalny SDK.
 *
 * Zasady (wnioski z przeglądu obecnego systemu):
 *  - streaming + finalMessage(): thinking nigdy nie jest duszony timeoutem HTTP,
 *  - structured outputs (output_config.format): koniec parsowania JSON-a regexem,
 *  - adaptive thinking z display "summarized": podsumowanie rozumowania idzie do
 *    śladu audytowego,
 *  - WŁASNE retry z backoffem i honorowaniem retry-after (maxRetries:0 w SDK,
 *    żeby czasy były przewidywalne) — polityka przeniesiona ze starego zapytajModel,
 *  - stop_reason "refusal"/"max_tokens" => błąd odczytu, karta do weryfikacji;
 *    ŻADNEGO server-side fallbacku — model niezwalidowany na korpusie nie dotyka
 *    toru wypłat.
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL_DOM = process.env.CZYTNIK_MODEL || 'claude-opus-5';
const MAX_TOKENS = 32000;

let client = null;
function klient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('brak ANTHROPIC_API_KEY w srodowisku');
  if (!client) client = new Anthropic({ maxRetries: 0, timeout: 15 * 60 * 1000 });
  return client;
}

const spij = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {string[]} obrazyB64  JPEG-i w base64, w kolejności z promptu
 * @param {string} prompt
 * @param {object} schemat     JSON Schema wymuszany przez output_config.format
 * @param {object} [o]         {model, effort, maxTokens, proby}
 */
async function zapytaj(obrazyB64, prompt, schemat, o = {}) {
  const req = {
    model: o.model || MODEL_DOM,
    max_tokens: o.maxTokens || MAX_TOKENS,
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: {
      effort: o.effort || 'high',
      format: { type: 'json_schema', schema: schemat },
    },
    messages: [{
      role: 'user',
      content: [
        ...obrazyB64.map(b64 => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } })),
        { type: 'text', text: prompt },
      ],
    }],
  };

  const proby = o.proby || 4;
  let ostatni = null;
  for (let i = 0; i < proby; i++) {
    try {
      const t0 = Date.now();
      const stream = klient().messages.stream(req);
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') {
        const e = new Error('model odmowil odczytu (stop_reason=refusal)');
        e.nieponawialny = true; throw e;
      }
      if (msg.stop_reason === 'max_tokens') {
        const e = new Error(`odpowiedz ucieta na limicie ${req.max_tokens} tokenow`);
        e.nieponawialny = true; throw e;
      }
      const tekst = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const thinking = (msg.content || []).filter(b => b.type === 'thinking').map(b => b.thinking).filter(Boolean).join('\n');
      // output_config.format gwarantuje, że pierwszy blok tekstowy to poprawny JSON
      let dane;
      try { dane = JSON.parse(tekst); }
      catch (e) { throw new Error('odpowiedz nie jest poprawnym JSON mimo output_config.format: ' + tekst.slice(0, 200)); }
      return {
        dane, thinking,
        stop: msg.stop_reason,
        model: msg.model,
        tokeny: msg.usage ? { we: msg.usage.input_tokens, wy: msg.usage.output_tokens } : null,
        czasMs: Date.now() - t0,
      };
    } catch (e) {
      ostatni = e;
      if (e.nieponawialny) throw e;
      const status = e.status || (e.error && e.error.status);
      const retryAfter = e.headers && (e.headers['retry-after'] || (e.headers.get && e.headers.get('retry-after')));
      const ponawialny = status === 429 || status === 529 || status >= 500 || !status; // !status = błąd sieci/streamu
      if (!ponawialny || i === proby - 1) throw e;
      const czekaj = retryAfter ? Number(retryAfter) * 1000 : 3000 * Math.pow(3, i);
      await spij(Math.min(czekaj, 120000));
    }
  }
  throw ostatni;
}

module.exports = { zapytaj, MODEL_DOM };
