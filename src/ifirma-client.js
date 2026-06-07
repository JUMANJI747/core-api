'use strict';

const crypto = require('crypto');
const https = require('https');

const login = (process.env.IFIRMA_USER || '').trim();
const keyHex = (process.env.IFIRMA_API_KEY || '').trim();
// Klucz modułu "Abonent" — wymagany do PUT /iapi/abonent/miesiacksiegowy.
// Fallback na klucz fakturowy, gdyby user wpisał ten sam klucz pod oba env-vary.
const keyHexAbonent = (process.env.IFIRMA_API_KEY_ABONENT || process.env.IFIRMA_API_KEY || '').trim();

// ============ HELPERS ============

function hmacSig(msg, keyHex) {
  return crypto.createHmac('sha1', Buffer.from(keyHex, 'hex')).update(msg, 'utf8').digest('hex');
}

function generateAuth(url, body, login, keyHex) {
  const msg = url + login + 'faktura' + (body || '');
  const sig = hmacSig(msg, keyHex);
  return 'IAPIS user=' + login + ', hmac-sha1=' + sig;
}

function generateAuthAbonent(url, body, login, keyHex) {
  const msg = url + login + 'abonent' + (body || '');
  const sig = hmacSig(msg, keyHex);
  return 'IAPIS user=' + login + ', hmac-sha1=' + sig;
}

