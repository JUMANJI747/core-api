'use strict';

const router = require('express').Router();
const { fetchInvoices: fetchIfirmaInvoices, createInvoice, fetchInvoicePdf, fetchInvoiceDetails, registerPayment, searchContractor, upsertContractor } = require('../ifirma-client');
const { buildIfirmaContractorPayload } = require('../services/ifirma-payload');
const { backfillInvoiceItems } = require('../services/invoice-backfill');
const { sendMail, getAccounts } = require('../mail-sender');
const { sendTelegram } = require('../telegram-utils');
const { notifyMailResult } = require('../services/notify-mail-result');
const { invoicePreviews, savePreview, getPreview } = require('../stores');
const { findBestContractors } = require('../services/contractor-match');
const { getActiveCatalog } = require('../services/product-catalog');
const { processIfirmaInvoices } = require('../services/ifirma-sync');
const { buildPlLinesFromPozycje, resolveProductIdByEan } = require('../services/invoice-lines-backfill');
const { fetchWithTimeout } = require('../http');
const { verifyVat } = require('../vies');

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

    const dataDo = nowIso.slice(0, 10);
    const dataOd = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const work = (async () => {
      const invoices = await fetchIfirmaInvoices({ dataOd, dataDo });
      return await processIfirmaInvoices(invoices, prisma, { dataOd, dataDo, dryRun: false, silent: true });
    })();
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
      for (const [key, val] of Object.entries(cennikWaluta.wyjatki)) {
        if (nameNorm.includes(key.toLowerCase())) return { cena: val, isNetto: false, source: 'wyjątek' };
      }
      return { cena: cennikWaluta.default, isNetto: false, source: 'default' };
    };

    // Determine price mode: if ANY item has netto price, whole invoice is netto
    const hasNetto = pozycje.some(p => p.itemCenaNetto != null) || globalPriceNetto != null;
    const priceMode = hasNetto ? 'netto' : 'brutto';
    console.log(`[invoice-preview] Price mode: ${priceMode}`);

    const linee = pozycje.map(({ product: p, ilosc, itemCena, itemCenaNetto, isDelivery }) => {
      const { cena, isNetto, source } = resolvePrice(itemCena, itemCenaNetto, contractor.name, contractor.extras);
      console.log(`[invoice-preview] price for ${contractor.name}: ${cena} ${isNetto ? 'netto' : 'brutto'} (source: ${source})`);
      const wartosc = Math.round(cena * ilosc * 100) / 100;
      return { ean: p.ean, nazwa: p.name, wariant: p.variant || null, ilosc, cena, cenaNetto: isNetto ? cena : null, wartosc, priceSource: source, isDelivery: !!isDelivery };
    });

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
    savePreview(previewId, { preview, contractorData: contractor, pozycjeData: linee, waluta, rodzaj, priceMode, paymentDays });

    prisma.agentContext.upsert({
      where: { id: 'ksiegowosc' },
      update: { data: { lastAction: 'preview', previewId, contractor: { name: contractor.name, nip: contractor.nip, country: contractor.country }, suma: preview.suma, waluta, timestamp: Date.now() } },
      create: { id: 'ksiegowosc', data: { lastAction: 'preview', previewId, contractor: { name: contractor.name, nip: contractor.nip, country: contractor.country }, suma: preview.suma, waluta, timestamp: Date.now() } },
    }).catch(e => console.error('[invoice-preview] AgentContext save error:', e.message));

    res.json({ ok: true, preview, previewId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ INVOICE CONFIRM LATEST ============

router.post('/ifirma/invoice-confirm-latest', async (req, res) => {
  const prisma = req.app.locals.prisma;
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
    if (!bestId) return res.status(404).json({ error: 'Brak aktywnego podglądu. Utwórz nowy.' });

    const stored = getPreview(bestId);
    if (!stored) return res.status(404).json({ error: 'Brak aktywnego podglądu. Utwórz nowy.' });

    const { contractorData: contractor, pozycjeData: pozycje, waluta, rodzaj, priceMode } = stored;
    const paymentDays = (Number.isFinite(Number(stored.paymentDays)) && Number(stored.paymentDays) > 0) ? Math.round(Number(stored.paymentDays)) : 7;

    // STRICT routing: tylko per-request chatId, brak fallback Config.
    const reqChatId = req.body && req.body.chatId;
    const { resolveToken } = require('../services/telegram-helper');
    const tgChat = reqChatId ? String(reqChatId) : null;
    const tgToken = (await resolveToken(prisma, 'pl')).token || '';
    if (!tgChat) {
      console.warn('[ifirma confirm-latest] BRAK chatId w body żądania — Master n8n nie skonfigurowany. PDF nie zostanie wysłany.');
    }
    console.log(`[ifirma confirm-latest] tg → chat=${tgChat || 'NONE'} (source=${reqChatId ? 'request' : 'NONE'}) token=...${tgToken.slice(-4)}`);

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
        const boundary = '----FormBoundary' + Date.now();
        const caption = `Faktura ${pelnyNumer} dla ${contractor.name}`;
        const filename = `faktura_${pelnyNumer.replace(/\//g, '_')}.pdf`;

        const parts = [
          `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${tgChat}`,
          `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}`,
          `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
        ];

        const pre = Buffer.from(parts.join('\r\n') + '\r\n', 'utf8');
        const post = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
        const body = Buffer.concat([pre, pdfBuffer, post]);

        await new Promise((resolve, reject) => {
          const tgUrl = new URL(`https://api.telegram.org/bot${tgToken}/sendDocument`);
          const options = {
            hostname: tgUrl.hostname,
            path: tgUrl.pathname,
            method: 'POST',
            headers: {
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
              'Content-Length': body.length,
            },
          };
          const req2 = require('https').request(options, r => { r.resume(); resolve(); });
          req2.on('error', reject);
          req2.write(body);
          req2.end();
        });
        pdfSent = true;
      }
    } catch (tgErr) {
      console.error('[invoice-confirm-latest] Telegram error:', tgErr.message);
    }

    invoicePreviews.delete(bestId);

    prisma.agentContext.upsert({
      where: { id: 'ksiegowosc' },
      update: { data: { lastAction: 'confirmed', invoiceNumber: pelnyNumer, invoiceId: invoice.id, contractor: { name: contractor.name }, timestamp: Date.now() } },
      create: { id: 'ksiegowosc', data: { lastAction: 'confirmed', invoiceNumber: pelnyNumer, invoiceId: invoice.id, contractor: { name: contractor.name }, timestamp: Date.now() } },
    }).catch(e => console.error('[invoice-confirm-latest] AgentContext save error:', e.message));

    res.json({ ok: true, invoiceNumber: pelnyNumer, invoiceId: invoice.id, pdfSent, ifirmaResponse: ifirmaRaw });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ INVOICE CONFIRM ============

router.post('/ifirma/invoice-confirm', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { previewId } = req.body;
    if (!previewId) return res.status(400).json({ error: 'previewId required' });

    const stored = getPreview(previewId);
    if (!stored) return res.status(404).json({ error: 'preview not found or expired' });

    const { contractorData: contractor, pozycjeData: pozycje, waluta, rodzaj, priceMode: storedPriceMode } = stored;
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

    const pdfBuffer = await fetchInvoicePdf(pelnyNumer, rodzaj);

    let pdfSent = false;
    try {
      // STRICT: tylko per-request chatId. Bez fallback na Config.
      const reqChatId = req.body && req.body.chatId;
      const { resolveToken } = require('../services/telegram-helper');
      const chatId = reqChatId ? String(reqChatId) : null;
      const token = (await resolveToken(prisma, 'pl')).token || '';
      if (!chatId) {
        console.warn('[ifirma confirm] BRAK chatId w body żądania — PDF nie zostanie wysłany.');
      }
      console.log(`[ifirma confirm] tg → chat=${chatId || 'NONE'} (source=${reqChatId ? 'request' : 'NONE'}) token=...${token.slice(-4)}`);

      if (token && chatId) {
        const boundary = '----FormBoundary' + Date.now();
        const caption = `Faktura ${pelnyNumer} dla ${contractor.name}`;
        const filename = `faktura_${pelnyNumer.replace(/\//g, '_')}.pdf`;

        const parts = [
          `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}`,
          `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}`,
          `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
        ];

        const pre = Buffer.from(parts.join('\r\n') + '\r\n', 'utf8');
        const post = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
        const body = Buffer.concat([pre, pdfBuffer, post]);

        await new Promise((resolve, reject) => {
          const tgUrl = new URL(`https://api.telegram.org/bot${token}/sendDocument`);
          const options = {
            hostname: tgUrl.hostname,
            path: tgUrl.pathname,
            method: 'POST',
            headers: {
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
              'Content-Length': body.length,
            },
          };
          const req2 = require('https').request(options, r => { r.resume(); resolve(); });
          req2.on('error', reject);
          req2.write(body);
          req2.end();
        });
        pdfSent = true;
      }
    } catch (tgErr) {
      console.error('[invoice-confirm] Telegram error:', tgErr.message);
    }

    invoicePreviews.delete(previewId);
    res.json({ ok: true, invoiceNumber: pelnyNumer, invoiceId: invoice.id, pdfSent });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    if (!to && invoice.contractorId) {
      const contractor = await prisma.contractor.findUnique({
        where: { id: invoice.contractorId },
        select: { email: true },
      });
      if (contractor && contractor.email) {
        to = contractor.email;
        emailSource = 'contractor';
        console.log(`[send-invoice-email] auto-fetched email from contractor: ${to}`);
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

    const boundary = '----FormBoundary' + Date.now();
    const filename = `faktura_${realNumber.replace(/\//g, '_')}.pdf`;
    const caption = `Faktura ${realNumber}`;
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${tgChat}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
    ];
    const pre = Buffer.from(parts.join('\r\n') + '\r\n', 'utf8');
    const post = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const tgBody = Buffer.concat([pre, pdfBuffer, post]);

    await new Promise((resolve, reject) => {
      const tgUrl = new URL(`https://api.telegram.org/bot${tgToken}/sendDocument`);
      const r = require('https').request({
        hostname: tgUrl.hostname,
        path: tgUrl.pathname,
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': tgBody.length },
      }, resp => { resp.resume(); resolve(); });
      r.on('error', reject);
      r.write(tgBody);
      r.end();
    });

    res.json({ ok: true, sent: true, invoiceNumber: realNumber, invoiceId: invoice.id });
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
        createdAt: true, updatedAt: true,
      },
    });
    res.json(list);
  } catch (e) {
    console.error('[GET /invoices] error:', e.message);
    res.status(500).json({ error: e.message });
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

module.exports = router;
