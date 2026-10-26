'use strict';

/* DRUK ZAMÓWIENIA DLA MAGAZYNU (26.10.2026).
 *
 * Magazyn zewnętrzny pakuje z wydruku: kod fabryczny (po nim szuka towaru na
 * półce), produkt z kolorem, EAN, ilość i kratka do odhaczenia. Ten sam PDF
 * jedzie w mailu „Powiadom magazyn" (trescMaila niżej).
 *
 * Wejście: zamówienie w kształcie dla roli magazyn (toPublic(o, 'magazyn')) —
 * bez danych CRM (kontrahent, FV, e-mail odbiorcy), tak jak widzi je panel.
 * Polskie znaki: Liberation Sans z assets/fonty (licencja SIL OFL obok). */

const path = require('path');
const PDFDocument = require('pdfkit');

const FONTY = path.join(__dirname, '..', '..', 'assets', 'fonty');
const PANEL_URL = (process.env.PANEL_URL || 'https://core-crm-frontend-eight.vercel.app').replace(/\/$/, '');
const STATUS = { NOWE: 'do spakowania', GOTOWE: 'spakowane, czeka na kuriera', KURIER: 'kurier zamówiony', WYSLANE: 'wysłane', ANULOWANE: 'ANULOWANE' };

const W = 595.28, H = 841.89, M = 40;           // A4 pionowo
const SZER = W - 2 * M;
const DOL = H - M - 20;                          // niżej tylko stopka
const KOL = { kratka: 26, kod: 70, produkt: 250, ean: 96 };
KOL.szt = SZER - KOL.kratka - KOL.kod - KOL.produkt - KOL.ean;

const czas = (d) => (d ? new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}).format(new Date(d)) : '');

function adresOdbiorcy(o) {
  const od = o || {};
  return [
    [od.street, od.houseNumber && (od.apartmentNumber ? `${od.houseNumber}/${od.apartmentNumber}` : od.houseNumber)].filter(Boolean).join(' '),
    [od.postCode, od.city].filter(Boolean).join(' '),
    od.country && od.country !== 'PL' ? od.country : null,
  ].filter(Boolean).join(', ');
}

// Sztuki jak w panelu: bez nagłówków boxów i bez pustego ekspozytora.
const sztukRazem = (items) => (items || []).filter(i => !i.packaging && i.ean !== 'EKSPOZYTOR').reduce((a, i) => a + (Number(i.qty) || 0), 0);

/* Wiersze tabeli: nagłówek boxa (ile kartonów/ekspozytorów), wcięte kolory,
 * pusty ekspozytor osobno — jak lista „Do spakowania" w panelu. */
function wiersze(items) {
  return (items || []).map(i => {
    if (i.packaging) {
      const eksp = i.packaging === 'ekspozytor';
      return { typ: 'box', kod: i.symbol || '', nazwa: i.name, dopisek: eksp ? 'EKSPOZYTOR ZATOWAROWANY' : 'w kartonie', ean: '', szt: `${i.qty} ${eksp ? 'eksp.' : 'kart.'}` };
    }
    if (i.ean === 'EKSPOZYTOR') return { typ: 'dziecko', kod: '', nazwa: 'Ekspozytor pusty (do zatowarowania)', dopisek: '', ean: '', szt: String(i.qty) };
    return { typ: i.parentEan ? 'dziecko' : 'zwykly', kod: i.symbol || '', nazwa: i.name, dopisek: i.variant || '', ean: /^\d{8,14}$/.test(String(i.ean)) ? String(i.ean) : '', szt: String(i.qty) };
  });
}

function naglowekTabeli(doc, y) {
  doc.rect(M, y, SZER, 20).fill('#e6e6e6');
  doc.fillColor('#000').font('b').fontSize(9);
  let x = M + KOL.kratka;
  doc.text('Kod', x + 4, y + 6, { width: KOL.kod - 8, lineBreak: false }); x += KOL.kod;
  doc.text('Produkt', x + 4, y + 6, { width: KOL.produkt - 8, lineBreak: false }); x += KOL.produkt;
  doc.text('EAN', x + 4, y + 6, { width: KOL.ean - 8, lineBreak: false }); x += KOL.ean;
  doc.text('Szt.', x + 4, y + 6, { width: KOL.szt - 8, align: 'right', lineBreak: false });
  return y + 20;
}