function httpsPutJson(url, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(bodyObj);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'PUT',
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

async function stepAccountingMonth(direction, crossYear, keyOverride) {
  const k = (keyOverride || keyHexAbonent || '').trim();
  if (!login || !k) throw new Error('login or key missing');
  const url = 'https://www.ifirma.pl/iapi/abonent/miesiacksiegowy.json';
  const body = { MiesiacKsiegowy: direction };
  if (crossYear) body.PrzeniesDaneZPoprzedniegoRoku = true;
  const bodyStr = JSON.stringify(body);
  const auth = generateAuthAbonent(url, bodyStr, login, k);
  console.log(`[ifirma] stepAccountingMonth → ${direction}${crossYear ? ' (cross-year)' : ''} body=${bodyStr}`);
  const { status, body: resp } = await httpsPutJson(url, { Authentication: auth }, body);
  const kod = resp && resp.response && resp.response.Kod;
  const informacja = resp && resp.response && resp.response.Informacja;
  console.log(`[ifirma] stepAccountingMonth status=${status} kod=${kod} info="${informacja}"`);
  if (status !== 200 || (kod != null && kod !== 0)) {
    throw new Error(`iFirma stepAccountingMonth błąd (kod=${kod}): ${informacja || JSON.stringify(resp)}`);
  }
  return { ok: true };
}

async function setAccountingMonth(targetMiesiac, targetRok) {
  if (!login || !keyHexAbonent) {
    throw new Error('IFIRMA_API_KEY_ABONENT not set — wygeneruj klucz Abonent w iFirma → Konfiguracja → API i wpisz w Railway (lub fallback IFIRMA_API_KEY).');
  }
  const current = await getAccountingMonth();
  const curM = current.body && current.body.response && current.body.response.MiesiacKsiegowy;
  const curR = current.body && current.body.response && current.body.response.RokKsiegowy;
  if (!curM || !curR) throw new Error('Nie udało się odczytać aktualnego miesiąca księgowego iFirma');
  console.log(`[ifirma] setAccountingMonth: current=${curR}-${String(curM).padStart(2,'0')} target=${targetRok}-${String(targetMiesiac).padStart(2,'0')}`);

  let delta = (targetRok - curR) * 12 + (targetMiesiac - curM);
  if (delta === 0) return { ok: true, message: 'already at target' };

  if (Math.abs(delta) > 24) {
    throw new Error(`Differential too large (${delta} months) — set manually in iFirma UI`);
  }

  let m = curM, y = curR;
  const direction = delta > 0 ? 'NAST' : 'POPRZ';
  const steps = Math.abs(delta);
  for (let i = 0; i < steps; i++) {
    let crossYear = false;
    if (direction === 'NAST') {
      crossYear = (m === 12);
      await stepAccountingMonth('NAST', crossYear);
      m = m === 12 ? 1 : m + 1;
      if (crossYear) y++;
    } else {
      crossYear = (m === 1);
      await stepAccountingMonth('POPRZ', crossYear);
      m = m === 1 ? 12 : m - 1;
      if (crossYear) y--;
    }
  }
  return { ok: true, message: `Przestawiono z ${curR}-${String(curM).padStart(2,'0')} na ${y}-${String(m).padStart(2,'0')}` };
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

async function fetchNbpRate(date) {
  let d = new Date(date);
  d.setDate(d.getDate() - 1);
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

// iFirma GET /iapi/kontrahenci/{fraza}.json szuka po NAZWIE/FRAZIE kontrahenta,
// nie scisle po NIP. Sprawdzone w starym n8n workflow ktory zawsze uzywal
// nazwy jako klucza. Search po NIP raw czesto zwraca empty mimo ze
// kontrahent istnieje (np. APTEKA CENTRUM NIP 8451905380 — empty po NIP, ale
// found po "APTEKA CENTRUM"). Wywoluj z nazwa jak masz, fallback NIP.
async function searchContractor(query) {
  if (!login || !keyHex) throw new Error('IFIRMA_USER or IFIRMA_API_KEY not set');
  if (!query) return null;

  const url = `https://www.ifirma.pl/iapi/kontrahenci/${encodeURIComponent(query)}.json`;
  const auth = generateAuth(url, '', login, keyHex);

  console.log('[ifirma] searching contractor by query:', query);

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

// Lista wszystkich kontrahentow z paginacja. Fallback gdy searchContractor
// (GET /iapi/kontrahenci/{nip}.json) zwraca empty dla danego NIP, mimo ze
// kontrahent obviously istnieje (iFirma quirk dla niektorych rekordow).
// KRYTYCZNE: HMAC liczy sie z URL BEZ query params (jak fetchInvoices),
// inaczej iFirma zwraca Kod 403 "Niepoprawny hash przesylanej wiadomosci".
// Paginujemy strona=1..N az zwroci empty (max 50 stron = 5000 kontrahentow).
async function listContractors() {
  if (!login || !keyHex) throw new Error('IFIRMA_USER or IFIRMA_API_KEY not set');

  const all = [];
  const baseUrl = 'https://www.ifirma.pl/iapi/kontrahenci.json';
  const auth = generateAuth(baseUrl, '', login, keyHex); // HMAC z path bez query
  let page = 1;
  const PAGE_SIZE = 200;
  const MAX_PAGES = 50;

  while (page <= MAX_PAGES) {
    const fullUrl = `${baseUrl}?strona=${page}&iloscNaStronie=${PAGE_SIZE}`;
    try {
      console.log(`[ifirma] listContractors page ${page}:`, fullUrl);
      const { status, body } = await httpsGetRaw(fullUrl, {
        Authentication: auth,
        Accept: 'application/json',
      });
      const bodyStr = body.toString();
      if (status !== 200) {
        console.log(`[ifirma] listContractors page ${page} HTTP ${status}:`, bodyStr.slice(0, 200));
        break;
      }
      let data;
      try { data = JSON.parse(bodyStr); } catch (_) {
        console.log(`[ifirma] listContractors page ${page} non-JSON:`, bodyStr.slice(0, 200));
        break;
      }
      const kod = data && data.response && data.response.Kod;
      const info = data && data.response && data.response.Informacja;
      const arr = (data && data.response && data.response.Wynik) || [];
      if (kod != null && kod !== 0) {
        console.log(`[ifirma] listContractors page ${page} iFirma Kod ${kod}: ${info}`);
        break;
      }
      console.log(`[ifirma] listContractors page ${page}: ${arr.length} contractors (running total ${all.length + arr.length})`);
      if (!Array.isArray(arr) || arr.length === 0) break;
      all.push(...arr);
      if (arr.length < PAGE_SIZE) break; // last page
      page++;
    } catch (e) {
      console.log(`[ifirma] listContractors page ${page} error:`, e.message);
      break;
    }
  }

  console.log(`[ifirma] listContractors total: ${all.length}`);
  return all;
}

// Wyszukaj kontrahenta po NIP przelistujac liste (fallback gdy search-by-NIP
// fails). Normalizujemy NIP (digits-only) po obu stronach do porownania.
async function findContractorInList(nip) {
  const list = await listContractors();
  if (!list.length) return null;
  const target = String(nip).replace(/\D/g, '');
  if (!target) return null;
  const match = list.find(c => {
    const cNip = String(c.NIP || c.Nip || c.nip || '').replace(/\D/g, '');
    return cNip === target;
  });
  if (match) {
    console.log(`[ifirma] findContractorInList: found NIP ${nip} → Identyfikator ${match.Identyfikator}`);
  }
  return match || null;
}

// ============ UPSERT CONTRACTOR ============

async function upsertContractor({ name, nip, address, postCode, city, country, email, phone, osobaFizyczna, identifier } = {}) {
  if (!login || !keyHex) throw new Error('IFIRMA_USER or IFIRMA_API_KEY not set');
  if (!nip) throw new Error('upsertContractor: NIP required');

  // === KASKADA SZUKANIA ISTNIEJACEGO KONTRAHENTA ===
  //
  // iFirma jest nieprzewidywalna w temacie szukania kontrahenta:
  //   - GET /iapi/kontrahenci/{fraza}.json — matchuje po NAZWIE, czasem
  //     po NIP. Czasem zwraca empty dla rekordow ktore istnieja (sprawdzone:
  //     APTEKA CENTRUM NIP 8451905380 — empty po NIP, found po nazwie).
  //   - NIP w iFirmie moze byc w roznych formatach (PL prefix, dashes XXX-XX-XX-XXX).
  //   - Niektore rekordy sa wylacznie w liscie /iapi/kontrahenci.json, nie po
  //     pojedynczym lookup.
  //
  // Kaskada (kazdy stopien powstal z konkretnego bug-fixu, kolejnosc po
  // niezawodnosci):
  //   0. identifier override (caller wprost podaje iFirma Identyfikator).
  //   1. search po NAZWIE — najniezawodniejszy (workflow n8n tak uzywal).
  //   2. search po NIP raw.
  //   3. search po NIP w alt formatach (PL prefix, dashes 3-3-2-2 / 3-2-2-3).
  //   4. listContractors paginowana + match digits-only po NIP.
  //
  // Pierwszy match konczy kaskade. Wszystkie padaja -> POST create (nowy kontrahent).
  let existing = null;
  if (identifier) {
    existing = { Identyfikator: identifier };
    console.log(`[ifirma] upsertContractor: identifier override = ${identifier} (skip search)`);
  } else {
    // 1. By name (PRIMARY)
    if (name) {
      try {
        const r = await searchContractor(name);
        if (r && r.Identyfikator) {
          console.log(`[ifirma] upsertContractor: found by name "${name}" → identifier=${r.Identyfikator}`);
          existing = r;
        }
      } catch (e) {
        console.log('[ifirma] upsertContractor: searchContractor(name) failed:', e.message);
      }
    }
    // 2. By NIP raw
    if (!existing) {
      try {
        const r = await searchContractor(nip);
        if (r && r.Identyfikator) {
          console.log(`[ifirma] upsertContractor: found by NIP "${nip}" → identifier=${r.Identyfikator}`);
          existing = r;
        }
      } catch (e) {
        console.log('[ifirma] upsertContractor: searchContractor(nip) failed:', e.message);
      }
    }
    // 3. Alt NIP formats (PL prefix, dashes)
    if (!existing) {
      const altNips = [
        `PL${nip}`,
        String(nip).replace(/(\d{3})(\d{3})(\d{2})(\d{2})$/, '$1-$2-$3-$4'),
        String(nip).replace(/(\d{3})(\d{2})(\d{2})(\d{3})$/, '$1-$2-$3-$4'),
      ].filter(v => v && v !== String(nip));
      for (const alt of altNips) {
        try {
          const r = await searchContractor(alt);
          if (r && r.Identyfikator) {
            console.log(`[ifirma] upsertContractor: found via alt NIP "${alt}" → identifier=${r.Identyfikator}`);
            existing = r;
            break;
          }
        } catch (_) {}
      }
    }
    // 4. Pelna lista
    if (!existing) {
      try {
        const fromList = await findContractorInList(nip);
        if (fromList && fromList.Identyfikator) {
          console.log(`[ifirma] upsertContractor: found via listContractors → identifier=${fromList.Identyfikator}`);
          existing = fromList;
        }
      } catch (e) {
        console.log('[ifirma] upsertContractor: listContractors failed:', e.message);
      }
    }
  }

  const body = {
    Nazwa: (name || (existing && existing.Nazwa) || '').slice(0, 100),
    Identyfikator: null,
    PrefiksUE: (existing && existing.PrefiksUE) || null,
    NIP: String(nip),
    Ulica: address || (existing && existing.Ulica) || '',
    KodPocztowy: postCode || (existing && existing.KodPocztowy) || '',
    Kraj: country || (existing && existing.Kraj) || 'Polska',
    Miejscowosc: city || (existing && existing.Miejscowosc) || '',
    Email: email || (existing && existing.Email) || '',
    Telefon: phone || (existing && existing.Telefon) || '',
    OsobaFizyczna: typeof osobaFizyczna === 'boolean' ? osobaFizyczna : !!(existing && existing.OsobaFizyczna),
  };

  if (existing && existing.Identyfikator) {
    const id = String(existing.Identyfikator);
    const url = `https://www.ifirma.pl/iapi/kontrahenci/${encodeURIComponent(id)}.json`;
    const bodyStr = JSON.stringify(body);
    const auth = generateAuth(url, bodyStr, login, keyHex);
    console.log(`[ifirma] upsertContractor PUT update ${id} nip=${nip} kod=${body.KodPocztowy} miasto=${body.Miejscowosc}`);
    const { status, body: resp } = await httpsPutJson(url, { Authentication: auth }, body);
    const kod = resp && resp.response && resp.response.Kod;
    const info = resp && resp.response && resp.response.Informacja;
    console.log(`[ifirma] upsertContractor PUT status=${status} kod=${kod} info="${info}"`);
    if (status !== 200 || (kod != null && kod !== 0)) {
      throw Object.assign(new Error(`iFirma upsertContractor PUT: ${info || JSON.stringify(resp)}`), { ifirmaRaw: resp });
    }
    return { ok: true, action: 'updated', identifier: id };
  }

  const url = 'https://www.ifirma.pl/iapi/kontrahenci.json';
  const bodyStr = JSON.stringify(body);
  const auth = generateAuth(url, bodyStr, login, keyHex);
  console.log(`[ifirma] upsertContractor POST create nip=${nip} kod=${body.KodPocztowy} miasto=${body.Miejscowosc}`);
  const { status, body: resp } = await httpsPostJson(url, { Authentication: auth }, body);
  const kod = resp && resp.response && resp.response.Kod;
  const info = resp && resp.response && resp.response.Informacja;
  console.log(`[ifirma] upsertContractor POST status=${status} kod=${kod} info="${info}"`);
  if (status !== 200 || (kod != null && kod !== 0)) {
    throw Object.assign(new Error(`iFirma upsertContractor POST: ${info || JSON.stringify(resp)}`), { ifirmaRaw: resp });
  }
  const r1 = (resp && resp.response) || {};
  const newId = r1.Identyfikator || (r1.Wynik && (r1.Wynik.Identyfikator || r1.Wynik)) || null;
  return { ok: true, action: 'created', identifier: newId };
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
    const auth = generateAuth(urlBase, '', login, keyHex);

    console.log('[ifirma] fetching:', fullUrl);

    const { status: httpStatus, body } = await httpsGetRaw(fullUrl, {
      Authentication: auth,
      Accept: 'application/json',
    });

    const bodyStr = body.toString();
    console.log('[ifirma] response status:', httpStatus, 'body length:', bodyStr.length);

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

async function createInvoice({ kontrahent, pozycje, rodzaj, waluta, priceMode, paymentDays = 7 }) {
  if (!login || !keyHex) throw new Error('IFIRMA_USER or IFIRMA_API_KEY not set');

  const isWdt = rodzaj === 'wdt';
  // Krajowa w EUR (np. klient z UE bez aktywnego VIES / stowarzyszenie — VAT 23%
  // ale rozliczane w EUR). iFirma ma osobny endpoint fakturawaluta.json
  // (faktura krajowa z cena w walucie obcej). fakturakraj NIE przyjmuje Waluta.
  const isEur = String(waluta || '').toUpperCase() === 'EUR';
  const url = isWdt
    ? 'https://www.ifirma.pl/iapi/fakturawdt.json'
    : isEur
      ? 'https://www.ifirma.pl/iapi/fakturawaluta.json'
      : 'https://www.ifirma.pl/iapi/fakturakraj.json';

  const today = new Date().toISOString().slice(0, 10);

  // Enrich contractor data from iFirma if address/postCode missing
  // Pre-upsert w invoices.js wywoluje upsertContractor PRZED createInvoice
  // i juz pcha dane do iFirmy oraz zwraca aktualny rekord. Dlatego nie robimy
  // tu drugiej rundy searchContractor + enrichment — bylby dubel. Pole
  // kontrahent.ifirmaId zwraca z upserta jak istnieje, postCode/address/city
  // przekazujemy ze ifirma-payload.js. Auto-retry przy 'Pole Kontrahent.X
  // wymagane' nizej nadal sluzy jako safety net na edge cases.
  const _nip = kontrahent.nip;
  const _ulica = kontrahent.address || '';
  const _kod = kontrahent.postCode || '';
  const _miasto = kontrahent.city || '';
  const _country = kontrahent.country || '';
  const _ifirmaId = kontrahent.ifirmaId || null;

  console.log(`[ifirma] FV final contractor fields: nip=${_nip} ulica="${_ulica}" kod="${_kod}" miasto="${_miasto}" kraj="${_country}" ifirmaId=${_ifirmaId}`);

  const isNetto = priceMode === 'netto';
  console.log('[ifirma] Price mode:', priceMode || 'brutto (default)');

  const Pozycje = pozycje.map(p => {
    const wariantSuffix = p.wariant && !p.nazwa.toLowerCase().includes(p.wariant.toLowerCase())
      ? ` - ${p.wariant}` : '';
    const isRealEan = p.ean && /^\d/.test(p.ean);
    const NazwaPelna = `${p.nazwa}${wariantSuffix}${isRealEan ? ` EAN ${p.ean}` : ''}`;
    const CenaJednostkowa = isNetto ? (p.cenaNetto || p.cena) : (p.cena || p.cenaNetto);
    console.log('[ifirma] position price:', CenaJednostkowa, isNetto ? '(netto)' : '(brutto)', p.isDelivery ? '(delivery)' : '');
    const isDelivery = !!p.isDelivery;
    const gtuCode = isDelivery ? 'GTU_13' : 'GTU_12';
    const Jednostka = isDelivery ? 'usł.' : 'szt.';
    const base = { GTU: gtuCode, Ilosc: p.ilosc, CenaJednostkowa, NazwaPelna, Jednostka };
    if (isWdt) {
      return { TypStawkiVat: 'NP', ...base };
    }
    return { StawkaVat: 0.23, TypStawkiVat: 'PRC', ...base };
  });

  const Kontrahent = {
    Nazwa: kontrahent.name,
    ...(_nip ? { NIP: _nip } : {}),
    ...(_ulica ? { Ulica: _ulica } : {}),
    ...(_kod ? { KodPocztowy: _kod } : {}),
    ...(_miasto ? { Miejscowosc: _miasto } : {}),
    // fakturakraj (tez w EUR) trzyma Kraj 'Polska' — bezpieczne dla iFirmy.
    // Tylko WDT (osobny endpoint) uzywa prawdziwego kraju kontrahenta.
    Kraj: isWdt ? (_country || '') : 'Polska',
  };

  const body = {
    Zaplacono: 0,
    ZaplaconoNaDokumencie: 0,
    WidocznyNumerGios: false,
    Numer: null,
    LiczOd: isNetto ? 'NET' : 'BRT',
    ...(_ifirmaId ? { IdentyfikatorKontrahenta: _ifirmaId } : {}),
    ...(_nip ? { NIPKontrahenta: _nip } : {}),
    DataWystawienia: today,
    MiejsceWystawienia: 'Warszawa',
    DataSprzedazy: today,
    FormatDatySprzedazy: 'DZN',
    TerminPlatnosci: new Date(Date.now() + (Number(paymentDays) > 0 ? Math.round(Number(paymentDays)) : 7) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    SposobZaplaty: 'PRZ',
    NazwaSeriiNumeracji: 'default',
    RodzajPodpisuOdbiorcy: 'BWO',
    // Jezyk: WDT -> en (+ prefiks UE). fakturawaluta (krajowa w EUR) tez wymaga
    // Jezyk i ODRZUCA 'pl' (to dokument dla zagranicznego klienta) -> 'en'
    // (dwujezyczny PL/EN), tak jak WDT.
    ...(isWdt ? { Jezyk: 'en', PrefiksUEKontrahenta: (_country || '').toUpperCase() }
      : isEur ? { Jezyk: 'en' } : {}),
    NumerKontaBankowego: isWdt ? 'PL67114020040000391213583952' : 'PL11114020040000300281459633',
    Kontrahent,
    Pozycje,
    ...((isWdt || isEur) ? {
      Waluta: 'EUR',
      KursWalutyZDniaPoprzedzajacegoDzienWystawieniaFaktury: await fetchNbpRate(today),
      // fakturawaluta obsluguje 2 typy (WYSYLKOWA / KRAJOWA) — dla nas krajowa
      // z cena w walucie obcej. To pole jest WYMAGANE na tym endpoincie.
      ...(isEur && !isWdt ? { KursWalutyWidoczny: true, TypSprzedazy: 'KRAJOWA' } : {}),
    } : {}),
  };

  const postOnce = async () => {
    const bodyStr = JSON.stringify(body);
    const auth = generateAuth(url, bodyStr, login, keyHex);
    console.log('[ifirma] creating invoice for', kontrahent.name);
    console.log('[ifirma] CREATE INVOICE URL:', url);
    console.log('[ifirma] CREATE INVOICE REQUEST BODY:', JSON.stringify(body, null, 2));
    return httpsPostJson(url, { Authentication: auth }, body);
  };

  let { status, body: resp } = await postOnce();
  let fullResp = JSON.stringify(resp);
  console.log('[ifirma] create invoice status:', status, fullResp.slice(0, 300));

  let kod = resp && resp.response && resp.response.Kod;
  let informacja = resp && resp.response && resp.response.Informacja;

  // Auto-retry: gdy iFirma odrzuca z powodu niezgodnego miesiąca/roku
  // księgowego (Kod 201 z komunikatem o "miesiącem i rokiem księgowym"),
  // przestawiamy miesiąc księgowy na ten z DataSprzedazy i ponawiamy raz.
  const isAccountingMonthError = (kod === 201 || kod === '201') &&
    typeof informacja === 'string' &&
    /miesi[aą]c.*ksi[eę]gow|rok.*ksi[eę]gow/i.test(informacja);

  if (isAccountingMonthError) {
    const [yyyy, mm] = (body.DataSprzedazy || today).split('-');
    const targetMonth = parseInt(mm, 10);
    const targetYear = parseInt(yyyy, 10);
    console.log(`[ifirma] Kod 201 miesiąc księgowy — próba przestawienia na ${targetYear}-${String(targetMonth).padStart(2, '0')} i retry`);
    try {
      await setAccountingMonth(targetMonth, targetYear);
      ({ status, body: resp } = await postOnce());
      fullResp = JSON.stringify(resp);
      kod = resp && resp.response && resp.response.Kod;
      informacja = resp && resp.response && resp.response.Informacja;
      console.log('[ifirma] retry create invoice status:', status, fullResp.slice(0, 300));
    } catch (e) {
      console.log('[ifirma] auto-retry przestawienia miesiąca nieudane:', e.message);
      throw Object.assign(
        new Error('iFirma error: ' + fullResp + ' (auto-fix miesiąca księgowego nieudany: ' + e.message + ')'),
        { ifirmaRaw: resp }
      );
    }
  }

  // Auto-retry: gdy iFirma odrzuca z powodu brakujacego pola kontrahenta
  // (Kod 201 z komunikatem "Pole 'Kontrahent.XXX' jest wymagane" — np.
  // KodPocztowy, Ulica, Miejscowosc). iFirma uzywa swojej zacachowanej
  // kopii rekordu kontrahenta (bo body ma IdentyfikatorKontrahenta), wiec
  // nawet jak my dajemy inline KodPocztowy, iFirma ignoruje. Fix: wymuszamy
  // upsertContractor (PUT na iFirma) z danymi ktore mamy, potem retry FV.
  //
  // Caller w invoices.js juz robi upsertContractor PRZED createInvoice, ale
  // ten retry obsluguje przypadki gdy: (a) tamten upsert padl cicho catchem,
  // (b) iFirma cache'owala stary rekord, (c) my mamy postCode tylko teraz.
  // iFirma raporruje brakujace pola kontrahenta na 2 sposoby (zalezy od endpointa):
  //   - createInvoice: "Pole 'Kontrahent.KodPocztowy' jest wymagane" (PascalCase)
  //   - upsertContractor PUT/POST: "Nieudana walidacja obiektu 'adres.kodPocztowy': Pole nie moze byc puste"
  // Lapie oba wzorce.
  const isContractorFieldError = (kod === 201 || kod === '201') &&
    typeof informacja === 'string' &&
    (/Pole.*['"]?Kontrahent\.[A-Za-z]+['"]?.*wymagan/i.test(informacja) ||
     /['"]?adres\.[a-zA-Z]+['"]?.*puste/i.test(informacja));

  if (isContractorFieldError && _nip) {
    const missingField = (informacja.match(/Kontrahent\.([A-Za-z]+)/) || [])[1] || 'unknown';
    console.log(`[ifirma] Kod 201 brakujace pole Kontrahent.${missingField} ("${informacja}") — auto-fix upsertContractor + retry`);
    try {
      const upRes = await upsertContractor({
        name: kontrahent.name,
        nip: _nip,
        address: _ulica,
        postCode: _kod,
        city: _miasto,
        country: _country || 'Polska',
        email: kontrahent.email,
        phone: kontrahent.phone,
        // KLUCZOWE: jak mamy iFirma Identyfikator (z body FV przez
        // IdentyfikatorKontrahenta), wymus PUT do tego konkretnego rekordu.
        // Inaczej searchContractor-by-NIP moze zwrocic empty (iFirma quirk) i
        // upsert pojdzie POST create -> duplikat NIP -> kolejny blad.
        identifier: _ifirmaId,
      });
      console.log(`[ifirma] auto-fix upsertContractor: ${upRes.action} id=${upRes.identifier}`);
      ({ status, body: resp } = await postOnce());
      fullResp = JSON.stringify(resp);
      kod = resp && resp.response && resp.response.Kod;
      informacja = resp && resp.response && resp.response.Informacja;
      console.log('[ifirma] retry create invoice (po contractor fix) status:', status, fullResp.slice(0, 300));
    } catch (e) {
      console.log('[ifirma] auto-fix upsertContractor padł:', e.message);
      throw Object.assign(
        new Error('iFirma error: ' + fullResp + ' (auto-fix kontrahenta nieudany: ' + e.message + ')'),
        { ifirmaRaw: resp }
      );
    }
  }

  if (status !== 200 || (kod != null && kod !== 0)) {
    console.log('[ifirma] API error:', fullResp);
    throw Object.assign(new Error('iFirma error: ' + fullResp), { ifirmaRaw: resp });
  }

  const r1 = resp.response || {};
  const wynik = r1.Wynik || resp.Wynik || {};
  const invoiceNumber = wynik.PelnyNumer || wynik.Numer || r1.PelnyNumer || r1.Numer || null;
  const ifirmaId = wynik.FakturaId || wynik.Identyfikator || r1.Identyfikator || r1.FakturaId || null;
  if (!invoiceNumber || !ifirmaId) {
    console.log('[ifirma] createInvoice: missing fields after parse — invoiceNumber=' + invoiceNumber + ', ifirmaId=' + ifirmaId + ', raw=', JSON.stringify(resp).slice(0, 1000));
  }
  return { ok: true, invoiceNumber, ifirmaId, ifirmaRaw: resp };
}

async function fetchInvoicePdf(pelnyNumer, rodzaj, fakturaId) {
  if (!login || !keyHex) throw new Error('IFIRMA_USER or IFIRMA_API_KEY not set');

  const r = (rodzaj || '').toLowerCase();
  let primary;
  if (r === 'prz_eksport_towarow' || r === 'eksport' || r.includes('eksport')) {
    primary = 'fakturaeksporttowarow';
  } else if (r === 'prz_faktura_proforma' || r.includes('proforma')) {
    primary = 'fakturaproforma';
  } else if (r === 'prz_dostawa_ue_towarow' || r === 'wdt' || r.includes('dostawa_ue') || r.includes('wdt')) {
    primary = 'fakturawdt';
  } else {
    primary = 'fakturakraj';
  }

  const numerUrl = (pelnyNumer && pelnyNumer !== 'UNKNOWN') ? pelnyNumer.replace(/\//g, '_') : null;

  // Typ dokumentu z metadanych (ifirmaType/type) bywa niepewny po synchronizacji,
  // a iFirma w URL .pdf akceptuje raz FakturaId, raz numer — zaleznie od typu.
  // Probujemy roznych ENDPOINTOW x IDENTYFIKATOROW i bierzemy pierwszy, ktory
  // zwroci PRAWDZIWY pdf (magia %PDF — iFirma na blad potrafi oddac 200+JSON).
  const endpoints = [...new Set([primary, 'fakturawaluta', 'fakturawdt', 'fakturakraj', 'fakturaeksporttowarow'])];
  const ids = [...new Set([fakturaId, numerUrl].filter(Boolean).map(String))];
  if (!ids.length) throw new Error('iFirma PDF: brak identyfikatora (FakturaId/numer)');

  let lastErr = 'brak prob';
  for (const ep of endpoints) {
    for (const id of ids) {
      const url = `https://www.ifirma.pl/iapi/${ep}/${id}.pdf`;
      const auth = generateAuth(url, '', login, keyHex);
      const { status, body } = await httpsGetRaw(url, {
        Authentication: auth,
        Accept: 'application/pdf',
      });
      const isPdf = status === 200 && body && body.slice(0, 5).toString('latin1').startsWith('%PDF');
      if (isPdf) {
        console.log(`[ifirma] PDF OK: ${ep}/${id}`);
        return body;
      }
      lastErr = `${ep}/${id} -> status ${status}${status === 200 ? ' (nie-PDF)' : ''}`;
      console.log(`[ifirma] PDF proba ${lastErr}`);
    }
  }
  throw new Error('iFirma PDF error: ' + lastErr);
}

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

  return (data.response && data.response.Wynik) || (data.response) || data;
}

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

async function getAccountingMonth(keyOverride) {
  const k = (keyOverride || keyHexAbonent || '').trim();
  if (!login || !k) throw new Error('login or key missing');
  const url = 'https://www.ifirma.pl/iapi/abonent/miesiacksiegowy.json';
  const auth = generateAuthAbonent(url, '', login, k);
  const { status, body } = await httpsGetRaw(url, { Authentication: auth, Accept: 'application/json' });
  return { status, body: JSON.parse(body.toString()) };
}

async function trySetAccountingMonth(direction, crossYear, keyOverride) {
  const k = (keyOverride || keyHexAbonent || '').trim();
  if (!login || !k) throw new Error('login or key missing');
  const url = 'https://www.ifirma.pl/iapi/abonent/miesiacksiegowy.json';
  const body = { MiesiacKsiegowy: direction };
  if (crossYear) body.PrzeniesDaneZPoprzedniegoRoku = true;
  const bodyStr = JSON.stringify(body);
  const auth = generateAuthAbonent(url, bodyStr, login, k);
  const { status, body: resp } = await httpsPutJson(url, { Authentication: auth }, body);
  return { status, body: resp, bodySent: body };
}

module.exports = {
  generateAuth, fetchInvoices, fetchNbpRate, searchContractor, upsertContractor,
  createInvoice, fetchInvoicePdf, fetchInvoiceDetails, deleteInvoice,
  registerPayment, setAccountingMonth,
  getAccountingMonth, trySetAccountingMonth,
};
