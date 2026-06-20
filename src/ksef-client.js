'use strict';

// Klient KSeF 2.0 — POBIERANIE faktur kosztowych (gdzie jesteśmy nabywcą).
// Auth tokenem KSeF (read-only). Flow wg dokumentacji CIRFMF/ksef-docs:
//   1. GET  /security/public-key-certificates  → cert KsefTokenEncryption
//   2. POST /auth/challenge                     → { challenge, timestamp(ms) }
//   3. RSA-OAEP-SHA256( `${token}|${timestampMs}` ) → base64 = encryptedToken
//   4. POST /auth/ksef-token { challenge, contextIdentifier, encryptedToken }
//   5. GET  /auth/{referenceNumber} (Bearer authenticationToken) → poll status
//   6. POST /auth/token/redeem → { accessToken, refreshToken }
//   7. POST /invoices/query/metadata { subjectType:'Subject2', dateRange }
//   8. GET  /invoices/ksef/{ksefNumber} → XML FA(3)
//
// Konfiguracja (env):
//   KSEF_BASE   — bazowy URL API v2 (np. https://api.ksef.mf.gov.pl/api/v2)
//   KSEF_TOKEN  — token KSeF (read-only) wygenerowany w aplikacji KSeF
//   KSEF_NIP    — NIP firmy (kontekst), np. 10 cyfr

const crypto = require('crypto');

// Baza API KSeF 2.0. PROD: https://api.ksef.mf.gov.pl/v2  (UWAGA: stary
// https://ksef.mf.gov.pl/api/v2 jest WYCOFANY — zwraca HTML). TE/test:
// https://api-test.ksef.mf.gov.pl/v2. Docs/Swagger są pod /docs/v2 (nie API).
const BASE = (process.env.KSEF_BASE || 'https://api.ksef.mf.gov.pl/v2').replace(/\/$/, '');

function isConfigured() {
  return !!(process.env.KSEF_TOKEN && process.env.KSEF_NIP);
}

