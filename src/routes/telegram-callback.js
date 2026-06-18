'use strict';

// POST /api/telegram/callback — deterministyczny wykonawca tapnięć w przyciski
// (inline keyboard) z Telegrama. n8n NIE woła tu Anthropic — tylko PRZEKAZUJE
// otrzymany callback_query (albo cały update), a backend:
//   1. parsuje callback_data,
//   2. woła właściwy endpoint confirm/order WPROST (po ID — bez modelu),
//   3. odpowiada na callback (zdejmuje zegarek) i usuwa przyciski (anty-2x).
//
// Schemat callback_data (≤64 bajty — limit Telegrama):
//   csfv:<previewId>            → wystaw FV Kanary (Contasimple)
//   csalb:<previewId>           → wystaw WZ Kanary
//   fvpl:<previewId>            → wystaw FV PL (iFirma)
//   ord:<quoteId>:<productId>   → zamów kuriera (GlobKurier)
//
// n8n: na callback_query → HTTP POST {tu} z body = { callback_query }.

const router = require('express').Router();
const asyncHandler = require('../asyncHandler');
const { selfCall } = require('../services/agent-runtime');
const { answerCallbackQuery, editMessageReplyMarkup } = require('../telegram-utils');

// Mapowanie prefiksu akcji → endpoint + budowa body + zakres tokena (do
// odpowiedzi/edycji wiadomości właściwym botem).
function resolveAction(data, chatId) {
  const [prefix, a, b] = String(data || '').split(':');
  switch (prefix) {
    case 'csfv':  return a && { scope: 'kanary', path: '/api/contasimple/invoice-confirm', body: { previewId: a, chatId } };
    case 'csalb': return a && { scope: 'kanary', path: '/api/contasimple/albaran-confirm', body: { previewId: a, chatId } };
    case 'fvpl':  return a && { scope: 'pl', path: '/api/ifirma/invoice-confirm', body: { previewId: a, chatId } };
    case 'ord':   return a && b && { scope: 'pl', path: '/api/glob/order', body: { quoteId: a, productId: b, chatId } };
    default: return null;
  }
}

router.post('/telegram/callback', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const cq = (req.body && req.body.callback_query) ? req.body.callback_query : (req.body || {});
  const data = cq.data;
  const cqId = cq.id;
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const messageId = cq.message && cq.message.message_id;
  if (!data) return res.status(400).json({ ok: false, error: 'brak callback_data' });

  const action = resolveAction(data, chatId);
  if (!action) return res.status(400).json({ ok: false, error: `nieznana akcja: ${String(data).slice(0, 40)}` });

  const { resolveToken } = require('../services/telegram-helper');
  const token = (await resolveToken(prisma, action.scope)).token || '';

  let result = {};
  let httpStatus = 0;
  try {
    const r = await selfCall('POST', action.path, action.body);
    httpStatus = r.status;
    result = r.body || {};
  } catch (e) {
    result = { ok: false, error: e.message };
  }

  const number = result.invoiceNumber || result.albaranNumber || (result.order && (result.order.number || result.order.orderNumber)) || result.number;
  const success = httpStatus >= 200 && httpStatus < 300 && result.ok !== false && !!number;
  const toast = success
    ? `✅ Wystawiono: ${number}`
    : `⚠ Nie udało się: ${String(result.error || result.message || `HTTP ${httpStatus}`).slice(0, 180)}`;

  // Odpowiedz na callback (zegarek znika) + usuń przyciski po sukcesie (anty-2x).
  if (token && cqId) await answerCallbackQuery(token, cqId, toast.slice(0, 190));
  if (token && success && chatId && messageId) await editMessageReplyMarkup(token, chatId, messageId, { inline_keyboard: [] });

  res.json({ ok: success, action: data.split(':')[0], number: number || null, toast, httpStatus, result });
}));

module.exports = router;
