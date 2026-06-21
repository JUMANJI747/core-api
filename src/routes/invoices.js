'use strict';

const router = require('express').Router();
const { fetchInvoices: fetchIfirmaInvoices, createInvoice, fetchInvoicePdf, fetchInvoiceDetails, registerPayment, searchContractor, upsertContractor } = require('../ifirma-client');
const { buildIfirmaContractorPayload } = require('../services/ifirma-payload');
const { backfillInvoiceItems } = require('../services/invoice-backfill');
const { sendMail, getAccounts } = require('../mail-sender');
const { sendTelegram, sendTelegramDocument } = require('../telegram-utils');
const { notifyMailResult } = require('../services/notify-mail-result');
const { invoicePreviews, savePreview, getPreview } = require('../stores');
const { findBestContractors } = require('../services/contractor-match');
const { getActiveCatalog } = require('../services/product-catalog');
const { processIfirmaInvoices, computeSyncWindow } = require('../services/ifirma-sync');
const { buildPlLinesFromPozycje, resolveProductIdByEan } = require('../services/invoice-lines-backfill');
const { runBackfill: runIfirmaLinesBackfill } = require('../services/invoice-lines-from-ifirma-backfill');
const { fetchWithTimeout } = require('../http');
const { verifyVat } = require('../vies');

// IDEMPOTENCJA wystawiania FV: jeden previewId => jedna faktura. Tap w guzik
// "Akceptuj" (callback) albo "tak" przychodzil kilka razy / rownolegle, a iFirma
// jest wolna — bez blokady KAZDE wywolanie tworzylo NOWA fakture (incydent: 4 FV
// z jednego podgladu). _confirming = w toku (rownolegle odrzucamy), _confirmed =
// juz wystawione (zwracamy TEN SAM numer zamiast duplikatu).
const _confirmingPreviews = new Set();
const _confirmedPreviews = new Map(); // previewId -> { invoiceNumber, invoiceId, ifirmaId, at }
const CONFIRM_DEDUP_TTL_MS = 30 * 60 * 1000;
function sweepConfirmedPreviews() {
  const now = Date.now();
  for (const [k, v] of _confirmedPreviews) if (now - v.at > CONFIRM_DEDUP_TTL_MS) _confirmedPreviews.delete(k);
}

// Zywe zamowienia z GlobKuriera — zrodlo prawdy dla statusu wysylki na fakturach
// (matchujemy fakture do zamowienia GK po nazwie odbiorcy + dacie, NIE przez
// krucha warstwe Transakcji/dealow). Cache 5 min: swieze -> serwuj; przeterminowane
// -> serwuj stare + odswiez w tle; PUSTE -> zablokuj raz (pierwsze ladowanie),
// zeby feature dzialal od razu, a nie dopiero po rozgrzaniu.
let _gkCache = { at: 0, orders: [] };
let _gkPromise = null;
function refreshGkOrders() {
  if (_gkPromise) return _gkPromise;
  _gkPromise = (async () => {
    try {
      const { getOrders } = require('../glob-client');
      const orders = [];
      for (let page = 0; page < 6; page++) {
        const body = await getOrders({ limit: 100, offset: page * 100 });
        const arr = Array.isArray(body) ? body : (body && (body.results || body.items || body.data)) || [];
        if (!arr.length) break;
        for (const o of arr) {
          const num = o.number || o.orderNumber;
          if (!num) continue;
          const recv = o.receiverAddress || o.receiver || {};
          const carrier = (o.carrier && typeof o.carrier === 'object') ? (o.carrier.name || '') : (o.carrier || '');
          orders.push({
            number: String(num),
            status: o.status || o.statusName || null,
            carrier,
            receiverName: recv.companyName || recv.name || recv.contactPerson || '',
            date: o.creationDate || o.created_at || o.createdAt || null,
            tracking: o.trackingNumber || o.tracking || null,
          });
        }
        if (arr.length < 100) break;
      }
      _gkCache = { at: Date.now(), orders };
      console.log(`[invoices] GK orders odswiezone: ${orders.length}`);
    } catch (e) {
      console.error('[invoices] GK orders refresh failed (best-effort):', e.message);
    } finally {
      _gkPromise = null;
    }
  })();
  return _gkPromise;
}
async function getGkOrders() {
  const stale = Date.now() - _gkCache.at > 5 * 60 * 1000;
  if (_gkCache.orders.length && !stale) return _gkCache.orders;
  if (_gkCache.orders.length && stale) { refreshGkOrders(); return _gkCache.orders; } // serwuj stare, odswiez w tle
  // pusty cache -> blokuj raz, ale z limitem 8s (GK nie moze zawiesic strony faktur)
  await Promise.race([refreshGkOrders(), new Promise(r => setTimeout(r, 8000))]);
  return _gkCache.orders;
}
// Po zamowieniu kuriera (glob/order) wstrzykujemy nowy list DO cache od razu, by
// faktura pokazala status wysylki natychmiast po odswiezeniu — bez czekania na
// 5-min TTL (to bylo zrodlo "guzik Kurier zamiast statusu" tuz po zamowieniu).
// Dodatkowo odpalamy refresh w tle, zeby dociagnac autorytatywne dane z GK.
function addGkOrderToCache(o) {
  if (!o || !o.number) return;
  const number = String(o.number);
  if (!_gkCache.orders.some(x => x.number === number)) {
    _gkCache.orders.unshift({
      number,
      status: o.status || 'NEW',
      carrier: o.carrier || '',
      receiverName: o.receiverName || '',
      date: o.date || new Date().toISOString(),
      tracking: o.tracking || null,
    });
  }
  refreshGkOrders();
}
// Rozgrzej na starcie procesu.
refreshGkOrders();

// Sync write: po Invoice.create budujemy InvoiceLineItem z preview pozycji.
// Tym samym builderem co backfill — jeden zrodlo prawdy. Best-effort, nie
// rzucamy bo glowna sciezka (create FV + send Telegram) jest wazniejsza.
async function createInvoiceLineItems(prisma, invoice, pozycje) {
  if (!invoice || !Array.isArray(pozycje) || pozycje.length === 0) return;
  try {
    const stub = {
      currency: invoice.currency,
      grossAmount: invoice.grossAmount,
    };
    // pozycje shape z confirm-flow: {ean, nazwa, ilosc, cena, wariant?}.
    // builder oczekuje {ean, nazwa, ilosc, pricePLN|priceEUR}.
    const mapped = pozycje.map(p => ({
      ean: p.ean,
      nazwa: p.nazwa,
      ilosc: p.ilosc,
      pricePLN: invoice.currency === 'PLN' ? p.cena : undefined,
      priceEUR: invoice.currency !== 'PLN' ? p.cena : undefined,
    }));
    const lines = buildPlLinesFromPozycje(stub, mapped);
    const productCache = new Map();
    const records = [];
    for (const l of lines) {
      const productId = await resolveProductIdByEan(prisma, l.ean, productCache);
      records.push({
        invoiceId: invoice.id,
        productId,
        ean: l.ean,
        name: l.name,
        unit: l.unit,
        qty: l.qty,
        unitPriceNetto: l.unitPriceNetto,
        vatRate: l.vatRate,
        vatAmount: l.vatAmount,
        totalNetto: l.totalNetto,
        totalGross: l.totalGross,
        currency: invoice.currency || 'PLN',
        contractorId: invoice.contractorId,
        contractorCountry: invoice.contractorCountry,
        issueDate: invoice.issueDate,
        ifirmaLineId: null,
        position: l.position,
        extras: { ...l.extras, source: 'invoice-confirm' },
      });
    }
    if (records.length) {
      await prisma.invoiceLineItem.createMany({ data: records });
    }
  } catch (e) {
    console.error('[invoice-confirm] createInvoiceLineItems failed:', e.message);
  }
}

const CENNIK = {
  PLN: {
    default: 18,
    wyjatki: {
      'Super -Pharm Holding': 16.10,
      'Nordsøen Designs': 13.32,
    },
  },
  EUR: {
    default: 4.50,
    wyjatki: {
      'Nuno Viegas Costa': 3.00,
      'Sirena Sardinia': 3.00,
    },
  },
};

// Country detection — centralizowane w services/country-helper.js (commit B).
// Re-export pod starymi nazwami żeby reszta pliku działała bez zmian.
const _country = require('../services/country-helper');
const EU_VAT_PREFIXES = _country.EU_VAT_PREFIXES;
const COUNTRY_NAME_TO_CODE = _country.COUNTRY_NAME_TO_ISO;
const LEGAL_FORM_TO_COUNTRY = _country.LEGAL_FORM_TO_COUNTRY;
const normalizeIso = _country.normalizeIso;
const nipPrefixToCountry = _country.nipPrefixToCountry;


// Prosta derywacja kraju — TYLKO mocne, niepodważalne sygnały. Nie używamy
// historii faktur (pojedyncza pomyłka EUR oznaczałaby PL klienta jako EU
// na zawsze) ani wzorca NIP / sufiksu nazwy (false positives na polskich
// nazwach jak "sp.k."). Trzy źródła w kolejności pewności:
// 1. contractor.country znormalizowany do ISO-2
// 2. NIP z prefiksem UE (ES36..., DE12..., etc.)
// 3. extras.billingAddress.country znormalizowany do ISO-2
async function deriveCountry(contractor) {
  const explicit = normalizeIso(contractor.country);
  if (explicit) return { country: explicit, source: 'contractor.country' };
  const fromPrefix = nipPrefixToCountry(contractor.nip);
  if (fromPrefix) return { country: fromPrefix, source: 'nip_prefix' };
  const billing = contractor.extras && contractor.extras.billingAddress;
  const fromBilling = billing ? normalizeIso(billing.country) : null;
  if (fromBilling) return { country: fromBilling, source: 'extras.billingAddress' };
  return { country: null, source: null };
}

// ============ IFIRMA SYNC ============

// Wspolny rdzen wszystkich syncow iFirmy: pobierz FV z okna [dataOd, dataDo]
// i przepusc przez processIfirmaInvoices. Roznice per-endpoint (okno, throttle,
// timeout race, dryRun, silent) zostaja w handlerach — tu tylko fetch+process
// (wczesniej skopiowane w 4 miejscach).
async function runIfirmaSync(prisma, { dataOd, dataDo, dryRun = false, silent = false }) {
  const invoices = await fetchIfirmaInvoices({ dataOd, dataDo });
  const result = await processIfirmaInvoices(invoices, prisma, { dataOd, dataDo, dryRun, silent });
  return { fetched: invoices.length, ...result };
}