function wysokoscWiersza(doc, r) {
  const wciecie = r.typ === 'dziecko' ? 12 : 0;
  doc.font(r.typ === 'box' ? 'b' : 'r').fontSize(11);
  const tekst = r.dopisek ? `${r.nazwa} ${r.dopisek}` : r.nazwa;
  return Math.max(24, doc.heightOfString(tekst, { width: KOL.produkt - 8 - wciecie }) + 12);
}

function rysujWiersz(doc, r, y, h, tlo) {
  const wciecie = r.typ === 'dziecko' ? 12 : 0;
  if (tlo) doc.rect(M, y, SZER, h).fill('#f5f5f5');
  doc.lineWidth(0.9).rect(M + 8, y + (h - 11) / 2, 11, 11).stroke('#000');
  let x = M + KOL.kratka;
  doc.fillColor(r.kod ? '#000' : '#888').font('b').fontSize(11).text(r.kod || '—', x + 4, y + 6, { width: KOL.kod - 8 });
  x += KOL.kod;
  const pw = KOL.produkt - 8 - wciecie;
  doc.fillColor('#000').font(r.typ === 'box' ? 'b' : 'r').fontSize(11);
  if (r.dopisek) {
    doc.text(`${r.nazwa} `, x + 4 + wciecie, y + 6, { width: pw, continued: true });
    doc.font('b').text(r.dopisek);
  } else {
    doc.text(r.nazwa, x + 4 + wciecie, y + 6, { width: pw });
  }
  x += KOL.produkt;
  doc.fillColor('#444').font('r').fontSize(9).text(r.ean, x + 4, y + 7.5, { width: KOL.ean - 8, lineBreak: false });
  x += KOL.ean;
  doc.fillColor('#000').font('b').fontSize(13).text(r.szt, x + 4, y + 5, { width: KOL.szt - 8, align: 'right', lineBreak: false });
  doc.moveTo(M, y + h).lineTo(M + SZER, y + h).lineWidth(0.4).stroke('#bbbbbb');
}

