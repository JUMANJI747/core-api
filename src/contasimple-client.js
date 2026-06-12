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

// Ceiling na zewnetrzne HTTP. Bez tego wisiace polaczenie (TCP zestawione,
// brak odpowiedzi) nigdy nie rozwiazuje promise -> flow agenta ES wisi.
// Timeout zamienia hang na reject, ktory callerzy juz propaguja.
const HTTP_TIMEOUT_MS = Number(process.env.CONTASIMPLE_HTTP_TIMEOUT_MS) || 30000;

let tokenCache = { accessToken: null, expiresAt: 0 };

// Default headers attached to every request. The User-Agent is required —
// without it Contasimple's WAF returns 403 Forbidden (HTML page) before the
// request ever reaches the OAuth endpoint. Accept ensures consistent JSON.
const DEFAULT_HEADERS = {
  'User-Agent': 'core-api/1.0 (contasimple-integration)',
  Accept: 'application/json',
};

// ============ HTTP HELPERS ============

function httpsRequest(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method,
      timeout: HTTP_TIMEOUT_MS,
      headers: { ...DEFAULT_HEADERS, ...headers },
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
    req.on('timeout', () => req.destroy(new Error(`Contasimple ${method} timeout po ${HTTP_TIMEOUT_MS}ms: ${parsed.hostname}`)));
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
  // Match the exact header set used in our verified-working PowerShell curl
  // test (Invoke-RestMethod). No Accept-Language, no charset suffix on
  // Content-Type — Contasimple's .NET binder is sensitive to these.
  let headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/json',
  };
  if (body !== undefined && body !== null) {
    bodyStr = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
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

async function createCustomer(data) {
  // Required by Contasimple: type ('Issuer' for customers), organization or
  // firstname+lastname, nif (we enforce CIF mandatory at route/agent level).
  const body = {
    type: 'Issuer',
    organization: null,
    name: null,
    firstname: null,
    lastname: null,
    nif: null,
    address: null,
    province: null,
    city: null,
    country: null,
    countryId: null,
    postalCode: null,
    phone: null,
    mobile: null,
    fax: null,
    email: null,
    notes: null,
    url: null,
    customField1: null,
    customField2: null,
    latitude: 0,
    longitude: 0,
    discountPercentage: 0,
    documentCulture: null,
    selectedTags: [],
    ...data,
  };
  return await csJson('POST', '/entities/customers', null, body);
}

async function updateCustomer(id, data) {
  return await csJson('PUT', `/entities/customers/${encodeURIComponent(id)}`, null, data);
}

// ============ PRODUCTS ============
//
// Used by the bulk-import endpoint to populate local EsProduct rows so that
// preview/confirm flow can resolve "30 sticków" → SURF STICK BELL SPF 50+
// (contasimpleId 3686995) without round-tripping the API on every line.

async function listAllProducts() {
  return await csJson('GET', '/products/all');
}

async function listProducts({ startIndex = 0, numRows = 100, name } = {}) {
  return await csJson('GET', '/products', { startIndex, numRows, name });
}

async function getProduct(id) {
  return await csJson('GET', `/products/${encodeURIComponent(id)}`);
}

async function updateProduct(id, data) {
  return await csJson('PUT', `/products/${encodeURIComponent(id)}`, null, data);
}

// ============ INVOICES — ISSUED ============
//
// Every invoice path includes a {period} segment. Period is a quarter in the
// form "YYYY-NT" (e.g. "2026-2T" for April-June 2026). Helper dateToPeriod()
// derives it from the invoice issue date. If Contasimple turns out to also
// accept "YYYY" or "YYYY-MM", we'll add fallbacks — for now we ship YYYY-NT
// since that's what the dashboard surfaces.

const DEFAULT_VAT_PERCENT = Number(process.env.CONTASIMPLE_DEFAULT_IGIC_PERCENT) || 7;
const DEFAULT_UI_CULTURE = process.env.CONTASIMPLE_DEFAULT_CULTURE || 'es-ES';

function dateToPeriod(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) throw new Error('dateToPeriod: invalid date: ' + date);
  const year = d.getFullYear();
  const quarter = Math.floor(d.getMonth() / 3) + 1; // months are 0-indexed
  return `${year}-${quarter}T`;
}

