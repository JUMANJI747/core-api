'use strict';

const { createCanvas } = require('canvas');

const W = 800;
const PAD = 30;
const ROW_H = 24;

// Columns: x start positions for Nazwa | Wariant | Ilość | Cena | Wartość
const COLS = [PAD, PAD + 250, PAD + 375, PAD + 440, PAD + 560];

function calcHeight(pozycje) {
  return (
    PAD +          // top padding
    50 +           // title
    12 +           // separator gap
    80 +           // contractor block (~4 lines)
    20 +           // separator gap
    ROW_H +        // table header row
    pozycje.length * ROW_H + // data rows
    16 +           // gap before summary separator
    12 +           // separator gap
    72 +           // summary (3 lines * 24px)
    16 +           // separator gap
    12 +           // separator gap
    30 +           // payment term
    PAD            // bottom padding
  );
}

function drawSeparator(ctx, y) {
  ctx.save();
  ctx.strokeStyle = '#cccccc';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, y);
  ctx.lineTo(W - PAD, y);
  ctx.stroke();
  ctx.restore();
}

function truncate(ctx, text, maxWidth) {
  if (!text) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && ctx.measureText(truncated + '…').width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + '…';
}

function generateInvoicePreviewImage(preview) {
  const { contractor, waluta, rodzaj, pozycje, suma, terminPlatnosci } = preview;
  const H = calcHeight(pozycje);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  let y = PAD;

  // ── Title ──
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText('FAKTURA — podgląd', PAD, y + 26);
  y += 40;

  drawSeparator(ctx, y);
  y += 16;

  // ── Contractor ──
  ctx.font = 'bold 13px sans-serif';
  ctx.fillStyle = '#333333';
  ctx.fillText('Kontrahent:', PAD, y + 13);
  y += 20;

  ctx.font = '13px sans-serif';
  ctx.fillStyle = '#000000';
  ctx.fillText(contractor.name || '', PAD, y + 13);
  y += 18;

  if (contractor.nip) {
    ctx.fillText('NIP: ' + contractor.nip, PAD, y + 13);
    y += 18;
  }

  ctx.fillText(
    'Kraj: ' + (contractor.country || 'PL') +
    '   Typ faktury: ' + (rodzaj === 'wdt' ? 'WDT (UE) — 0% VAT' : 'Krajowa — 23% VAT') +
    '   Waluta: ' + waluta,
    PAD, y + 13
  );
  y += 20;

  drawSeparator(ctx, y);
  y += 16;

  // ── Table header ──
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(PAD, y, W - PAD * 2, ROW_H);

  ctx.font = 'bold 12px sans-serif';
  ctx.fillStyle = '#000000';
  ctx.fillText('Nazwa', COLS[0] + 4, y + 16);
  ctx.fillText('Wariant', COLS[1] + 4, y + 16);
  ctx.fillText('Ilość', COLS[2] + 4, y + 16);
  ctx.fillText('Cena netto', COLS[3] + 4, y + 16);
  ctx.fillText('Wartość netto', COLS[4] + 4, y + 16);
  y += ROW_H;

  // ── Table rows ──
  ctx.font = '12px sans-serif';
  pozycje.forEach((p, i) => {
    ctx.fillStyle = i % 2 === 0 ? '#ffffff' : '#f5f5f5';
    ctx.fillRect(PAD, y, W - PAD * 2, ROW_H);
    ctx.fillStyle = '#000000';

    const maxNazwa = COLS[1] - COLS[0] - 8;
    const maxWariant = COLS[2] - COLS[1] - 8;

    ctx.fillText(truncate(ctx, p.nazwa || '', maxNazwa), COLS[0] + 4, y + 16);
    ctx.fillText(truncate(ctx, p.wariant || '', maxWariant), COLS[1] + 4, y + 16);
    ctx.fillText(String(p.ilosc), COLS[2] + 4, y + 16);
    ctx.fillText(Number(p.cenaNetto).toFixed(2) + ' ' + waluta, COLS[3] + 4, y + 16);
    ctx.fillText(Number(p.wartoscNetto).toFixed(2) + ' ' + waluta, COLS[4] + 4, y + 16);
    y += ROW_H;
  });

  y += 16;
  drawSeparator(ctx, y);
  y += 16;

  // ── Summary ──
  const sumX = W - PAD - 220;
  const valX = W - PAD - 10;

  function drawSumRow(label, value, bold) {
    if (bold) ctx.font = 'bold 13px sans-serif'; else ctx.font = '13px sans-serif';
    ctx.fillStyle = '#000000';
    ctx.fillText(label, sumX, y + 14);
    const valStr = Number(value).toFixed(2) + ' ' + waluta;
    const valW = ctx.measureText(valStr).width;
    ctx.fillText(valStr, valX - valW, y + 14);
    y += 22;
  }

  drawSumRow('Netto:', suma.netto, false);
  drawSumRow('VAT:', suma.vat, false);
  drawSumRow('BRUTTO:', suma.brutto, true);

  y += 4;
  drawSeparator(ctx, y);
  y += 16;

  // ── Payment term ──
  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#555555';
  ctx.fillText('Termin płatności: ' + terminPlatnosci, PAD, y + 13);

  return canvas.toBuffer('image/png');
}

module.exports = { generateInvoicePreviewImage };
