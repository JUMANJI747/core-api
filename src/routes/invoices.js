'use strict';

const router = require('express').Router();
const { fetchInvoices: fetchIfirmaInvoices, createInvoice, fetchInvoicePdf, fetchInvoiceDetails, registerPayment, searchContractor, upsertContractor } = require('../ifirma-client');
const { backfillInvoiceItems } = require('../services/invoice-backfill');
const { sendMail, getAccounts } = require('../mail-sender');
const { sendTelegram } = require('../telegram-utils');
const { notifyMailResult } = require('../services/notify-mail-result');
const { invoicePreviews, savePreview, getPreview } = require('../stores');
const { scoreContractor } = require('../services/contractor-match');
const { processIfirmaInvoices } = require('../services/ifirma-sync');
const { buildPlLinesFromPozycje, resolveProductIdByEan } = require('../services/invoice-lines-backfill');
const { fetchWithTimeout } = require('../http');

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

    const invoices = await fetchIfirmaInvoices({ dataOd, dataDo });
    const result = await processIfirmaInvoices(invoices, prisma, { dataOd, dataDo, dryRun: dryRun || false });
    res.json({ ok: true, period: `${y}-${String(m).padStart(2, '0')}`, fetched: invoices.length, dryRun: dryRun || false, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

    const invoices = await fetchIfirmaInvoices({ dataOd, dataDo });
    const result = await processIfirmaInvoices(invoices, prisma, { dataOd, dataDo, dryRun: true });
    res.json({ ok: true, period: `${y}-${String(m).padStart(2, '0')}`, fetched: invoices.length, dryRun: true, ...result });
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

__INV_TRUNC_REST__