async function listInvoices(period, filters = {}) {
  const {
    startIndex = 0,
    numRows = 100,
    number,
    nif,
    status,
    fromDate,
    toDate,
    customerOrganizationName,
    sort,
  } = filters;
  return await csJson(
    'GET',
    `/accounting/${encodeURIComponent(period)}/invoices/issued`,
    { startIndex, numRows, number, nif, status, fromDate, toDate, customerOrganizationName, sort }
  );
}

async function getInvoice(period, id) {
  return await csJson(
    'GET',
    `/accounting/${encodeURIComponent(period)}/invoices/issued/${encodeURIComponent(id)}`
  );
}

async function searchInvoiceByNumber(period, query) {
  // Contasimple-side fuzzy search on invoice number — analog of the
  // "65" → "65/2026" trick we run in the iFirma agent.
  return await csJson(
    'GET',
    `/accounting/${encodeURIComponent(period)}/invoices/issued/search/number`,
    { query }
  );
}

// POST the payload as-is. Earlier this function had its own buildInvoiceLine
// remapper that silently stripped totalTaxableAmount and injected productId:0
// + productName:'' on every line — which was the actual root cause of the
// TaxableAmountDiscrepancy errors. The caller (buildContasimplePayload in
// services/contasimple-helpers.js) already produces the verified-working
// minimal shape; the client must not modify it.
async function createInvoice(period, payload) {
  if (!payload.targetEntityId) {
    throw new Error('createInvoice: targetEntityId required (customer must exist in Contasimple)');
  }
  if (!Array.isArray(payload.lines) || payload.lines.length === 0) {
    throw new Error('createInvoice: lines[] required and non-empty');
  }
  return await csJson(
    'POST',
    `/accounting/${encodeURIComponent(period)}/invoices/issued`,
    null,
    payload
  );
}

async function deleteInvoice(period, id) {
  return await csJson(
    'DELETE',
    `/accounting/${encodeURIComponent(period)}/invoices/issued/${encodeURIComponent(id)}`
  );
}

// Returns raw Buffer (PDF binary). Swagger says response is application/json
// with empty body — that's a docs artifact; the real response is application/pdf.
async function fetchInvoicePdf(period, id) {
  const { status, body, headers } = await csRequest(
    'GET',
    `/accounting/${encodeURIComponent(period)}/invoices/issued/${encodeURIComponent(id)}/pdf`
  );
  if (status >= 400) {
    throw new Error(
      `Contasimple PDF fetch failed (${status}): ${body.toString().slice(0, 300)}`
    );
  }
  return { buffer: body, contentType: headers['content-type'] || 'application/pdf' };
}

async function sendInvoiceEmail(period, id, message) {
  // message: { to, replyTo?, blindCopy?, subject, body }
  if (!message || !message.to) throw new Error('sendInvoiceEmail: message.to required');
  const body = {
    to: message.to,
    replyTo: message.replyTo || null,
    blindCopy: Boolean(message.blindCopy),
    subject: message.subject || '',
    body: message.body || '',
  };
  return await csJson(
    'POST',
    `/accounting/${encodeURIComponent(period)}/invoices/issued/${encodeURIComponent(id)}/send`,
    null,
    body
  );
}

async function getNextInvoiceNumber(period, numberingFormatId) {
  return await csJson(
    'GET',
    `/accounting/${encodeURIComponent(period)}/invoices/issued/nextInvoiceNumber/${encodeURIComponent(numberingFormatId)}`
  );
}

// ============ DELIVERY NOTES (ALBARANES / WZ) ============
//
// Endpointy globalne (bez {period} w URL — Contasimple sam wybiera okres
// na podstawie deliveryNoteDate w body). Body POST analogiczne do FV ale
// zwykle z zerami w polach finansowych (albarán = lista wydanych towarów,
// bez cen/podatku).

async function listDeliveryNotes(params = {}) {
  const query = new URLSearchParams();
  if (params.page) query.set('page', String(params.page));
  if (params.itemsPerPage) query.set('itemsPerPage', String(params.itemsPerPage));
  if (params.targetEntityId) query.set('targetEntityId', String(params.targetEntityId));
  const url = '/accounting/deliveryNotes' + (query.toString() ? `?${query}` : '');
  return await csJson('GET', url);
}