router.post('/ifirma/sync', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    let { year, month, dryRun } = req.body || {};
    const now = new Date();

    // Reject hallucinated year values (agent sometimes sends 2024 when current is 2026)
    if (year && (year < now.getFullYear() - 2 || year > now.getFullYear() + 1)) {
      console.log('[ifirma-sync] Invalid year from agent:', year, '- using current:', now.getFullYear());
      year = now.getFullYear();
    }

    const y = year || now.getFullYear();
    const m = month || (now.getMonth() + 1);

    const dataOd = `${y}-${String(m).padStart(2, '0')}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const dataDo = `${y}-${String(m).padStart(2, '0')}-${lastDay}`;

    const result = await runIfirmaSync(prisma, { dataOd, dataDo, dryRun: dryRun || false });
    res.json({ ok: true, period: `${y}-${String(m).padStart(2, '0')}`, dryRun: dryRun || false, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cichy, throttlowany sync iFirmy odpalany przy WEJSCIU na Faktury (Polska).
// BEZ powiadomien Telegram (silent), okno 60 dni, throttle 60s (Config) zeby
// nie bic w iFirme przy kazdym odswiezeniu. Zawsze 200 (blad nie psuje strony).
router.post('/ifirma/autosync', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const KEY = 'autosync:ifirma:lastRunAt';
  const THROTTLE_MS = 60 * 1000;
  try {
    const cfg = await prisma.config.findUnique({ where: { key: KEY } }).catch(() => null);
    const ageMs = cfg ? Date.now() - new Date(cfg.value).getTime() : Infinity;
    if (ageMs < THROTTLE_MS) return res.json({ ok: true, throttled: true, ageMs });
    // Ustaw znacznik OD RAZU, by rownolegle wejscia nie odpalily kilku syncow.
    const nowIso = new Date().toISOString();
    await prisma.config.upsert({ where: { key: KEY }, update: { value: nowIso }, create: { key: KEY, value: nowIso } }).catch(() => {});

    // Autosync (przy wejsciu na Faktury) = LEKKO: tylko biezacy miesiac.
    // Platnosci na starszych FV domyka szersze okno w cronie + pelny sync.
    const now = new Date();
    const dataDo = nowIso.slice(0, 10);
    const dataOd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const work = runIfirmaSync(prisma, { dataOd, dataDo, dryRun: false, silent: true });
    const result = await Promise.race([
      work,
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 15000)),
    ]);
    res.json({ ok: true, throttled: false, ...result });
  } catch (e) {
    console.error('[ifirma/autosync]', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// Jednorazowy PELNY sync z iFirmy (domyslnie od poczatku biezacego roku).
// Aktualizuje paidAmount/status/kwoty wszystkich FV w zakresie — uzyj raz, by
// wyrownac stan (np. stare FV oplacone pozno). Override dataOd/dataDo w body.
router.post('/ifirma/sync-full', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const body = req.body || {};
    const dataDo = body.dataDo || new Date().toISOString().slice(0, 10);
    const dataOd = body.dataOd || `${new Date().getUTCFullYear()}-01-01`;
    console.log(`[ifirma/sync-full] ${dataOd} -> ${dataDo}`);
    const result = await runIfirmaSync(prisma, { dataOd, dataDo, dryRun: false, silent: true });
    res.json({ ok: true, dataOd, dataDo, ...result });
  } catch (e) {
    console.error('[ifirma/sync-full]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/ifirma/sync/preview', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const now = new Date();
    let y = parseInt(req.query.year) || now.getFullYear();
    if (y < now.getFullYear() - 2 || y > now.getFullYear() + 1) {
      console.log('[ifirma-sync-preview] Invalid year:', y, '- using current:', now.getFullYear());
      y = now.getFullYear();
    }
    const m = parseInt(req.query.month) || (now.getMonth() + 1);

    const dataOd = `${y}-${String(m).padStart(2, '0')}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const dataDo = `${y}-${String(m).padStart(2, '0')}-${lastDay}`;

    const result = await runIfirmaSync(prisma, { dataOd, dataDo, dryRun: true });
    res.json({ ok: true, period: `${y}-${String(m).padStart(2, '0')}`, dryRun: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/ifirma/invoices', async (req, res) => {
  try {
    const { dataOd, dataDo, status, nipKontrahenta } = req.query;
    const invoices = await fetchIfirmaInvoices({ dataOd, dataDo, status, nipKontrahenta });
    res.json(invoices);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ FUZZY PRODUCT LOOKUP ============

function findProductFuzzy(catalog, query) {
  if (!query) return null;

  const normalize = s => (s || '').toString().toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

  const q = normalize(query);
  if (!q) return null;

  // 0. EAN match — case-insensitive, with/without hyphens (e.g. "stick generic" → "STICK-GENERIC")
  const eanInput = query.toString().trim().toUpperCase().replace(/\s+/g, '-');
  const byEanCI = catalog.find(p => p.ean.toUpperCase() === eanInput);
  if (byEanCI) return byEanCI;
  const noHyphen = eanInput.replace(/-/g, '');
  const byEanNoHyphen = catalog.find(p => p.ean.toUpperCase().replace(/-/g, '') === noHyphen);
  if (byEanNoHyphen) return byEanNoHyphen;

  // 1. Exact EAN/SKU
  const byEan = catalog.find(p => p.ean === query.toString());
  if (byEan) return byEan;

  // 2. Exact name+variant match
  const byExact = catalog.find(p => {
    const nv = normalize((p.name || '') + ' ' + (p.variant || ''));
    return nv === q;
  });
  if (byExact) return byExact;

  // 3. All query words contained in name+variant
  // Generic vs kolorowy: aktualizacja regulu zeby "stick" bez koloru poszedl
  // do GENERIC, a "stick blue" do konkretnego koloru. Wczesniejszy filter
  // (!ean.startsWith('STICK-')) wyrzucal wszystko, bo WSZYSTKIE sticki maja
  // prefix STICK- (generic i kolorowe).
  const COLOR_WORDS = ['blue', 'pink', 'purple', 'mint', 'white', 'skin', 'black', 'red', 'green', 'yellow'];
  const words = q.split(' ').filter(w => w.length > 1);
  const queryHasColor = words.some(w => COLOR_WORDS.includes(w));
  const candidates = catalog.filter(p => {
    const nv = normalize((p.name || '') + ' ' + (p.variant || ''));
    return words.every(w => nv.includes(w));
  });

  if (candidates.length === 1) return candidates[0];

  if (candidates.length > 1) {
    const isGeneric = c => /generic/i.test((c.ean || '') + ' ' + (c.name || '') + ' ' + (c.variant || ''));
    let pool;
    if (queryHasColor) {
      // Query "stick blue" -> preferuj kolorowy (non-generic)
      const colored = candidates.filter(c => !isGeneric(c));
      pool = colored.length ? colored : candidates;
    } else {
      // Query "stick" bez koloru -> preferuj generic
      const generics = candidates.filter(c => isGeneric(c));
      pool = generics.length ? generics : candidates;
    }
    pool.sort((a, b) => {
      const nvA = normalize((a.name || '') + ' ' + (a.variant || ''));
      const nvB = normalize((b.name || '') + ' ' + (b.variant || ''));
      return nvA.length - nvB.length;
    });
    return pool[0];
  }

  return null;
}

// ============ INVOICE PREVIEW ============

router.post('/ifirma/invoice-preview', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { contractorId, contractorSearch, items, globalPriceNetto, globalPriceBrutto } = req.body;
    let parsedItems = items;
    if (typeof items === 'string') {
      try { parsedItems = JSON.parse(items); } catch(e) { return res.status(400).json({ error: 'items must be valid JSON array' }); }
    }
    if (!parsedItems || !parsedItems.length) return res.status(400).json({ error: 'items required' });
    console.log('[invoice-preview] parsed items:', JSON.stringify(parsedItems));

    let contractor;
    if (contractorId) {
      contractor = await prisma.contractor.findUnique({ where: { id: contractorId } });
    } else if (contractorSearch) {
      const scored = await findBestContractors(prisma, contractorSearch);

      const best = scored[0];
      console.log(`[invoice-preview] contractor match: "${contractorSearch}" → "${best ? best.contractor.name : 'none'}" (score: ${best ? best.score : 0})`);

      if (best && best.score >= 50) {
        contractor = await prisma.contractor.findUnique({ where: { id: best.contractor.id } });
      } else {
        const suggestions = scored.slice(0, 5).map(x => ({ id: x.contractor.id, name: x.contractor.name, score: x.score }));
        return res.json({ ok: false, suggestions });
      }
    }
    if (!contractor) return res.status(404).json({ error: 'contractor not found' });

    // Cascading address lookup if contractor has no address
    const hasAddress = contractor.address || contractor.city ||
      (contractor.extras && contractor.extras.billingAddress && (contractor.extras.billingAddress.street || contractor.extras.billingAddress.city)) ||
      (contractor.extras && contractor.extras.street);

    if (!hasAddress && contractor.nip) {
      console.log('[invoice-preview] No address for', contractor.name, '- looking up...');
      let foundAddress = null;

      // STEP 1: iFirma searchContractor by NIP
      try {
        const cleanNip = contractor.nip.replace(/[\s.-]/g, '');
        const ifirmaResult = await searchContractor(cleanNip);
        if (ifirmaResult && (ifirmaResult.Ulica || ifirmaResult.Miejscowosc)) {
          foundAddress = {
            street: ((ifirmaResult.Ulica || '') + ' ' + (ifirmaResult.NumerDomu || '')).trim(),
            city: ifirmaResult.Miejscowosc || '',
            postCode: ifirmaResult.KodPocztowy || '',
            country: ifirmaResult.Kraj || ifirmaResult.KrajKod || '',
            source: 'ifirma',
          };
          console.log('[invoice-preview] Address from iFirma:', JSON.stringify(foundAddress));
        }
      } catch (err) {
        console.log('[invoice-preview] iFirma search failed:', err.message);
      }

      // STEP 2: VIES fallback
      if (!foundAddress) {
        try {
          const clean = contractor.nip.replace(/[\s.-]/g, '').toUpperCase();
          const m = clean.match(/^([A-Z]{2})(.+)$/);
          const countryCode = m ? m[1] : (contractor.country || 'PL');
          const vatNumber = m ? m[2] : clean;

          const viesRes = await fetchWithTimeout('https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ countryCode, vatNumber }),
          }, 20000);
          const viesData = await viesRes.json();

          if (viesData.valid && viesData.address) {
            const addrParts = viesData.address.split('\n').map(s => s.trim()).filter(Boolean);
            const street = addrParts[0] || '';
            const cityLine = addrParts[addrParts.length - 1] || '';
            const postMatch = cityLine.match(/(\d{4,5}[\s-]?\w*)/);
            const postCode = postMatch ? postMatch[1].trim() : '';
            const city = cityLine.replace(postMatch ? postMatch[1] : '', '').trim();
            foundAddress = { street, city, postCode, country: countryCode, source: 'vies' };
            if (viesData.name) foundAddress.companyName = viesData.name;
            console.log('[invoice-preview] Address from VIES:', JSON.stringify(foundAddress));
          }
        } catch (err) {
          console.log('[invoice-preview] VIES lookup failed:', err.message);
        }
      }

      // STEP 3: Save to contractor extras for future use
      if (foundAddress) {
        try {
          const currentExtras = (typeof contractor.extras === 'object' && contractor.extras) ? contractor.extras : {};
          await prisma.contractor.update({
            where: { id: contractor.id },
            data: { extras: { ...currentExtras, billingAddress: foundAddress } },
          });
          console.log('[invoice-preview] Saved address to contractor', contractor.name);
          contractor = await prisma.contractor.findUnique({ where: { id: contractor.id } });
        } catch (err) {
          console.log('[invoice-preview] Failed to save address:', err.message);
        }
      } else {
        console.log('[invoice-preview] No address found in iFirma or VIES for', contractor.name);
      }
    }

    const derived = await deriveCountry(contractor);
    const effectiveCountry = derived.country || 'PL';
    const waluta = effectiveCountry === 'PL' ? 'PLN' : 'EUR';
    let rodzaj = waluta === 'EUR' ? 'wdt' : 'krajowa';

    // Per-kontrahent override: klient z UE bez aktywnego VIES (np. stowarzyszenie)
    // — na zyczenie usera wystawiamy NORMALNA FV z VAT 23% (krajowa), nie WDT 0%.
    // Flaga: contractor.extras.vatMode === 'domestic'. Waluta zostaje EUR.
    const _cExtras = (typeof contractor.extras === 'object' && contractor.extras) ? contractor.extras : {};
    if (_cExtras.vatMode === 'domestic' && rodzaj === 'wdt') {
      rodzaj = 'krajowa';
      console.log(`[invoice-preview] vatMode=domestic → wymuszam krajowa VAT 23% (waluta ${waluta}) dla ${contractor.name}`);
    }

    // VIES fresh check przed WDT — blokuje TYLKO gdy NIP na pewno nieaktywny.
    // Gdy VIES niedostepny/limit (status 'unknown') NIE blokujemy — to czesty
    // falszywy negatyw (zwlaszcza FR/ES) i blokowalby waznych klientow.
    if (rodzaj === 'wdt' && contractor.nip) {
      try {
        const nip = contractor.nip.replace(/[\s-]/g, '').toUpperCase();
        const cc = nip.slice(0, 2);
        const num = nip.slice(2);
        if (cc.length === 2 && /^[A-Z]{2}$/.test(cc)) {
          const vies = await verifyVat(cc, num);
          if (vies.status === 'invalid') {
            return res.status(400).json({
              error: `VIES: NIP ${nip} nieaktywny w VIES. Nie mozna wystawic WDT 0%. Sprawdz NIP kontrahenta.`,
              vies: { vatNumber: nip, valid: false, name: vies.name || null },
            });
          }
          if (vies.status === 'unknown') {
            console.warn(`[invoice-preview] VIES niedostepny dla ${nip} (${vies.userError}) — nie blokuje WDT`);
          }
        }
      } catch (viesErr) {
        console.warn('[invoice-preview] VIES check failed (non-blocking):', viesErr.message);
      }
    }

    // Auto-persist znormalizowanego ISO-2 gdy w bazie był pełny tekst
    // ("Polska"/"Hiszpania") albo pusto a wykryliśmy non-PL przez NIP.
    // Robimy update tylko gdy nowa wartość różni się od obecnej.
    if (effectiveCountry && contractor.country !== effectiveCountry) {
      try {
        await prisma.contractor.update({
          where: { id: contractor.id },
          data: { country: effectiveCountry },
        });
        contractor = { ...contractor, country: effectiveCountry };
        console.log(`[invoice-preview] normalize country: ${derived.source} → ${effectiveCountry} on ${contractor.name}`);
      } catch (e) {
        console.error('[invoice-preview] persist country failed:', e.message);
      }
    }
    console.log(`[invoice-preview] country=${effectiveCountry} (source=${derived.source || 'default_PL'}) → waluta=${waluta} rodzaj=${rodzaj}`);

    // Load product catalog for fuzzy lookup (cache z TTL — patrz product-catalog.js)
    const catalog = await getActiveCatalog(prisma);

    const pozycje = [];
    // Match delivery / shipping line items (not in product catalog) so the
    // agent can say "dodaj delivery za 18 EUR" without us inventing an
    // imaginary catalog entry. Trigger: explicit type='delivery'/'shipping'
    // OR name starts with one of the keywords below. Must have a price set.
    const DELIVERY_RE = /^(delivery|dostawa|wysy[lł]ka|shipping|transport|fracht)\b/i;
    function isDeliveryItem(item) {
      const t = String(item.type || '').toLowerCase();
      if (t === 'delivery' || t === 'shipping' || t === 'dostawa') return true;
      const name = item.name || item.productName || item.product || '';
      return DELIVERY_RE.test(String(name).trim());
    }

    for (const item of parsedItems) {
      // Delivery / shipping line — skip catalog, build pozycja directly.
      if (isDeliveryItem(item)) {
        const rawPrice = item.priceNetto != null ? item.priceNetto
          : (item.priceBrutto != null ? item.priceBrutto
          : (item.price != null ? item.price : item.cena));
        if (rawPrice == null) {
          return res.status(400).json({ error: `delivery line "${item.name || 'delivery'}" requires price (price / priceNetto / priceBrutto)` });
        }
        const itemCenaNetto = item.priceNetto != null ? parseFloat(item.priceNetto) : null;
        const itemCena = (item.priceBrutto != null || item.price != null || item.cena != null)
          ? parseFloat(item.priceBrutto || item.price || item.cena) : null;
        // Synthetic product so the downstream code keeps working unchanged.
        const fakeProduct = { ean: null, name: item.name || 'Delivery', variant: null, category: 'delivery' };
        pozycje.push({ product: fakeProduct, ilosc: item.qty || 1, itemCena, itemCenaNetto, isDelivery: true });
        console.log(`[invoice-preview] delivery line: "${fakeProduct.name}" × ${item.qty || 1} @ ${itemCenaNetto != null ? itemCenaNetto + ' netto' : itemCena + ' brutto'}`);
        continue;
      }

      // Fuzzy product lookup: try EAN first, then name+variant
      const ean = item.productEan || item.ean;
      let product = null;

      if (ean) {
        product = catalog.find(p => p.ean === ean);
      }

      if (!product) {
        const query = [item.name, item.productName, item.product, item.variant, item.color]
          .filter(Boolean).join(' ');
        if (query) product = findProductFuzzy(catalog, query);
      }

      if (!product && ean) {
        // Last resort: try findUnique by EAN (maybe not in catalog query)
        product = await prisma.product.findUnique({ where: { ean } });
      }

      if (!product) {
        const searchedFor = ean || item.name || item.productName || item.product || 'unknown';
        return res.status(404).json({ error: `product not found: ${searchedFor}` });
      }

      console.log('[invoice-preview] Matched:', (item.name || item.productName || ean), '→', product.name, product.variant || '', '(EAN:', product.ean, ')');

      if (product.category === 'template' && product.extras && product.extras.composition) {
        for (const comp of product.extras.composition) {
          const sub = await prisma.product.findUnique({ where: { ean: comp.ean } });
          if (sub) pozycje.push({ product: sub, ilosc: comp.qty * (item.qty || 1), itemCena: null });
        }
      } else {
        // Resolve per-item price override
        let itemCena = null;
        let itemCenaNetto = null;
        let priceSource = null;

        if (item.priceNetto != null) {
          itemCenaNetto = parseFloat(item.priceNetto);
          priceSource = 'netto_override';
        } else if (item.priceBrutto != null || item.price != null) {
          itemCena = parseFloat(item.priceBrutto || item.price);
          priceSource = 'brutto_override';
        } else if (item.cena != null) {
          itemCena = parseFloat(item.cena);
          priceSource = 'cena_override';
        } else if (globalPriceNetto != null) {
          itemCenaNetto = parseFloat(globalPriceNetto);
          priceSource = 'global_netto';
        } else if (globalPriceBrutto != null) {
          itemCena = parseFloat(globalPriceBrutto);
          priceSource = 'global_brutto';
        }

        if (priceSource) {
          console.log(`[invoice-preview] Price override for ${product.name}: netto=${itemCenaNetto} brutto=${itemCena} (${priceSource})`);
        }

        pozycje.push({ product, ilosc: item.qty || 1, itemCena, itemCenaNetto });
      }
    }

    const cennikWaluta = CENNIK[waluta] || CENNIK.PLN;
    const resolvePrice = (itemCena, itemCenaNetto, contractorName, contractorExtras) => {
      if (itemCenaNetto != null) return { cena: itemCenaNetto, isNetto: true, source: 'user_netto' };
      if (itemCena != null) return { cena: itemCena, isNetto: false, source: 'user' };
      if (contractorExtras && contractorExtras.lastPrice != null) {
        return { cena: contractorExtras.lastPrice, isNetto: false, source: 'lastPrice' };
      }
      const nameNorm = (contractorName || '').toLowerCase();
      // Konwencja cennika per waluta: EUR = ceny NETTO (B2B, VAT dolicza się na
      // fakturze krajowej 23%), PLN = ceny BRUTTO (tak umawiane krajowo).
      // (Wcześniej EUR błędnie liczone jako brutto → 8×45 EUR pokazywało 360
      //  brutto zamiast 360 netto + 82,80 VAT.)
      const catalogIsNetto = waluta === 'EUR';
      for (const [key, val] of Object.entries(cennikWaluta.wyjatki)) {
        if (nameNorm.includes(key.toLowerCase())) return { cena: val, isNetto: catalogIsNetto, source: 'wyjątek' };
      }
      return { cena: cennikWaluta.default, isNetto: catalogIsNetto, source: 'default' };
    };

    const linee = pozycje.map(({ product: p, ilosc, itemCena, itemCenaNetto, isDelivery }) => {
      const { cena, isNetto, source } = resolvePrice(itemCena, itemCenaNetto, contractor.name, contractor.extras);
      console.log(`[invoice-preview] price for ${contractor.name}: ${cena} ${isNetto ? 'netto' : 'brutto'} (source: ${source})`);
      const wartosc = Math.round(cena * ilosc * 100) / 100;
      return { ean: p.ean, nazwa: p.name, wariant: p.variant || null, ilosc, cena, cenaNetto: isNetto ? cena : null, wartosc, priceSource: source, isDelivery: !!isDelivery };
    });

    // Price mode z REALNYCH linii: 'brutto' tylko gdy WSZYSTKIE linie są brutto
    // (override brutto / lastPrice). Cennik/wyjątek/netto-override = netto.
    // Steruje i podglądem, i createInvoice (iFirma) — więc poprawia obie strony.
    const priceMode = (linee.length && linee.every(l => l.cenaNetto == null)) ? 'brutto' : 'netto';
    console.log(`[invoice-preview] Price mode: ${priceMode}`);

    let brutto, netto, vat;
    if (priceMode === 'netto' && rodzaj === 'krajowa') {
      netto = Math.round(linee.reduce((s, l) => s + l.wartosc, 0) * 100) / 100;
      vat = Math.round(netto * 0.23 * 100) / 100;
      brutto = Math.round((netto + vat) * 100) / 100;
    } else if (rodzaj === 'wdt') {
      netto = Math.round(linee.reduce((s, l) => s + l.wartosc, 0) * 100) / 100;
      brutto = netto;
      vat = 0;
    } else {
      brutto = Math.round(linee.reduce((s, l) => s + l.wartosc, 0) * 100) / 100;
      netto = Math.round(brutto / 1.23 * 100) / 100;
      vat = Math.round((brutto - netto) * 100) / 100;
    }
    // Termin platnosci: domyslnie 7 dni, ale edytowalny przez req.body.paymentDays
    // (np. user mowi "30 dni"). Walidacja: liczba > 0, inaczej fallback 7.
    const pdRaw = Number(req.body && req.body.paymentDays);
    const paymentDays = Number.isFinite(pdRaw) && pdRaw > 0 ? Math.round(pdRaw) : 7;
    const terminPlatnosci = new Date(Date.now() + paymentDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const vatMode = rodzaj === 'wdt' ? 'WDT 0%' : `krajowa VAT ${Math.round(0.23 * 100)}%`;
    // Sygnal dla agenta: krajowa 23% dla klienta z UE jest CELOWA (vatMode=domestic),
    // zeby nie traktowal tego jako blad i nie proponowal WDT 0%.
    const vatOverride = _cExtras.vatMode === 'domestic';
    const vatNote = vatOverride
      ? 'UWAGA DLA AGENTA: krajowa 23% VAT dla tego klienta z UE jest CELOWA i poprawna (kontrahent ma ustawiony vatMode=domestic, np. stowarzyszenie bez aktywnego VIES). To NIE jest blad. NIE proponuj WDT 0%, NIE "napraw" na 0% — po prostu pokaz podglad i wystaw 23%.'
      : null;
    const preview = {
      contractor: { id: contractor.id, name: contractor.name, nip: contractor.nip, country: contractor.country, address: contractor.address },
      waluta,
      rodzaj,
      vatMode,
      vatOverride,
      vatNote,
      derivedCountry: derived.country,
      derivedCountrySource: derived.source,
      pozycje: linee,
      suma: { brutto, netto, vat },
      terminPlatnosci,
      paymentDays,
    };

    const previewId = require('crypto').randomUUID();
    // Uwagi/notatka na FV (np. numer zamówienia) — z req.body.uwagi lub .notes.
    const uwagi = (req.body && (req.body.uwagi || req.body.notes)) || null;
    const reqSource = (req.body && req.body.source) || null;
    const reqChatId = req.body && req.body.chatId;

    // Telegram: push podglądu z przyciskami Akceptuj/Odrzuć (deterministycznie,
    // bez Anthropic — tap woła confirm/discard WPROST po previewId). Pomijamy gdy
    // żądanie idzie z CRM (frontend) — tam są przyciski w UI. ZAPAMIĘTUJEMY chat,
    // na który poszedł podgląd (pushChatId), żeby confirm wysłał tam PDF — bez tego
    // confirm był STRICT i FV się wystawiała, ale potwierdzenie/PDF nie docierało.
    let telegramPushed = false;
    let pushChatId = null;
    if (reqSource !== 'frontend') {
      try {
        const { resolveTelegram } = require('../services/telegram-helper');
        const tg = await resolveTelegram(prisma, { reqChatId, scope: 'pl' });
        if (tg.token && tg.chatId) {
          pushChatId = String(tg.chatId);
          const lines = linee.map(l =>
            `• ${l.nazwa}${l.wariant ? ` ${l.wariant}` : ''} × ${l.ilosc} szt\n  ${l.cenaNetto != null ? `netto ${l.cenaNetto.toFixed(2)}` : `brutto ${(l.cena || 0).toFixed(2)}`} ${waluta}/szt → ${l.wartosc.toFixed(2)} ${waluta}`
          ).join('\n');
          const previewText =
            `🧾 PODGLĄD FAKTURY${rodzaj === 'wdt' ? ' (WDT)' : ''}\n\n` +
            `Kontrahent: ${contractor.name}${contractor.country ? ` (${contractor.country})` : ''}\n` +
            `Waluta: ${waluta} | VAT: ${vatMode}\n` +
            `Termin płatności: ${terminPlatnosci} (${paymentDays} dni)\n\n` +
            `${lines}\n\n` +
            `SUMA: ${netto.toFixed(2)} netto | ${brutto.toFixed(2)} brutto ${waluta}\n\n` +
            `Akceptuj przyciskiem poniżej albo napisz "tak".`;
          const replyMarkup = { inline_keyboard: [[
            { text: '✅ Akceptuj i wystaw fakturę', callback_data: `fvpl:${previewId}` },
            { text: '❌ Odrzuć', callback_data: `fvno:${previewId}` },
          ]] };
          const r = await sendTelegram(tg.token, String(tg.chatId), previewText, { replyMarkup });
          telegramPushed = !!(r && r.ok);
          if (!telegramPushed) console.error('[invoice-preview] tg push failed:', r && r.error);
        }
      } catch (e) {
        console.error('[invoice-preview] tg push threw:', e.message);
      }
    }

    const storePayload = { preview, contractorData: contractor, pozycjeData: linee, waluta, rodzaj, priceMode, paymentDays, uwagi, source: reqSource, chatId: pushChatId };
    savePreview(previewId, storePayload);

    // TRWAŁY zapis pełnego podglądu w DB (agentContext) — in-memory Map ginie
    // przy redeployu / między instancjami, przez co confirm-latest nie znajdował
    // podglądu i agent halucynował "wystawiona". Confirm ma fallback do tego.
    const previewData = {
      lastAction: 'preview', previewId,
      contractor: { name: contractor.name, nip: contractor.nip, country: contractor.country },
      suma: preview.suma, waluta, timestamp: Date.now(),
      previewFull: storePayload, previewSavedAt: Date.now(),
    };
    prisma.agentContext.upsert({
      where: { id: 'ksiegowosc' },
      update: { data: previewData },
      create: { id: 'ksiegowosc', data: previewData },
    }).catch(e => console.error('[invoice-preview] AgentContext save error:', e.message));

    res.json({ ok: true, preview, previewId, telegramPushed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ INVOICE CONFIRM LATEST ============

router.post('/ifirma/invoice-confirm-latest', async (req, res) => {
  const prisma = req.app.locals.prisma;
  let lockedId = null;
  try {
    const now = Date.now();
    let bestId = null;
    let bestExpiry = 0;
    for (const [id, entry] of invoicePreviews.entries()) {
      if (entry.expiresAt > now && entry.expiresAt > bestExpiry) {
        bestExpiry = entry.expiresAt;
        bestId = id;
      }
    }
    let stored = bestId ? getPreview(bestId) : null;

    // FALLBACK DB: in-memory Map pusty (redeploy / inna instancja). Wczytaj
    // pełny podgląd z agentContext (zapisany przy /invoice-preview), jeśli świeży.
    if (!stored) {
      const PREVIEW_DB_TTL_MS = 30 * 60 * 1000;
      const ac = await prisma.agentContext.findUnique({ where: { id: 'ksiegowosc' } }).catch(() => null);
      const d = ac && ac.data;
      if (d && d.previewFull && d.previewSavedAt && (now - Number(d.previewSavedAt) < PREVIEW_DB_TTL_MS) && d.lastAction === 'preview') {
        stored = d.previewFull;
        bestId = d.previewId || null;
        console.log('[ifirma confirm-latest] preview odtworzony z DB (agentContext)');
      }
    }
    if (!stored) return res.status(404).json({ error: 'Brak aktywnego podglądu. Utwórz nowy.' });

    // IDEMPOTENCJA: jeden podgląd => jedna faktura (anti-duplikat przy wielokrotnym
    // "tak"/tapnięciu guzika; iFirma jest wolna, więc równoległe wywołania zdążyłyby
    // wystawić kilka FV zanim podgląd zostanie skasowany).
    sweepConfirmedPreviews();
    if (bestId) {
      const already = _confirmedPreviews.get(bestId);
      if (already) return res.json({ ok: true, invoiceNumber: already.invoiceNumber, invoiceId: already.invoiceId, duplicate: true, pdfSent: false });
      if (_confirmingPreviews.has(bestId)) return res.status(409).json({ ok: false, error: 'Faktura z tego podglądu jest właśnie wystawiana — poczekaj chwilę.', inProgress: true });
      _confirmingPreviews.add(bestId);
      lockedId = bestId;
    }

    const { contractorData: contractor, pozycjeData: pozycje, waluta, rodzaj, priceMode } = stored;
    const storedUwagi = stored.uwagi || null;
    const paymentDays = (Number.isFinite(Number(stored.paymentDays)) && Number(stored.paymentDays) > 0) ? Math.round(Number(stored.paymentDays)) : 7;

    // Chat docelowy PDF: per-request chatId → chat z podglądu (stored.chatId) →
    // fallback Config (resolveTelegram). Gdy podgląd był z CRM (source=frontend) →
    // NIE wysyłamy na Telegram (potwierdzenie/PDF zostają w CRM).
    const reqChatId = req.body && req.body.chatId;
    const { resolveTelegram } = require('../services/telegram-helper');
    const _tg = await resolveTelegram(prisma, { reqChatId: reqChatId || stored.chatId, scope: 'pl' });
    const tgToken = _tg.token || '';
    const tgChat = stored.source === 'frontend' ? null : (_tg.chatId ? String(_tg.chatId) : null);
    if (!tgChat) {
      console.warn(`[ifirma confirm-latest] brak chatId (source=${stored.source || 'n/a'}) — PDF nie zostanie wysłany na Telegram.`);
    }
    console.log(`[ifirma confirm-latest] tg → chat=${tgChat || 'NONE'} token=...${tgToken.slice(-4)}`);

    let ifirmaResult;
    try {
      const kontrahentPayload = await buildIfirmaContractorPayload(prisma, contractor);
      console.log(`[invoice-confirm] kontrahent fields: nip=${kontrahentPayload.nip} addr="${kontrahentPayload.address}" city="${kontrahentPayload.city}" postCode="${kontrahentPayload.postCode}" ifirmaId=${kontrahentPayload.ifirmaId}`);
      // Pre-check: iFirma wymaga kodu pocztowego. Lepiej jasny komunikat TERAZ
      // niz kryptyczny blad iFirmy. (postCode jest auto-wyciagany z adresu w
      // buildIfirmaContractorPayload — tu lapiemy przypadek gdy naprawde brak.)
      if (!kontrahentPayload.postCode) {
        return res.status(400).json({
          error: `Brak kodu pocztowego dla „${contractor.name}". iFirma nie wystawi faktury bez kodu pocztowego. Podaj kod, np. napisz: „ustaw kod pocztowy XXXXX dla ${contractor.name}", i spróbuj ponownie.`,
          missingField: 'postCode',
          contractor: contractor.name,
        });
      }
      // Utrwal wyciagniety kod na kontrahencie (czesto wklejony w adresie, ale
      // nie zapisany w polu postCode) — zeby kolejne FV juz go mialy.
      if (kontrahentPayload.postCode && !contractor.postCode) {
        prisma.contractor.update({ where: { id: contractor.id }, data: { postCode: kontrahentPayload.postCode } }).catch(() => {});
      }
      // Push aktualnych danych do iFirmy ZANIM wystawimy FV — bez tego iFirma
      // siga do swojej (potencjalnie stale) kopii rekordu i ignoruje inline
      // Kontrahent (skutek: korekta np. kodu pocztowego u nas nigdy nie dociera
      // do faktur). Non-fatal — jak push padnie i tak probujemy wystawic, iFirma
      // moze wtedy uzyc swojej kopii.
      if (kontrahentPayload.nip && rodzaj !== 'wdt') {
        try {
          const upRes = await upsertContractor(kontrahentPayload);
          console.log(`[invoice-confirm] iFirma kontrahent ${upRes.action} id=${upRes.identifier}`);
        } catch (e) {
          console.warn('[invoice-confirm] upsertContractor failed (non-fatal):', e.message);
        }
      }
      ifirmaResult = await createInvoice({
        kontrahent: kontrahentPayload,
        pozycje,
        waluta,
        rodzaj,
        priceMode,
        paymentDays,
        uwagi: storedUwagi,
      });
    } catch (ifirmaErr) {
      const raw = ifirmaErr.ifirmaRaw || null;
      const kod = raw && raw.response && raw.response.Kod;
      const info = raw && raw.response && raw.response.Informacja;
      const humanError = info ? `${info}${kod != null ? ` (kod ${kod})` : ''}` : ifirmaErr.message;
      console.log('[invoice-confirm] iFirma error:', humanError);
      if (tgToken && tgChat) {
        sendTelegram(tgToken, tgChat,
          `❌ Błąd iFirma\n${humanError}\nKontrahent: ${contractor.name}`
        ).catch(e => console.error('[invoice-confirm] tg error:', e.message));
      }
      return res.json({ ok: false, error: humanError, ifirmaCode: kod != null ? kod : null });
    }

    const ifirmaRaw = ifirmaResult.ifirmaRaw;
    // Prefer values already extracted by ifirma-client (which now parses
    // multiple shapes); only fall back to raw if missing.
    const fakturaId = ifirmaResult.ifirmaId
      || (ifirmaRaw && ifirmaRaw.response && (ifirmaRaw.response.Wynik && ifirmaRaw.response.Wynik.FakturaId))
      || (ifirmaRaw && ifirmaRaw.response && ifirmaRaw.response.Identyfikator)
      || null;
    const ifirmaIdNum = fakturaId;

    let pelnyNumer = ifirmaResult.invoiceNumber || null;
    // If we still don't have a real number, retry the iFirma list lookup
    // a few times — sometimes the just-issued invoice takes a moment to
    // show up in the daily list.
    if (!pelnyNumer && ifirmaIdNum) {
      for (let attempt = 1; attempt <= 3 && !pelnyNumer; attempt++) {
        try {
          if (attempt > 1) await new Promise(r => setTimeout(r, 1500));
          const today = new Date().toISOString().slice(0, 10);
          const todayInvoices = await fetchIfirmaInvoices({ dataOd: today, dataDo: today });
          const matched = todayInvoices.find(inv => String(inv.FakturaId) === String(ifirmaIdNum));
          if (matched) {
            pelnyNumer = matched.PelnyNumer || matched.Numer || null;
            console.log(`[invoice-confirm] recovered number on attempt ${attempt}: ${pelnyNumer}`);
          }
        } catch (lookupErr) {
          console.error(`[invoice-confirm] lookup attempt ${attempt} error:`, lookupErr.message);
        }
      }
    }
    if (!pelnyNumer) {
      pelnyNumer = 'UNKNOWN';
      console.error('[invoice-confirm] FAILED to resolve invoice number after retries — saving UNKNOWN. ifirmaId=' + ifirmaIdNum);
    }

    const brutto = stored.preview.suma.brutto;

    const invoice = await prisma.invoice.create({
      data: {
        contractorId: contractor.id,
        ifirmaId: ifirmaIdNum,
        number: pelnyNumer,
        issueDate: new Date(),
        dueDate: new Date(Date.now() + paymentDays * 24 * 60 * 60 * 1000),
        grossAmount: brutto,
        currency: waluta,
        paidAmount: 0,
        status: 'unpaid',
        type: rodzaj,
        contractorName: contractor.name || null,
        contractorNip: contractor.nip || null,
        contractorCountry: contractor.country || null,
        contractorCity: contractor.city || null,
        extras: {
          pozycje: pozycje.map(p => ({ ean: p.ean, nazwa: p.nazwa, ilosc: p.ilosc, pricePLN: p.cena, priceEUR: p.cena })),
          items: pozycje.map(p => ({ name: p.nazwa, variant: p.wariant || null, qty: p.ilosc, ean: p.ean, priceNetto: p.cena })),
        },
      },
    });
    await createInvoiceLineItems(prisma, invoice, pozycje);

    try {
      const { logActivity } = require('../services/activity-log');
      logActivity(prisma, {
        type: 'invoice.created',
        summary: `FV ${pelnyNumer} wystawiona dla ${contractor.name} (${brutto} ${waluta})`,
        source: 'ifirma',
        contractorId: contractor.id,
        invoiceId: invoice.id,
        actorType: 'user',
        actorId: req.body && req.body.chatId ? String(req.body.chatId) : null,
        payload: {
          number: pelnyNumer, ifirmaId: ifirmaIdNum, grossAmount: String(brutto),
          currency: waluta, type: rodzaj, contractorName: contractor.name, contractorNip: contractor.nip,
          lineCount: pozycje.length,
        },
        tags: [`country:${(contractor.country || 'pl').toLowerCase()}`, `currency:${waluta.toLowerCase()}`],
      });
    } catch (_) {}

    // Operations tracker — link to existing Transaction (matched against an
    // already-created shipment) or open a new one. Best-effort, never fail
    // the request because of it.
    try {
      const { trackInvoice } = require('../services/transaction-tracker');
      await trackInvoice(prisma, invoice, {
        source: 'invoice-confirm-latest',
        contractorName: contractor.name,
        itemsSummary: pozycje && pozycje.length
          ? pozycje.map(p => `${p.ilosc}× ${p.nazwa}${p.wariant ? ' ' + p.wariant : ''}`).slice(0, 3).join(', ') + (pozycje.length > 3 ? `, +${pozycje.length - 3}` : '')
          : null,
        itemsDetails: pozycje && pozycje.length ? pozycje.map(p => ({ name: p.nazwa, variant: p.wariant, qty: p.ilosc, priceNetto: p.cena })) : null,
      });
    } catch (e) {
      console.error('[invoice-confirm] tracker error:', e.message);
    }

    console.log('[invoice-confirm] sending iFirma response to Telegram');
    if (tgToken && tgChat) {
      const info = ifirmaRaw && ifirmaRaw.response && ifirmaRaw.response.Informacja || '';
      sendTelegram(tgToken, tgChat,
        `IFIRMA ODPOWIEDŹ:\nStatus: SUKCES\nKod: 0\nInformacja: ${info}\nIdentyfikator: ${fakturaId}\nKontrahent: ${contractor.name}\nKwota: ${stored.preview.suma.brutto} ${waluta}`
      ).catch(e => console.error('[invoice-confirm] tg notify error:', e.message));
    }

    const pdfBuffer = await fetchInvoicePdf(pelnyNumer, rodzaj, fakturaId);

    let pdfSent = false;
    try {
      if (tgToken && tgChat) {
        const caption = `Faktura ${pelnyNumer} dla ${contractor.name}`;
        const filename = `faktura_${pelnyNumer.replace(/\//g, '_')}.pdf`;
        const tgResp = await sendTelegramDocument(tgToken, tgChat, pdfBuffer, filename, caption);
        pdfSent = Boolean(tgResp && tgResp.ok);
        if (!pdfSent) console.error('[invoice-confirm-latest] Telegram sendDocument not-ok:', JSON.stringify(tgResp));
      }
    } catch (tgErr) {
      console.error('[invoice-confirm-latest] Telegram error:', tgErr.message);
    }

    invoicePreviews.delete(bestId);
    // Zapamiętaj wystawioną FV pod previewId — kolejne "tak"/tapnięcia zwrócą
    // TEN SAM numer zamiast tworzyć duplikat.
    if (lockedId) _confirmedPreviews.set(lockedId, { invoiceNumber: pelnyNumer, invoiceId: invoice.id, ifirmaId: fakturaId, at: Date.now() });

    prisma.agentContext.upsert({
      where: { id: 'ksiegowosc' },
      update: { data: { lastAction: 'confirmed', invoiceNumber: pelnyNumer, invoiceId: invoice.id, contractor: { name: contractor.name }, timestamp: Date.now() } },
      create: { id: 'ksiegowosc', data: { lastAction: 'confirmed', invoiceNumber: pelnyNumer, invoiceId: invoice.id, contractor: { name: contractor.name }, timestamp: Date.now() } },
    }).catch(e => console.error('[invoice-confirm-latest] AgentContext save error:', e.message));

    res.json({ ok: true, invoiceNumber: pelnyNumer, invoiceId: invoice.id, pdfSent, ifirmaResponse: ifirmaRaw });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (lockedId) _confirmingPreviews.delete(lockedId);
  }
});

// ODRZUĆ preview FV PL — kasuje błędny podgląd (in-memory + trwały w DB),
// żeby nie dało się go zatwierdzić ani przez confirm-latest, ani przez button.
router.post('/ifirma/invoice-preview-discard', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { previewId } = req.body || {};
    if (previewId) invoicePreviews.delete(previewId);
    // Wyczyść trwały podgląd, by confirm-latest (fallback DB) go nie odnalazł.
    await prisma.agentContext.upsert({
      where: { id: 'ksiegowosc' },
      update: { data: { lastAction: 'preview-discarded', timestamp: Date.now() } },
      create: { id: 'ksiegowosc', data: { lastAction: 'preview-discarded', timestamp: Date.now() } },
    }).catch(e => console.error('[invoice-preview-discard] AgentContext clear error:', e.message));
    res.json({ ok: true, discarded: true, previewId: previewId || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ INVOICE CONFIRM ============

router.post('/ifirma/invoice-confirm', async (req, res) => {
  const prisma = req.app.locals.prisma;
  let lockedId = null;
  try {
    const { previewId } = req.body;
    if (!previewId) return res.status(400).json({ error: 'previewId required' });

    // IDEMPOTENCJA: jeden previewId => jedna faktura. Tapnięcie guzika "Akceptuj"
    // mogło przyjść kilka razy / równolegle — bez tej blokady każdy tap tworzył
    // NOWĄ fakturę (incydent: 4 FV z jednego podglądu). Duplikat → ten sam numer.
    sweepConfirmedPreviews();
    const already = _confirmedPreviews.get(previewId);
    if (already) return res.json({ ok: true, invoiceNumber: already.invoiceNumber, invoiceId: already.invoiceId, duplicate: true, pdfSent: false });
    if (_confirmingPreviews.has(previewId)) return res.status(409).json({ ok: false, error: 'Faktura z tego podglądu jest właśnie wystawiana — poczekaj chwilę.', inProgress: true });

    const stored = getPreview(previewId);
    if (!stored) return res.status(404).json({ error: 'preview not found or expired' });

    _confirmingPreviews.add(previewId);
    lockedId = previewId;

    const { contractorData: contractor, pozycjeData: pozycje, waluta, rodzaj, priceMode: storedPriceMode } = stored;
    const storedUwagi = stored.uwagi || null;
    const paymentDays = (Number.isFinite(Number(stored.paymentDays)) && Number(stored.paymentDays) > 0) ? Math.round(Number(stored.paymentDays)) : 7;

    const kontrahentPayload2 = await buildIfirmaContractorPayload(prisma, contractor);
    console.log(`[invoice-confirm/${previewId}] kontrahent fields: nip=${kontrahentPayload2.nip} addr="${kontrahentPayload2.address}" city="${kontrahentPayload2.city}" postCode="${kontrahentPayload2.postCode}" ifirmaId=${kontrahentPayload2.ifirmaId}`);
    if (!kontrahentPayload2.postCode) {
      return res.status(400).json({
        error: `Brak kodu pocztowego dla „${contractor.name}". iFirma nie wystawi faktury bez kodu pocztowego. Podaj kod, np. „ustaw kod pocztowy XXXXX dla ${contractor.name}", i spróbuj ponownie.`,
        missingField: 'postCode',
        contractor: contractor.name,
      });
    }
    if (kontrahentPayload2.postCode && contractor.id && !contractor.postCode) {
      prisma.contractor.update({ where: { id: contractor.id }, data: { postCode: kontrahentPayload2.postCode } }).catch(() => {});
    }
    // Push aktualnych danych do iFirmy zanim wystawimy FV (patrz invoice-confirm-latest powyzej).
    if (kontrahentPayload2.nip && rodzaj !== 'wdt') {
      try {
        const upRes = await upsertContractor(kontrahentPayload2);
        console.log(`[invoice-confirm/${previewId}] iFirma kontrahent ${upRes.action} id=${upRes.identifier}`);
      } catch (e) {
        console.warn(`[invoice-confirm/${previewId}] upsertContractor failed (non-fatal):`, e.message);
      }
    }
    const ifirmaResp = await createInvoice({
      kontrahent: kontrahentPayload2,
      pozycje,
      waluta,
      rodzaj,
      priceMode: storedPriceMode,
      paymentDays,
      uwagi: storedUwagi,
    });

    const ifirmaInvoice = ifirmaResp.response && ifirmaResp.response.Wynik;
    const pelnyNumer = ifirmaInvoice && (ifirmaInvoice.PelnyNumer || ifirmaInvoice.Numer) || 'UNKNOWN';
    const ifirmaId = ifirmaInvoice && ifirmaInvoice.FakturaId || null;

    const brutto = stored.preview.suma.brutto;

    const invoice = await prisma.invoice.create({
      data: {
        contractorId: contractor.id,
        ifirmaId,
        number: pelnyNumer,
        issueDate: new Date(),
        dueDate: new Date(Date.now() + paymentDays * 24 * 60 * 60 * 1000),
        grossAmount: brutto,
        currency: waluta,
        paidAmount: 0,
        status: 'unpaid',
        type: rodzaj,
        contractorName: contractor.name || null,
        contractorNip: contractor.nip || null,
        contractorCountry: contractor.country || null,
        contractorCity: contractor.city || null,
        extras: {
          pozycje: pozycje.map(p => ({ ean: p.ean, nazwa: p.nazwa, ilosc: p.ilosc, pricePLN: p.cena, priceEUR: p.cena })),
          items: pozycje.map(p => ({ name: p.nazwa, variant: p.wariant || null, qty: p.ilosc, ean: p.ean, priceNetto: p.cena })),
        },
      },
    });
    await createInvoiceLineItems(prisma, invoice, pozycje);

    try {
      const { logActivity } = require('../services/activity-log');
      logActivity(prisma, {
        type: 'invoice.created',
        summary: `FV ${pelnyNumer} wystawiona dla ${contractor.name} (${brutto} ${waluta})`,
        source: 'ifirma',
        contractorId: contractor.id,
        invoiceId: invoice.id,
        actorType: 'user',
        actorId: req.body && req.body.chatId ? String(req.body.chatId) : null,
        payload: {
          number: pelnyNumer, ifirmaId, grossAmount: String(brutto),
          currency: waluta, type: rodzaj, contractorName: contractor.name, contractorNip: contractor.nip,
          lineCount: pozycje.length,
        },
        tags: [`country:${(contractor.country || 'pl').toLowerCase()}`, `currency:${waluta.toLowerCase()}`],
      });
    } catch (_) {}

    const pdfBuffer = await fetchInvoicePdf(pelnyNumer, rodzaj, ifirmaId);

    let pdfSent = false;
    try {
      // Chat docelowy: per-request chatId → chat z podglądu (stored.chatId) →
      // Config fallback. Podgląd z CRM (source=frontend) → bez Telegrama.
      const reqChatId = req.body && req.body.chatId;
      const { resolveTelegram } = require('../services/telegram-helper');
      const _tg = await resolveTelegram(prisma, { reqChatId: reqChatId || stored.chatId, scope: 'pl' });
      const token = _tg.token || '';
      const chatId = stored.source === 'frontend' ? null : (_tg.chatId ? String(_tg.chatId) : null);
      if (!chatId) {
        console.warn(`[ifirma confirm] brak chatId (source=${stored.source || 'n/a'}) — PDF nie zostanie wysłany.`);
      }
      console.log(`[ifirma confirm] tg → chat=${chatId || 'NONE'} token=...${token.slice(-4)}`);

      if (token && chatId) {
        // Najpierw KRÓTKIE potwierdzenie tekstowe — żeby user zawsze wiedział, że
        // FV powstała, nawet gdyby PDF nie zdążył się wygenerować po stronie iFirmy.
        await sendTelegram(token, chatId,
          `✅ Wystawiono fakturę ${pelnyNumer} dla ${contractor.name}\nKwota: ${brutto} ${waluta}`
        ).catch(e => console.error('[invoice-confirm] tg notify error:', e.message));

        const caption = `Faktura ${pelnyNumer} dla ${contractor.name}`;
        const filename = `faktura_${pelnyNumer.replace(/\//g, '_')}.pdf`;
        const tgResp = await sendTelegramDocument(token, chatId, pdfBuffer, filename, caption);
        pdfSent = Boolean(tgResp && tgResp.ok);
        if (!pdfSent) console.error('[invoice-confirm] Telegram sendDocument not-ok:', JSON.stringify(tgResp));
      }
    } catch (tgErr) {
      console.error('[invoice-confirm] Telegram error:', tgErr.message);
    }

    invoicePreviews.delete(previewId);
    if (lockedId) _confirmedPreviews.set(lockedId, { invoiceNumber: pelnyNumer, invoiceId: invoice.id, ifirmaId, at: Date.now() });
    res.json({ ok: true, invoiceNumber: pelnyNumer, invoiceId: invoice.id, pdfSent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (lockedId) _confirmingPreviews.delete(lockedId);
  }
});

// ============ SEND INVOICE EMAIL ============

router.post('/ifirma/send-invoice-email', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { invoiceId, toEmail, emailId, subject: customSubject, body: customBody } = req.body;
    if (!invoiceId) return res.status(400).json({ error: 'invoiceId required' });

    // Accept fuzzy invoice references — agents and humans rarely type the
    // canonical "65/2026" form. Strip prefixes ("FV 65", "Faktura 65"),
    // normalize 2-digit year ("65/26" → "65/2026"), and append the current
    // year when only a number is given ("65" → "65/2026"). Keep the raw
    // input as a fallback search so explicit forms still work.
    function normalizeInvoiceQuery(input) {
      if (!input) return null;
      const stripped = String(input).trim()
        .replace(/^(?:fv|faktura|faktur[aęoy])\s*\/?\s*/i, '')
        .replace(/^nr\s*/i, '')
        .trim();
      if (/^\d+\/\d{4}$/.test(stripped)) return stripped;
      if (/^\d+\/\d{2}$/.test(stripped)) {
        const [n, yy] = stripped.split('/');
        return n + '/20' + yy;
      }
      if (/^\d+$/.test(stripped)) return stripped + '/' + new Date().getFullYear();
      return stripped;
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(invoiceId);
    let invoice = isUuid
      ? await prisma.invoice.findUnique({ where: { id: invoiceId } })
      : null;

    const queries = [];
    if (!invoice) {
      const normalized = normalizeInvoiceQuery(invoiceId);
      if (normalized && normalized !== invoiceId) queries.push(normalized);
      queries.push(invoiceId);
      for (const q of queries) {
        invoice = await prisma.invoice.findFirst({
          where: { number: { equals: q, mode: 'insensitive' } },
          orderBy: { createdAt: 'desc' },
        });
        if (invoice) {
          console.log(`[send-invoice-email] resolved "${invoiceId}" → "${q}" → invoiceId=${invoice.id}, number=${invoice.number}`);
          break;
        }
      }
    }
    if (!invoice) return res.status(404).json({ error: `Invoice not found: tried ${[invoiceId, ...queries.filter(q => q !== invoiceId)].map(q => '"' + q + '"').join(', ')}` });

    const pdfBuffer = await fetchInvoicePdf(invoice.number, invoice.type);
    const filename = `faktura_${invoice.number.replace(/\//g, '_')}.pdf`;

    // Threading: if emailId provided, reply in same thread
    // Walidacja formatu — agent czasem podaje nazwę firmy ('Delart Ochnik sp.k.')
    // jako toEmail. Jeśli nie wygląda na adres email — traktujemy jak brak,
    // żeby fallback chain (contractor → email_history) miał szansę zadziałać.
    const looksLikeEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
    let to = looksLikeEmail(toEmail) ? toEmail.trim() : null;
    if (toEmail && !to) {
      console.log(`[send-invoice-email] toEmail="${toEmail}" nie wygląda na adres — odrzucone, próbuję fallback`);
    }
    let from = 'info@surfstickbell.com';
    let fromSource = 'default';
    let subject = customSubject || `Faktura ${invoice.number} - Surf Stick Bell`;
    let inReplyTo = null;
    let references = null;

    if (emailId) {
      const originalEmail = await prisma.email.findUnique({ where: { id: emailId } });
      if (originalEmail) {
        // Use the sender's email as recipient (reply to them)
        if (!to) to = originalEmail.fromEmail;
        // Send from the inbox that received the original email
        if (originalEmail.inbox) {
          const accounts = getAccounts();
          const matchedAccount = accounts.find(a => (a.inbox || '').toLowerCase() === originalEmail.inbox.toLowerCase());
          if (matchedAccount) {
            from = matchedAccount.user;
            fromSource = `reply_inbox:${originalEmail.inbox}`;
          }
        }
        // Threading headers
        if (originalEmail.messageId) {
          inReplyTo = originalEmail.messageId;
          references = ((originalEmail.references || '') + ' ' + originalEmail.messageId).trim();
        }
        // Re: subject
        if (!customSubject) {
          const origSubject = originalEmail.subject || '';
          subject = origSubject.startsWith('Re:') ? origSubject : `Re: ${origSubject}`;
        }
        console.log(`[send-invoice-email] Replying in thread: inReplyTo=${inReplyTo}, from=${from} (${fromSource}), to=${to}`);
      }
    }

    // Auto-fetch z kontrahenta gdy agent nie podał maila explicit. Lustro
    // logiki ES /api/contasimple/send-invoice-email — agent mówi „wyślij im
    // mailem", backend resolwuje email z Contractor.email zamiast wymagać
    // od agenta pamiętania adresów (i halucynowania).
    let emailSource = to ? 'request' : null;

    // Kandydaci na kontrahenta: po invoice.contractorId ORAZ po NIP z faktury
    // (gdy contractorId jest null/wskazuje na duplikat bez maila — incydent
    // Beauty Company: mail był na innym rekordzie/jako kontakt). Zbieramy maile z
    // pola Contractor.email i z ContractorContact (type=email) wszystkich kandydatów.
    if (!to) {
      const candidateIds = new Set();
      if (invoice.contractorId) candidateIds.add(invoice.contractorId);
      const nip = (invoice.contractorNip || '').replace(/[^0-9A-Za-z]/g, '');
      if (nip) {
        const byNip = await prisma.contractor.findMany({
          where: { nip: { contains: nip } },
          select: { id: true },
          take: 10,
        }).catch(() => []);
        for (const c of byNip) candidateIds.add(c.id);
      }
      if (candidateIds.size) {
        const ids = [...candidateIds];
        // 1) główne pole Contractor.email
        const mains = await prisma.contractor.findMany({
          where: { id: { in: ids }, email: { not: null } },
          select: { email: true },
        }).catch(() => []);
        const mainEmail = mains.map(m => m.email).find(e => looksLikeEmail(e));
        if (mainEmail) {
          to = mainEmail;
          emailSource = 'contractor';
        } else {
          // 2) kontakty email (label priorytet: accounting>billing>office>sales>support>shipping)
          const contacts = await prisma.contractorContact.findMany({
            where: { contractorId: { in: ids }, type: 'email' },
          }).catch(() => []);
          const valid = contacts.filter(c => looksLikeEmail(c.value));
          if (valid.length) {
            const LABEL_PRIO = { accounting: 1, billing: 2, office: 3, sales: 4, support: 5, shipping: 6 };
            valid.sort((a, b) => {
              if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
              return (LABEL_PRIO[String(a.label || '').toLowerCase()] || 9) - (LABEL_PRIO[String(b.label || '').toLowerCase()] || 9);
            });
            to = valid[0].value;
            emailSource = 'contractor_contact';
            console.log(`[send-invoice-email] email z ContractorContact (${valid[0].label || 'no-label'}): ${to}`);
          }
        }
      }
    }

    // Drugi fallback: historia korespondencji. Wcześniej wysyłaliśmy do nich
    // FV (OUTBOUND z contractorId), albo oni pisali do nas (INBOUND). Bierzemy
    // najświeższy wpis Email z tym samym contractorId i ekstraktujemy adres.
    // Jak znajdziemy → też zapisujemy na Contractor.email żeby kolejny raz
    // szło bezpośrednio.
    if (!to && invoice.contractorId) {
      const lastOut = await prisma.email.findFirst({
        where: { contractorId: invoice.contractorId, direction: 'OUTBOUND' },
        orderBy: { createdAt: 'desc' },
        select: { toEmail: true },
      });
      if (lastOut && lastOut.toEmail) {
        to = lastOut.toEmail;
        emailSource = 'email_history_outbound';
      } else {
        const lastIn = await prisma.email.findFirst({
          where: { contractorId: invoice.contractorId, direction: 'INBOUND' },
          orderBy: { createdAt: 'desc' },
          select: { fromEmail: true },
        });
        if (lastIn && lastIn.fromEmail) {
          to = lastIn.fromEmail;
          emailSource = 'email_history_inbound';
        }
      }
    }

    // Trzeci fallback: fuzzy lookup po tokenach nazwy firmy w polach Email
    // (fromName/fromEmail/toEmail/subject). Działa nawet jak Email rekordy
    // mają contractorId=null (poller nie zlinkował bo Contractor.email był
    // pusty). Filtrujemy oczywiste śmieci (placeholder/blocklist domains)
    // żeby nie podstawić halucynacji typu 'delart.ochnik@example.com' z
    // poprzednich nieudanych wysyłek.
    if (!to && invoice.contractorId) {
      const contractor = await prisma.contractor.findUnique({
        where: { id: invoice.contractorId },
        select: { name: true },
      });
      const STOPWORDS = new Set(['sp', 'k', 'sa', 'sc', 'sl', 'sci', 'spz', 'oo', 'ltd', 'gmbh', 'ochnik', 'spolka', 'spółka', 'komandytowa', 'akcyjna', 'cywilna']);
      const tokens = ((contractor && contractor.name) || '')
        .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, ' ').split(/\s+/)
        .filter(t => t.length >= 4 && !STOPWORDS.has(t));
      console.log(`[send-invoice-email] fuzzy: contractor="${contractor && contractor.name}" tokens=[${tokens.join(',')}]`);
      if (tokens.length) {
        const orFilters = [];
        for (const t of tokens) {
          orFilters.push({ fromEmail: { contains: t, mode: 'insensitive' } });
          orFilters.push({ toEmail: { contains: t, mode: 'insensitive' } });
          orFilters.push({ fromName: { contains: t, mode: 'insensitive' } });
          orFilters.push({ subject: { contains: t, mode: 'insensitive' } });
        }
        const candidates = await prisma.email.findMany({
          where: { OR: orFilters },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { fromEmail: true, toEmail: true, direction: true, fromName: true, subject: true },
        });
        console.log(`[send-invoice-email] fuzzy: ${candidates.length} kandydatów w Email`);
        const isPlaceholder = (e) => !e || /(example|test|fake|placeholder|domain)\.(com|org|net|pl)$/i.test(e);
        const isFromUs = (e) => !e || /surfstickbell|surf-stick-bell/i.test(e);
        for (const c of candidates) {
          const candidate = c.direction === 'INBOUND' ? c.fromEmail : c.toEmail;
          if (!candidate) { continue; }
          if (isPlaceholder(candidate)) { console.log(`[send-invoice-email] fuzzy skip ${candidate}: placeholder`); continue; }
          if (isFromUs(candidate)) { console.log(`[send-invoice-email] fuzzy skip ${candidate}: from us`); continue; }
          to = candidate;
          emailSource = 'email_history_fuzzy';
          console.log(`[send-invoice-email] fuzzy match: ${candidate} (${c.direction}, fromName="${c.fromName}", subject="${c.subject}")`);
          break;
        }
        if (!to) console.log(`[send-invoice-email] fuzzy: zero przeszło filtry`);
      }
    }
    // Po znalezieniu z którejkolwiek warstwy historii — zapisz na rekord.
    if (to && (emailSource === 'email_history_outbound' || emailSource === 'email_history_inbound' || emailSource === 'email_history_fuzzy')) {
      console.log(`[send-invoice-email] resolved from email history (${emailSource}): ${to}`);
      try {
        await prisma.contractor.update({
          where: { id: invoice.contractorId },
          data: { email: to.toLowerCase().trim() },
        });
        console.log(`[send-invoice-email] backfilled contractor.email from history: ${to}`);
      } catch (e) {
        console.error('[send-invoice-email] history backfill failed:', e.message);
      }
    }

    // Reject oczywistych halucynacji (example.com, test.com, fake-...).
    // Agent wymyślał adresy „delart.ochnik@example.com" zamiast wziąć
    // prawdziwy z bazy. Lepiej 400 z sugestią niż wysłać w próżnię.
    if (to && /(example|test|fake|placeholder|domain)\.(com|org|net|pl)$/i.test(to)) {
      const realEmail = invoice.contractorId
        ? (await prisma.contractor.findUnique({
            where: { id: invoice.contractorId },
            select: { email: true, name: true },
          }))
        : null;
      return res.status(400).json({
        error: `toEmail "${to}" wygląda na zmyślony (placeholder domain)`,
        hint: realEmail && realEmail.email
          ? `W bazie kontrahent "${realEmail.name}" ma email: ${realEmail.email} — użyj go.`
          : `Kontrahent w bazie nie ma maila. Podaj prawdziwy adres.`,
        contractorEmail: realEmail && realEmail.email,
      });
    }

    if (!to) return res.status(400).json({ error: 'toEmail required (or provide emailId to reply, or set contractor.email in DB)' });

    // Localize default body by recipient country. Hiszpan dostaje
    // hiszpańską wiadomość; polski klient polską itd. Falls back to EN
    // when we don't have a translation. Subject też lokalizujemy.
    const contractor = invoice.contractorId
      ? await prisma.contractor.findUnique({ where: { id: invoice.contractorId } })
      : null;
    const country = (contractor && contractor.country || '').toUpperCase();
    const TEMPLATES = {
      PL: { subject: 'Faktura {n} - Surf Stick Bell', body: 'Dzień dobry,\n\nFaktura w załączniku.\n\nPozdrawiam,\nMichał Pałyska\nSurf Stick Bell', html: 'Dzień dobry,<br><br>Faktura w załączniku.<br><br>Pozdrawiam,<br>Michał Pałyska<br>Surf Stick Bell' },
      ES: { subject: 'Factura {n} - Surf Stick Bell', body: 'Hola,\n\nAdjunto la factura.\n\nUn saludo,\nMichał Pałyska\nSurf Stick Bell', html: 'Hola,<br><br>Adjunto la factura.<br><br>Un saludo,<br>Michał Pałyska<br>Surf Stick Bell' },
      PT: { subject: 'Fatura {n} - Surf Stick Bell', body: 'Olá,\n\nSegue a fatura em anexo.\n\nCumprimentos,\nMichał Pałyska\nSurf Stick Bell', html: 'Olá,<br><br>Segue a fatura em anexo.<br><br>Cumprimentos,<br>Michał Pałyska<br>Surf Stick Bell' },
      IT: { subject: 'Fattura {n} - Surf Stick Bell', body: 'Buongiorno,\n\nIn allegato la fattura.\n\nCordiali saluti,\nMichał Pałyska\nSurf Stick Bell', html: 'Buongiorno,<br><br>In allegato la fattura.<br><br>Cordiali saluti,<br>Michał Pałyska<br>Surf Stick Bell' },
      DE: { subject: 'Rechnung {n} - Surf Stick Bell', body: 'Guten Tag,\n\nDie Rechnung im Anhang.\n\nMit freundlichen Grüßen,\nMichał Pałyska\nSurf Stick Bell', html: 'Guten Tag,<br><br>Die Rechnung im Anhang.<br><br>Mit freundlichen Grüßen,<br>Michał Pałyska<br>Surf Stick Bell' },
      FR: { subject: 'Facture {n} - Surf Stick Bell', body: 'Bonjour,\n\nVeuillez trouver la facture en pièce jointe.\n\nCordialement,\nMichał Pałyska\nSurf Stick Bell', html: 'Bonjour,<br><br>Veuillez trouver la facture en pièce jointe.<br><br>Cordialement,<br>Michał Pałyska<br>Surf Stick Bell' },
      NL: { subject: 'Factuur {n} - Surf Stick Bell', body: 'Geachte heer/mevrouw,\n\nIn de bijlage vindt u de factuur.\n\nMet vriendelijke groet,\nMichał Pałyska\nSurf Stick Bell', html: 'Geachte heer/mevrouw,<br><br>In de bijlage vindt u de factuur.<br><br>Met vriendelijke groet,<br>Michał Pałyska<br>Surf Stick Bell' },
      EN: { subject: 'Invoice {n} - Surf Stick Bell', body: 'Hello,\n\nPlease find the invoice attached.\n\nBest regards,\nMichał Pałyska\nSurf Stick Bell', html: 'Hello,<br><br>Please find the invoice attached.<br><br>Best regards,<br>Michał Pałyska<br>Surf Stick Bell' },
    };
    // Resolve language with cascade priority:
    //   1. contractor.country (DB) — najpewniejsze
    //   2. język maila OD kontrahenta (emailId lub ostatni INBOUND)
    //   3. EN fallback
    function detectLangFromBody(text) {
      if (!text) return null;
      const t = String(text).toLowerCase();
      const patterns = [
        { lang: 'FR', words: ['bonjour', 'cordialement', 'merci', 'votre', 'pouvez', 'nous sommes'] },
        { lang: 'ES', words: ['hola', 'saludos', 'gracias', 'buenos días', 'buenas tardes', 'estaríamos', 'estamos', 'somos'] },
        { lang: 'IT', words: ['buongiorno', 'grazie', 'cordiali saluti', 'siamo', 'vorrei'] },
        { lang: 'PT', words: ['olá', 'obrigado', 'cumprimentos', 'estamos', 'somos'] },
        { lang: 'DE', words: ['guten tag', 'mit freundlichen', 'danke', 'wir sind', 'ihre'] },
        { lang: 'NL', words: ['geachte', 'met vriendelijke groet', 'bedankt', 'wij zijn', 'kunnen we', 'bestelling', 'onderstaand'] },
        { lang: 'PL', words: ['dzień dobry', 'pozdrawiam', 'dziękuję', 'jesteśmy'] },
      ];
      let best = null, bestScore = 0;
      for (const p of patterns) {
        const score = p.words.filter(w => t.includes(w)).length;
        if (score > bestScore) { bestScore = score; best = p.lang; }
      }
      // Require ≥2 hits to avoid false positives (single common word like "merci"
      // could appear in any language email).
      return bestScore >= 2 ? best : null;
    }

    // Kaskada języka (kolejność wg reguły biznesowej):
    //   1. contractor.country — najpewniejsze (np. NL z VIES)
    //   2. język maila OD kontrahenta — z podanego emailId, a gdy go brak,
    //      z ostatniego maila INBOUND tego kontrahenta (klient bywa na Gmailu,
    //      więc TLD adresu nic nie mówi — liczy się treść).
    //   3. EN.
    // TLD adresu świadomie pominięty — mylił przy klientach z gmail/outlook.
    let lang = null;
    let langSource = null;
    if (TEMPLATES[country]) { lang = country; langSource = 'contractor.country'; }
    if (!lang) {
      try {
        let body = null;
        if (emailId) {
          const orig = await prisma.email.findUnique({ where: { id: emailId }, select: { bodyFull: true, bodyPreview: true } });
          body = orig && (orig.bodyFull || orig.bodyPreview);
        }
        if (!body && invoice.contractorId) {
          const lastIn = await prisma.email.findFirst({
            where: { contractorId: invoice.contractorId, direction: 'INBOUND' },
            orderBy: { createdAt: 'desc' },
            select: { bodyFull: true, bodyPreview: true },
          });
          body = lastIn && (lastIn.bodyFull || lastIn.bodyPreview);
        }
        const detected = detectLangFromBody(body || '');
        if (detected && TEMPLATES[detected]) { lang = detected; langSource = emailId ? 'email_body' : 'contractor_last_email'; }
      } catch (_) { /* ignore */ }
    }
    if (!lang) { lang = 'EN'; langSource = 'fallback'; }
    const tpl = TEMPLATES[lang];
    const defaultBody = tpl.body;
    const defaultHtml = tpl.html;
    if (!customSubject) subject = tpl.subject.replace('{n}', invoice.number);
    console.log(`[send-invoice-email] language: ${lang} (source=${langSource}, to=${to}, country=${country || 'null'})`);

    const sentBody = customBody || defaultBody;
    const reqChatId = req.body && req.body.chatId;
    let savedEmail;
    try {
      savedEmail = await sendMail({
        from,
        to,
        subject,
        body: sentBody,
        html: customBody ? undefined : defaultHtml,
        inReplyTo,
        references,
        attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
      });
    } catch (sendErr) {
      await notifyMailResult(prisma, {
        reqChatId, scope: 'pl', ok: false,
        to, from, subject,
        attachmentFilename: filename,
        attachmentSizeKB: pdfBuffer ? Math.round(pdfBuffer.length / 102.4) / 10 : null,
        error: sendErr.message,
      });
      throw sendErr;
    }
    await notifyMailResult(prisma, {
      reqChatId, scope: 'pl', ok: true,
      to, from, subject,
      messageId: savedEmail && savedEmail.messageId,
      attachmentFilename: filename,
      attachmentSizeKB: pdfBuffer ? Math.round(pdfBuffer.length / 102.4) / 10 : null,
    });

    // Auto-backfill: jak user/agent podał email i kontrahent miał pusty,
    // zapisz na rekord. Następnym razem nie trzeba podawać.
    let backfilled = false;
    if (emailSource === 'request' && invoice.contractorId) {
      try {
        const c = await prisma.contractor.findUnique({
          where: { id: invoice.contractorId },
          select: { email: true },
        });
        if (c && (!c.email || !c.email.trim())) {
          await prisma.contractor.update({
            where: { id: invoice.contractorId },
            data: { email: to.toLowerCase().trim() },
          });
          backfilled = true;
          console.log(`[send-invoice-email] auto-backfilled contractor.email: ${to}`);
        }
      } catch (e) {
        console.error('[send-invoice-email] backfill failed:', e.message);
      }
    }

    // Verbatim confirmation block — agents tend to claim "sent" without
    // proof, so surface every fact the SMTP server gave us. The agent is
    // instructed to display this block as-is to the user.
    res.json({
      ok: true,
      sent: true,
      confirmation: {
        invoiceNumber: invoice.number,
        language: lang,
        languageSource: langSource,
        contractorCountry: country || null,
        from,
        fromSource,
        to,
        toSource: emailSource,
        backfilled,
        subject,
        bodyPreview: (sentBody || '').slice(0, 200),
        attachmentFilename: filename,
        attachmentSizeBytes: pdfBuffer.length,
        attachmentSizeKB: Math.round(pdfBuffer.length / 102.4) / 10,
        messageId: (savedEmail && savedEmail.messageId) || null,
        savedEmailId: savedEmail && savedEmail.id,
        sentAt: (savedEmail && savedEmail.createdAt) || new Date().toISOString(),
        replyToThread: !!inReplyTo,
        inReplyTo: inReplyTo || null,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ INVOICE MANAGEMENT ============

router.post('/invoices/extract-prices', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const contractors = await prisma.contractor.findMany({
      where: { nip: { not: null } },
      select: { id: true, name: true, nip: true, extras: true },
    });

    const results = [];
    for (const contractor of contractors) {
      try {
        const invoices = await fetchIfirmaInvoices({ nipKontrahenta: contractor.nip });
        if (!invoices.length) { results.push({ id: contractor.id, name: contractor.name, skipped: 'no invoices' }); continue; }

        invoices.sort((a, b) => new Date(b.DataWystawienia || 0) - new Date(a.DataWystawienia || 0));
        const latest = invoices[0];
        const fakturaId = latest.Identyfikator || latest.id;
        const rodzaj = latest.Rodzaj || 'krajowa';
        const waluta = latest.Waluta || 'PLN';

        const details = await fetchInvoiceDetails(fakturaId, rodzaj);
        const pozycje = details && (details.Pozycje || details.pozycje);
        if (!pozycje || !pozycje.length) { results.push({ id: contractor.id, name: contractor.name, skipped: 'no positions in invoice' }); continue; }

        const cena = pozycje[0].CenaJednostkowa;
        const extras = { ...(contractor.extras || {}), lastPrice: cena, lastPriceCurrency: waluta };
        await prisma.contractor.update({ where: { id: contractor.id }, data: { extras } });
        results.push({ id: contractor.id, name: contractor.name, lastPrice: cena, lastPriceCurrency: waluta });
      } catch (e) {
        results.push({ id: contractor.id, name: contractor.name, error: e.message });
      }
    }

    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/invoices/delete-search', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { contractorSearch, dateFrom, dateTo, limit } = req.body;
    if (!contractorSearch) return res.status(400).json({ error: 'contractorSearch required' });

    const scored = await findBestContractors(prisma, contractorSearch);
    if (!scored.length) return res.status(404).json({ error: 'Nie znaleziono kontrahenta: ' + contractorSearch });
    const contractor = scored[0].contractor;

    const today = new Date().toISOString().slice(0, 10);
    const where = {
      contractorId: contractor.id,
      issueDate: { gte: new Date(dateFrom || today), lte: new Date(dateTo || today + 'T23:59:59.999Z') },
    };
    const invoices = await prisma.invoice.findMany({
      where,
      orderBy: { issueDate: 'desc' },
      take: limit || 50,
      select: { id: true, number: true, grossAmount: true, currency: true, issueDate: true, status: true, ifirmaId: true, type: true },
    });

    if (!invoices.length) return res.status(404).json({ error: `Brak faktur dla ${contractor.name} w podanym okresie.` });

    res.json({
      ok: true,
      invoices,
      message: `Znaleziono ${invoices.length} faktur dla ${contractor.name}. Potwierdź kasowanie.`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/invoices/delete-confirm', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { invoiceIds } = req.body;
    if (!Array.isArray(invoiceIds) || !invoiceIds.length) return res.status(400).json({ error: 'invoiceIds required' });

    const deleted = [];
    for (const id of invoiceIds) {
      const inv = await prisma.invoice.findUnique({ where: { id } });
      if (!inv) { deleted.push({ id, error: 'not found' }); continue; }

      await prisma.invoice.delete({ where: { id } });
      console.log(`[invoices] deleted from local DB: ${inv.number}, ifirmaId=${inv.ifirmaId} (iFirma manual deletion required)`);
      deleted.push({ id, number: inv.number });
    }

    res.json({ ok: true, deleted, note: 'Skasowano z lokalnej bazy. Faktury w iFirma trzeba skasować ręcznie w panelu.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pozycje konkretnej faktury (po numerze) — ZRODLO CEN gdy user mowi
// "ceny jak w fakturze X" / "takie same jak ostatnia FV". Numer ma slash
// (np. "97/2026") wiec idzie jako query param, nie path. Match: exact -> contains.
router.get('/invoice-lines', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const number = (req.query.number || '').toString().trim();
  if (!number) return res.status(400).json({ error: 'number required' });
  try {
    let invoice = await prisma.invoice.findFirst({
      where: { number: { equals: number, mode: 'insensitive' } },
      orderBy: { issueDate: 'desc' },
    });
    if (!invoice) {
      invoice = await prisma.invoice.findFirst({
        where: { number: { contains: number, mode: 'insensitive' } },
        orderBy: { issueDate: 'desc' },
      });
    }
    if (!invoice) return res.status(404).json({ error: 'invoice not found', number });

    const lines = await prisma.invoiceLineItem.findMany({
      where: { invoiceId: invoice.id },
      orderBy: { position: 'asc' },
      select: {
        name: true, ean: true, qty: true, unit: true,
        unitPriceNetto: true, vatRate: true, currency: true, position: true,
      },
    });
    res.json({
      number: invoice.number,
      issueDate: invoice.issueDate,
      currency: invoice.currency,
      contractorName: invoice.contractorName,
      lineCount: lines.length,
      lines,
    });
  } catch (e) {
    console.error('[invoice-lines] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/invoices/unpaid', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const now = new Date();
    const invoices = await prisma.invoice.findMany({
      where: { status: { not: 'paid' } },
      orderBy: { dueDate: 'asc' },
      include: { contractor: { select: { name: true, nip: true, country: true } } },
    });

    const result = invoices.map(inv => ({
      id: inv.id,
      number: inv.number,
      contractor: inv.contractor ? { name: inv.contractor.name, nip: inv.contractor.nip, country: inv.contractor.country } : null,
      grossAmount: Number(inv.grossAmount),
      currency: inv.currency,
      paidAmount: Number(inv.paidAmount),
      status: inv.status,
      issueDate: inv.issueDate,
      dueDate: inv.dueDate,
      daysOverdue: inv.dueDate ? Math.max(0, Math.floor((now - new Date(inv.dueDate)) / 86400000)) : null,
    }));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ PAYMENT MATCHING ============

router.post('/payments/match', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { amount, currency, sender } = req.body;
    const date = req.body.date || new Date().toISOString().slice(0, 10);
    if (!amount || !currency || !sender) return res.status(400).json({ error: 'amount, currency, sender required' });

    // Global admin notification (payment matched) — fallback Config OK
    const { resolveTelegram } = require('../services/telegram-helper');
    const tg = await resolveTelegram(prisma, { scope: 'pl' });
    const tgToken = tg.token;
    const tgChat = tg.chatId;

    // Find contractor by sender
    const scored = await findBestContractors(prisma, sender, { minScore: 40 });

    if (!scored.length) {
      const msg = `WPŁATA: ${amount} ${currency} od ${sender} → nieznany nadawca`;
      console.log('[payments/match]', msg);
      if (tgToken && tgChat) sendTelegram(tgToken, tgChat, msg).catch(e => console.error('[payments/match] tg error:', e.message));
      return res.json({ ok: true, matched: false, invoice: null, contractor: null, ifirma: null, message: msg });
    }

    const contractor = scored[0].contractor;

    // Find unpaid invoice closest to amount (tolerance 1%)
    const invoices = await prisma.invoice.findMany({
      where: { contractorId: contractor.id, currency, status: { not: 'paid' } },
      orderBy: { grossAmount: 'asc' },
    });

    let bestInvoice = null;
    let bestDiff = Infinity;
    for (const inv of invoices) {
      const gross = Number(inv.grossAmount);
      const diff = Math.abs(gross - amount);
      const tolerance = gross * 0.01;
      if (diff <= tolerance && diff < bestDiff) {
        bestDiff = diff;
        bestInvoice = inv;
      }
    }

    if (!bestInvoice) {
      const msg = `WPŁATA: ${amount} ${currency} od ${sender} → brak pasującej faktury`;
      console.log('[payments/match]', msg);
      if (tgToken && tgChat) sendTelegram(tgToken, tgChat, msg).catch(e => console.error('[payments/match] tg error:', e.message));
      return res.json({ ok: true, matched: false, invoice: null, contractor: contractor.name, ifirma: null, message: msg });
    }

    // Update invoice in DB
    await prisma.invoice.update({
      where: { id: bestInvoice.id },
      data: { status: 'paid', paidAmount: amount },
    });

    // Register payment in iFirma
    const invoiceType = bestInvoice.type || (currency === 'EUR' ? 'wdt' : 'krajowa');
    let ifirmaResp = null;
    let ifirmaOk = false;
    try {
      ifirmaResp = await registerPayment(bestInvoice.number, invoiceType, amount, currency, date);
      ifirmaOk = ifirmaResp && ifirmaResp.status === 200;
    } catch (e) {
      console.error('[payments/match] iFirma error:', e.message);
    }

    const msg = `WPŁATA: ${amount} ${currency} od ${sender} → FV ${bestInvoice.number} opłacona (iFirma: ${ifirmaOk ? 'OK' : 'BŁĄD'})`;
    console.log('[payments/match]', msg);
    if (tgToken && tgChat) sendTelegram(tgToken, tgChat, msg).catch(e => console.error('[payments/match] tg error:', e.message));

    return res.json({ ok: true, matched: true, invoice: bestInvoice.number, contractor: contractor.name, ifirma: ifirmaResp });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pobierz PDF z iFirma + wyślij na Telegram (do recovery gdy automatyczna
// wysyłka po confirm nie zadziałała — np. faktura w bazie miała "UNKNOWN"
// jako number, lub Telegram chatId/token były niedostępne w momencie confirm).
router.post('/ifirma/resend-pdf-telegram', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    let { invoiceId, invoiceNumber, ifirmaId } = req.body || {};

    // Same fuzzy normalization as send-invoice-email: "65" → "65/2026"
    // (current year), "FV 65" / "Faktura 65" / "65/26" all collapse to
    // canonical form. Tries normalized first, falls back to raw.
    function normalizeInvoiceQuery(input) {
      if (!input) return null;
      const stripped = String(input).trim()
        .replace(/^(?:fv|faktura|faktur[aęoy])\s*\/?\s*/i, '')
        .replace(/^nr\s*/i, '').trim();
      if (/^\d+\/\d{4}$/.test(stripped)) return stripped;
      if (/^\d+\/\d{2}$/.test(stripped)) {
        const [n, yy] = stripped.split('/');
        return n + '/20' + yy;
      }
      if (/^\d+$/.test(stripped)) return stripped + '/' + new Date().getFullYear();
      return stripped;
    }

    let invoice = null;
    if (invoiceId) invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice && invoiceNumber) {
      const candidates = [normalizeInvoiceQuery(invoiceNumber), invoiceNumber].filter(Boolean);
      const seen = new Set();
      for (const q of candidates) {
        if (seen.has(q)) continue; seen.add(q);
        invoice = await prisma.invoice.findFirst({
          where: { number: { equals: q, mode: 'insensitive' } },
          orderBy: { createdAt: 'desc' },
        });
        if (invoice) {
          console.log(`[resend-pdf] resolved "${invoiceNumber}" → "${q}" → ${invoice.id} (${invoice.number})`);
          break;
        }
      }
    }
    if (!invoice && ifirmaId) invoice = await prisma.invoice.findUnique({ where: { ifirmaId: parseInt(ifirmaId) } });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found. Provide invoiceId, invoiceNumber (e.g. "65/2026" or just "65" for current year), or ifirmaId.' });

    // If number is the placeholder, try to recover the real one from iFirma details.
    let realNumber = invoice.number;
    if ((!realNumber || realNumber === 'UNKNOWN') && invoice.ifirmaId) {
      try {
        const details = await fetchInvoiceDetails(invoice.ifirmaId, invoice.ifirmaType || invoice.type || 'wdt');
        const fromDetails = details && (details.PelnyNumer || details.Numer || (details.Wynik && (details.Wynik.PelnyNumer || details.Wynik.Numer)));
        if (fromDetails) {
          realNumber = fromDetails;
          await prisma.invoice.update({ where: { id: invoice.id }, data: { number: realNumber } });
          console.log(`[resend-pdf] Recovered real number ${realNumber} for invoice ${invoice.id} (was UNKNOWN)`);
        }
      } catch (e) {
        console.error('[resend-pdf] Failed to fetch iFirma details:', e.message);
      }
    }
    if (!realNumber || realNumber === 'UNKNOWN') {
      return res.status(400).json({ error: 'Cannot resolve real invoice number from iFirma. Try /api/ifirma/sync first.' });
    }

    const rodzaj = invoice.ifirmaType || invoice.type || 'wdt';
    const pdfBuffer = await fetchInvoicePdf(realNumber, rodzaj, invoice.ifirmaId);

    // STRICT: tylko per-request chatId.
    const { resolveToken } = require('../services/telegram-helper');
    const tgToken = (await resolveToken(prisma, 'pl')).token || '';
    const reqChatId = req.body && req.body.chatId;
    const tgChat = reqChatId ? String(reqChatId) : null;
    console.log(`[ifirma resend-pdf] tg → chat=${tgChat || 'NONE'} (source=${reqChatId ? 'request' : 'NONE'}) token=...${tgToken.slice(-4)}`);
    if (!tgToken) return res.json({ ok: false, error: 'Brak telegram_bot_token. Skonfiguruj env TELEGRAM_BOT_TOKEN albo Config.' });
    if (!tgChat) return res.json({ ok: false, error: 'Brak chatId w body żądania. Master n8n musi przekazać chatId={{ $(\'Buduj kontekst\').first().json.chatId }} w body tool calla.' });

    const filename = `faktura_${realNumber.replace(/\//g, '_')}.pdf`;
    const caption = `Faktura ${realNumber}`;
    const tgResp = await sendTelegramDocument(tgToken, tgChat, pdfBuffer, filename, caption);
    if (!tgResp || !tgResp.ok) {
      return res.json({ ok: false, sent: false, error: `telegram api: ${(tgResp && tgResp.description) || 'unknown'}`, invoiceNumber: realNumber });
    }

    res.json({
      ok: true,
      sent: true,
      invoiceNumber: realNumber,
      invoiceId: invoice.id,
      // Kontrahent + nota: zeby agent NIE mogl podpisac reprintu cudza nazwa
      // ani sprzedac go jako "wystawienie nowej FV" (incydent 101/2026).
      contractorName: invoice.contractorName || null,
      note: 'REPRINT istniejacej faktury — to NIE jest wystawienie nowej FV.',
    });
  } catch (e) {
    console.error('[resend-pdf-telegram] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/invoices/:id/backfill-items', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!invoice) return res.status(404).json({ error: 'invoice not found' });
    const result = await backfillInvoiceItems(prisma, invoice);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[backfill-items] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Diagnostyka — jakie email backend ZNAJDZIE dla danego kontrahenta przez
// fallback chain (contractor.email → email_history_outbound/inbound →
// fuzzy). Bez wysyłki, bez side-effectów. Pomocne gdy „wyślij im mailem"
// nie działa i chcemy zobaczyć co backend widzi.
router.get('/find-contractor-email/:idOrSearch', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const idOrSearch = req.params.idOrSearch;
  try {
    let contractor = null;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSearch);
    if (isUuid) {
      contractor = await prisma.contractor.findUnique({ where: { id: idOrSearch } });
    } else {
      const scored = await findBestContractors(prisma, idOrSearch, { minScore: 50 });
      if (scored.length) contractor = scored[0].contractor;
    }
    if (!contractor) return res.status(404).json({ error: 'contractor not found' });
    const result = { contractor: { id: contractor.id, name: contractor.name, nip: contractor.nip, currentEmail: contractor.email } };

    // L1: Contractor.email
    if (contractor.email) {
      result.found = { source: 'contractor', email: contractor.email };
      return res.json(result);
    }

    // L2: history outbound
    const lastOut = await prisma.email.findFirst({
      where: { contractorId: contractor.id, direction: 'OUTBOUND' },
      orderBy: { createdAt: 'desc' },
      select: { toEmail: true },
    });
    if (lastOut && lastOut.toEmail) {
      result.found = { source: 'email_history_outbound', email: lastOut.toEmail };
      return res.json(result);
    }
    const lastIn = await prisma.email.findFirst({
      where: { contractorId: contractor.id, direction: 'INBOUND' },
      orderBy: { createdAt: 'desc' },
      select: { fromEmail: true },
    });
    if (lastIn && lastIn.fromEmail) {
      result.found = { source: 'email_history_inbound', email: lastIn.fromEmail };
      return res.json(result);
    }

    // L3: fuzzy
    const STOPWORDS = new Set(['sp', 'k', 'sa', 'sc', 'sl', 'sci', 'spz', 'oo', 'ltd', 'gmbh', 'ochnik', 'spolka', 'spółka', 'komandytowa', 'akcyjna', 'cywilna']);
    const tokens = (contractor.name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').split(/\s+/)
      .filter(t => t.length >= 4 && !STOPWORDS.has(t));
    result.fuzzyTokens = tokens;
    if (!tokens.length) {
      return res.json({ ...result, found: null, hint: 'brak tokenów ≥4 znaki po wyrzuceniu stopwords' });
    }
    const orFilters = [];
    for (const t of tokens) {
      orFilters.push({ fromEmail: { contains: t, mode: 'insensitive' } });
      orFilters.push({ toEmail: { contains: t, mode: 'insensitive' } });
      orFilters.push({ fromName: { contains: t, mode: 'insensitive' } });
      orFilters.push({ subject: { contains: t, mode: 'insensitive' } });
    }
    const candidates = await prisma.email.findMany({
      where: { OR: orFilters },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { fromEmail: true, toEmail: true, direction: true, fromName: true, subject: true },
    });
    result.candidatesFound = candidates.length;
    const isPlaceholder = (e) => !e || /(example|test|fake|placeholder|domain)\.(com|org|net|pl)$/i.test(e);
    const isFromUs = (e) => !e || /surfstickbell|surf-stick-bell/i.test(e);
    const inspected = [];
    for (const c of candidates) {
      const candidate = c.direction === 'INBOUND' ? c.fromEmail : c.toEmail;
      if (!candidate) { inspected.push({ direction: c.direction, candidate: null, reason: 'null' }); continue; }
      if (isPlaceholder(candidate)) { inspected.push({ direction: c.direction, candidate, reason: 'placeholder' }); continue; }
      if (isFromUs(candidate)) { inspected.push({ direction: c.direction, candidate, reason: 'from_us' }); continue; }
      inspected.push({ direction: c.direction, candidate, fromName: c.fromName, subject: c.subject, accepted: true });
      result.found = { source: 'email_history_fuzzy', email: candidate, direction: c.direction, fromName: c.fromName };
      result.candidatesInspected = inspected;
      return res.json(result);
    }
    result.candidatesInspected = inspected;
    result.found = null;
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ COUNTRY BACKFILL ============
// Normalizuje pole country we wszystkich rekordach Contractor — z pełnych
// nazw ("POLSKA"/"Hiszpania") na ISO-2 ("PL"/"ES"). Plus dorzuca ISO dla
// kontrahentów z pustym country gdy NIP ma prefiks UE. dryRun=true (default)
// zwraca plan bez zapisu.
router.post('/invoices/backfill-country', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { dryRun = true, onlyMissing = false } = req.body || {};
  try {
    const where = onlyMissing
      ? { OR: [{ country: null }, { country: '' }] }
      : {};
    const contractors = await prisma.contractor.findMany({
      where,
      select: { id: true, name: true, nip: true, country: true, address: true, extras: true },
    });
    const plan = [];
    for (const c of contractors) {
      const d = await deriveCountry(c);
      if (!d.country) continue;
      if (c.country === d.country) continue; // już zgodne
      plan.push({ id: c.id, name: c.name, nip: c.nip, currentCountry: c.country, newCountry: d.country, source: d.source });
    }
    if (dryRun) {
      return res.json({ ok: true, dryRun: true, scanned: contractors.length, planSize: plan.length, plan });
    }
    let updated = 0;
    for (const item of plan) {
      try {
        await prisma.contractor.update({ where: { id: item.id }, data: { country: item.newCountry } });
        updated++;
      } catch (e) {
        console.error('[backfill-country] update failed for', item.id, e.message);
      }
    }
    res.json({ ok: true, scanned: contractors.length, updated, planSize: plan.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Diagnostyka miesiąca księgowego — sprawdza który klucz iFirma działa
// dla modułu Abonent. Najpierw GET (read-only), potem opcjonalnie PUT.
// Body: { test: 'get'|'set', miesiac?, rok?, keyType?: 'abonent'|'faktury' }
// Bez body — default test=get z keyType=abonent (czyli env IFIRMA_API_KEY_ABONENT
// → fallback IFIRMA_API_KEY).
router.post('/ifirma/_diag-month', async (req, res) => {
  const { test = 'get', miesiac, rok, keyType = 'abonent' } = req.body || {};
  try {
    const { getAccountingMonth, trySetAccountingMonth } = require('../ifirma-client');
    const keyOverride = keyType === 'faktury' ? process.env.IFIRMA_API_KEY : null;
    if (test === 'get') {
      const r = await getAccountingMonth(keyOverride);
      const envInfo = {
        IFIRMA_USER: !!process.env.IFIRMA_USER,
        IFIRMA_API_KEY_set: !!process.env.IFIRMA_API_KEY,
        IFIRMA_API_KEY_last4: (process.env.IFIRMA_API_KEY || '').slice(-4),
        IFIRMA_API_KEY_ABONENT_set: !!process.env.IFIRMA_API_KEY_ABONENT,
        IFIRMA_API_KEY_ABONENT_last4: (process.env.IFIRMA_API_KEY_ABONENT || '').slice(-4),
        keyUsedNow: keyType === 'faktury' ? 'IFIRMA_API_KEY (fakturowy)' : 'IFIRMA_API_KEY_ABONENT → fallback IFIRMA_API_KEY',
      };
      return res.json({ ok: true, test: 'get', env: envInfo, ifirmaResponse: r });
    }
    if (test === 'step') {
      // body: { direction: 'NAST'|'POPRZ', crossYear?: bool }
      const dir = (req.body && req.body.direction) || 'NAST';
      const cy = !!(req.body && req.body.crossYear);
      const r = await trySetAccountingMonth(dir, cy, keyOverride);
      return res.json({ ok: true, test: 'step', direction: dir, crossYear: cy, ifirmaResponse: r });
    }
    if (test === 'set') {
      // Pełne setAccountingMonth — auto-iteracja NAST/POPRZ żeby trafić w target
      const { setAccountingMonth } = require('../ifirma-client');
      const now = new Date();
      const m = miesiac || (now.getMonth() + 1);
      const y = rok || now.getFullYear();
      const r = await setAccountingMonth(m, y);
      return res.json({ ok: true, test: 'set', target: { miesiac: m, rok: y }, result: r });
    }
    res.status(400).json({ error: "test must be 'get', 'step' (NAST/POPRZ once), or 'set' (iterate to target)" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============ LIST LOCAL INVOICES (Invoice table) ============
// GET /api/invoices?search=&country=&status=&fromDate=&toDate=&limit=&ifirmaOnly=1
// Returns local Invoice rows ordered by issueDate desc. Used by CRM frontend.
// PDF faktury z iFirmy — otwierany guzikiem w zakladce Faktury (jak listy w wysylce).
router.get('/invoices/:invoiceId/pdf', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const key = String(req.params.invoiceId || '');
    // Odporny lookup — przyjmij prismowe id (UUID), ifirmaId (liczba) lub numer.
    let inv = await prisma.invoice.findUnique({ where: { id: key } }).catch(() => null);
    if (!inv && /^\d+$/.test(key)) {
      inv = await prisma.invoice.findUnique({ where: { ifirmaId: parseInt(key, 10) } }).catch(() => null);
    }
    if (!inv) {
      inv = await prisma.invoice.findFirst({ where: { number: key } }).catch(() => null);
    }
    if (!inv) return res.status(404).json({ error: `Nie znaleziono faktury (key=${key})` });

    // Odzyskaj prawdziwy numer z iFirmy gdy lokalnie pusty/UNKNOWN (jak bot
    // resend-pdf-telegram) — niektore PDF-y iFirmy dzialaja tylko po numerze.
    let realNumber = inv.number;
    if ((!realNumber || realNumber === 'UNKNOWN') && inv.ifirmaId) {
      try {
        const details = await fetchInvoiceDetails(inv.ifirmaId, inv.ifirmaType || inv.type || 'wdt');
        const fromDetails = details && (details.PelnyNumer || details.Numer || (details.Wynik && (details.Wynik.PelnyNumer || details.Wynik.Numer)));
        if (fromDetails) realNumber = fromDetails;
      } catch (e) {
        console.error('[invoices/:id/pdf] fetchInvoiceDetails:', e.message);
      }
    }
    if (!realNumber && !inv.ifirmaId) return res.status(404).json({ error: 'Faktura bez identyfikatora iFirmy (brak PDF)' });

    // Tak samo jak dzialajacy bot: rodzaj = ifirmaType || type || 'wdt'.
    let rodzaj = inv.ifirmaType || inv.type || 'wdt';
    // Krajowa w EUR = iFirma 'fakturawaluta'. Dla swiezych faktur type bywa
    // 'krajowa' (przed sync) — wymus wlasciwy endpoint na podstawie waluty.
    if (String(inv.currency || '').toUpperCase() === 'EUR' && !/wdt|dostawa_ue|eksport/i.test(rodzaj)) {
      rodzaj = 'prz_faktura_wys_ter_kraj';
    }
    console.log(`[invoices/:id/pdf] key=${key} -> id=${inv.id} num=${realNumber} ifirmaId=${inv.ifirmaId} rodzaj=${rodzaj}`);
    const pdf = await fetchInvoicePdf(realNumber, rodzaj, inv.ifirmaId);
    res.setHeader('Content-Type', 'application/pdf');
    // inline (nie attachment) — iOS pokazuje PDF w wbudowanym viewerze z share.
    res.setHeader('Content-Disposition', `inline; filename="faktura_${(realNumber || inv.number || 'faktura').replace(/\//g, '_')}.pdf"`);
    res.send(pdf);
  } catch (e) {
    console.error('[invoices/:id/pdf]', e.message);
    res.status(502).json({ error: 'iFirma: ' + e.message });
  }
});

router.get('/invoices', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { search, country, status, fromDate, toDate, limit, ifirmaOnly } = req.query;
    const where = {};
    if (search) {
      where.OR = [
        { number: { contains: search, mode: 'insensitive' } },
        { contractorName: { contains: search, mode: 'insensitive' } },
        { contractorNip: { contains: search } },
      ];
    }
    if (country) where.contractorCountry = { equals: country, mode: 'insensitive' };
    if (status) where.status = status;
    if (fromDate || toDate) {
      where.issueDate = {};
      if (fromDate) where.issueDate.gte = new Date(fromDate);
      if (toDate) where.issueDate.lte = new Date(toDate);
    }
    if (ifirmaOnly === '1' || ifirmaOnly === 'true') {
      where.ifirmaId = { not: null };
    }
    const take = Math.max(1, Math.min(parseInt(limit, 10) || 200, 10000));
    const list = await prisma.invoice.findMany({
      where,
      orderBy: { issueDate: 'desc' },
      take,
      select: {
        id: true, number: true, ifirmaId: true,
        contractorId: true, contractorName: true, contractorNip: true, contractorCountry: true,
        issueDate: true, dueDate: true,
        grossAmount: true, currency: true, paidAmount: true,
        status: true, type: true, ifirmaType: true, source: true,
        shipmentNumber: true, shipmentHash: true, shipmentCarrier: true,
        ksefNumber: true, ksefSentAt: true,
        createdAt: true, updatedAt: true,
      },
    });
    // Status wysylki per faktura — matchujemy do ZYWYCH zamowien GlobKuriera
    // (zrodlo prawdy) po nazwie odbiorcy + dacie, 1:1. NIE polegamy na warstwie
    // Transakcji/dealow (czesto pusta/niezmatchowana) — to byl powod, ze status
    // sie nie pokazywal. Dzieki temu prawie kazda faktura z wysylka pokazuje
    // realny status GK, a guzik "Kurier" zostaje tylko przy tych BEZ wysylki.
    const shipByInvoiceId = {};
    const gkByNumber = {}; // numer GK → zamówienie (do jawnego linku FV.shipmentNumber)
    try {
      const gkOrders = await getGkOrders();
      for (const o of gkOrders) { if (o.number) gkByNumber[String(o.number)] = o; }
      if (gkOrders.length) {
        const { normalizeContractorName, scoreContractor } = require('../services/contractor-match');
        const WINDOW_MS = 45 * 86400000; // paczka zwykle do paru tygodni od FV
        const gk = gkOrders
          .filter(o => o.receiverName)
          .map(o => ({ ...o, key: normalizeContractorName(o.receiverName), used: false }));
        const gkByKey = {};
        for (const o of gk) if (o.key) (gkByKey[o.key] ||= []).push(o);

        // Od NAJNOWSZEJ faktury — swiezo wystawiony list trafia do najnowszej
        // FV kontrahenta bez wysylki (zgodnie z oczekiwaniem usera).
        const sortedInvs = list
          .filter(i => i.contractorName)
          .slice()
          .sort((a, b) => new Date(b.issueDate) - new Date(a.issueDate));

        const isCanceled = (s) => ['CANCELED', 'CANCELLED'].includes((s.status || '').toUpperCase());
        // Najlepszy kandydat z puli: NAJPIERW listy aktywne (nie-anulowane),
        // dopiero w braku — anulowane; w obrebie grupy najblizsza data.
        // (Case: 2 listy dla tego samego klienta, jeden anulowany — faktura ma
        // pokazac AKTYWNY/IN_TRANSIT, nie CANCELED.)
        const assignNearest = (inv, pool) => {
          let best = null, bd = Infinity, bestCanceled = true;
          for (const s of pool) {
            if (s.used) continue;
            const d = Math.abs(new Date(inv.issueDate) - new Date(s.date));
            if (d > WINDOW_MS) continue;
            const c = isCanceled(s);
            if ((bestCanceled && !c) || (c === bestCanceled && d < bd)) { bd = d; best = s; bestCanceled = c; }
          }
          if (best) { best.used = true; shipByInvoiceId[inv.id] = best; return true; }
          return false;
        };

        // Pass 1: dokladna nazwa znormalizowana (najczestszy przypadek).
        for (const inv of sortedInvs) {
          const k = normalizeContractorName(inv.contractorName);
          if (k && gkByKey[k]) assignNearest(inv, gkByKey[k]);
        }
        // Pass 2: fuzzy dla niezmatchowanych — TYLKO obustronny score>=90
        // (WSZYSTKIE znaczace slowa jednej nazwy w drugiej). Wczesniejszy prog
        // 80 = JEDNO wspolne slowo — u nas niemal kazda nazwa ma "surf", wiec
        // wolny list jednego klienta lapal sie do faktury INNEGO (incydent:
        // list Club de Surf Patris przypiety do cudzej nowej FV).
        const unmatched = sortedInvs.filter(i => !shipByInvoiceId[i.id]);
        const unusedGk = gk.filter(o => !o.used);
        if (unmatched.length && unusedGk.length) {
          for (const inv of unmatched) {
            let best = null, bestScore = 0, bestDiff = Infinity, bestCanceled = true;
            for (const s of unusedGk) {
              if (s.used) continue;
              const d = Math.abs(new Date(inv.issueDate) - new Date(s.date));
              if (d > WINDOW_MS) continue;
              const sc = Math.min(
                scoreContractor({ name: s.receiverName }, inv.contractorName),
                scoreContractor({ name: inv.contractorName }, s.receiverName)
              );
              if (sc < 90) continue;
              const c = isCanceled(s);
              const better = (bestCanceled && !c)
                || (c === bestCanceled && (sc > bestScore || (sc === bestScore && d < bestDiff)));
              if (better) { bestScore = sc; bestDiff = d; best = s; bestCanceled = c; }
            }
            if (best) { best.used = true; shipByInvoiceId[inv.id] = best; }
          }
        }
      }
    } catch (e) {
      console.error('[GET /invoices] shipment match failed (best-effort):', e.message);
    }
    res.json(list.map(i => {
      // PRIORYTET: jawny link FV→wysyłka (i.shipmentNumber, ustawiony przy
      // zamówieniu kuriera z guzika przy fakturze). Status bierzemy na żywo z GK
      // po numerze; gdy go (jeszcze) nie ma w cache — pokazujemy wysyłkę z
      // zapisanych pól (neutralny status), żeby zniknął guzik "Kurier".
      let s = shipByInvoiceId[i.id];
      if (!s && i.shipmentNumber) {
        const live = gkByNumber[String(i.shipmentNumber)];
        s = live || { number: i.shipmentNumber, tracking: null, status: null, carrier: i.shipmentCarrier || null };
      }
      if (!s) return { ...i, shipment: null };
      const st = (s.status || '').toUpperCase();
      return {
        ...i,
        shipment: {
          shipmentNumber: s.number,
          trackingNumber: s.tracking,
          status: s.status || null,            // surowy status GK (IN_TRANSIT/DELIVERED/CANCELED...)
          carrier: s.carrier || i.shipmentCarrier || null,
          delivered: st === 'DELIVERED',
          shipped: !!st && !['NEW', 'CREATED', 'CANCELED', 'CANCELLED'].includes(st),
        },
      };
    }));
  } catch (e) {
    console.error('[GET /invoices] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Backfill pozycji faktur W TLE — wolany przez dashboard przy wejsciu. Maly
// batch + lock (anti-duplikat). Uzupelnia InvoiceLineItem dla FV bez pozycji
// (iFirma details, a gdy brak -> PDF + LLM). Dzieki temu dashboard z czasem
// liczy sztuki poprawnie (zamiast 0 dla FV bez items). Idempotentny.
let _linesBackfillRunning = false;
router.post('/invoices/backfill-lines-bg', async (req, res) => {
  const prisma = req.app.locals.prisma;
  if (_linesBackfillRunning) return res.json({ ok: true, started: false, note: 'already running' });
  _linesBackfillRunning = true;
  res.json({ ok: true, started: true }); // odpowiedz od razu, robota leci w tle az do konca
  (async () => {
    const BATCH = 25;
    let rounds = 0, totalLines = 0, totalProcessed = 0;
    try {
      while (rounds < 80) { // safety cap ~2000 FV
        const r = await runIfirmaLinesBackfill(prisma, { apply: true, limit: BATCH, sleepMs: 250, log: () => {} });
        rounds++;
        totalLines += r.totalLinesCreated || 0;
        totalProcessed += r.processed || 0;
        if ((r.processed || 0) < BATCH) break; // brak wiecej kandydatow
      }
      console.log(`[bg-lines-backfill] FINISHED rounds=${rounds} processed=${totalProcessed} linesCreated=${totalLines}`);
    } catch (e) {
      console.error('[bg-lines-backfill] error:', e.message);
    } finally {
      _linesBackfillRunning = false;
    }
  })();
});

// Backfill pozycji SYNCHRONICZNIE — przetwarza kandydatow i ODDAJE wynik z
// bledami per faktura (diagnoza). Limit 30 (te 16 zalapie sie w calosci).
router.post('/invoices/backfill-lines-now', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const limit = Math.min(parseInt((req.body && req.body.limit), 10) || 30, 50);
  try {
    const r = await runIfirmaLinesBackfill(prisma, {
      apply: true, limit, sleepMs: 150, verbose: true,
      log: (m) => console.log('[backfill-now]', m),
    });
    res.json({ ok: true, limit, ...r });
  } catch (e) {
    console.error('[backfill-lines-now]', e);
    res.status(500).json({ ok: false, error: e.message, stack: (e.stack || '').split('\n').slice(0, 3) });
  }
});

// Podglad postepu backfillu pozycji (do diagnozy "ile FV bez sztuk").
router.get('/invoices/lines-backfill-status', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const [total, withLines, failed, lineItemTotal] = await Promise.all([
      prisma.invoice.count({ where: { ifirmaId: { not: null } } }),
      prisma.invoice.count({ where: { ifirmaId: { not: null }, lineItems: { some: {} } } }),
      prisma.invoice.count({ where: { ifirmaId: { not: null }, extras: { path: ['lineBackfillFailed'], equals: true } } }),
      prisma.invoiceLineItem.count(),
    ]);
    const withoutSample = await prisma.invoice.findMany({
      where: { ifirmaId: { not: null }, lineItems: { none: {} } },
      orderBy: { issueDate: 'desc' },
      take: 30,
      select: { number: true, issueDate: true, grossAmount: true, currency: true, type: true, ifirmaType: true },
    });
    res.json({
      ok: true,
      running: _linesBackfillRunning,
      ifirmaInvoices: total,
      withLineItems: withLines,
      withoutLineItems: total - withLines,
      markedFailed: failed,
      totalLineItems: lineItemTotal,
      withoutSample: withoutSample.map(i => ({ number: i.number, date: i.issueDate, amount: String(i.grossAmount), currency: i.currency, type: i.ifirmaType || i.type || null })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============ IFIRMA CONTRACTOR DIAG + FORCE-SYNC ============
//
// Po wczorajszych zmianach upsertContractor trafia do iFirmy automatycznie
// przy KAZDEJ FV. Czasem jednak iFirma odrzuca FV z bledem o danych
// kontrahenta (kod pocztowy, ulica) bo (a) my w lokalnej bazie tez nie mamy,
// albo (b) lokal ma, ale push sie nie udal w przeszlosci.
//
// Te dwa endpointy + odpowiadajace tools w accounting-agent dyzaja agentowi
// MOZLIWOSC SAMODZIELNEJ DIAGNOZY I NAPRAWY:
//
// 1) GET /api/ifirma/contractors/:nip  - pokaz co iFirma ma TERAZ
// 2) POST /api/ifirma/contractors/sync/:id - wymus push lokalnego do iFirmy
//
// Flow naprawy:
//   ifirma_contractor_get -> porownaj z find_contractor -> jak brakuje pola
//   ktore my mamy, ifirma_contractor_sync, retry invoice_confirm.

router.get('/ifirma/contractors/:nip', async (req, res) => {
  try {
    const nip = String(req.params.nip || '').trim();
    if (!nip) return res.status(400).json({ ok: false, error: 'nip required' });
    const data = await searchContractor(nip);
    if (!data) return res.json({ ok: false, error: 'not found in iFirma', nip });
    res.json({ ok: true, nip, ifirma: data });
  } catch (e) {
    console.error('[ifirma-contractor-get] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/ifirma/contractors/sync/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const contractor = await prisma.contractor.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, name: true, nip: true,
        address: true, city: true, country: true,
        primaryEmail: true, email: true, phone: true,
        extras: true, externalIds: true,
      },
    });
    if (!contractor) return res.status(404).json({ ok: false, error: 'contractor not found' });
    if (!contractor.nip) return res.status(400).json({ ok: false, error: 'contractor has no NIP — cannot upsert to iFirma' });

    const payload = await buildIfirmaContractorPayload(prisma, contractor);
    const result = await upsertContractor(payload);
    res.json({ ok: true, action: result.action, identifier: result.identifier, payload });
  } catch (e) {
    console.error('[ifirma-contractor-sync] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Ręczne powiązanie faktury z wysyłką GK — naprawa FV zamówionych zanim doszło
// jawne linkowanie (np. 121/122). Body: { invoiceNumber, shipmentNumber } albo
// { invoiceNumber } → wtedy auto-dobiera najnowsze zamówienie GK dla kontrahenta.
router.post('/invoices/link-shipment', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { invoiceNumber } = req.body || {};
    let { shipmentNumber } = req.body || {};
    if (!invoiceNumber) return res.status(400).json({ ok: false, error: 'invoiceNumber required' });
    const inv = await prisma.invoice.findFirst({ where: { number: String(invoiceNumber) }, orderBy: { createdAt: 'desc' } });
    if (!inv) return res.status(404).json({ ok: false, error: `Nie znaleziono faktury ${invoiceNumber}` });

    let carrier = null;
    if (!shipmentNumber) {
      // Auto: dopasuj po nazwie kontrahenta wśród żywych zamówień GK (najnowsze).
      const { normalizeContractorName, scoreContractor } = require('../services/contractor-match');
      const gk = await getGkOrders();
      const key = normalizeContractorName(inv.contractorName || '');
      const cands = gk
        .filter(o => o.receiverName)
        .map(o => ({ o, score: Math.min(scoreContractor({ name: o.receiverName }, inv.contractorName || ''), scoreContractor({ name: inv.contractorName || '' }, o.receiverName)) }))
        .filter(x => x.score >= 60 || normalizeContractorName(x.o.receiverName) === key)
        .sort((a, b) => new Date(b.o.date) - new Date(a.o.date));
      if (!cands.length) {
        return res.json({ ok: false, error: 'Nie znalazłem zamówienia GK dla tego kontrahenta — podaj shipmentNumber ręcznie.', contractor: inv.contractorName, hint: 'GET /glob/orders pokaże numery wysyłek.' });
      }
      shipmentNumber = cands[0].o.number;
      carrier = cands[0].o.carrier || null;
    }
    const updated = await prisma.invoice.update({
      where: { id: inv.id },
      data: { shipmentNumber: String(shipmentNumber), shipmentHash: req.body.shipmentHash || null, shipmentCarrier: req.body.carrier || carrier },
    });
    res.json({ ok: true, invoiceNumber: updated.number, shipmentNumber: updated.shipmentNumber, carrier: updated.shipmentCarrier });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Wyślij fakturę sprzedażową do KSeF przez iFirmę. body/param: invoiceNumber lub id.
router.post('/invoices/:idOrNumber/ksef-send', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const key = req.params.idOrNumber;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
    let inv = isUuid ? await prisma.invoice.findUnique({ where: { id: key } }) : null;
    if (!inv) inv = await prisma.invoice.findFirst({ where: { number: key }, orderBy: { createdAt: 'desc' } });
    if (!inv) return res.status(404).json({ ok: false, error: `Nie znaleziono faktury ${key}` });
    if (!inv.ifirmaId) return res.status(400).json({ ok: false, error: 'Faktura nie ma ifirmaId — nie była wystawiona przez iFirmę, nie wyślę do KSeF.' });
    if (inv.ksefNumber) return res.json({ ok: true, alreadyInKsef: true, ksefNumber: inv.ksefNumber });

    const { sendInvoiceToKsef } = require('../ifirma-client');
    const r = await sendInvoiceToKsef({ ifirmaId: inv.ifirmaId, rodzaj: inv.type, waluta: inv.currency });
    const resp = r.body && r.body.response ? r.body.response : r.body;
    const kod = resp && (resp.Kod !== undefined ? resp.Kod : resp.kod);
    const ok = r.status >= 200 && r.status < 300 && (kod === 0 || kod === undefined);
    const ksefNumber = resp && (resp.NumerKSeF || resp.numerKSeF || resp.Numer || null);
    if (!ok) {
      return res.status(200).json({ ok: false, error: (resp && (resp.Informacja || resp.informacja)) || `iFirma HTTP ${r.status}`, ifirma: r.body });
    }
    await prisma.invoice.update({ where: { id: inv.id }, data: { ksefSentAt: new Date(), ...(ksefNumber ? { ksefNumber: String(ksefNumber) } : {}) } });
    res.json({ ok: true, invoiceNumber: inv.number, ksefNumber: ksefNumber || null, info: resp && (resp.Informacja || resp.informacja), segment: r.segment });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Status KSeF pojedynczej faktury — używany przez front do odpytywania po
// kliknięciu „Wyślij do KSeF" (KSeF nadaje numer asynchronicznie). Jeśli numer
// jest już w bazie → zwraca go. Inaczej pyta KSeF (Subject1) o ten numer FV
// w zakresie wokół daty wystawienia i zapisuje numer KSeF gdy się pojawi.
router.get('/invoices/:idOrNumber/ksef-status', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const key = req.params.idOrNumber;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
    let inv = isUuid ? await prisma.invoice.findUnique({ where: { id: key } }) : null;
    if (!inv) inv = await prisma.invoice.findFirst({ where: { number: key }, orderBy: { createdAt: 'desc' } });
    if (!inv) return res.status(404).json({ ok: false, error: `Nie znaleziono faktury ${key}` });
    if (inv.ksefNumber) return res.json({ ok: true, status: 'in_ksef', ksefNumber: inv.ksefNumber });

    const ksef = require('../ksef-client');
    if (!ksef.isConfigured()) return res.json({ ok: true, status: 'pending', ksefNumber: null, configured: false });

    // Zakres: od daty wystawienia (z zapasem 2 dni wstecz) do dziś — wąsko, szybko.
    const issued = inv.issueDate ? new Date(inv.issueDate) : new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const from = new Date(issued.getTime() - 2 * 24 * 3600 * 1000).toISOString();
    const to = new Date(Date.now() + 24 * 3600 * 1000 - 1).toISOString();
    const { accessToken } = await ksef.authenticate();
    const metadata = await ksef.queryInvoiceMetadata(accessToken, { subjectType: 'Subject1', from, to, dateType: 'Issue' });
    const P = ksef._pick;
    let ksefNumber = null;
    for (const m of metadata) {
      const number = P(m, 'invoiceNumber', 'number');
      if (number && String(number) === String(inv.number)) {
        ksefNumber = P(m, 'ksefNumber', 'ksefReferenceNumber', 'referenceNumber');
        if (ksefNumber) break;
      }
    }
    if (ksefNumber) {
      await prisma.invoice.update({ where: { id: inv.id }, data: { ksefNumber: String(ksefNumber) } }).catch(() => {});
      return res.json({ ok: true, status: 'in_ksef', ksefNumber: String(ksefNumber) });
    }
    res.json({ ok: true, status: 'pending', ksefNumber: null });
  } catch (e) {
    res.status(200).json({ ok: false, status: 'error', error: e.message });
  }
});

router.addGkOrderToCache = addGkOrderToCache;
module.exports = router;