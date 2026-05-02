'use strict';

// Shared helpers for the Contasimple (ES) invoice flow: fuzzy contractor
// lookup, fuzzy product lookup, box/template expansion, and IGIC totals.
// Mirrors the iFirma equivalents in src/routes/invoices.js so the agent
// behaviour matches between PL and ES (preview/confirm UX, "stick generic",
// "box collection" expansion). Two key differences from PL:
//   - tax: IGIC 7% (not VAT 23%)
//   - currency: EUR only

const { scoreContractor } = require('./contractor-match');

const IGIC_DEFAULT_PCT = 7;

// ============ CONTRACTOR FUZZY LOOKUP ============

// Picks the best EsContractor by name/CIF/aliases. scoreContractor expects
// `nip` field — EsContractor stores it as `nif`, so we shim before scoring.
async function findEsContractor(prisma, search) {
  if (!search) return { contractor: null, suggestions: [] };

  const all = await prisma.esContractor.findMany({
    select: {
      id: true,
      name: true,
      organization: true,
      nif: true,
      country: true,
      email: true,
      address: true,
      city: true,
      postalCode: true,
      extras: true,
    },
  });

  const scored = all
    .map(c => ({
      contractor: c,
      score: scoreContractor({ ...c, nip: c.nif }, search),
    }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best && best.score >= 50) {
    const full = await prisma.esContractor.findUnique({ where: { id: best.contractor.id } });
    return { contractor: full, suggestions: [] };
  }

  return {
    contractor: null,
    suggestions: scored.slice(0, 5).map(x => ({
      id: x.contractor.id,
      name: x.contractor.name,
      organization: x.contractor.organization,
      nif: x.contractor.nif,
      score: x.score,
    })),
  };
}

// ============ PRODUCT FUZZY LOOKUP ============

function normalize(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 1:1 of findProductFuzzy from src/routes/invoices.js — kept local so the
// PL function can evolve without dragging ES along (different catalogs,
// different generic-prefixes). Plus an extra rule: prefer non-template
// products unless the query explicitly mentions a "box" keyword — without
// this, "stick" fuzzy-matches both BOX-STICK-ES (14 chars, wins length sort)
// and SURF STICK zinc stick (28 chars), accidentally expanding 1 stick into
// the whole 30-piece box.
const BOX_KEYWORDS = /\b(box|pudelko|pudlo|kartonik|collection|coleccion|colecc)\b/;

function findEsProductFuzzy(catalog, query) {
  if (!query) return null;
  const q = normalize(query);
  if (!q) return null;

  const eanInput = query.toString().trim().toUpperCase().replace(/\s+/g, '-');
  const byEanCI = catalog.find(p => p.ean && p.ean.toUpperCase() === eanInput);
  if (byEanCI) return byEanCI;
  const noHyphen = eanInput.replace(/-/g, '');
  const byEanNoHyphen = catalog.find(p => p.ean && p.ean.toUpperCase().replace(/-/g, '') === noHyphen);
  if (byEanNoHyphen) return byEanNoHyphen;

  const byEan = catalog.find(p => p.ean === query.toString());
  if (byEan) return byEan;

  const byExact = catalog.find(p => normalize((p.name || '') + ' ' + (p.variant || '')) === q);
  if (byExact) return byExact;

  const words = q.split(' ').filter(w => w.length > 1);
  const candidates = catalog.filter(p => {
    const nv = normalize((p.name || '') + ' ' + (p.variant || ''));
    return words.every(w => nv.includes(w));
  });

  if (candidates.length === 1) return candidates[0];

  if (candidates.length > 1) {
    // Disambiguate template vs product based on whether the query mentions
    // a box keyword. "stick" → product. "box stick" → template.
    const isBoxQuery = BOX_KEYWORDS.test(q);
    let pool = candidates;
    if (isBoxQuery) {
      const templates = candidates.filter(c => c.category === 'template');
      if (templates.length) pool = templates;
    } else {
      const nonTemplate = candidates.filter(c => c.category !== 'template');
      if (nonTemplate.length) pool = nonTemplate;
    }

    const nonGeneric = pool.filter(c => !(c.ean || '').startsWith('STICK-') && !(c.ean || '').startsWith('MASCARA-'));
    if (nonGeneric.length) pool = nonGeneric;

    pool.sort((a, b) => {
      const nvA = normalize((a.name || '') + ' ' + (a.variant || ''));
      const nvB = normalize((b.name || '') + ' ' + (b.variant || ''));
      return nvA.length - nvB.length;
    });
    return pool[0];
  }

  return null;
}

// ============ EXPAND ITEMS (with box/template support) ============
//
// items: [{ name?, ean?, qty, priceNetto?, priceBrutto? }, ...]
// returns: array of { product, qty, priceNetto?, priceBrutto? } where each
// `product` is a real EsProduct row (templates are expanded into their
// composition, with original qty multiplied through).
async function expandEsLines(prisma, items, opts = {}) {
  const { globalPriceNetto, globalPriceBrutto } = opts;

  const catalog = await prisma.esProduct.findMany({ where: { active: true } });
  const positions = [];

  for (const item of items) {
    const ean = item.ean ? String(item.ean).trim() : null;
    let product = null;

    if (ean) product = catalog.find(p => p.ean === ean);

    if (!product) {
      const query = [item.name, item.productName, item.product, item.variant, item.color]
        .filter(Boolean)
        .join(' ');
      if (query) product = findEsProductFuzzy(catalog, query);
    }

    if (!product && ean) {
      product = await prisma.esProduct.findUnique({ where: { ean } });
    }

    if (!product) {
      const searchedFor = ean || item.name || item.productName || item.product || 'unknown';
      const err = new Error(`product not found: ${searchedFor}`);
      err.status = 404;
      throw err;
    }

    if (product.category === 'template' && product.extras && Array.isArray(product.extras.composition)) {
      // Template (box, collection, mix) — expand into individual products.
      // Composition entries reference children by ean (preferred) or name.
      for (const comp of product.extras.composition) {
        let sub = null;
        if (comp.ean) sub = await prisma.esProduct.findUnique({ where: { ean: comp.ean } });
        if (!sub && comp.contasimpleId) sub = await prisma.esProduct.findUnique({ where: { contasimpleId: comp.contasimpleId } });
        if (!sub && comp.name) sub = catalog.find(p => normalize(p.name) === normalize(comp.name)) || null;
        if (!sub) continue;
        positions.push({
          product: sub,
          qty: comp.qty * (item.qty || 1),
          priceNetto: null,
          priceBrutto: null,
        });
      }
    } else {
      let priceNetto = null;
      let priceBrutto = null;

      if (item.priceNetto != null) priceNetto = parseFloat(item.priceNetto);
      else if (item.priceBrutto != null) priceBrutto = parseFloat(item.priceBrutto);
      else if (item.price != null) priceBrutto = parseFloat(item.price);
      else if (globalPriceNetto != null) priceNetto = parseFloat(globalPriceNetto);
      else if (globalPriceBrutto != null) priceBrutto = parseFloat(globalPriceBrutto);

      positions.push({
        product,
        qty: item.qty || 1,
        priceNetto,
        priceBrutto,
      });
    }
  }

  return positions;
}

// ============ TOTALS (IGIC 7%) ============
//
// Resolves the unit price for each position (override → catalog default),
// computes per-line and grand totals. priceMode is "netto" if any input
// arrived as netto; otherwise "brutto" (gross).
function buildEsTotals(positions, opts = {}) {
  const igicPct = opts.igicPct != null ? Number(opts.igicPct) : IGIC_DEFAULT_PCT;
  const igicFactor = 1 + igicPct / 100;

  // Catalog priceEUR is netto (matches Contasimple unitTaxableAmount).
  // priceMode reflects how the prices were sourced — informational only,
  // since unitNetto is always normalized to netto for createInvoice.
  const hasNettoOverride = positions.some(p => p.priceNetto != null) || opts.globalPriceNetto != null;
  const hasBruttoOverride = positions.some(p => p.priceBrutto != null) || opts.globalPriceBrutto != null;
  let priceMode;
  if (hasNettoOverride && hasBruttoOverride) priceMode = 'mixed';
  else if (hasBruttoOverride) priceMode = 'brutto';
  else if (hasNettoOverride) priceMode = 'netto';
  else priceMode = 'netto'; // catalog default — Contasimple unitTaxableAmount = netto

  const lines = positions.map(({ product, qty, priceNetto, priceBrutto }) => {
    let unitNetto;
    let priceSource;

    if (priceNetto != null) {
      unitNetto = priceNetto;
      priceSource = 'override_netto';
    } else if (priceBrutto != null) {
      unitNetto = round2(priceBrutto / igicFactor);
      priceSource = 'override_brutto';
    } else {
      unitNetto = Number(product.priceEUR);
      priceSource = 'catalog';
    }

    const lineNetto = round2(unitNetto * qty);
    const lineIgic = round2(lineNetto * (igicPct / 100));
    const lineBrutto = round2(lineNetto + lineIgic);

    return {
      ean: product.ean,
      contasimpleProductId: product.contasimpleId || null,
      name: product.name,
      variant: product.variant || null,
      qty,
      unitNetto,
      vatPercentage: igicPct,
      lineNetto,
      lineIgic,
      lineBrutto,
      priceSource,
    };
  });

  const totalNetto = round2(lines.reduce((s, l) => s + l.lineNetto, 0));
  const totalIgic = round2(lines.reduce((s, l) => s + l.lineIgic, 0));
  const totalBrutto = round2(totalNetto + totalIgic);

  return { lines, totals: { netto: totalNetto, igic: totalIgic, brutto: totalBrutto, vatPct: igicPct }, priceMode };
}

// ============ CONTASIMPLE PAYLOAD BUILDER ============
//
// Translates our preview lines into the body shape Contasimple expects on
// POST /accounting/{period}/invoices/issued. Defaults reflect Nikodem's
// existing setup (numberingFormatId=1285771, invoiceClass=700,
// operationType=Nacional, expirationDate = invoiceDate + 7 days).

const NIKODEM_DEFAULTS = {
  numberingFormatId: 1285771,
  invoiceClass: 700, // "Venta de mercaderías"
  operationType: 'Nacional',
  paymentTermDays: 7,
};

function buildContasimplePayload({ targetEntityId, lines, invoiceDate, overrides = {} }) {
  const date = invoiceDate || new Date().toISOString();
  const dueDate = new Date(new Date(date).getTime() + NIKODEM_DEFAULTS.paymentTermDays * 24 * 60 * 60 * 1000);

  return {
    targetEntityId,
    number: overrides.number || '', // required by Contasimple — caller must fetch via getNextInvoiceNumber
    numberingFormatId: overrides.numberingFormatId || NIKODEM_DEFAULTS.numberingFormatId,
    invoiceClass: overrides.invoiceClass || NIKODEM_DEFAULTS.invoiceClass,
    operationType: overrides.operationType || NIKODEM_DEFAULTS.operationType,
    date,
    expirationDate: overrides.expirationDate || dueDate.toISOString(),
    notes: overrides.notes || '',
    footer: overrides.footer || '', // empty → Contasimple uses company default
    uiCulture: overrides.uiCulture || 'es-ES',
    lines: lines.map(l => {
      const concept = l.name + (l.variant ? ` ${l.variant}` : '');
      const lineNetto = l.lineNetto;
      const lineIgic = l.lineIgic;
      // Contasimple's API binder is inconsistent: most fields accept camelCase
      // (unitAmount, quantity, vatPercentage), but totalTaxableAmount,
      // vatAmount and productName silently get dropped to zero/null when sent
      // in camelCase — the server then validates the post-bind values against
      // its computed totals and rejects with TaxableAmountDiscrepancy. Sending
      // the same values under PascalCase keys (matching the underlying entity
      // names) lets them through. We send both shapes; whichever the binder
      // accepts wins.
      return {
        concept,
        unitAmount: l.unitNetto,
        quantity: l.qty,
        vatPercentage: l.vatPercentage,
        vatAmount: lineIgic,
        VatAmount: lineIgic,
        VATAmount: lineIgic,
        rePercentage: 0,
        reAmount: 0,
        totalTaxableAmount: lineNetto,
        TotalTaxableAmount: lineNetto,
        discountPercentage: 0,
        detailedDescription: '',
        productId: l.contasimpleProductId || 0,
        productName: l.name,
        ProductName: l.name,
        productSku: '',
      };
    }),
  };
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

module.exports = {
  IGIC_DEFAULT_PCT,
  NIKODEM_DEFAULTS,
  findEsContractor,
  findEsProductFuzzy,
  expandEsLines,
  buildEsTotals,
  buildContasimplePayload,
};