async function getDeliveryNote(id) {
  return await csJson('GET', `/accounting/deliveryNotes/${encodeURIComponent(id)}`);
}

async function createDeliveryNote(payload) {
  if (!payload.targetEntityId) {
    throw new Error('createDeliveryNote: targetEntityId required (customer must exist in Contasimple)');
  }
  if (!Array.isArray(payload.lines) || payload.lines.length === 0) {
    throw new Error('createDeliveryNote: lines[] required');
  }
  return await csJson('POST', '/accounting/deliveryNotes', null, payload);
}

async function deleteDeliveryNote(id) {
  return await csJson('DELETE', `/accounting/deliveryNotes/${encodeURIComponent(id)}`);
}

async function fetchDeliveryNotePdf(id) {
  const { status, body, headers } = await csRequest(
    'GET',
    `/accounting/deliveryNotes/${encodeURIComponent(id)}/pdf`
  );
  if (status >= 400) {
    throw new Error(`Contasimple deliveryNote PDF fetch failed (${status}): ${body.toString().slice(0, 300)}`);
  }
  return { buffer: body, contentType: headers['content-type'] || 'application/pdf' };
}

async function sendDeliveryNoteEmail(id, message) {
  if (!message || !message.to) throw new Error('sendDeliveryNoteEmail: message.to required');
  const body = {
    to: message.to,
    replyTo: message.replyTo || null,
    blindCopy: Boolean(message.blindCopy),
    subject: message.subject || '',
    body: message.body || '',
  };
  return await csJson('POST', `/accounting/deliveryNotes/${encodeURIComponent(id)}/send`, null, body);
}

async function getNextDeliveryNoteNumber(numberingFormatId) {
  return await csJson(
    'GET',
    `/accounting/deliveryNotes/nextDeliveryNoteNumber/${encodeURIComponent(numberingFormatId)}`
  );
}

// Lista formatow numeracji skonfigurowanych na koncie. Uzywane do
// auto-wykrycia formatu albaranu (WZ) zeby Nikodem nie musial recznie
// ustawiac KANARY_ALBARAN_NUMBERING_FORMAT_ID. Endpoint moze sie roznic miedzy
// wdrozeniami Contasimple — probujemy kilku znanych sciezek, pierwsza ktora
// odpowie 2xx wygrywa. Best-effort: zwraca [] gdy zaden nie zadziala.
async function listNumberingFormats() {
  const candidates = [
    '/accounting/numberingFormats',
    '/numberingFormats',
    '/accounting/numerationFormats',
    '/me/numberingFormats',
  ];
  for (const path of candidates) {
    try {
      const data = await csJson('GET', path);
      const arr = Array.isArray(data) ? data : (data && (data.data || data.items || data.results));
      if (Array.isArray(arr)) {
        console.log(`[contasimple] listNumberingFormats via ${path} → ${arr.length} formatow`);
        return arr;
      }
    } catch (e) {
      // 404/403 — sprobuj nastepny kandydat.
    }
  }
  console.warn('[contasimple] listNumberingFormats — zaden kandydat-endpoint nie zadzialal');
  return [];
}

// ============ EXPORTS ============

function isConfigured() {
  return Boolean(API_KEY);
}

module.exports = {
  isConfigured,
  getAccessToken,
  // me
  getMyCompanies,
  // customers
  listCustomers,
  listAllCustomers,
  searchCustomerByNif,
  searchCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  // products
  listProducts,
  listAllProducts,
  getProduct,
  updateProduct,
  // invoices
  listInvoices,
  getInvoice,
  searchInvoiceByNumber,
  createInvoice,
  deleteInvoice,
  fetchInvoicePdf,
  sendInvoiceEmail,
  getNextInvoiceNumber,
  // delivery notes (albaranes / WZ)
  listDeliveryNotes,
  getDeliveryNote,
  createDeliveryNote,
  deleteDeliveryNote,
  fetchDeliveryNotePdf,
  sendDeliveryNoteEmail,
  getNextDeliveryNoteNumber,
  listNumberingFormats,
  // helpers
  dateToPeriod,
  DEFAULT_VAT_PERCENT,
  DEFAULT_UI_CULTURE,
};
