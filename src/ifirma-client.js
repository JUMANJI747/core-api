'use strict';

const crypto = require('crypto');
const https = require('https');

const login = (process.env.IFIRMA_USER || '').trim();
const keyHex = (process.env.IFIRMA_API_KEY || '').trim();

// ============ HELPERS ============

function hmacSig(msg, keyHex) {
  return crypto.createHmac('sha1', Buffer.from(keyHex, 'hex')).update(msg, 'utf8').digest('hex');
}

function generateAuth(url, body, login, keyHex) {
  const msg = url + login + 'faktura' + (body || '');
  const sig = hmacSig(msg, keyHex);
  return 'IAPIS user=' + login + ', hmac-sha1=' + sig;
}

function httpsGetRaw(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers };
    https.get(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

function httpsPostJson(url, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(bodyObj);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data, 'utf8'),
        ...headers,
      },
    };
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch (e) { reject(new Error('iFirma invalid JSON: ' + text.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ============ NBP RATE ============

async function fetchNbpRate(date) {
  let d = new Date(date);
  for (let i = 0; i < 5; i++) {
    const ds = d.toISOString().slice(0, 10);
    const url = `https://api.nbp.pl/api/exchangerates/rates/A/EUR/${ds}/?format=json`;
    try {
      const { status, body } = await httpsGetRaw(url, { Accept: 'application/json' });
      if (status === 200) {
        const data = JSON.parse(body.toString());
        return data.rates[0].mid;
      }
    } catch (_) {}
    d.setDate(d.getDate() - 1);
  }
  throw new Error('NBP rate not found for date: ' + date);
}

// ============ FETCH INVOICES ============

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
    const auth = generateAuth(urlBase, '', login, keyHex);

    console.log('[ifirma] fetching:', fullUrl);
    console.log('[ifirma] auth header:', auth.substring(0, 50) + '...');

    const { status: httpStatus, body } = await httpsGetRaw(fullUrl, {
      Authentication: auth,
      Accept: 'application/json',
    });

    const bodyStr = body.toString();
    console.log('[ifirma] response status:', httpStatus, 'body length:', bodyStr.length);
    console.log('[ifirma] raw response (first 500 chars):', bodyStr.substring(0, 500));

    let data;
    try { data = JSON.parse(bodyStr); }
    catch (e) { throw new Error('iFirma invalid JSON: ' + bodyStr.slice(0, 200)); }

    const pageInvoices = (data.response && data.response.Wynik) || [];
    console.log(`[ifirma] page ${page}: fetched ${pageInvoices.length} invoices`);

    allInvoices.push(...pageInvoices);
    if (pageInvoices.length < 200) break;
    page++;
  }

  return allInvoices;
}

// ============ CREATE INVOICE ============

async function createInvoice({ kontrahent, pozycje, rodzaj }) {
  if (!login || !keyHex) throw new Error('IFIRMA_USER or IFIRMA_API_KEY not set');

  const isWdt = rodzaj === 'wdt';
  const url = isWdt
    ? 'https://www.ifirma.pl/iapi/fakturawdt.json'
    : 'https://www.ifirma.pl/iapi/fakturakraj.json';

  const today = new Date().toISOString().slice(0, 10);

  const Kontrahent = {
    Nazwa: kontrahent.name,
    NIP: kontrahent.nip || '',
    Ulica: kontrahent.address || '',
    KodPocztowy: kontrahent.postCode || '',
    Kraj: isWdt ? (kontrahent.country || '') : 'Polska',
    Miejscowosc: kontrahent.city || '',
  };

  const Pozycje = pozycje.map(p => (isWdt ? {
    TypStawkiVat: 'NP',
    Ilosc: p.ilosc,
    CenaJednostkowa: p.cenaNetto,
    NazwaPelna: p.nazwa,
    Jednostka: 'szt.',
  } : {
    StawkaVat: 0.23,
    TypStawkiVat: 'PRC',
    GTU: 'GTU_12',
    Ilosc: p.ilosc,
    CenaJednostkowa: p.cenaNetto,
    NazwaPelna: p.nazwa,
    Jednostka: 'szt.',
  }));

  const body = {
    Zaplacono: 0,
    LiczOd: 'BRT',
    DataWystawienia: today,
    MiejsceWystawienia: 'Warszawa',
    DataSprzedazy: today,
    FormatDatySprzedazy: 'DZN',
    SposobZaplaty: 'PRZ',
    NazwaSeriiNumeracji: 'default',
    RodzajPodpisuOdbiorcy: 'BWO',
    Kontrahent,
    Pozycje,
  };

  const bodyStr = JSON.stringify(body);
  const auth = generateAuth(url, bodyStr, login, keyHex);

  console.log('[ifirma] creating invoice for', kontrahent.name);
  console.log('[ifirma] CREATE INVOICE URL:', url);
  console.log('[ifirma] CREATE INVOICE AUTH:', auth.slice(0, 60) + '...');
  console.log('[ifirma] CREATE INVOICE REQUEST BODY:', JSON.stringify(body, null, 2));

  const { status, body: resp } = await httpsPostJson(url, { Authentication: auth }, body);
  const fullResp = JSON.stringify(resp);
  console.log('[ifirma] create invoice status:', status, fullResp.slice(0, 300));

  const kod = resp && resp.response && resp.response.Kod;
  const informacja = resp && resp.response && resp.response.Informacja;
  if (status !== 200 || (kod != null && kod !== 0) || informacja) {
    console.log('[ifirma] API error:', fullResp);
    throw Object.assign(new Error('iFirma error: ' + fullResp), { ifirmaRaw: resp });
  }

  const wynik = resp.response && resp.response.Wynik;
  const invoiceNumber = wynik && (wynik.PelnyNumer || wynik.Numer) || null;
  return { ok: true, invoiceNumber, ifirmaRaw: resp };
}

// ============ FETCH PDF ============

async function fetchInvoicePdf(pelnyNumer, rodzaj) {
  if (!login || !keyHex) throw new Error('IFIRMA_USER or IFIRMA_API_KEY not set');

  const numer = pelnyNumer.replace(/\//g, '_');
  const endpoint = (rodzaj || '').toLowerCase().includes('wdt') || (rodzaj || '').toLowerCase().includes('dostawa_ue')
    ? 'fakturawdt'
    : 'fakturakraj';

  const url = `https://www.ifirma.pl/iapi/${endpoint}/${numer}.pdf`;
  const auth = generateAuth(url, '', login, keyHex);

  console.log('[ifirma] fetching PDF:', url);

  const { status, body } = await httpsGetRaw(url, {
    Authentication: auth,
    Accept: 'application/pdf',
  });

  if (status !== 200) {
    const bodyText = body.toString();
    console.log('[ifirma] API error (PDF):', JSON.stringify({ status, body: bodyText }));
    throw new Error('iFirma PDF error: status ' + status + ' — ' + bodyText);
  }
  return body; // Buffer
}

module.exports = { generateAuth, fetchInvoices, fetchNbpRate, createInvoice, fetchInvoicePdf };
