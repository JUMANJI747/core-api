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

function httpsGetJson(url, headers) {
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
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          reject(new Error('iFirma invalid JSON: ' + Buffer.concat(chunks).toString().slice(0, 200)));
        }
      });
    }).on('error', reject);
  });
}

async function fetchInvoices({ dataOd, dataDo, status, nipKontrahenta } = {}) {
  if (!login || !keyHex) throw new Error('IFIRMA_LOGIN or IFIRMA_KEY_HEX not set');

  const urlBase = 'https://www.ifirma.pl/iapi/faktury.json';
  const params = new URLSearchParams();
  if (dataOd) params.set('dataOd', dataOd);
  if (dataDo) params.set('dataDo', dataDo);
  if (status) params.set('status', status);
  if (nipKontrahenta) params.set('nipKontrahenta', nipKontrahenta);

  const query = params.toString();
  const fullUrl = query ? urlBase + '?' + query : urlBase;

  const auth = generateAuth(urlBase, login, keyHex);
  const data = await httpsGetJson(fullUrl, {
    Authentication: auth,
    Accept: 'application/json',
  });

  return data.Wynik || [];
}

module.exports = { fetchInvoices };
