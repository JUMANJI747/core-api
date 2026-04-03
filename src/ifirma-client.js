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
  d.setDate(d.getDate() - 1); // NBP rate from the day preceding the invoice date
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

// ============ SEARCH CONTRACTOR ============

async function searchContractor(nip) {
  if (!login || !keyHex) throw new Error('IFIRMA_USER or IFIRMA_API_KEY not set');

  const url = `https://www.ifirma.pl/iapi/kontrahenci/${encodeURIComponent(nip)}.json`;
  const auth = generateAuth(url, '', login, keyHex);

  console.log('[ifirma] searching contractor by NIP:', nip);

  const { status, body } = await httpsGetRaw(url, {
    Authentication: auth,
    Accept: 'application/json',
  });

  const bodyStr = body.toString();
  console.log('[ifirma] searchContractor status:', status, bodyStr.slice(0, 300));

  let data;
  try { data = JSON.parse(bodyStr); }
  catch (e) { throw new Error('iFirma invalid JSON (searchContractor): ' + bodyStr.slice(0, 200)); }

  return data.response && data.response.Wynik && data.response.Wynik[0] || null;
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

  // Enrich contractor data from iFirma if address/postCode missing
  let enriched = {};
  if (kontrahent.nip && (!kontrahent.address || !kontrahent.postCode)) {
    try {
      const ifirmaContractor = await searchContractor(kontrahent.nip);
      if (ifirmaContractor) {
        console.log('[ifirma] enriched contractor data from iFirma:', ifirmaContractor.Ulica, ifirmaContractor.KodPocztowy, ifirmaContractor.Miejscowosc);
        enriched = {
          Ulica: ifirmaContractor.Ulica || '',
          KodPocztowy: ifirmaContractor.KodPocztowy || '',
          Miejscowosc: ifirmaContractor.Miejscowosc || '',
          Kraj: ifirmaContractor.Kraj || '',
          ...(ifirmaContractor.Identyfikator ? { IdentyfikatorKontrahenta: ifirmaContractor.Identyfikator } : {}),
        };
      }
    } catch (e) {
      console.log('[ifirma] searchContractor failed (non-fatal):', e.message);
    }
  }

  const _nip = kontrahent.nip;
  const _ulica = kontrahent.address || enriched.Ulica;
  const _kod = kontrahent.postCode || enriched.KodPocztowy;
  const _miasto = kontrahent.city || enriched.Miejscowosc;
  const _country = kontrahent.country || enriched.Kraj;
  const _ifirmaId = kontrahent.ifirmaId || enriched.IdentyfikatorKontrahenta;

  const Pozycje = pozycje.map(p => {
    const wariantSuffix = p.wariant && !p.nazwa.toLowerCase().includes(p.wariant.toLowerCase())
      ? ` - ${p.wariant}` : '';
    const isRealEan = p.ean && /^\d/.test(p.ean);
    const NazwaPelna = `${p.nazwa}${wariantSuffix}${isRealEan ? ` EAN ${p.ean}` : ''}`;
    const CenaJednostkowa = p.cena || p.cenaNetto;
    console.log('[ifirma] position price:', CenaJednostkowa);
    return isWdt ? {
      TypStawkiVat: 'NP',
      GTU: 'GTU_12',
      Ilosc: p.ilosc,
      CenaJednostkowa,
      NazwaPelna,
      Jednostka: 'szt.',
    } : {
      StawkaVat: 0.23,
      TypStawkiVat: 'PRC',
      GTU: 'GTU_12',
      Ilosc: p.ilosc,
      CenaJednostkowa,
      NazwaPelna,
      Jednostka: 'szt.',
    };
  });

  const Kontrahent = {
    Nazwa: kontrahent.name,
    ...(_nip ? { NIP: _nip } : {}),
    ...(_ulica ? { Ulica: _ulica } : {}),
    ...(_kod ? { KodPocztowy: _kod } : {}),
    ...(_miasto ? { Miejscowosc: _miasto } : {}),
    Kraj: isWdt ? (_country || '') : 'Polska',
  };

  const body = {
    Zaplacono: 0,
    ZaplaconoNaDokumencie: 0,
    WidocznyNumerGios: false,
    Numer: null,
    LiczOd: 'BRT',
    ...(_ifirmaId ? { IdentyfikatorKontrahenta: _ifirmaId } : {}),
    ...(_nip ? { NIPKontrahenta: _nip } : {}),
    DataWystawienia: today,
    MiejsceWystawienia: 'Warszawa',
    DataSprzedazy: today,
    FormatDatySprzedazy: 'DZN',
    SposobZaplaty: 'PRZ',
    NazwaSeriiNumeracji: 'default',
    RodzajPodpisuOdbiorcy: 'BWO',
    ...(isWdt ? { Jezyk: 'en', PrefiksUEKontrahenta: (_country || '').toUpperCase() } : {}),
    NumerKontaBankowego: isWdt ? '67 1140 2004 0000 3912 1358 3952' : '11 1140 2004 0000 3002 8145 9633',
    Kontrahent,
    Pozycje,
    ...(isWdt ? {
      Waluta: 'EUR',
      KursWalutyZDniaPoprzedzajacegoDzienWystawieniaFaktury: await fetchNbpRate(today),
    } : {}),
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
  if (status !== 200 || (kod != null && kod !== 0)) {
    console.log('[ifirma] API error:', fullResp);
    throw Object.assign(new Error('iFirma error: ' + fullResp), { ifirmaRaw: resp });
  }

  const wynik = resp.response && resp.response.Wynik;
  const invoiceNumber = wynik && (wynik.PelnyNumer || wynik.Numer) || null;
  return { ok: true, invoiceNumber, ifirmaRaw: resp };
}

// ============ FETCH PDF ============

async function fetchInvoicePdf(pelnyNumer, rodzaj, fakturaId) {
  if (!login || !keyHex) throw new Error('IFIRMA_USER or IFIRMA_API_KEY not set');

  const r = (rodzaj || '').toLowerCase();
  let endpoint;
  if (r === 'prz_eksport_towarow' || r === 'eksport') {
    endpoint = 'fakturaeksporttowarow';
  } else if (r === 'prz_faktura_proforma') {
    endpoint = 'fakturaproforma';
  } else if (r === 'prz_dostawa_ue_towarow' || r === 'wdt') {
    endpoint = 'fakturawdt';
  } else {
    endpoint = 'fakturakraj';
  }

  const numerUrl = (pelnyNumer && pelnyNumer !== 'UNKNOWN') ? pelnyNumer.replace(/\//g, '_') : null;
  const identyfikator = fakturaId || numerUrl;

  const url = `https://www.ifirma.pl/iapi/${endpoint}/${identyfikator}.pdf`;
  const auth = generateAuth(url, '', login, keyHex);

  console.log('[ifirma] PDF download URL:', url);

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

// ============ FETCH INVOICE DETAILS ============

async function fetchInvoiceDetails(fakturaId, rodzaj) {
  if (!login || !keyHex) throw new Error('IFIRMA_USER or IFIRMA_API_KEY not set');

  const r = (rodzaj || '').toLowerCase();
  let endpoint;
  if (r === 'prz_eksport_towarow' || r === 'eksport') {
    endpoint = 'fakturaeksporttowarow';
  } else if (r === 'prz_faktura_proforma') {
    endpoint = 'fakturaproforma';
  } else if (r === 'prz_dostawa_ue_towarow' || r === 'wdt') {
    endpoint = 'fakturawdt';
  } else {
    endpoint = 'fakturakraj';
  }

  const url = `https://www.ifirma.pl/iapi/${endpoint}/${fakturaId}.json`;
  const auth = generateAuth(url, '', login, keyHex);

  console.log('[ifirma] fetching invoice details:', fakturaId);

  const { status, body } = await httpsGetRaw(url, {
    Authentication: auth,
    Accept: 'application/json',
  });

  const bodyStr = body.toString();
  if (status !== 200) throw new Error('iFirma invoice details error: status ' + status + ' — ' + bodyStr.slice(0, 200));

  let data;
  try { data = JSON.parse(bodyStr); }
  catch (e) { throw new Error('iFirma invalid JSON (fetchInvoiceDetails): ' + bodyStr.slice(0, 200)); }

  return (data.response && data.response.Wynik) || data;
}

// ============ DELETE INVOICE ============

async function deleteInvoice(fakturaId, rodzaj) {
  if (!login || !keyHex) throw new Error('IFIRMA_USER or IFIRMA_API_KEY not set');

  const r = (rodzaj || '').toLowerCase();
  const endpoint = (r === 'wdt' || r === 'prz_dostawa_ue_towarow') ? 'fakturawdt' : 'fakturakraj';
  const url = `https://www.ifirma.pl/iapi/${endpoint}/${fakturaId}.json`;
  const msg = url + login + 'faktura';
  const sig = require('crypto').createHmac('sha1', Buffer.from(keyHex, 'hex')).update(msg, 'utf8').digest('hex');
  const auth = 'IAPIS user=' + login + ', hmac-sha1=' + sig;

  console.log('[ifirma] deleting invoice:', fakturaId);

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = require('https').request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'DELETE',
      headers: { Authentication: auth, Accept: 'application/json' },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        console.log('[ifirma] delete invoice response:', res.statusCode, text.slice(0, 300));
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch (e) { resolve({ status: res.statusCode, body: text }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ============ REGISTER PAYMENT ============

async function registerPayment(invoiceNumber, type, amount, currency, date) {
  if (!login || !keyHex) throw new Error('IFIRMA_USER or IFIRMA_API_KEY not set');

  const typ = type === 'krajowa' ? 'prz_faktura_kraj' : 'prz_dostawa_ue_towarow';
  const numer = invoiceNumber.replace(/\//g, '_');
  const url = `https://www.ifirma.pl/iapi/faktury/wplaty/${typ}/${numer}.json`;

  const body = { Kwota: amount };
  if (currency !== 'PLN') {
    const rateUrl = `https://api.nbp.pl/api/exchangerates/rates/a/${currency}/?format=json`;
    const { status: rateStatus, body: rateBody } = await httpsGetRaw(rateUrl, { Accept: 'application/json' });
    if (rateStatus !== 200) throw new Error(`NBP rate fetch failed for ${currency}: status ${rateStatus}`);
    const rateData = JSON.parse(rateBody.toString());
    const kursNBP = rateData.rates[0].mid;
    console.log(`[ifirma] NBP rate for ${currency}: ${kursNBP}`);
    body.Kurs = kursNBP;
    body.Data = date;
  }
  const bodyStr = JSON.stringify(body);
  const auth = generateAuth(url, bodyStr, login, keyHex);

  console.log(`[ifirma] registering payment: ${invoiceNumber}, ${amount} ${currency}`);

  const result = await httpsPostJson(url, { Authentication: auth, Accept: 'application/json' }, body);
  console.log('[ifirma] registerPayment response:', result.status, JSON.stringify(result.body).slice(0, 300));
  return result;
}

module.exports = { generateAuth, fetchInvoices, fetchNbpRate, searchContractor, createInvoice, fetchInvoicePdf, fetchInvoiceDetails, deleteInvoice, registerPayment };
