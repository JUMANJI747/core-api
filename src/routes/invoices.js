'use strict';

const router = require('express').Router();
const { fetchInvoices: fetchIfirmaInvoices, createInvoice, fetchInvoicePdf, fetchInvoiceDetails, registerPayment, searchContractor } = require('../ifirma-client');
const { backfillInvoiceItems } = require('../services/invoice-backfill');
const { sendMail, getAccounts } = require('../mail-sender');
const { sendTelegram } = require('../telegram-utils');
const { invoicePreviews, savePreview, getPreview } = require('../stores');
const { scoreContractor } = require('../services/contractor-match');
const { processIfirmaInvoices } = require('../services/ifirma-sync');
const { fetchWithTimeout } = require('../http');

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

// 2-literowe prefiksy NIP w UE (bez PL — lokalny krajowy nie wymaga rozpoznania).
const EU_VAT_PREFIXES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR',
  'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'RO', 'SE',
  'SI', 'SK', 'XI', // XI = Northern Ireland post-Brexit
]);

const COUNTRY_NAME_TO_CODE = {
  hiszpania: 'ES', hiszpańska: 'ES', spain: 'ES', españa: 'ES', espana: 'ES',
  niemcy: 'DE', germany: 'DE', deutschland: 'DE',
  francja: 'FR', france: 'FR',
  włochy: 'IT', wlochy: 'IT', italy: 'IT', italia: 'IT',
  holandia: 'NL', netherlands: 'NL',
  portugalia: 'PT', portugal: 'PT',
  belgia: 'BE', belgium: 'BE',
  austria: 'AT',
  dania: 'DK', denmark: 'DK', danmark: 'DK',
  szwecja: 'SE', sweden: 'SE',
  irlandia: 'IE', ireland: 'IE', éire: 'IE',
  czechy: 'CZ', 'czech republic': 'CZ', česko: 'CZ',
  słowacja: 'SK', slowacja: 'SK', slovakia: 'SK',
  węgry: 'HU', wegry: 'HU', hungary: 'HU',
  rumunia: 'RO', romania: 'RO',
  bułgaria: 'BG', bulgaria: 'BG',
  chorwacja: 'HR', croatia: 'HR',
  słowenia: 'SI', slowenia: 'SI', slovenia: 'SI',
  litwa: 'LT', lithuania: 'LT',
  łotwa: 'LV', lotwa: 'LV', latvia: 'LV',
  estonia: 'EE',
  finlandia: 'FI', finland: 'FI',
  cypr: 'CY', cyprus: 'CY',
  malta: 'MT',
  luksemburg: 'LU', luxembourg: 'LU',
  grecja: 'GR', greece: 'GR',
};

const LEGAL_FORM_TO_COUNTRY = [
  { re: /\b(s\.?\s?l\.?\s?u\.?|s\.?\s?l\.?|sociedad limitada)\b/i, country: 'ES' },
  { re: /\b(s\.?\s?a\.?|sociedad an[oó]nima)\b/i, country: 'ES' },
  { re: /\bgmbh\b/i, country: 'DE' },
  { re: /\bag\b/i, country: 'DE' },
  { re: /\bs\.?\s?r\.?\s?l\.?\b/i, country: 'IT' },
  { re: /\bs\.?\s?p\.?\s?a\.?\b/i, country: 'IT' },
  { re: /\bb\.?\s?v\.?\b/i, country: 'NL' },
  { re: /\bs\.?\s?a\.?\s?s\.?\b/i, country: 'FR' },
  { re: /\bs\.?\s?à\.?\s?r\.?\s?l\.?\b/i, country: 'FR' },
  { re: /\bs\.?\s?p\.?\s?z\s?o\.?\s?o\.?\b/i, country: 'PL' },
  { re: /\bltd\b/i, country: 'GB' },
];

// Sprowadza dowolny zapis kraju do ISO-2 ("Polska"/"POLSKA"/"Poland"/"PL"
// → "PL"). Zwraca null gdy nie da się rozpoznać. Używamy WSZĘDZIE gdzie
// czytamy country — bo iFirma/VIES zwracają pełne nazwy ("Polska",
// "Hiszpania"), a w bazie Contractor mamy mix ("PL", "POLSKA", null).
function normalizeIso(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  const key = v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (key === 'polska' || key === 'poland') return 'PL';
  return COUNTRY_NAME_TO_CODE[key] || null;
}

