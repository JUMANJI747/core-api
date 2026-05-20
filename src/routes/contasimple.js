'use strict';

const router = require('express').Router();
const crypto = require('crypto');
const prisma = require('../db');
const asyncHandler = require('../asyncHandler');
const cs = require('../contasimple-client');
const { resolveOwnerFromAddress } = require('../services/owner-derive');
const {
  saveEsPreview,
  getEsPreview,
  deleteEsPreview,
  getLatestEsPreview,
  saveEsDeletePreview,
  getEsDeletePreview,
  deleteEsDeletePreview,
  getLatestEsDeletePreview,
  saveEsAlbaranPreview,
  getEsAlbaranPreview,
  deleteEsAlbaranPreview,
  getLatestEsAlbaranPreview,
} = require('../es-stores');
const {
  findEsContractor,
  expandEsLines,
  buildEsTotals,
  buildContasimplePayload,
  buildContasimpleAlbaranPayload,
  IGIC_DEFAULT_PCT,
  NIKODEM_DEFAULTS,
} = require('../services/contasimple-helpers');
const { sendTelegram, sendTelegramDocument } = require('../telegram-utils');
const { sendMail } = require('../mail-sender');
const { notifyMailResult } = require('../services/notify-mail-result');
const {
  buildEsLinesFromPreview,
  buildEsLinesFromContasimple,
  resolveEsProductIdByEan,
} = require('../services/invoice-lines-backfill');
const {
  upsertContact: upsertCrmContact,
  upsertAddress: upsertCrmAddress,
  tryAutoLinkEs,
} = require('../services/contractor-sync-helpers');

// Wspolny sync write helper — po EsInvoice.create budujemy EsInvoiceLineItem
// z previewLines (preferowane bo zawiera ean+variant) albo z contasimple
// lines fallback. Best-effort, glowna sciezka (create FV + send PDF) wazniejsza.
async function createEsInvoiceLineItems(prisma, esInvoice, previewLines, fallbackLines) {
  if (!esInvoice) return;
  try {
    const stub = {
      currency: esInvoice.currency,
      invoiceDate: esInvoice.invoiceDate,
    };
    let lines = null;
    if (Array.isArray(previewLines) && previewLines.length) {
      lines = buildEsLinesFromPreview(stub, previewLines);
    } else if (Array.isArray(fallbackLines) && fallbackLines.length) {
      lines = buildEsLinesFromContasimple(stub, fallbackLines);
    }
    if (!lines || !lines.length) return;
    const productCache = new Map();
    const records = [];
    for (const l of lines) {
      const productId = await resolveEsProductIdByEan(prisma, l.ean, productCache);
      records.push({
        esInvoiceId: esInvoice.id,
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
        currency: esInvoice.currency || 'EUR',
        contractorId: esInvoice.contractorId,
        contractorCountry: esInvoice.contractorCountry,
        invoiceDate: esInvoice.invoiceDate,
        contasimpleLineId: null,
        position: l.position,
        extras: { ...l.extras, source: 'cs-invoice-confirm' },
      });
    }
    if (records.length) {
      await prisma.esInvoiceLineItem.createMany({ data: records });
    }
  } catch (e) {
    console.error('[cs invoice-confirm] createEsInvoiceLineItems failed:', e.message);
  }
}
const { resolveToken } = require('../services/telegram-helper');

// Wrapper na resolveToken z scope='kanary' + log diagnostyczny — żeby
// w Railway było widać który token został wybrany.
async function getEsTelegramToken(prismaClient) {
  const r = await resolveToken(prismaClient, 'kanary');
  console.log(`[cs telegram-token] using ${r.source} (last4=${r.token ? r.token.slice(-4) : '-'})`);
  return r.token;
}

// chatId resolver dla ES — request.body.chatId → Config telegram_chat_id_es →
// Config telegram_chat_id (fallback admin). Eliminuje 7-krotny duplikat w
// pliku (preview/confirm/delete/PDF resend/send-email).
async function getEsChatId(prismaClient, reqChatId) {
  const { resolveChatId } = require('../services/telegram-helper');
  const r = await resolveChatId(prismaClient, reqChatId, 'kanary');
  return r.chatId;
}

