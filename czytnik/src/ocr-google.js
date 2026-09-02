'use strict';
/**
 * ocr-google.js — TRZECI GŁOS przy odczycie karty: Google Cloud Vision.
 *
 * PO CO, skoro mamy model? Bo dwa odczyty tym samym modelem mylą się w tych
 * samych miejscach. Przebieg kontrolny sierpnia 2026 pokazał to wprost: ta sama
 * karta czytana dwa razy dała inną liczbę na 2 z 27 kart (Wołoch dzień 9, Korejwo
 * dzień 2). Trzeci czytelnik ma sens tylko wtedy, gdy myli się INACZEJ — a OCR
 * oparty na rozpoznawaniu znaków ma zupełnie inne słabości niż model językowy:
 * nie „domyśla się" wartości z kontekstu, więc gdy zgadza się z modelem co do
 * liczby, zgoda naprawdę coś znaczy.
 *
 * DLACZEGO AKURAT VISION:
 *  - `DOCUMENT_TEXT_DETECTION` czyta pismo odręczne,
 *  - 1000 stron miesięcznie ZA DARMO (robimy ~30), potem 1,50 USD/1000,
 *  - konto serwisowe `GOOGLE_SERVICE_ACCOUNT_JSON` już jest (Arkusze) — nie
 *    zakładamy nowego dostawcy ani nowej umowy powierzenia danych.
 *
 * CZEGO NIE ROBIMY: nie ufamy wykrywaniu tabel po stronie Google. Mamy własną,
 * zmierzoną siatkę karty (`obrazy.detectGrid`), więc bierzemy stamtąd tylko
 * SŁOWA Z WSPÓŁRZĘDNYMI i sami przypisujemy je do rubryk. Mapowanie „dzień ->
 * kolumna" zostaje po naszej stronie, gdzie jest sprawdzone.
 */

const https = require('https');
const crypto = require('crypto');

const ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ZAKRES = 'https://www.googleapis.com/auth/cloud-platform';

const b64url = b => Buffer.from(b).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function konto() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('brak GOOGLE_SERVICE_ACCOUNT_JSON');
  const k = JSON.parse(raw);
  if (!k.client_email || !k.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON bez client_email/private_key');
  return k;
}

function post(url, body, naglowki) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const dane = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'content-length': Buffer.byteLength(dane), ...naglowki },
      timeout: 60000,
    }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 400)}`));
        }
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('odpowiedz nie jest JSON-em')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout Vision')));
    req.on('error', reject);
    req.end(dane);
  });
}

let tokenCache = { token: null, waznyDo: 0 };

/** OAuth2 dla konta serwisowego: podpisany JWT wymieniany na access token */
async function token() {
  if (tokenCache.token && Date.now() < tokenCache.waznyDo - 60000) return tokenCache.token;
  const k = konto();
  const teraz = Math.floor(Date.now() / 1000);
  const naglowek = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const ladunek = b64url(JSON.stringify({
    iss: k.client_email, scope: ZAKRES, aud: TOKEN_URL, iat: teraz, exp: teraz + 3600,
  }));
  const podpis = b64url(crypto.createSign('RSA-SHA256')
    .update(`${naglowek}.${ladunek}`).sign(k.private_key));
  const odp = await post(TOKEN_URL,
    `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}`
    + `&assertion=${naglowek}.${ladunek}.${podpis}`,
    { 'content-type': 'application/x-www-form-urlencoded' });
  tokenCache = { token: odp.access_token, waznyDo: Date.now() + (odp.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

/**
 * Surowy odczyt strony: słowa z prostokątami.
 * @param {Buffer} obraz JPEG/PNG strony (ten sam, z którego liczymy siatkę)
 * @returns {Promise<Array<{tekst, x0, y0, x1, y1, pewnosc}>>}
 */
async function slowa(obraz) {
  const t = await token();
  const odp = await post(ENDPOINT, {
    requests: [{
      image: { content: obraz.toString('base64') },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      // bez language hints: dokumentacja Google mowi wprost, ze dla alfabetu
      // lacinskiego automatyczne wykrywanie zwykle wypada lepiej, a bledna
      // podpowiedz potrafi zaszkodzic
    }],
  }, { authorization: `Bearer ${t}`, 'content-type': 'application/json' });

  const odpowiedz = (odp.responses || [])[0] || {};
  if (odpowiedz.error) throw new Error(`Vision: ${odpowiedz.error.message}`);
  const strony = (odpowiedz.fullTextAnnotation || {}).pages || [];
  const out = [];
  for (const s of strony) {
    for (const blok of s.blocks || []) {
      for (const par of blok.paragraphs || []) {
        for (const w of par.words || []) {
          const tekst = (w.symbols || []).map(x => x.text).join('');
          const v = (w.boundingBox && w.boundingBox.vertices) || [];
          if (!tekst || v.length < 4) continue;
          const xs = v.map(p => p.x || 0), ys = v.map(p => p.y || 0);
          out.push({
            tekst,
            x0: Math.min(...xs), x1: Math.max(...xs),
            y0: Math.min(...ys), y1: Math.max(...ys),
            pewnosc: w.confidence != null ? +w.confidence.toFixed(2) : null,
          });
        }
      }
    }
  }
  return out;
}

module.exports = { slowa, token, skonfigurowany: () => !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON };
