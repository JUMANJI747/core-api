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

module.exports = { getToken, getSenders, getReceivers };
