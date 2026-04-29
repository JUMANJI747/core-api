'use strict';

const pdfParse = require('pdf-parse');

// Parse iFirma invoice PDF text into items. The layout pdf-parse extracts
// is column-interleaved and inconsistent across invoice types (krajowa, WDT,
// eksport), so we try two strategies:
//
//   FORMAT A — single-line rows: "<qty> szt. <price> CCY <amount> CCY <vat>%"
//     (seen on FakturaEksportTowarów)
//   FORMAT B — scattered fields where qty, price, name live in separate
//     blocks; we recover qty either from explicit "Ilość Qty <n>" marker
//     or by computing amount / priceNetto.
//
// Returns: { items: [{ name, qty, priceNetto, currency, vatRate }], rawText }
async function parseIfirmaPdfItems(pdfBytes) {
  const data = await pdfParse(pdfBytes);
  const text = data.text || '';

  let items = parseFormatA(text);
  if (items.length === 0) items = parseFormatB(text);

  return { items, rawText: text };
}

function parseFormatA(text) {
  const namePattern = /Lp\.\s*No\.\s*(\d+)\.\s*([\s\S]+?)(?=\s*(?:Lp\.\s*No\.|PODSUMOWANIE|SUMMARY|Ilość|Qty|Razem|Total|$))/g;
  const names = [];
  let m;
  while ((m = namePattern.exec(text)) !== null) {
    const cleaned = m[2]
      .replace(/\s+/g, ' ')
      .replace(/\b(PODSUMOWANIE|SUMMARY|Ilość|Qty|Jedn\.|Unit|Cena|jedn\.|netto|Wartość|Net amount|Stawka|VAT rate|Nazwa.*)\b/gi, '')
      .trim();
    names.push({ idx: parseInt(m[1], 10), name: cleaned });
  }

  const rowPattern = /(\d+(?:\s\d{3})*)\s+szt\.?\s+([\d\s]+,\d{2})\s+(EUR|PLN|USD|GBP|CHF)\s+([\d\s]+,\d{2})\s+(EUR|PLN|USD|GBP|CHF)\s+(\d+)%/g;
  const rows = [];
  while ((m = rowPattern.exec(text)) !== null) {
    rows.push({
      qty: parseInt(m[1].replace(/\s/g, ''), 10),
      priceNetto: parseFloat(m[2].replace(/\s/g, '').replace(',', '.')),
      currency: m[3],
      vatRate: parseInt(m[6], 10),
    });
  }

  const items = [];
  const count = Math.min(names.length, rows.length);
  for (let i = 0; i < count; i++) {
    items.push({
      name: names[i].name || 'Unknown',
      qty: rows[i].qty,
      priceNetto: rows[i].priceNetto,
      currency: rows[i].currency,
      vatRate: rows[i].vatRate,
    });
  }
  return items;
}

function parseFormatB(text) {
  // 1. Item names — "<n>. <name>" lines (PL name; EN duplicate on next line).
  // Bound to lines that look like product titles (start with a letter).
  const names = [];
  const nameRe = /(^|\n)\s*(\d+)\.\s+([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż][^\n]{1,100})/g;
  let m;
  while ((m = nameRe.exec(text)) !== null) {
    const idx = parseInt(m[2], 10);
    const name = m[3].trim().replace(/\s+/g, ' ');
    if (!names.find(n => n.idx === idx)) names.push({ idx, name });
  }

  // 2. Price / amount / vat triples. Stop scanning at "Razem"/"Total"
  // so we don't pick up the SUMMARY row (netto / VAT / brutto).
  const beforeTotal = text.split(/Razem\s*:|Total\s*:/i)[0] || text;
  const tripleRe = /([\d\s]+,\d{2})\s+(EUR|PLN|USD|GBP|CHF)\s+([\d\s]+,\d{2})\s+\2\s+(\d+)%/g;
  const triples = [];
  while ((m = tripleRe.exec(beforeTotal)) !== null) {
    const priceNetto = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
    const amount = parseFloat(m[3].replace(/\s/g, '').replace(',', '.'));
    // Skip rows where price == amount (likely netto/brutto SUMMARY row, not an item).
    if (priceNetto === amount) continue;
    triples.push({ priceNetto, currency: m[2], amount, vatRate: parseInt(m[4], 10) });
  }

  // 3. Quantities — explicit "Ilość Qty <n>" markers (one per item).
  const qtyRe = /Ilość\s+Qty\s+(\d+(?:\s\d{3})*)/g;
  const qties = [];
  while ((m = qtyRe.exec(text)) !== null) {
    qties.push(parseInt(m[1].replace(/\s/g, ''), 10));
  }

  const items = [];
  const count = Math.min(names.length, triples.length);
  for (let i = 0; i < count; i++) {
    const t = triples[i];
    let qty = qties[i];
    if (!qty && t.priceNetto > 0) qty = Math.round(t.amount / t.priceNetto);
    items.push({
      name: names[i].name,
      qty: qty || 1,
      priceNetto: t.priceNetto,
      currency: t.currency,
      vatRate: t.vatRate,
    });
  }
  return items;
}

module.exports = { parseIfirmaPdfItems };
