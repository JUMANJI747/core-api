'use strict';

// Klient API Mała Księgowość (mk.app, host malaksiegowosc.app, Swagger 2.0).
// ETAP 0 ("obicie") integracji MK ↔ KSeF ↔ nasza baza ↔ iFirma.
//
// Auth (3 warianty z securityDefinitions — wybieramy wg env):
//   - MK_API_KEY            → nagłówek X-API-Key (najprościej),
//   - MK_USER + MK_PASSWORD → POST /api/authentication-tokens {name,password} → JWT (Bearer),
//   - MK_DATA_SHARING_KEY   → token z klucza udostępniania księgowej (from-data-sharing-key).
// Base URL: MK_BASE (domyślnie https://malaksiegowosc.app).
//
// KSeF w MK:
//   - POST /api/ksef/fetch-sessions {fetchMode: 'buy'|'sell'|'thirdParty', from, to}
//     → uruchamia pobranie faktur z KSeF do MK; zwraca referenceNumber,
//   - GET  /api/ksef/fetch-session/{referenceNumber} → status sesji.
// Odczyt do porównania:
//   - GET /api/vat-purchase-ledger-entries (koszty), /api/vat-sales-ledger-entries (sprzedaż),
//   - GET /api/new-ledger-entries (świeżo pobrane, jeszcze niezaksięgowane),
//   - GET /api/invoices (faktury sprzedaży wystawione w MK).
//
// UWAGA: dokładne kształty odpowiedzi (paged result, pola filter/sort) trzeba
// potwierdzić na żywo po wrzuceniu kluczy — klient zwraca surowy JSON.

const { fetchWithTimeout } = require('./http');

const MK_BASE = (process.env.MK_BASE || 'https://malaksiegowosc.app').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.MK_TIMEOUT_MS) || 60000;

let _jwt = null;
let _jwtAt = 0;
const JWT_TTL_MS = 50 * 60 * 1000; // odśwież token przed wygaśnięciem (zapas)

function isConfigured() {
  return !!(process.env.MK_API_KEY || (process.env.MK_USER && process.env.MK_PASSWORD) || process.env.MK_DATA_SHARING_KEY);
}

async function login() {
  if (process.env.MK_DATA_SHARING_KEY) {
    const r = await rawFetch('POST', '/api/authentication-tokens/from-data-sharing-key', {
      body: { key: process.env.MK_DATA_SHARING_KEY },
      noAuth: true,
    });
    return extractToken(r);
  }
  const r = await rawFetch('POST', '/api/authentication-tokens', {
    body: { name: process.env.MK_USER, password: process.env.MK_PASSWORD },
    noAuth: true,
  });
  return extractToken(r);
}

function extractToken(r) {
  // /api/authentication-tokens zwraca JWT jako string (czasem w cudzysłowach).
  if (typeof r === 'string') return r.replace(/^"|"$/g, '');
  if (r && typeof r.token === 'string') return r.token;
  if (r && typeof r.value === 'string') return r.value;
  throw new Error('MK: nie udało się odczytać tokena z odpowiedzi /authentication-tokens');
}

async function getToken() {
  if (process.env.MK_API_KEY) return null; // X-API-Key nie potrzebuje JWT
  if (_jwt && (Date.now() - _jwtAt) < JWT_TTL_MS) return _jwt;
  _jwt = await login();
  _jwtAt = Date.now();
  return _jwt;
}

// Niskopoziomowy fetch (bez auto-auth) — używany przez login() i mkFetch().
async function rawFetch(method, path, { query, body, headers = {}, noAuth = false } = {}) {
  let url = MK_BASE + path;
  if (query && typeof query === 'object') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach(x => qs.append(k, String(x)));
      else qs.append(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const h = { Accept: 'application/json', ...headers };
  if (!noAuth) {
    if (process.env.MK_API_KEY) h['X-API-Key'] = process.env.MK_API_KEY;
    else { const t = await getToken(); if (t) h['Authorization'] = `Bearer ${t}`; }
  }
  const opts = { method, headers: h };
  if (body !== undefined) { h['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }

  const res = await fetchWithTimeout(url, opts, TIMEOUT_MS);
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const err = new Error(`MK ${method} ${path} → HTTP ${res.status}`);
    err.status = res.status; err.body = parsed;
    throw err;
  }
  return parsed;
}

// Wysokopoziomowy fetch z auto-auth + jednym retry po 401 (token wygasł).
async function mkFetch(method, path, opts = {}) {
  try {
    return await rawFetch(method, path, opts);
  } catch (e) {
    if (e.status === 401 && !process.env.MK_API_KEY && !opts.noAuth) {
      _jwt = null; // wymuś ponowny login
      return await rawFetch(method, path, opts);
    }
    throw e;
  }
}

// ── Diagnostyka ──
async function version() { return mkFetch('GET', '/api/version'); }

// ── KSeF: wyzwól pobranie do MK ──
// mode: 'buy' (koszty) | 'sell' (sprzedaż) | 'thirdParty'. from/to: 'YYYY-MM-DD'.
async function ksefFetch(mode, from, to) {
  return mkFetch('POST', '/api/ksef/fetch-sessions', { body: { fetchMode: mode, from, to } });
}
async function ksefFetchStatus(referenceNumber) {
  return mkFetch('GET', `/api/ksef/fetch-session/${encodeURIComponent(referenceNumber)}`);
}

// ── Odczyt do porównania ──
function _ledgerQuery({ from, to, pageNo = 1, pageSize = 500, filter = '', sort = '' }) {
  return { from, to, pageNo, pageSize, filter, sort };
}
async function vatPurchaseEntries(args = {}) { return mkFetch('GET', '/api/vat-purchase-ledger-entries', { query: _ledgerQuery(args) }); }
async function vatSalesEntries(args = {}) { return mkFetch('GET', '/api/vat-sales-ledger-entries', { query: _ledgerQuery(args) }); }
async function newLedgerEntries(args = {}) { return mkFetch('GET', '/api/new-ledger-entries', { query: _ledgerQuery(args) }); }
async function invoices(args = {}) { return mkFetch('GET', '/api/invoices', { query: { pageNo: args.pageNo || 1, pageSize: args.pageSize || 500, filter: args.filter || '', sort: args.sort || '' } }); }

module.exports = {
  isConfigured, MK_BASE,
  version, ksefFetch, ksefFetchStatus,
  vatPurchaseEntries, vatSalesEntries, newLedgerEntries, invoices,
  mkFetch, // surowy dostęp do dowolnego endpointu MK (diagnostyka)
};
