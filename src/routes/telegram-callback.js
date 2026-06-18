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
//   csno:<previewId>            → ODRZUĆ preview FV Kanary (kasuje podgląd)
//   csalbno:<previewId>         → ODRZUĆ preview WZ Kanary
//   fvno:<previewId>            → ODRZUĆ preview FV PL
//   csdel:<previewId>           → POTWIERDŹ kasowanie FV Kanary (usuwa z Contasimple)
//   csdelno:<previewId>         → ANULUJ podgląd kasowania FV Kanary
//
// n8n: na callback_query → HTTP POST {tu} z body = { callback_query }.

const router = require('express').Router();
const asyncHandler = require('../asyncHandler');
const { selfCall } = require('../services/agent-runtime');
const { sendTelegram, tgApi, answerCallbackQuery, editMessageReplyMarkup } = require('../telegram-utils');

// GET /api/telegram/webhook-info?scope=pl|kanary — diagnostyka: pokazuje URL
// webhooka i allowed_updates. Jeśli allowed_updates NIE zawiera "callback_query"
// (i nie jest puste = wszystkie), to tapnięcia przycisków NIE są dostarczane —
// trzeba dodać callback_query w Telegram Trigger w n8n i RE-AKTYWOWAĆ workflow.
router.get('/telegram/webhook-info', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const scope = req.query.scope === 'pl' ? 'pl' : 'kanary';
  const { resolveToken } = require('../services/telegram-helper');
  const token = (await resolveToken(prisma, scope)).token || '';
  if (!token) return res.status(503).json({ ok: false, error: `brak tokena (${scope})` });
  const info = await tgApi(token, 'getWebhookInfo', {});
  const au = info && info.result && info.result.allowed_updates;
  const callbackDelivered = !au || (Array.isArray(au) && au.includes('callback_query'));
  res.json({
    ok: true, scope,
    url: info && info.result && info.result.url,
    allowed_updates: au || '(puste = wszystkie domyślne)',
    callbackDelivered,
    hint: callbackDelivered
      ? 'callback_query JEST dostarczany. Jeśli n8n nie łapie — sprawdź czy nasłuch jest na tym samym bocie/URL.'
      : 'callback_query NIE jest dostarczany — dodaj go w Telegram Trigger (Updates) i RE-AKTYWUJ workflow (off/on), żeby n8n ponownie zarejestrował webhook.',
    raw: info && info.result,
  });
}));

// POST /api/telegram/test-button — wysyła na Telegram wiadomość z przyciskiem
// testowym (callback_data="ping:test"). Służy do skonfigurowania IF/Switch w
// n8n: odpalasz to z terminala, klikasz przycisk, n8n łapie callback_query i
// pod niego ustawiasz noda. Bezpieczne — "ping" nic nie wystawia.
// body: { scope?: 'pl'|'kanary' (default kanary), chatId? }
router.post('/telegram/test-button', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const scope = (req.body && req.body.scope) === 'pl' ? 'pl' : 'kanary';
  const { resolveToken, resolveChatId } = require('../services/telegram-helper');
  const token = (await resolveToken(prisma, scope)).token || '';
  const chatId = (await resolveChatId(prisma, req.body && req.body.chatId, scope)).chatId;
  if (!token) return res.status(503).json({ ok: false, error: `brak tokena bota (${scope})` });
  if (!chatId) return res.status(503).json({ ok: false, error: 'brak chatId (podaj w body albo ustaw w Config)' });
  const replyMarkup = { inline_keyboard: [[{ text: '✅ Klik testowy', callback_data: `ping:${scope}` }]] };
  const r = await sendTelegram(token, String(chatId), '🔘 Test przycisku — kliknij, żeby n8n złapał callback_query.', { replyMarkup });
  res.json({ ok: !!(r && r.ok), scope, chatId, telegram: r });
}));

