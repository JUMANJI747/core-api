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

  let text;
  if (ok) {
    text = `✉️ Mail wysłany (SMTP potwierdził)\n` +
      `- Do: ${to}\n` +
      `- Od: ${from}\n` +
      `- Temat: ${subject || '-'}\n` +
      `${attachmentLine}\n` +
      `- MessageId: ${messageId || '(brak)'}`;
  } else {
    text = `❌ Błąd wysyłki maila\n` +
      `- Do: ${to || '-'}\n` +
      `- Od: ${from || '-'}\n` +
      `- Temat: ${subject || '-'}\n` +
      `${attachmentLine}\n` +
      `- Powód: ${error || 'unknown'}`;
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
