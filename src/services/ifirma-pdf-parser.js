'use strict';

const pdfParse = require('pdf-parse');

// Parse iFirma invoice PDF text into items.
// iFirma layout interleaves columns, so we extract:
//   1. names from "Lp. No. <n>. <name>" markers (lookahead trims trailing column labels)
//   2. numeric rows matching "<qty> szt. <price> <CCY> <amount> <CCY> <vat>%"
// Returns: [{ name, qty, priceNetto, currency, vatRate }]
async function parseIfirmaPdfItems(pdfBytes) {
  const data = await pdfParse(pdfBytes);
  const text = data.text || '';

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

  const dataPattern = /(\d+(?:\s\d{3})*)\s+szt\.?\s+([\d\s]+,\d{2})\s+(EUR|PLN|USD|GBP|CHF)\s+([\d\s]+,\d{2})\s+(EUR|PLN|USD|GBP|CHF)\s+(\d+)%/g;
  const rows = [];
  while ((m = dataPattern.exec(text)) !== null) {
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

  return { items, rawText: text };
}

module.exports = { parseIfirmaPdfItems };
