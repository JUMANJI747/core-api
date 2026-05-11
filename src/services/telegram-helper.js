'use strict';

// Wspólny helper rozwiązywania tokenu bota Telegram + chatId. Wcześniej
// powtarzana logika w 9 miejscach (każde z własnym fallbackiem env→Config),
// teraz jedna funkcja per resolver.
//
// scope:
//   'kanary' / 'es'      → bot dla firmy kanaryjskiej (Nikodem). Token z env
//                          TELEGRAM_BOT_TOKEN_KANARY/TELEGRAM_BOT_TOKEN_ES,
//                          fallback Config 'telegram_bot_token_es', fallback
//                          PL token (warning że to fallback).
//   'pl' (default)       → bot dla firmy PL. env TELEGRAM_BOT_TOKEN →
//                          Config 'telegram_bot_token'.
//
// chatId:
//   reqChatId z body żądania (per-user routing) ma pierwszeństwo. Fallback:
//   Config 'telegram_chat_id_es' (dla scope=ES) → 'telegram_chat_id' (admin
//   default, gdy nikt nie podał chatId).

async function resolveToken(prisma, scope) {
  if (scope === 'kanary' || scope === 'es') {
    const env = (process.env.TELEGRAM_BOT_TOKEN_KANARY || process.env.TELEGRAM_BOT_TOKEN_ES || '').trim();
    if (env) {
      return { token: env, source: process.env.TELEGRAM_BOT_TOKEN_KANARY ? 'env_KANARY' : 'env_ES' };
    }
    const cfg = await prisma.config.findUnique({ where: { key: 'telegram_bot_token_es' } });
    if (cfg && cfg.value) return { token: cfg.value, source: 'config_telegram_bot_token_es' };
  }
  // PL default (albo fallback dla ES gdy ES nie skonfigurowane)
  const env = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (env) {
    return {
      token: env,
      source: (scope === 'kanary' || scope === 'es') ? 'env_PL_FALLBACK' : 'env_PL',
    };
  }
  const cfg = await prisma.config.findUnique({ where: { key: 'telegram_bot_token' } });
  if (cfg && cfg.value) {
    return {
      token: cfg.value,
      source: (scope === 'kanary' || scope === 'es') ? 'config_PL_FALLBACK' : 'config_PL',
    };
  }
  return { token: null, source: 'none' };
}

async function resolveChatId(prisma, reqChatId, scope) {
  if (reqChatId) return { chatId: String(reqChatId), source: 'request' };
  if (scope === 'kanary' || scope === 'es') {
    const esCfg = await prisma.config.findUnique({ where: { key: 'telegram_chat_id_es' } });
    if (esCfg && esCfg.value) return { chatId: esCfg.value, source: 'config_es' };
  }
  const cfg = await prisma.config.findUnique({ where: { key: 'telegram_chat_id' } });
  if (cfg && cfg.value) return { chatId: cfg.value, source: 'config_pl' };
  // env fallback dla legacy
  if (process.env.TELEGRAM_CHAT_ID) return { chatId: process.env.TELEGRAM_CHAT_ID, source: 'env' };
  return { chatId: null, source: 'none' };
}

// Najczęściej używana kombinacja — token + chatId w jednej kuli.
async function resolveTelegram(prisma, { reqChatId, scope } = {}) {
  const [t, c] = await Promise.all([
    resolveToken(prisma, scope),
    resolveChatId(prisma, reqChatId, scope),
  ]);
  return {
    token: t.token,
    chatId: c.chatId,
    tokenSource: t.source,
    chatSource: c.source,
    ready: !!(t.token && c.chatId),
  };
}

module.exports = { resolveToken, resolveChatId, resolveTelegram };
