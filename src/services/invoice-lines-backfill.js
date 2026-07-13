'use strict';

/**
 * CRM v2 Etap 2.2/2.3 — backfill InvoiceLineItem + EsInvoiceLineItem z
 * extras.{pozycje|items|lines|previewLines} starych FV.
 *
 * Zrodla pozycji per FV (PL Invoice.extras):
 *   - extras.pozycje  [{ean, nazwa, ilosc, pricePLN|priceEUR}]  ← preferowane,
 *                                                                  ma cene
 *   - extras.items    [{name, qty, productEan, priceNetto?}]    ← z ifirma-sync
 *                                                                  (minimal)
 *
 * Zrodla pozycji per FV (EsInvoice.extras):
 *   - extras.previewLines [{ean, name, variant, qty, unitNetto,
 *                            vatPercentage, lineNetto, lineIgic,
 *                            lineBrutto}]                        ← preferowane,
 *                                                                  zawiera EAN
 *   - extras.lines        [{concept, unitAmount, quantity,
 *                            vatPercentage, vatAmount,
 *                            totalTaxableAmount}]                ← Contasimple
 *                                                                  response shape
 *
 * Heurystyki:
 *   - PL vatRate: brak na lvl pozycji w extras → wnioskujemy z FV. Currency
 *     != PLN → "0" (WDT/eksport). Currency PLN → "23" domyslnie. Mark
 *     extras.vatInferred=true zeby NocoDB pokazal flage do rewizji.
 *   - PL gdy extras.pozycje ma price → traktuj jako netto (taki shape uzywaja
 *     nasze /invoice-confirm preview). Brutto liczymy: netto + netto*vatRate.
 *   - PL bez ceny per line (extras.items only) → spróbuj rozliczyc po
 *     proporcji qty na grossAmount FV. Mark extras.priceInferred=true.
 *   - ES previewLines maja juz unitNetto + lineIgic + lineBrutto → mapowanie
 *     1:1 bez heurystyk.
 *   - ES extras.lines z Contasimple — vatPercentage juz mamy.
 *
 * Idempotent: invoice z istniejacym InvoiceLineItem (count>0) jest pomijany
 * niezaleznie od flagi apply. Force-rerun wymagalby manual delete (osobne
 * narzedzie, nie dorzucam tutaj zeby nie strzelic sobie w stope).
 *
 * Wolane z POST /api/admin/backfill/invoice-lines.
 */

// VAT pozycji: najpierw z RODZAJU faktury (Invoice.type: wdt/eksport → 0%,
// krajowa → 23% — także krajowa w EUR i WDT w PLN), fallback z waluty
// (historyczne rekordy bez type).
function inferVatRatePl(currency, type) {
  const t = String(type || '').toLowerCase();
  if (t === 'wdt' || /eksport|dostawa_ue/.test(t)) return '0';
  if (t === 'krajowa') return '23';
  if (!currency) return '23';
  return currency.toUpperCase() === 'PLN' ? '23' : '0';
}

