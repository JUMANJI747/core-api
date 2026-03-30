'use strict';

const sharp = require('sharp');

const W = 800;
const PAD = 30;
const ROW_H = 24;
const COLS = [PAD, PAD + 250, PAD + 375, PAD + 440, PAD + 560];
const FONT = 'DejaVu Sans, Liberation Sans, Arial, sans-serif';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function generateInvoicePreviewImage(preview) {
  const { contractor, waluta, rodzaj, pozycje, suma, terminPlatnosci } = preview;

  const els = [];
  let y = PAD;

  function txt(x, yPos, content, { bold = false, size = 13, fill = '#000000', anchor = 'start' } = {}) {
    const fw = bold ? ' font-weight="bold"' : '';
    const ta = anchor !== 'start' ? ` text-anchor="${anchor}"` : '';
    els.push(`<text x="${x}" y="${yPos}" font-family="${FONT}" font-size="${size}"${fw} fill="${fill}"${ta}>${esc(content)}</text>`);
  }

  function rect(x, yPos, w, h, fill) {
    els.push(`<rect x="${x}" y="${yPos}" width="${w}" height="${h}" fill="${fill}"/>`);
  }

  function sep(yPos) {
    els.push(`<line x1="${PAD}" y1="${yPos}" x2="${W - PAD}" y2="${yPos}" stroke="#cccccc" stroke-width="1"/>`);
  }

  // ── Title ──
  txt(PAD, y + 26, 'FAKTURA \u2014 podgl\u0105d', { bold: true, size: 22 });
  y += 42;
  sep(y); y += 16;

  // ── Contractor ──
  txt(PAD, y + 13, 'Kontrahent:', { bold: true });
  y += 20;
  txt(PAD, y + 13, contractor.name || '');
  y += 18;
  if (contractor.nip) {
    txt(PAD, y + 13, 'NIP: ' + contractor.nip);
    y += 18;
  }
  txt(PAD, y + 13,
    'Kraj: ' + (contractor.country || 'PL') +
    '   Typ: ' + (rodzaj === 'wdt' ? 'WDT (UE) \u2014 0% VAT' : 'Krajowa \u2014 23% VAT') +
    '   Waluta: ' + waluta
  );
  y += 18;

  y += 10;
  sep(y); y += 16;

  // ── Table header ──
  rect(PAD, y, W - PAD * 2, ROW_H, '#e8e8e8');
  txt(COLS[0] + 4, y + 16, 'Nazwa',         { bold: true, size: 12 });
  txt(COLS[1] + 4, y + 16, 'Wariant',       { bold: true, size: 12 });
  txt(COLS[2] + 4, y + 16, 'Ilo\u015b\u0107', { bold: true, size: 12 });
  txt(COLS[3] + 4, y + 16, 'Cena netto',    { bold: true, size: 12 });
  txt(COLS[4] + 4, y + 16, 'Warto\u015b\u0107 netto', { bold: true, size: 12 });
  y += ROW_H;

  // ── Data rows ──
  pozycje.forEach((p, i) => {
    rect(PAD, y, W - PAD * 2, ROW_H, i % 2 === 0 ? '#ffffff' : '#f5f5f5');
    txt(COLS[0] + 4, y + 16, (p.nazwa  || '').slice(0, 34), { size: 12 });
    txt(COLS[1] + 4, y + 16, (p.wariant || '').slice(0, 14), { size: 12 });
    txt(COLS[2] + 4, y + 16, String(p.ilosc),              { size: 12 });
    txt(COLS[3] + 4, y + 16, Number(p.cenaNetto).toFixed(2)    + ' ' + waluta, { size: 12 });
    txt(COLS[4] + 4, y + 16, Number(p.wartoscNetto).toFixed(2) + ' ' + waluta, { size: 12 });
    y += ROW_H;
  });

  y += 14;
  sep(y); y += 16;

  // ── Summary (right-aligned) ──
  const labelX = W - PAD - 160;
  const valX   = W - PAD;

  txt(labelX, y + 14, 'Netto:');
  txt(valX,   y + 14, Number(suma.netto).toFixed(2)  + ' ' + waluta, { anchor: 'end' });
  y += 22;

  txt(labelX, y + 14, 'VAT:');
  txt(valX,   y + 14, Number(suma.vat).toFixed(2)    + ' ' + waluta, { anchor: 'end' });
  y += 22;

  txt(labelX, y + 14, 'BRUTTO:', { bold: true });
  txt(valX,   y + 14, Number(suma.brutto).toFixed(2) + ' ' + waluta, { bold: true, anchor: 'end' });
  y += 26;

  y += 8;
  sep(y); y += 16;

  // ── Payment term ──
  txt(PAD, y + 13, 'Termin p\u0142atno\u015bci: ' + (terminPlatnosci || ''), { size: 12, fill: '#555555' });
  y += 20;

  const H = y + PAD;

  const svg = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
    ...els,
    `</svg>`,
  ].join('\n');

  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { generateInvoicePreviewImage };
