'use strict';

// Tlumacz mailowy via Claude (Anthropic). Hand-rolled https request (zero
// dependency, spojny z reszta projektu np. inbox-poller ktory tez tak woli).
//
// Dwa kierunki:
//   translateToPl(text, sourceLang?)  — tlumacz na polski, na zadanie lazy w UI
//   translateFromPl(text, target, sourceLang?) — composer, PL -> jezyk odbiorcy
//
// Model domyslnie claude-haiku-4-5 (najtanszy, jakosc OK dla tlumaczen
// biznesowych). Override przez env EMAIL_TRANSLATE_MODEL.

const https = require('https');

const API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = process.env.EMAIL_TRANSLATE_MODEL || 'claude-haiku-4-5-20251001';

const LANG_NAMES = {
  pl: 'Polski', es: 'Hiszpanski', en: 'Angielski', de: 'Niemiecki',
  fr: 'Francuski', it: 'Wloski', pt: 'Portugalski', nl: 'Holenderski',
  cs: 'Czeski', sk: 'Slowacki', ru: 'Rosyjski', uk: 'Ukrainski',
};

function langName(code) {
  return LANG_NAMES[code] || code;
}

// Mapowanie kraju (ISO-2 lub nazwa) do kodu jezyka. Uzywane do auto-detection
// jezyka odbiorcy w composerze (z contractor.country).
function countryToLang(country) {
  if (!country) return null;
  const c = String(country).toLowerCase().trim();
  const map = {
    es: 'es', 'espana': 'es', 'spain': 'es', 'hiszpania': 'es',
    de: 'de', 'niemcy': 'de', 'germany': 'de', 'deutschland': 'de',
    fr: 'fr', 'francja': 'fr', 'france': 'fr',
    it: 'it', 'wlochy': 'it', 'italy': 'it', 'italia': 'it',
    pt: 'pt', 'portugalia': 'pt', 'portugal': 'pt',
    nl: 'nl', 'holandia': 'nl', 'netherlands': 'nl',
    pl: 'pl', 'polska': 'pl', 'poland': 'pl',
    gb: 'en', uk: 'en', 'wielka brytania': 'en', 'united kingdom': 'en',
    us: 'en', usa: 'en', 'united states': 'en',
    ie: 'en', ireland: 'en',
    cz: 'cs', 'czechy': 'cs', 'czech republic': 'cs',
    sk: 'sk', 'slowacja': 'sk', slovakia: 'sk',
    ru: 'ru', 'rosja': 'ru',
    ua: 'uk', 'ukraina': 'uk', ukraine: 'uk',
  };
  return map[c] || null;
}

function callAnthropic(messages, system, maxTokens = 4000) {
  return new Promise((resolve, reject) => {
    if (!API_KEY) return reject(new Error('ANTHROPIC_API_KEY not set'));
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages,
    });
    const req = https.request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) {
          return reject(new Error(`Anthropic ${res.statusCode}: ${text.slice(0, 300)}`));
        }
        try {
          const data = JSON.parse(text);
          if (data.content && data.content[0] && data.content[0].text) {
            resolve(data.content[0].text.trim());
          } else {
            reject(new Error('Anthropic empty response: ' + text.slice(0, 300)));
          }
        } catch (e) {
          reject(new Error('Anthropic invalid JSON: ' + text.slice(0, 300)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Tlumaczenie incoming maila na polski. sourceLang opcjonalny (jak znamy z
// klasyfikacji w pollerze — przyspiesza i poprawia dokladnosc).
async function translateToPl(text, sourceLang) {
  if (!text || !text.trim()) return '';
  const sourceLabel = sourceLang ? langName(sourceLang) : 'auto-detect';
  const system = 'Jestes tlumaczem maili biznesowych. Tlumaczysz dokladnie zachowujac ton, formatowanie i terminologie. Zwracasz TYLKO przetlumaczony tekst, bez komentarzy, prefixow ani markdownu wokol.';
  const prompt = `Przetlumacz ponizszy mail na polski.${sourceLang ? ` Jezyk zrodlowy: ${sourceLabel}.` : ''} Zachowaj formatowanie, listy, podpisy, akapity.

---
${text}
---`;
  return await callAnthropic([{ role: 'user', content: prompt }], system);
}

// Tlumaczenie outgoing draftu z polskiego na jezyk odbiorcy. Composer pattern:
// user pisze po PL, klika "Tlumacz dla odbiorcy", widzi side-by-side, edytuje
// i wysyla wersje docelowa.
async function translateFromPl(text, targetLang, sourceLang = 'pl') {
  if (!text || !text.trim()) return '';
  if (!targetLang) throw new Error('translateFromPl: targetLang required');
  if (targetLang === sourceLang) return text; // no-op
  const targetLabel = langName(targetLang);
  const system = 'Jestes tlumaczem maili biznesowych. Tlumaczysz z polskiego na jezyk docelowy zachowujac profesjonalny ton biznesowej korespondencji, terminologie i formatowanie (akapity, listy, podpisy). Zwracasz TYLKO przetlumaczony tekst.';
  const prompt = `Przetlumacz ponizszy mail z polskiego na ${targetLabel}. Zachowaj profesjonalny ton biznesowy i formatowanie.

---
${text}
---`;
  return await callAnthropic([{ role: 'user', content: prompt }], system);
}

module.exports = { translateToPl, translateFromPl, langName, countryToLang };
