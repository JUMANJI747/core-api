'use strict';

const router = require('express').Router();
const { fetchInvoices: fetchIfirmaInvoices, createInvoice, fetchInvoicePdf, fetchInvoiceDetails, registerPayment, searchContractor, upsertContractor } = require('../ifirma-client');
const { backfillInvoiceItems } = require('../services/invoice-backfill');
const { sendMail, getAccounts } = require('../mail-sender');
const { sendTelegram } = require('../telegram-utils');
const { notifyMailResult } = require('../services/notify-mail-result');
const { invoicePreviews, savePreview, getPreview } = require('../stores');
const { scoreContractor } = require('../services/contractor-match');
const { processIfirmaInvoices } = require('../services/ifirma-sync');
const { buildPlLinesFromPozycje, resolveProductIdByEan } = require('../services/invoice-lines-backfill');
const { fetchWithTimeout } = require('../http');

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

__INV_PLACEHOLDER__