function vatFactor(rateStr) {
  if (!rateStr || rateStr === 'ZW' || rateStr === 'NP' || rateStr === 'EX') return 0;
  const n = parseFloat(rateStr);
  if (isNaN(n)) return 0;
  return n / 100;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function buildPlLinesFromPozycje(invoice, pozycje) {
  const vatRate = inferVatRatePl(invoice.currency, invoice.type);
  const factor = vatFactor(vatRate);
  return pozycje.map((p, idx) => {
    const qty = Number(p.ilosc || p.qty || 1);
    // pricePLN i priceEUR w preview oznaczaja netto w walucie FV.
    const unitNetto = Number(
      invoice.currency === 'PLN'
        ? (p.pricePLN != null ? p.pricePLN : p.priceEUR)
        : (p.priceEUR != null ? p.priceEUR : p.pricePLN)
    ) || 0;
    const totalNetto = round2(unitNetto * qty);
    const vatAmount = round2(totalNetto * factor);
    const totalGross = round2(totalNetto + vatAmount);
    return {
      position: idx + 1,
      ean: p.ean || null,
      name: p.nazwa || p.name || '(bez nazwy)',
      unit: 'szt',
      qty,
      unitPriceNetto: unitNetto,
      vatRate,
      vatAmount,
      totalNetto,
      totalGross,
      extras: { source: 'extras.pozycje', vatInferred: true },
    };
  });
}

function buildPlLinesFromItemsProportional(invoice, items) {
  // Mamy tylko qty + name (ifirma-sync items minimal). Cene per pozycja
  // wyliczamy proporcjonalnie do qty z Invoice.grossAmount → priceInferred.
  const vatRate = inferVatRatePl(invoice.currency, invoice.type);
  const factor = vatFactor(vatRate);
  const gross = Number(invoice.grossAmount) || 0;
  const totalQty = items.reduce((s, it) => s + (Number(it.qty || it.ilosc || 1)), 0) || 1;
  return items.map((it, idx) => {
    const qty = Number(it.qty || it.ilosc || 1);
    const share = qty / totalQty;
    const totalGross = round2(gross * share);
    const totalNetto = round2(totalGross / (1 + factor));
    const vatAmount = round2(totalGross - totalNetto);
    const unitNetto = round2(qty > 0 ? totalNetto / qty : 0);
    return {
      position: idx + 1,
      ean: it.productEan || it.ean || null,
      name: it.name || it.nazwa || '(bez nazwy)',
      unit: 'szt',
      qty,
      unitPriceNetto: unitNetto,
      vatRate,
      vatAmount,
      totalNetto,
      totalGross,
      extras: { source: 'extras.items', vatInferred: true, priceInferred: true },
    };
  });
}

function buildEsLinesFromPreview(esInvoice, previewLines) {
  return previewLines.map((l, idx) => {
    const qty = Number(l.qty || l.quantity || 1);
    const unitNetto = Number(l.unitNetto || l.unitAmount || 0);
    const totalNetto = Number(l.lineNetto != null ? l.lineNetto : round2(unitNetto * qty));
    const vatAmount = Number(l.lineIgic != null ? l.lineIgic : 0);
    const totalGross = Number(l.lineBrutto != null ? l.lineBrutto : round2(totalNetto + vatAmount));
    const vatRate = String(l.vatPercentage != null ? l.vatPercentage : '7');
    const name = (l.name || l.concept || '(bez nazwy)') + (l.variant ? ` ${l.variant}` : '');
    return {
      position: idx + 1,
      ean: l.ean || null,
      name,
      unit: 'szt',
      qty,
      unitPriceNetto: unitNetto,
      vatRate,
      vatAmount,
      totalNetto,
      totalGross,
      extras: { source: 'extras.previewLines' },
    };
  });
}

function buildEsLinesFromContasimple(esInvoice, lines) {
  return lines.map((l, idx) => {
    const qty = Number(l.quantity || l.qty || 1);
    const unitNetto = Number(l.unitAmount || 0);
    const totalNetto = Number(l.totalTaxableAmount != null ? l.totalTaxableAmount : round2(unitNetto * qty));
    const vatAmount = Number(l.vatAmount || 0);
    const totalGross = round2(totalNetto + vatAmount);
    const vatRate = String(l.vatPercentage != null ? l.vatPercentage : '7');
    return {
      position: idx + 1,
      ean: null,
      name: l.concept || '(bez nazwy)',
      unit: 'szt',
      qty,
      unitPriceNetto: unitNetto,
      vatRate,
      vatAmount,
      totalNetto,
      totalGross,
      extras: { source: 'extras.lines' },
    };
  });
}

async function resolveProductIdByEan(prisma, ean, cache) {
  if (!ean) return null;
  if (cache.has(ean)) return cache.get(ean);
  const p = await prisma.product.findUnique({ where: { ean }, select: { id: true } }).catch(() => null);
  const id = p ? p.id : null;
  cache.set(ean, id);
  return id;
}

async function resolveEsProductIdByEan(prisma, ean, cache) {
  if (!ean) return null;
  if (cache.has(ean)) return cache.get(ean);
  const p = await prisma.esProduct.findUnique({ where: { ean }, select: { id: true } }).catch(() => null);
  const id = p ? p.id : null;
  cache.set(ean, id);
  return id;
}

async function backfillPl(prisma, { apply, verbose, log }) {
  // Idempotency: bierzemy tylko Invoice ktore nie maja zadnego lineItem.
  // Pre-fetch w jednym strzale przez findMany + include _count, taniej niz
  // count per id.
  const invoices = await prisma.invoice.findMany({
    select: {
      id: true, number: true, currency: true, grossAmount: true, issueDate: true,
      contractorId: true, contractorCountry: true, extras: true,
      _count: { select: { lineItems: true } },
    },
  });

  let scanned = 0, withExisting = 0, withoutSource = 0, touched = 0, linesCreated = 0;
  const productCache = new Map();
  const sample = [];
  const sampleSkipped = [];

  for (const inv of invoices) {
    scanned++;
    if (inv._count.lineItems > 0) { withExisting++; continue; }

    const extras = (inv.extras && typeof inv.extras === 'object') ? inv.extras : {};
    let lines = null;

    if (Array.isArray(extras.pozycje) && extras.pozycje.length) {
      lines = buildPlLinesFromPozycje(inv, extras.pozycje);
    } else if (Array.isArray(extras.items) && extras.items.length) {
      lines = buildPlLinesFromItemsProportional(inv, extras.items);
    }

    if (!lines || lines.length === 0) {
      withoutSource++;
      if (sampleSkipped.length < 10) sampleSkipped.push({ id: inv.id, number: inv.number, reason: 'no extras.pozycje/items' });
      continue;
    }

    // Resolve productId per ean.
    const enriched = [];
    for (const l of lines) {
      const productId = await resolveProductIdByEan(prisma, l.ean, productCache);
      enriched.push({
        invoiceId: inv.id,
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
        currency: inv.currency || 'PLN',
        contractorId: inv.contractorId,
        contractorCountry: inv.contractorCountry,
        issueDate: inv.issueDate,
        ifirmaLineId: null,
        position: l.position,
        extras: l.extras,
      });
    }

    touched++;
    linesCreated += enriched.length;
    if (verbose) log(`  pl ${inv.number || inv.id} -> ${enriched.length} lines`);
    if (sample.length < 10) sample.push({ id: inv.id, number: inv.number, lineCount: enriched.length, source: enriched[0].extras.source });

    if (apply) {
      await prisma.invoiceLineItem.createMany({ data: enriched });
    }
  }

  return { scanned, withExisting, withoutSource, touched, linesCreated, sample, sampleSkipped };
}

async function backfillEs(prisma, { apply, verbose, log }) {
  const invoices = await prisma.esInvoice.findMany({
    select: {
      id: true, number: true, currency: true, invoiceDate: true,
      contractorId: true, contractorCountry: true, extras: true,
      _count: { select: { lineItems: true } },
    },
  });

  let scanned = 0, withExisting = 0, withoutSource = 0, touched = 0, linesCreated = 0;
  const productCache = new Map();
  const sample = [];
  const sampleSkipped = [];

  for (const inv of invoices) {
    scanned++;
    if (inv._count.lineItems > 0) { withExisting++; continue; }

    const extras = (inv.extras && typeof inv.extras === 'object') ? inv.extras : {};
    let lines = null;

    if (Array.isArray(extras.previewLines) && extras.previewLines.length) {
      lines = buildEsLinesFromPreview(inv, extras.previewLines);
    } else if (Array.isArray(extras.lines) && extras.lines.length) {
      lines = buildEsLinesFromContasimple(inv, extras.lines);
    }

    if (!lines || lines.length === 0) {
      withoutSource++;
      if (sampleSkipped.length < 10) sampleSkipped.push({ id: inv.id, number: inv.number, reason: 'no extras.previewLines/lines' });
      continue;
    }

    const enriched = [];
    for (const l of lines) {
      const productId = await resolveEsProductIdByEan(prisma, l.ean, productCache);
      enriched.push({
        esInvoiceId: inv.id,
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
        currency: inv.currency || 'EUR',
        contractorId: inv.contractorId,
        contractorCountry: inv.contractorCountry,
        invoiceDate: inv.invoiceDate,
        contasimpleLineId: null,
        position: l.position,
        extras: l.extras,
      });
    }

    touched++;
    linesCreated += enriched.length;
    if (verbose) log(`  es ${inv.number || inv.id} -> ${enriched.length} lines`);
    if (sample.length < 10) sample.push({ id: inv.id, number: inv.number, lineCount: enriched.length, source: enriched[0].extras.source });

    if (apply) {
      await prisma.esInvoiceLineItem.createMany({ data: enriched });
    }
  }

  return { scanned, withExisting, withoutSource, touched, linesCreated, sample, sampleSkipped };
}

async function runBackfill(prisma, opts = {}) {
  const apply = !!opts.apply;
  const verbose = !!opts.verbose;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  log(`backfill invoice lines (apply=${apply})`);
  const pl = await backfillPl(prisma, { apply, verbose, log });
  const es = await backfillEs(prisma, { apply, verbose, log });

  return { apply, pl, es };
}

module.exports = {
  runBackfill,
  // Eksportowane zeby /invoice-confirm (PL) i /contasimple invoice-confirm (ES)
  // mogly tworzyc lineItems od razu przy zapisie FV — bez backfillu w petli.
  buildPlLinesFromPozycje,
  buildEsLinesFromPreview,
  buildEsLinesFromContasimple,
  resolveProductIdByEan,
  resolveEsProductIdByEan,
};