/** PDF zamówienia → Buffer. `z` w kształcie toPublic(o, 'magazyn'). */
function pdfZamowienia(z, { teraz = new Date() } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: { Title: `Zamówienie #${z.numer}`, Author: 'Surf Stick Bell' } });
    const czesci = [];
    doc.on('data', c => czesci.push(c));
    doc.on('end', () => resolve(Buffer.concat(czesci)));
    doc.on('error', reject);
    try {
      doc.registerFont('r', path.join(FONTY, 'LiberationSans-Regular.ttf'));
      doc.registerFont('b', path.join(FONTY, 'LiberationSans-Bold.ttf'));
      const od = z.odbiorca || {};

      // Nagłówek
      doc.fillColor('#000').font('b').fontSize(24).text(`Zamówienie #${z.numer}`, M, M, { width: SZER * 0.6, lineBreak: false });
      doc.font('r').fontSize(9).fillColor('#444')
        .text('Surf Stick Bell → magazyn', M, M + 2, { width: SZER, align: 'right' })
        .text(`złożone ${czas(z.createdAt)}`, { width: SZER, align: 'right' });
      if (z.status && z.status !== 'NOWE') doc.font('b').fillColor('#b00').text(`status: ${STATUS[z.status] || z.status}`, { width: SZER, align: 'right' });
      let y = M + 40;

      // Odbiorca + kurier
      doc.fillColor('#666').font('b').fontSize(8).text('ODBIORCA', M, y); y += 12;
      if (od.name) {
        doc.fillColor('#000').font('b').fontSize(13).text(od.name, M, y, { width: SZER }); y = doc.y + 1;
        doc.font('r').fontSize(11).text(adresOdbiorcy(od) || '—', M, y, { width: SZER }); y = doc.y + 1;
        if (od.phone) { doc.text(`tel. ${od.phone}`, M, y, { width: SZER }); y = doc.y; }
      } else {
        doc.fillColor('#000').font('r').fontSize(11).text('nie podano — wysyłka niestandardowa, kuriera zamawia Surf Stick', M, y, { width: SZER }); y = doc.y;
      }
      y += 8;
      doc.fillColor('#000').font('r').fontSize(10).text(z.autoList
        ? 'Kurier: zamówi się sam po kliknięciu „Paczka gotowa” w panelu — list przewozowy pojawi się przy zamówieniu.'
        : 'Kurier: zamawia Surf Stick — list przewozowy pojawi się przy zamówieniu w panelu.', M, y, { width: SZER });
      y = doc.y + 6;
      if (z.uwagiNasze) {
        doc.font('b').fontSize(10).text('Uwagi od Surf Stick: ', M, y, { width: SZER, continued: true }).font('r').text(z.uwagiNasze);
        y = doc.y + 6;
      }
      y += 6;

      // Tabela pozycji
      y = naglowekTabeli(doc, y);
      wiersze(z.items).forEach((r, n) => {
        const h = wysokoscWiersza(doc, r);
        if (y + h > DOL) { doc.addPage(); y = naglowekTabeli(doc, M); }
        rysujWiersz(doc, r, y, h, n % 2 === 1);
        y += h;
      });
      y += 8;
      doc.fillColor('#000').font('b').fontSize(13).text(`Razem do spakowania: ${sztukRazem(z.items)} szt.`, M, y, { width: SZER, align: 'right' });
      y = doc.y + 12;

      // Dokumenty do paczki
      const docs = z.dokumenty || [];
      if (docs.length) {
        if (y + 20 + docs.length * 14 > DOL) { doc.addPage(); y = M; }
        doc.font('b').fontSize(10).text('Dokumenty do włożenia do paczki (wydruk z panelu, guzik przy zamówieniu):', M, y, { width: SZER });
        y = doc.y + 2;
        for (const d of docs) { doc.font('r').fontSize(10).text(`•  ${d.opis || d.filename}${d.opis ? ` (${d.filename})` : ''}`, M + 8, y, { width: SZER - 8 }); y = doc.y + 1; }
        y += 10;
      }

      // Podpis magazynu
      if (y + 70 > DOL) { doc.addPage(); y = M; }
      y += 10;
      doc.fillColor('#000').font('r').fontSize(10);
      doc.text('Spakował(a): ..........................................', M, y, { lineBreak: false });
      doc.text('Data: ..............................', M + 300, y, { lineBreak: false });
      y += 26;
      doc.text('Uwagi magazynu: ...................................................................................................................', M, y, { width: SZER, lineBreak: false });

      // Stopka na każdej stronie (dolny margines na chwilę 0, inaczej pdfkit
      // dokłada pustą stronę przy pisaniu poniżej marginesu).
      const zakres = doc.bufferedPageRange();
      for (let i = 0; i < zakres.count; i++) {
        doc.switchToPage(zakres.start + i);
        const stary = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.fillColor('#777').font('r').fontSize(8).text(`Surf Stick Bell · zamówienie #${z.numer} · wydruk ${czas(teraz)} · strona ${i + 1}/${zakres.count}`, M, H - M + 8, { width: SZER, align: 'center', lineBreak: false });
        doc.page.margins.bottom = stary;
      }
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

/** Mail „nowe zamówienie" do magazynu: temat, tekst i HTML. `z` jak wyżej. */
function trescMaila(z) {
  const od = z.odbiorca || {};
  const razem = sztukRazem(z.items);
  const linie = wiersze(z.items).map(r => {
    const kod = r.kod ? `${r.kod}  ` : '';
    if (r.typ === 'box') return `• ${r.szt} ${r.nazwa} — ${r.dopisek}${r.kod ? ` [${r.kod}]` : ''}`;
    return `${r.typ === 'dziecko' ? '    – ' : '• '}${r.szt} × ${kod}${r.nazwa}${r.dopisek ? ` ${r.dopisek}` : ''}`;
  });
  const kurier = z.autoList
    ? 'Kurier zamówi się sam po kliknięciu „Paczka gotowa” w panelu, list przewozowy pojawi się przy zamówieniu.'
    : 'Kuriera zamawia Surf Stick, list przewozowy pojawi się przy zamówieniu w panelu.';
  const docs = z.dokumenty || [];
  const subject = `Nowe zamówienie #${z.numer} do spakowania (${razem} szt.) — Surf Stick Bell`;
  const text = [
    'Dzień dobry,',
    '',
    `w panelu magazynu jest nowe zamówienie #${z.numer} do spakowania.`,
    '',
    od.name ? `Odbiorca: ${od.name}\n${adresOdbiorcy(od)}${od.phone ? ` · tel. ${od.phone}` : ''}` : 'Odbiorca: nie podano — wysyłka niestandardowa, kuriera zamawia Surf Stick.',
    kurier,
    '',
    `Do spakowania (razem ${razem} szt.):`,
    ...linie,
    ...(z.uwagiNasze ? ['', `Uwagi od nas: ${z.uwagiNasze}`] : []),
    ...(docs.length ? ['', `Dokumenty do włożenia do paczki (w załączniku, do druku): ${docs.map(d => d.opis || d.filename).join(', ')}`] : []),
    '',
    `W załączniku zamówienie w PDF do wydruku. Panel: ${PANEL_URL}/magazyn`,
    '',
    'Pozdrawiamy',
    'Surf Stick Bell',
  ].join('\n');
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const wierszeHtml = wiersze(z.items).map(r => `<tr${r.typ === 'box' ? ' style="font-weight:bold;background:#f2f2f2"' : ''}>`
    + `<td style="padding:4px 8px;font-family:monospace;font-weight:bold">${esc(r.kod)}</td>`
    + `<td style="padding:4px 8px${r.typ === 'dziecko' ? ';padding-left:24px' : ''}">${esc(r.nazwa)}${r.dopisek ? ` <b>${esc(r.dopisek)}</b>` : ''}</td>`
    + `<td style="padding:4px 8px;color:#555">${esc(r.ean)}</td>`
    + `<td style="padding:4px 8px;text-align:right;font-weight:bold">${esc(r.szt)}</td></tr>`).join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">`
    + `<p>Dzień dobry,</p><p>w panelu magazynu jest nowe zamówienie <b>#${z.numer}</b> do spakowania.</p>`
    + (od.name ? `<p><b>Odbiorca:</b> ${esc(od.name)}<br>${esc(adresOdbiorcy(od))}${od.phone ? ` · tel. ${esc(od.phone)}` : ''}</p>` : '<p><b>Odbiorca:</b> nie podano — wysyłka niestandardowa, kuriera zamawia Surf Stick.</p>')
    + `<p>${esc(kurier)}</p>`
    + `<table style="border-collapse:collapse;border:1px solid #ccc"><tr style="background:#e6e6e6"><th style="padding:4px 8px;text-align:left">Kod</th><th style="padding:4px 8px;text-align:left">Produkt</th><th style="padding:4px 8px;text-align:left">EAN</th><th style="padding:4px 8px;text-align:right">Szt.</th></tr>${wierszeHtml}</table>`
    + `<p><b>Razem do spakowania: ${razem} szt.</b></p>`
    + (z.uwagiNasze ? `<p><b>Uwagi od nas:</b> ${esc(z.uwagiNasze).replace(/\n/g, '<br>')}</p>` : '')
    + (docs.length ? `<p><b>Dokumenty do włożenia do paczki</b> (w załączniku, do druku): ${docs.map(d => esc(d.opis || d.filename)).join(', ')}</p>` : '')
    + `<p>W załączniku zamówienie w PDF do wydruku. Panel: <a href="${PANEL_URL}/magazyn">${PANEL_URL}/magazyn</a></p>`
    + `<p>Pozdrawiamy<br>Surf Stick Bell</p></div>`;
  return { subject, text, html };
}

module.exports = { pdfZamowienia, trescMaila, sztukRazem, adresOdbiorcy };
