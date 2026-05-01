'use strict';

// Contasimple REST API client (Spain — second accounting provider for the
// Canary Islands company). Uses OAuth2 "authentication_key" grant: long-lived
// API key (env CONTASIMPLE_API_KEY) is exchanged for a short-lived access
// token (default TTL 1h), cached in-memory and refreshed automatically.
//
// The token implies a single "current company" — multi-company support is
// out of scope for now (one key = one company).

const https = require('https');
const querystring = require('querystring');

const BASE_URL = (process.env.CONTASIMPLE_BASE_URL || 'https://api.contasimple.com/api/v2')
  .trim()
  .replace(/\/$/, '');
const API_KEY = (process.env.CONTASIMPLE_API_KEY || '').trim();

let tokenCache = { accessToken: null, expiresAt: 0 };

// ============ HTTP HELPERS ============

function httpsRequest(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method,
      headers: { ...headers },
    };
    if (body !== null && body !== undefined) {
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks),
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

// ============ AUTH (OAuth2 authentication_key grant) ============

async function refreshToken() {
  if (!API_KEY) throw new Error('CONTASIMPLE_API_KEY not set');

  const formBody = querystring.stringify({
    grant_type: 'authentication_key',
    key: API_KEY,
  });

  console.log('[contasimple] refreshing access token');
  const { status, body } = await httpsRequest(
    'POST',
    `${BASE_URL}/oauth/token`,
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    formBody
  );

  const text = body.toString();
  if (status !== 200) {
    throw new Error(`Contasimple /oauth/token failed (${status}): ${text.slice(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('Contasimple token response is not JSON: ' + text.slice(0, 300));
  }

  const accessToken = data.access_token;
  const expiresInSec = Number(data.expires_in) || 3600;
  if (!accessToken) {
    throw new Error('Contasimple token response missing access_token: ' + text.slice(0, 300));
  }

  // Refresh 5 minutes before actual expiry to avoid 401 race
  tokenCache = {
    accessToken,
    expiresAt: Date.now() + (expiresInSec - 300) * 1000,
  };
  console.log('[contasimple] token refreshed, expires in', expiresInSec, 's');
  return accessToken;
}

async function getAccessToken() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }
  return await refreshToken();
}

// Authenticated request. Retries once on 401 with a fresh token (handles
// the case where Contasimple invalidates the token before our cache TTL).
async function csRequest(method, path, queryParams, body) {
  const url = new URL(BASE_URL + path);
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }

  let token = await getAccessToken();
  let bodyStr = null;
  let headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/json',
    'Accept-Language': 'es-ES',
  };
  if (body !== undefined && body !== null) {
    bodyStr = JSON.stringify(body);
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }

  let res = await httpsRequest(method, url.toString(), headers, bodyStr);

  if (res.status === 401) {
    console.log('[contasimple] 401 received — refreshing token and retrying once');
    tokenCache.accessToken = null;
    token = await refreshToken();
    headers.Authorization = 'Bearer ' + token;
    res = await httpsRequest(method, url.toString(), headers, bodyStr);
  }

  return res;
}

async function csJson(method, path, queryParams, body) {
  const { status, body: respBody } = await csRequest(method, path, queryParams, body);
  const text = respBody.toString();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(
        `Contasimple ${method} ${path} returned non-JSON (${status}): ${text.slice(0, 300)}`
      );
    }
  }
  if (status >= 400) {
    const msg =
      (data && (data.message || data.error || data.errorDescription || data.error_description)) ||
      text.slice(0, 300);
    const err = new Error(`Contasimple ${method} ${path} failed (${status}): ${msg}`);
    err.status = status;
    err.body = data;
    throw err;
  }
  return data;
}

// ============ ME / COMPANIES ============

// Sanity check + surfaces company info (country, fiscalRegion, currency).
// Used by the smoke-test endpoint after deploy to verify auth flow works.
async function getMyCompanies() {
  return await csJson('GET', '/me/companies');
}

// ============ CUSTOMERS (Entities) ============
//
// Mirror of iFirma's searchContractor flow, with two extra niceties:
//   - /search/nif?exactMatch=...  →  exact CIF match
//   - /search?query=...           →  free-text fuzzy
//   - /all                        →  full list (no pagination, for bulk import)

async function listCustomers({
  startIndex = 0,
  numRows = 100,
  organization,
  nif,
  email,
} = {}) {
  return await csJson('GET', '/entities/customers', {
    startIndex,
    numRows,
    organization,
    nIF: nif, // Contasimple uses camelCase nIF, not nif
    email,
  });
}

async function listAllCustomers() {
  return await csJson('GET', '/entities/customers/all');
}

async function searchCustomerByNif(nif, exactMatch = true) {
  return await csJson('GET', '/entities/customers/search/nif', { query: nif, exactMatch });
}

async function searchCustomers(query) {
  return await csJson('GET', '/entities/customers/search', { query });
}

async function getCustomer(id) {
  return await csJson(
    'GET',
    `/entities/customers/${encodeURIComponent(id)}`,
    { includeBankAccounts: true }
  );
}

// ============ EXPORTS ============

function isConfigured() {
  return Boolean(API_KEY);
}

module.exports = {
  isConfigured,
  getAccessToken,
  getMyCompanies,
  listCustomers,
  listAllCustomers,
  searchCustomerByNif,
  searchCustomers,
  getCustomer,
};