// Niskopoziomowy fetch JSON z obsługą Bearer + błędów (zwraca {status, body}).
// TWARDY timeout per wywołanie — bez tego, gdy host KSeF nie odpowiada, request
// wisi w nieskończoność ("Wysyłam..." w Konsoli).
async function api(method, path, { token, body, accept = 'application/json', timeoutMs = 15000 } = {}) {
  const url = `${BASE}${path}`;
  const headers = { Accept: accept };
  if (body != null) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body != null ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = new Error(`KSeF ${method} ${path} → ${e.name === 'TimeoutError' ? `timeout po ${timeoutMs}ms (host nie odpowiada — sprawdź KSEF_BASE/sieć)` : e.message}`);
    err.status = 0;
    throw err;
  }
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = text; }
  if (!res.ok) {
    const err = new Error(`KSeF ${method} ${path} → HTTP ${res.status}: ${typeof parsed === 'string' ? parsed.slice(0, 300) : JSON.stringify(parsed).slice(0, 300)}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

// Tolerancyjny dostęp do pól (API miesza PascalCase/camelCase).
function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k];
    const lc = k.charAt(0).toLowerCase() + k.slice(1);
    if (obj[lc] !== undefined) return obj[lc];
  }
  return undefined;
}

// 1. Pobierz cert do szyfrowania tokena i zbuduj klucz publiczny.
async function getTokenEncryptionPublicKey() {
  const data = await api('GET', '/security/public-key-certificates');
  const list = Array.isArray(data) ? data : (pick(data, 'certificates') || pick(data, 'Certificates') || []);
  const tokenCerts = list.filter(c => /kseftokenencryption/i.test(String(pick(c, 'usage') || '')));
  const pool = (tokenCerts.length ? tokenCerts : list)
    .slice()
    .sort((a, b) => new Date(pick(b, 'validFrom') || 0) - new Date(pick(a, 'validFrom') || 0));
  const cert = pool[0];
  if (!cert) throw new Error('KSeF: brak certyfikatu KsefTokenEncryption w /security/public-key-certificates');
  const b64 = pick(cert, 'certificate', 'publicKey', 'value');
  if (!b64) throw new Error('KSeF: certyfikat bez pola certificate');
  const pem = `-----BEGIN CERTIFICATE-----\n${String(b64).replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
  const x509 = new crypto.X509Certificate(pem);
  return x509.publicKey;
}

// 3. RSA-OAEP-SHA256 szyfrowanie `${token}|${timestampMs}`.
function encryptToken(publicKey, token, timestampMs) {
  const plain = Buffer.from(`${token}|${timestampMs}`, 'utf8');
  const enc = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    plain
  );
  return enc.toString('base64');
}

// Pełne uwierzytelnienie tokenem → { accessToken, refreshToken }.
async function authenticate() {
  if (!isConfigured()) throw new Error('KSeF nie skonfigurowany — ustaw KSEF_TOKEN i KSEF_NIP (oraz KSEF_BASE jeśli inny niż prod).');
  const publicKey = await getTokenEncryptionPublicKey();

  const challengeResp = await api('POST', '/auth/challenge', { body: {} });
  const challenge = pick(challengeResp, 'challenge');
  const tsRaw = pick(challengeResp, 'timestamp');
  const timestampMs = typeof tsRaw === 'number' ? tsRaw : new Date(tsRaw).getTime();
  if (!challenge) throw new Error(`KSeF: brak challenge w odpowiedzi (${JSON.stringify(challengeResp).slice(0, 200)})`);

  const encryptedToken = encryptToken(publicKey, process.env.KSEF_TOKEN, timestampMs);
  const initResp = await api('POST', '/auth/ksef-token', {
    body: {
      challenge,
      contextIdentifier: { type: 'Nip', value: String(process.env.KSEF_NIP) },
      encryptedToken,
    },
  });
  const authToken = pick(initResp, 'authenticationToken', 'token');
  const refNumber = pick(initResp, 'referenceNumber');
  const authTokenValue = (authToken && typeof authToken === 'object') ? pick(authToken, 'token', 'value') : authToken;
  if (!authTokenValue) throw new Error(`KSeF: brak authenticationToken (${JSON.stringify(initResp).slice(0, 200)})`);

  // Poll statusu auth (krótko — max ~15s; per-call timeout 6s).
  for (let i = 0; i < 6; i++) {
    const st = await api('GET', `/auth/${encodeURIComponent(refNumber)}`, { token: authTokenValue, timeoutMs: 6000 }).catch(() => null);
    const status = st && (pick(st, 'status') || pick(pick(st, 'status') || {}, 'code'));
    if (st && (String(status).toLowerCase().includes('succe') || Number(status) === 200 || pick(st, 'authenticationFinished'))) break;
    await new Promise(r => setTimeout(r, 1500));
  }

  const redeem = await api('POST', '/auth/token/redeem', { token: authTokenValue, body: {} });
  const accessToken = pick(redeem, 'accessToken');
  const refreshToken = pick(redeem, 'refreshToken');
  const accessTokenValue = (accessToken && typeof accessToken === 'object') ? pick(accessToken, 'token', 'value') : accessToken;
  if (!accessTokenValue) throw new Error(`KSeF: brak accessToken po redeem (${JSON.stringify(redeem).slice(0, 200)})`);
  return { accessToken: accessTokenValue, refreshToken };
}

// Metadane faktur w zakresie dat. subjectType: 'Subject2' = nabywca (koszty),
// 'Subject1' = sprzedawca (nasze sprzedażowe — do oznaczania „jest w KSeF").
async function queryInvoiceMetadata(accessToken, { subjectType = 'Subject2', from, to, dateType = 'Issue', pageSize = 100 }) {
  const results = [];
  let pageOffset = 0;
  for (let guard = 0; guard < 100; guard++) {
    const body = { subjectType, dateRange: { dateType, from, to } };
    const resp = await api('POST', `/invoices/query/metadata?pageOffset=${pageOffset}&pageSize=${pageSize}`, { token: accessToken, body });
    const items = pick(resp, 'invoices') || pick(resp, 'items') || (Array.isArray(resp) ? resp : []);
    results.push(...items);
    if (items.length < pageSize) break;
    pageOffset += 1;
  }
  return results;
}

// Wrapper: faktury KOSZTOWE (Subject2 = nabywca).
async function queryCostInvoiceMetadata(accessToken, opts) {
  return queryInvoiceMetadata(accessToken, { ...opts, subjectType: 'Subject2' });
}

// 8. Pobierz XML pojedynczej faktury po numerze KSeF.
async function getInvoiceXml(accessToken, ksefNumber) {
  const xml = await api('GET', `/invoices/ksef/${encodeURIComponent(ksefNumber)}`, { token: accessToken, accept: 'application/xml' });
  return typeof xml === 'string' ? xml : JSON.stringify(xml);
}

module.exports = {
  BASE,
  isConfigured,
  authenticate,
  getTokenEncryptionPublicKey,
  queryInvoiceMetadata,
  queryCostInvoiceMetadata,
  getInvoiceXml,
  _pick: pick,
};