// Wyciąga prefiks UE z NIP-u (np. "ES36100525R" → "ES"). Zwraca null
// gdy NIP polski (10 cyfr) lub nie pasuje do schematu UE.
function nipPrefixToCountry(nip) {
  if (!nip) return null;
  const clean = nip.replace(/[\s.-]/g, '').toUpperCase();
  const m = clean.match(/^([A-Z]{2})[A-Z0-9]+$/);
  if (!m) return null;
  const prefix = m[1];
  if (prefix === 'EL') return 'GR';
  return EU_VAT_PREFIXES.has(prefix) ? prefix : null;
}

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
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
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
  const words = q.split(' ').filter(w => w.length > 1);
  const candidates = catalog.filter(p => {
    const nv = normalize((p.name || '') + ' ' + (p.variant || ''));
    return words.every(w => nv.includes(w));
  });

  if (candidates.length === 1) return candidates[0];

  if (candidates.length > 1) {
    // Prefer non-generic, then shortest match
    const nonGeneric = candidates.filter(c => !c.ean.startsWith('STICK-') && !c.ean.startsWith('MASCARA-'));
    const pool = nonGeneric.length ? nonGeneric : candidates;
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
      const all = await prisma.contractor.findMany({
        select: { id: true, name: true, nip: true, country: true, email: true, address: true, city: true, extras: true },
      });
      const scored = all
        .map(c => ({ contractor: c, score: scoreContractor(c, contractorSearch) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score);

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
    const rodzaj = waluta === 'EUR' ? 'wdt' : 'krajowa';

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

    // Load product catalog for fuzzy lookup
    const catalog = await prisma.product.findMany({ where: { active: true } });

    const pozycje = [];
    for (const item of parsedItems) {
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

    const linee = pozycje.map(({ product: p, ilosc, itemCena, itemCenaNetto }) => {
      const { cena, isNetto, source } = resolvePrice(itemCena, itemCenaNetto, contractor.name, contractor.extras);
      console.log(`[invoice-preview] price for ${contractor.name}: ${cena} ${isNetto ? 'netto' : 'brutto'} (source: ${source})`);
      const wartosc = Math.round(cena * ilosc * 100) / 100;
      return { ean: p.ean, nazwa: p.name, wariant: p.variant || null, ilosc, cena, cenaNetto: isNetto ? cena : null, wartosc, priceSource: source };
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
    const terminPlatnosci = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const vatMode = rodzaj === 'wdt' ? 'WDT 0%' : `krajowa VAT ${Math.round(0.23 * 100)}%`;
    const preview = {
      contractor: { id: contractor.id, name: contractor.name, nip: contractor.nip, country: contractor.country, address: contractor.address },
      waluta,
      rodzaj,
      vatMode,
      derivedCountry: derived.country,
      derivedCountrySource: derived.source,
      pozycje: linee,
      suma: { brutto, netto, vat },
      terminPlatnosci,
    };

    const previewId = require('crypto').randomUUID();
    savePreview(previewId, { preview, contractorData: contractor, pozycjeData: linee, waluta, rodzaj, priceMode });

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

    const reqChatId = req.body && req.body.chatId;
    const tgTokenCfg = await prisma.config.findUnique({ where: { key: 'telegram_bot_token' } });
    const tgChatCfg = reqChatId
      ? { value: String(reqChatId) }
      : await prisma.config.findUnique({ where: { key: 'telegram_chat_id' } });
    const tgToken = (process.env.TELEGRAM_BOT_TOKEN || (tgTokenCfg && tgTokenCfg.value) || '').trim();
    const tgChat = tgChatCfg && tgChatCfg.value;
    console.log(`[ifirma confirm-latest] tg → chat=${tgChat} (source=${reqChatId ? 'request' : 'config'}) token=...${tgToken.slice(-4)}`);

    let ifirmaResult;
    try {
      const cExtras = contractor.extras || {};
      const billing = (cExtras.billingAddress && typeof cExtras.billingAddress === 'object') ? cExtras.billingAddress : {};
      ifirmaResult = await createInvoice({
        kontrahent: {
          name: contractor.name,
          nip: contractor.nip,
          address: contractor.address || billing.street || cExtras.street || '',
          city: contractor.city || billing.city || cExtras.city || '',
          postCode: billing.postCode || cExtras.postCode || '',
          country: contractor.country || billing.country || '',
          ifirmaId: cExtras.ifirmaId || null,
        },
        pozycje,
        rodzaj,
        priceMode,
      });
    } catch (ifirmaErr) {
      const raw = ifirmaErr.ifirmaRaw || null;
      const kod = raw && raw.response && raw.response.Kod;
      const info = raw && raw.response && raw.response.Informacja;
      console.log('[invoice-confirm] sending iFirma response to Telegram (error)');
      if (tgToken && tgChat) {
        sendTelegram(tgToken, tgChat,
          `IFIRMA ODPOWIEDŹ:\nStatus: BŁĄD\nKod: ${kod != null ? kod : '?'}\nInformacja: ${info || ifirmaErr.message}\nKontrahent: ${contractor.name}\nPełna odpowiedź: ${JSON.stringify(raw)}`
        ).catch(e => console.error('[invoice-confirm] tg error:', e.message));
      }
      return res.json({ ok: false, error: 'iFirma error', ifirmaResponse: raw });
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
        dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        grossAmount: brutto,
        currency: waluta,
        paidAmount: 0,
        status: 'unpaid',
        type: rodzaj,
        extras: {
          pozycje: pozycje.map(p => ({ ean: p.ean, nazwa: p.nazwa, ilosc: p.ilosc, pricePLN: p.cena, priceEUR: p.cena })),
          items: pozycje.map(p => ({ name: p.nazwa, variant: p.wariant || null, qty: p.ilosc, ean: p.ean, priceNetto: p.cena })),
        },
      },
    });

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

    const cExtras2 = contractor.extras || {};
    const billing2 = (cExtras2.billingAddress && typeof cExtras2.billingAddress === 'object') ? cExtras2.billingAddress : {};
    const ifirmaResp = await createInvoice({
      kontrahent: {
        name: contractor.name,
        nip: contractor.nip,
        address: contractor.address || billing2.street || cExtras2.street || '',
        city: contractor.city || billing2.city || cExtras2.city || '',
        postCode: billing2.postCode || cExtras2.postCode || '',
        country: contractor.country || billing2.country || '',
      },
      pozycje,
      waluta,
      rodzaj,
      priceMode: storedPriceMode,
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
        dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        grossAmount: brutto,
        currency: waluta,
        paidAmount: 0,
        status: 'unpaid',
        type: rodzaj,
        extras: {
          pozycje: pozycje.map(p => ({ ean: p.ean, nazwa: p.nazwa, ilosc: p.ilosc, pricePLN: p.cena, priceEUR: p.cena })),
          items: pozycje.map(p => ({ name: p.nazwa, variant: p.wariant || null, qty: p.ilosc, ean: p.ean, priceNetto: p.cena })),
        },
      },
    });

    const pdfBuffer = await fetchInvoicePdf(pelnyNumer, rodzaj);

    let pdfSent = false;
    try {
      // chatId per-request (od kogo idzie żądanie) ma pierwszeństwo nad
      // statycznym Config — bez tego PDF leciał zawsze do telegram_chat_id
      // z Config niezależnie od tego kto pisał.
      const reqChatId = req.body && req.body.chatId;
      const tokenCfg = await prisma.config.findUnique({ where: { key: 'telegram_bot_token' } });
      const chatCfg = reqChatId
        ? { value: String(reqChatId) }
        : await prisma.config.findUnique({ where: { key: 'telegram_chat_id' } });
      const token = (process.env.TELEGRAM_BOT_TOKEN || (tokenCfg && tokenCfg.value) || '').trim();
      const chatId = chatCfg && chatCfg.value;
      console.log(`[ifirma confirm] tg → chat=${chatId} (source=${reqChatId ? 'request' : 'config'}) token=...${token.slice(-4)}`);

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
        where: { contractorId: invoice.contractorId, direction: 'OUTBOUND', toEmail: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { toEmail: true },
      });
      if (lastOut && lastOut.toEmail) {
        to = lastOut.toEmail;
        emailSource = 'email_history_outbound';
      } else {
        const lastIn = await prisma.email.findFirst({
          where: { contractorId: invoice.contractorId, direction: 'INBOUND', fromEmail: { not: null } },
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
          select: { fromEmail: true, toEmail: true, direction: true, fromName: true },
        });
        const isPlaceholder = (e) => !e || /(example|test|fake|placeholder|domain)\.(com|org|net|pl)$/i.test(e);
        const isFromUs = (e) => !e || /surfstickbell|surf-stick-bell/i.test(e);
        for (const c of candidates) {
          const candidate = c.direction === 'INBOUND' ? c.fromEmail : c.toEmail;
          if (!candidate) continue;
          if (isPlaceholder(candidate)) continue;
          if (isFromUs(candidate)) continue; // nasz adres, pomijamy
          to = candidate;
          emailSource = 'email_history_fuzzy';
          break;
        }
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
      EN: { subject: 'Invoice {n} - Surf Stick Bell', body: 'Hello,\n\nPlease find the invoice attached.\n\nBest regards,\nMichał Pałyska\nSurf Stick Bell', html: 'Hello,<br><br>Please find the invoice attached.<br><br>Best regards,<br>Michał Pałyska<br>Surf Stick Bell' },
    };
    // Resolve language with cascade priority:
    //   1. recipient email TLD (.fr/.es/.de/.it/.pt/.pl) — strongest signal
    //   2. contractor.country (DB)
    //   3. detect from original email body when reply-in-thread
    //   4. EN fallback
    function tldToLang(email) {
      if (!email) return null;
      const m = String(email).toLowerCase().match(/@[^@\s]+\.([a-z]{2,3})$/);
      if (!m) return null;
      const tld = m[1];
      const map = { fr: 'FR', es: 'ES', de: 'DE', it: 'IT', pt: 'PT', pl: 'PL' };
      return map[tld] || null;
    }
    function detectLangFromBody(text) {
      if (!text) return null;
      const t = String(text).toLowerCase();
      const patterns = [
        { lang: 'FR', words: ['bonjour', 'cordialement', 'merci', 'votre', 'pouvez', 'nous sommes'] },
        { lang: 'ES', words: ['hola', 'saludos', 'gracias', 'buenos días', 'buenas tardes', 'estaríamos', 'estamos', 'somos'] },
        { lang: 'IT', words: ['buongiorno', 'grazie', 'cordiali saluti', 'siamo', 'vorrei'] },
        { lang: 'PT', words: ['olá', 'obrigado', 'cumprimentos', 'estamos', 'somos'] },
        { lang: 'DE', words: ['guten tag', 'mit freundlichen', 'danke', 'wir sind', 'ihre'] },
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

    let lang = tldToLang(to);
    let langSource = lang ? 'tld' : null;
    if (!lang && TEMPLATES[country]) { lang = country; langSource = 'contractor.country'; }
    if (!lang && emailId) {
      try {
        const orig = await prisma.email.findUnique({ where: { id: emailId }, select: { bodyFull: true, bodyPreview: true } });
        const detected = detectLangFromBody((orig && (orig.bodyFull || orig.bodyPreview)) || '');
        if (detected && TEMPLATES[detected]) { lang = detected; langSource = 'email_body'; }
      } catch (_) { /* ignore */ }
    }
    if (!lang) { lang = 'EN'; langSource = 'fallback'; }
    const tpl = TEMPLATES[lang];
    const defaultBody = tpl.body;
    const defaultHtml = tpl.html;
    if (!customSubject) subject = tpl.subject.replace('{n}', invoice.number);
    console.log(`[send-invoice-email] language: ${lang} (source=${langSource}, to=${to}, country=${country || 'null'})`);

    const sentBody = customBody || defaultBody;
    const savedEmail = await sendMail({
      from,
      to,
      subject,
      body: sentBody,
      html: customBody ? undefined : defaultHtml,
      inReplyTo,
      references,
      attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
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

    const all = await prisma.contractor.findMany({ select: { id: true, name: true, nip: true, country: true, email: true, extras: true } });
    const scored = all.map(c => ({ c, score: scoreContractor(c, contractorSearch) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    if (!scored.length) return res.status(404).json({ error: 'Nie znaleziono kontrahenta: ' + contractorSearch });
    const contractor = scored[0].c;

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

    const [tgTokenCfg, tgChatCfg] = await Promise.all([
      prisma.config.findUnique({ where: { key: 'telegram_bot_token' } }),
      prisma.config.findUnique({ where: { key: 'telegram_chat_id' } }),
    ]);
    const tgToken = tgTokenCfg && tgTokenCfg.value;
    const tgChat = tgChatCfg && tgChatCfg.value;

    // Find contractor by sender
    const all = await prisma.contractor.findMany({
      select: { id: true, name: true, nip: true, country: true, email: true, address: true, city: true, extras: true },
    });
    const scored = all
      .map(c => ({ contractor: c, score: scoreContractor(c, sender) }))
      .filter(x => x.score >= 40)
      .sort((a, b) => b.score - a.score);

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

    const tgTokenCfg = await prisma.config.findUnique({ where: { key: 'telegram_bot_token' } });
    const tgChatCfg = await prisma.config.findUnique({ where: { key: 'telegram_chat_id' } });
    const tgToken = (process.env.TELEGRAM_BOT_TOKEN || (tgTokenCfg && tgTokenCfg.value) || '').trim();
    const reqChatId = req.body && req.body.chatId;
    const tgChat = reqChatId || (tgChatCfg && tgChatCfg.value);
    console.log(`[ifirma resend-pdf] tg → chat=${tgChat} (source=${reqChatId ? 'request' : 'config'}) token=...${tgToken.slice(-4)}`);
    if (!tgToken || !tgChat) {
      return res.status(500).json({ error: 'Brak telegram_bot_token lub telegram_chat_id w konfiguracji.' });
    }

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

module.exports = router;
