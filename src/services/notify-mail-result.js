'use strict';

// Wspólny helper potwierdzeń SMTP na Telegram. Każde miejsce w backendzie
// wysyłające mail (drafty, faktury PL/ES, oferty) używa tej samej funkcji
// żeby format był jednolity i nic się nie zgubiło.
//
// scope: 'es'|'kanary' → token bota Kanary; cokolwiek innego → token PL.
// chatId: per-request (z body sub-agenta) → fallback Config.telegram_chat_id.

const { sendTelegram } = require('../telegram-utils');
const { resolveTelegram } = require('./telegram-helper');

async function notifyMailResult(prisma, {
  reqChatId, scope, ok,
  to, from, subject, messageId,
  attachmentFilename, attachmentSizeKB, attachmentCount,
  error,
}) {
  const tg = await resolveTelegram(prisma, { reqChatId, scope });
  if (!tg.ready) return { sent: false, reason: `no_token_or_chat (token=${tg.tokenSource}, chat=${tg.chatSource})` };
  const { token, chatId } = tg;

  // Linijka załącznika — pokazuje nazwę+rozmiar (single PDF FV) ALBO liczbę
  // (multi-attachment) ALBO 'brak' żeby user widział wprost.
  let attachmentLine;
  if (attachmentFilename) {
    attachmentLine = `- Załącznik: ${attachmentFilename}${attachmentSizeKB ? ` (${attachmentSizeKB} KB)` : ''}`;
  } else if (attachmentCount && attachmentCount > 0) {
    attachmentLine = `- Załączniki: ${attachmentCount}`;
  } else {
    attachmentLine = `- Załącznik: brak`;
  }

  // Backend signature: short hex tag of (boot timestamp + secret salt). Stable
  // for the lifetime of this process so user can recognise it visually, but
  // not predictable by an LLM agent that doesn't see process state. Agents
  // can't fake the same tag — they'd have to guess random hex.
  if (!global.__backendNotifySig) {
    const seed = `${process.pid}:${process.env.RAILWAY_DEPLOYMENT_ID || ''}:${Date.now()}`;
    global.__backendNotifySig = require('crypto').createHash('sha256').update(seed).digest('hex').slice(0, 6);
  }
  const sig = `🔧 backend:${global.__backendNotifySig}`;

  let text;
  if (ok) {
    text = `✉️ Mail wysłany (SMTP potwierdził)\n` +
      `- Do: ${to}\n` +
      `- Od: ${from}\n` +
      `- Temat: ${subject || '-'}\n` +
      `${attachmentLine}\n` +
      `- MessageId: ${messageId || '(brak)'}\n` +
      sig;
  } else {
    text = `❌ Błąd wysyłki maila\n` +
      `- Do: ${to || '-'}\n` +
      `- Od: ${from || '-'}\n` +
      `- Temat: ${subject || '-'}\n` +
      `${attachmentLine}\n` +
      `- Powód: ${error || 'unknown'}\n` +
      sig;
  }
  try {
    const resp = await sendTelegram(token, String(chatId), text);
    return { sent: !!(resp && resp.ok), tgResponse: resp };
  } catch (e) {
    console.error('[notifyMailResult] tg error:', e.message);
    return { sent: false, reason: e.message };
  }
}

module.exports = { notifyMailResult };
