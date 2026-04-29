'use strict';

const { fetchInvoicePdf, fetchInvoiceDetails } = require('../ifirma-client');
const { parseIfirmaPdfItems } = require('./ifirma-pdf-parser');

// Backfill `extras.items` for older invoices that were created before we
// started persisting line items at confirm time. iFirma's GET endpoint
// returns only the header (number, totals, contractor), not the items —
// so we pull the PDF, parse it locally with pdf-parse, and write back.
async function backfillInvoiceItems(prisma, invoice) {
  if (!invoice) throw new Error('invoice required');
  if (!invoice.ifirmaId) throw new Error('invoice has no ifirmaId — cannot fetch PDF');

  let realNumber = invoice.number;
  if (!realNumber || realNumber === 'UNKNOWN') {
    const details = await fetchInvoiceDetails(invoice.ifirmaId, invoice.ifirmaType || invoice.type || 'wdt');
    const fromDetails = details && (details.PelnyNumer || details.Numer || (details.Wynik && (details.Wynik.PelnyNumer || details.Wynik.Numer)));
    if (fromDetails) {
      realNumber = fromDetails;
      await prisma.invoice.update({ where: { id: invoice.id }, data: { number: realNumber } });
    }
  }
  if (!realNumber || realNumber === 'UNKNOWN') {
    throw new Error('Cannot resolve real invoice number from iFirma');
  }

  const rodzaj = invoice.ifirmaType || invoice.type || 'wdt';
  const pdfBuffer = await fetchInvoicePdf(realNumber, rodzaj, invoice.ifirmaId);
  const { items, rawText } = await parseIfirmaPdfItems(pdfBuffer);

  const currentExtras = (invoice.extras && typeof invoice.extras === 'object') ? invoice.extras : {};
  const newExtras = {
    ...currentExtras,
    items: items.map(it => ({ name: it.name, qty: it.qty, priceNetto: it.priceNetto, currency: it.currency, vatRate: it.vatRate })),
    itemsBackfilledAt: new Date().toISOString(),
    itemsSource: 'pdf-parse',
  };
  await prisma.invoice.update({ where: { id: invoice.id }, data: { extras: newExtras } });

  return { items, rawTextLength: (rawText || '').length, realNumber };
}

module.exports = { backfillInvoiceItems };
