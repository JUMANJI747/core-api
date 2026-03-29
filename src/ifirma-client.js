'use strict';

const crypto = require('crypto');
const https = require('https');

const login = (process.env.IFIRMA_USER || '').trim();
const keyHex = (process.env.IFIRMA_API_KEY || '').trim();

function generateAuth(url, login, keyHex) {
  const msg = url + login + 'faktura';
  const sig = crypto.createHmac('sha1', Buffer.from(keyHex, 'hex')).update(msg, 'utf8').digest('hex');
  return 'IAPIS user=' + login + ', hmac-sha1=' + sig;
}

function httpsGetRaw(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers,
    };
    https.get(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() });
      });
    }).on('error', reject);
  });
}

async function fetchInvoices({ dataOd, dataDo, status, nipKontrahenta } = {}) {
  if (!login || !keyHex) throw new Error('IFIRMA_USER or IFIRMA_API_KEY not set');

  const today = new Date().toISOString().slice(0, 10);
  const urlBase = 'https://www.ifirma.pl/iapi/faktury.json';

  const baseParams = new URLSearchParams();
  baseParams.set('dataOd', dataOd || '2025-01-01');
  baseParams.set('dataDo', dataDo || today);
  baseParams.set('iloscNaStronie', '200');
  if (status) baseParams.set('status', status);
  if (nipKontrahenta) baseParams.set('nipKontrahenta', nipKontrahenta);

  const allInvoices = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams(baseParams);
    params.set('strona', String(page));
    const fullUrl = urlBase + '?' + params.toString();
    const auth = generateAuth(urlBase, login, keyHex);

    console.log('[ifirma] fetching:', fullUrl);
    console.log('[ifirma] auth header:', auth.substring(0, 50) + '...');

    const { status: httpStatus, body } = await httpsGetRaw(fullUrl, {
      Authentication: auth,
      Accept: 'application/json',
    });

    console.log('[ifirma] response status:', httpStatus, 'body length:', body.length);
    console.log('[ifirma] raw response (first 500 chars):', body.substring(0, 500));

    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      throw new Error('iFirma invalid JSON: ' + body.slice(0, 200));
    }

    const pageInvoices = (data.response && data.response.Wynik) || [];
    console.log(`[ifirma] page ${page}: fetched ${pageInvoices.length} invoices`);

    allInvoices.push(...pageInvoices);

    if (pageInvoices.length < 200) break;
    page++;
  }

  return allInvoices;
}

module.exports = { fetchInvoices };