// Mapowanie prefiksu akcji → endpoint + budowa body + zakres tokena (do
// odpowiedzi/edycji wiadomości właściwym botem).
function resolveAction(data, chatId) {
  const [prefix, a, b] = String(data || '').split(':');
  switch (prefix) {
    case 'csfv':    return a && { scope: 'kanary', path: '/api/contasimple/invoice-confirm', body: { previewId: a, chatId } };
    case 'csalb':   return a && { scope: 'kanary', path: '/api/contasimple/albaran-confirm', body: { previewId: a, chatId } };
    case 'fvpl':    return a && { scope: 'pl', path: '/api/ifirma/invoice-confirm', body: { previewId: a, chatId } };
    case 'ord':     return a && b && { scope: 'pl', path: '/api/glob/order', body: { quoteId: a, productId: b, chatId }, order: true };
    // ODRZUĆ — kasuje błędny podgląd (deterministycznie, bez Anthropic).
    case 'csno':    return a && { scope: 'kanary', path: '/api/contasimple/invoice-preview-discard', body: { previewId: a }, reject: true };
    case 'csalbno': return a && { scope: 'kanary', path: '/api/contasimple/albaran-preview-discard', body: { previewId: a }, reject: true };
    case 'fvno':    return a && { scope: 'pl', path: '/api/ifirma/invoice-preview-discard', body: { previewId: a }, reject: true };
    // KASOWANIE FV Kanary — potwierdzenie usuwa z Contasimple; anuluj kasuje podgląd.
    case 'csdel':   return a && { scope: 'kanary', path: '/api/contasimple/delete-confirm', body: { previewId: a, chatId }, del: true };
    case 'csdelno': return a && { scope: 'kanary', path: '/api/contasimple/delete-preview-discard', body: { previewId: a }, reject: true };
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

  // PING — test round-tripu (nic nie wystawia). Tylko potwierdza tapnięcie.
  if (String(data).startsWith('ping')) {
    const scope = String(data).split(':')[1] === 'pl' ? 'pl' : 'kanary';
    const { resolveToken } = require('../services/telegram-helper');
    const tok = (await resolveToken(prisma, scope)).token || '';
    if (tok && cqId) await answerCallbackQuery(tok, cqId, '✅ Callback działa (test OK)');
    return res.json({ ok: true, action: 'ping', toast: 'test OK' });
  }

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

  const httpOk = httpStatus >= 200 && httpStatus < 300 && result.ok !== false;

  let success;
  let toast;
  // removeButtons: czy zdjąć WSZYSTKIE guziki z wiadomości. Domyślnie po sukcesie.
  // Dla kuriera zdejmujemy też gdy wycena jest już zamawiana/zamówiona (dedup) —
  // żeby z JEDNEJ wyceny nie dało się zamówić kilku kurierów.
  let removeButtons;
  if (action.reject) {
    // ODRZUĆ — sukces = podgląd skasowany. Nic nie wystawiamy.
    success = httpOk;
    removeButtons = success;
    toast = success
      ? '❌ Odrzucono — podgląd skasowany.'
      : `⚠ Nie udało się odrzucić: ${String(result.error || result.message || `HTTP ${httpStatus}`).slice(0, 160)}`;
  } else if (action.del) {
    // KASOWANIE — sukces = co najmniej jedna FV usunięta i 0 błędów.
    const n = Number(result.totalDeleted || 0);
    success = httpOk && n > 0;
    removeButtons = success;
    const nums = (result.results || []).filter(r => r.status === 'deleted').map(r => r.number).join(', ');
    toast = success
      ? `🗑 Skasowano ${n} FV${nums ? `: ${nums}` : ''}`
      : `⚠ Nie skasowano: ${String(result.error || result.message || (result.totalFailed ? `${result.totalFailed} błędów` : `HTTP ${httpStatus}`)).slice(0, 160)}`;
  } else if (action.order) {
    // KURIER — sukces = zamówienie istnieje (numer/hash) albo dedup zwrócił
    // istniejące. result.duplicate = "w toku" (drugie tapnięcie). W KAŻDYM z tych
    // przypadków blokujemy guziki tej wyceny (jedna paczka = jeden kurier).
    const ord = result.order || {};
    const ref = ord.number || ord.orderNumber || ord.hash || ord.orderHash || result.number || null;
    success = httpOk && (!!ref || result.deduplicated === true);
    // Guziki zdejmujemy gdy zamówienie POTWIERDZONE (sukces/dedup). Przy "w toku"
    // (duplicate) zostawiamy — backend i tak NIE zamówi drugiego kuriera (blokada
    // po quoteId), a gdyby pierwszy padł, user może wybrać innego z tej wyceny.
    removeButtons = success;
    if (success) {
      toast = `📦 Zamówiono kuriera${result.carrier ? ` ${result.carrier}` : ''}${ref ? ` — ${ref}` : ''}${result.deduplicated ? ' (już było zamówione)' : ''}`;
    } else if (result.duplicate === true) {
      toast = '📦 Zamówienie tej wyceny już trwa — nie zamawiam drugiego kuriera.';
    } else {
      toast = `⚠ Nie udało się zamówić: ${String(result.error || result.message || `HTTP ${httpStatus}`).slice(0, 170)}`;
    }
  } else {
    const number = result.invoiceNumber || result.albaranNumber || (result.order && (result.order.number || result.order.orderNumber)) || result.number;
    success = httpOk && !!number;
    removeButtons = success;
    toast = success
      ? `✅ Wystawiono: ${number}`
      : `⚠ Nie udało się: ${String(result.error || result.message || `HTTP ${httpStatus}`).slice(0, 180)}`;
  }

  // Odpowiedz na callback (zegarek znika) + usuń przyciski (anty-2x / anty-drugi kurier).
  if (token && cqId) await answerCallbackQuery(token, cqId, toast.slice(0, 190));
  if (token && removeButtons && chatId && messageId) await editMessageReplyMarkup(token, chatId, messageId, { inline_keyboard: [] });

  res.json({ ok: success, action: data.split(':')[0], reject: !!action.reject, toast, httpStatus, result });
}));

module.exports = router;
