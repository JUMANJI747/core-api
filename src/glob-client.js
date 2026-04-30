'use strict';

const https = require('https');

let cachedToken = null;
let tokenExpiry = 0;

function httpsRequest(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Accept': 'application/json',
        'Accept-Language': 'pl',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch (e) { resolve({ status: res.statusCode, body: text }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const email = (process.env.GLOBKURIER_EMAIL || '').trim();
  const password = (process.env.GLOBKURIER_PASSWORD || '').trim();
  if (!email || !password) throw new Error('GLOBKURIER_EMAIL or GLOBKURIER_PASSWORD not set');

  const resp = await httpsRequest('https://api.globkurier.pl/v1/auth/login', 'POST', {}, { email, password });
  if (resp.status !== 200 || !resp.body.token) {
    throw new Error('GlobKurier login failed: ' + JSON.stringify(resp.body).slice(0, 200));
  }

  cachedToken = resp.body.token;
  tokenExpiry = Date.now() + 50 * 60 * 1000;
  console.log('[glob-client] Logged in, token cached for 50 min');
  return cachedToken;
}

async function getSenders(offset = 0, limit = 100, phrase = '') {
  const token = await getToken();
  let url = `https://api.globkurier.pl/v1/user/addressBook/senders?offset=${offset}&limit=${limit}`;
  if (phrase) url += '&filters[phrase]=' + encodeURIComponent(phrase);
  const resp = await httpsRequest(url, 'GET', { 'X-Auth-Token': token });
  return resp.body;
}

async function getReceivers(offset = 0, limit = 100, phrase = '') {
  const token = await getToken();
  let url = `https://api.globkurier.pl/v1/user/addressBook/receivers?offset=${offset}&limit=${limit}`;
  if (phrase) url += '&filters[phrase]=' + encodeURIComponent(phrase);
  const resp = await httpsRequest(url, 'GET', { 'X-Auth-Token': token });
  return resp.body;
}

async function getOrders(params = {}) {
  const token = await getToken();
  const query = new URLSearchParams();
  query.set('limit', String(params.limit || 100));
  if (params.offset) query.set('offset', String(params.offset));
  if (params.status) query.set('filters[status]', params.status);
  if (params.dateFrom) query.set('filters[dateFrom]', params.dateFrom);
  if (params.dateTo) query.set('filters[dateTo]', params.dateTo);

  const url = `https://api.globkurier.pl/v1/orders?${query.toString()}`;
  const resp = await httpsRequest(url, 'GET', { 'X-Auth-Token': token });
  return resp.body;
}

async function getOrderTracking(orderHash) {
  const token = await getToken();
  const url = `https://api.globkurier.pl/v1/order/tracking?orderHash=${encodeURIComponent(orderHash)}`;
  const resp = await httpsRequest(url, 'GET', { 'X-Auth-Token': token });
  return resp.body;
}

async function getOrderLabels(orderHash, format = 'A4') {
  const token = await getToken();
  const url = `https://api.globkurier.pl/v1/order/labels?orderHashes[]=${encodeURIComponent(orderHash)}&format=${format}`;
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'X-Auth-Token': token, 'Accept-Language': 'pl' },
    };
    https.get(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

async function getProducts(senderCountryId = 1, receiverCountryId) {
  const token = await getToken();
  let url = `https://api.globkurier.pl/v1/products?senderCountryId=${senderCountryId}`;
  if (receiverCountryId) url += `&receiverCountryId=${receiverCountryId}`;
  const resp = await httpsRequest(url, 'GET', { 'X-Auth-Token': token });
  return resp.body;
}

async function createOrder(orderData) {
  const token = await getToken();
  const resp = await httpsRequest('https://api.globkurier.pl/v1/order', 'POST', { 'X-Auth-Token': token }, orderData);
  return resp.body;
}

async function getQuote(params) {
  const token = await getToken();
  const query = new URLSearchParams();
  query.set('width', String(params.width));
  query.set('height', String(params.height));
  query.set('length', String(params.length));
  query.set('weight', String(params.weight));
  query.set('quantity', String(params.quantity || 1));
  query.set('senderCountryId', String(params.senderCountryId));
  query.set('senderPostCode', String(params.senderPostCode || ''));
  query.set('receiverCountryId', String(params.receiverCountryId));
  query.set('receiverPostCode', String(params.receiverPostCode || ''));
  query.set('packageType', 'PARCEL');
  query.set('transportType', 'ROAD');
  query.append('collectionTypes[]', params.collectionType || 'PICKUP');
  query.append('deliveryTypes[]', params.deliveryType || 'PICKUP');
  query.set('flatList', 'true');

  const url = `https://api.globkurier.pl/v1/products?${query.toString()}`;
  const resp = await httpsRequest(url, 'GET', { 'X-Auth-Token': token });
  return resp.body;
}

async function getAddons(productId, params) {
  const token = await getToken();
  const query = new URLSearchParams();
  query.set('productId', String(productId));
  query.set('length', String(params.length));
  query.set('width', String(params.width));
  query.set('height', String(params.height));
  query.set('weight', String(params.weight));
  query.set('quantity', String(params.quantity || 1));
  query.set('senderCountryId', String(params.senderCountryId));
  query.set('receiverCountryId', String(params.receiverCountryId));
  query.set('senderPostCode', String(params.senderPostCode || ''));
  query.set('receiverPostCode', String(params.receiverPostCode || ''));

  const url = `https://api.globkurier.pl/v1/product/addons?${query.toString()}`;
  const resp = await httpsRequest(url, 'GET', { 'X-Auth-Token': token });
  return resp.body;
}

async function getPickupTimes(productId, params) {
  const token = await getToken();
  const query = new URLSearchParams();
  query.set('productId', String(productId));
  query.set('senderCountryId', String(params.senderCountryId));
  query.set('senderPostCode', String(params.senderPostCode || ''));
  // GK doc: "providing as much data as possible allows for better matching
  // of shipping dates for a given location" — for DPD specifically the
  // city / street can flip a "no slots" answer to "available".
  if (params.senderCity) query.set('senderCity', String(params.senderCity));
  if (params.senderStreet) query.set('senderStreet', String(params.senderStreet));
  if (params.senderHouseNumber) query.set('senderHouseNumber', String(params.senderHouseNumber));
  if (params.senderState) query.set('senderState', String(params.senderState));
  query.set('receiverCountryId', String(params.receiverCountryId));
  query.set('receiverPostCode', String(params.receiverPostCode || ''));
  query.set('receiverCity', String(params.receiverCity || ''));
  if (params.receiverState) query.set('receiverState', String(params.receiverState));
  query.set('date', params.date || new Date().toISOString().split('T')[0]);
  query.set('weight', String(params.weight));
  query.set('quantity', '1');

  const url = `https://api.globkurier.pl/v1/order/pickupTimeRanges?${query.toString()}`;
  const resp = await httpsRequest(url, 'GET', { 'X-Auth-Token': token });
  return resp.body;
}

// Walk forward day by day from `startDate` (default today) and return the
// first day that has at least one pickup window. GlobKurier's API only
// answers per-date — there's no "soonest" endpoint — so we iterate. Skips
// weekends/holidays automatically because GK returns an empty list on
// those days. Stops after `maxDays` to bound the call count when the
// carrier has no slots at all.
//
// Returns: { date, timeFrom, timeTo, daysAhead } or null.
async function findNearestPickupDate(productId, params, maxDays = 10) {
  const start = params.date ? new Date(params.date) : new Date();

  function extractList(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    return data.results || data.items || data.data || [];
  }

  for (let i = 0; i < maxDays; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    let resp;
    try {
      resp = await getPickupTimes(productId, { ...params, date: dateStr });
    } catch (e) {
      console.log('[glob-client] findNearestPickupDate iter', dateStr, 'error:', e.message);
      continue;
    }
    const list = extractList(resp);
    if (list.length > 0) {
      const slot = list[0];
      return {
        date: slot.date || dateStr,
        timeFrom: slot.from || slot.timeFrom || null,
        timeTo: slot.to || slot.timeTo || null,
        daysAhead: i,
      };
    }
  }
  return null;
}

async function getCustomRequiredFields(productId, senderCountryId, receiverCountryId) {
  const token = await getToken();
  const query = new URLSearchParams();
  query.set('productId', String(productId));
  query.set('senderCountryId', String(senderCountryId));
  query.set('receiverCountryId', String(receiverCountryId));
  query.set('collectionType', 'PICKUP');

  const url = `https://api.globkurier.pl/v1/order/customRequiredFields?${query.toString()}`;
  const resp = await httpsRequest(url, 'GET', { 'X-Auth-Token': token });
  return resp.body;
}

module.exports = { getToken, getSenders, getReceivers, getOrders, getOrderTracking, getOrderLabels, getProducts, createOrder, getQuote, getAddons, getPickupTimes, findNearestPickupDate, getCustomRequiredFields };
