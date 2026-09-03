'use strict';

const https = require('https');

/* ZDROWIE KANALU POWIADOMIEN.
 *
 * sendTelegram oddawal cokolwiek, co przyszlo z API, i uznawal to za sukces —
 * takze HTTP 403 „bot was blocked by the user". Efekt: powiadomienia przestaja
 * dochodzic, kod jest przekonany, ze wysyla, i nikt sie nie dowiaduje. Nie
 * mozna tez tego zglosic... Telegramem, bo to wlasnie on jest zepsuty.
 * Dlatego stan kanalu zapisujemy tutaj, a czyta go /poczta/zdrowie, ktore od
 * Telegrama nie zalezy.
 *
 * Swiadomie NIE rzucamy wyjatkiem: sendTelegram ma 28 wywolan w kodzie i
 * wiekszosc nie jest opakowana w try/catch — rzucenie wywracaloby proces
 * zamiast tracic jedno powiadomienie. Zwracamy {ok:false} i zostawiamy slad.
 */
const stanKanalu = { wyslane: 0, bledy: 0, ostatniBlad: null, ostatniBladO: null, ostatniSukcesO: null };

const TG_TIMEOUT_MS = 15000;

async function sendTelegram(botToken, chatId, text, opts = {}) {
  // Default to plain text. parse_mode='HTML' chokes on Markdown-style **bold**
  // that LLMs love to emit ("Can't find end of the entity"). Caller can opt
  // back into HTML or MarkdownV2 if they hand-craft escaped content.
  const payload = { chat_id: chatId, text };
  if (opts.parseMode) payload.parse_mode = opts.parseMode;
  if (opts.replyMarkup) payload.reply_markup = opts.replyMarkup; // inline_keyboard (przyciski)
  const body = Buffer.from(JSON.stringify(payload));

  const niepowodzenie = (powod) => {
    stanKanalu.bledy += 1;
    stanKanalu.ostatniBlad = String(powod).slice(0, 300);
    stanKanalu.ostatniBladO = new Date().toISOString();
    console.error('[telegram] NIE wyslano powiadomienia:', stanKanalu.ostatniBlad);
    return { ok: false, error: stanKanalu.ostatniBlad };
  };

  return new Promise(resolve => {
    let zamkniete = false;
    const koniec = (wynik) => { if (!zamkniete) { zamkniete = true; resolve(wynik); } };

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      timeout: TG_TIMEOUT_MS,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const tekst = Buffer.concat(chunks).toString();
        let dane = null;
        try { dane = JSON.parse(tekst); } catch (_) { /* API oddalo nie-JSON */ }
        // Telegram sygnalizuje bledy POLEM ok, nie tylko kodem HTTP
        if (res.statusCode >= 400 || !dane || dane.ok === false) {
          const opis = dane && dane.description ? dane.description : tekst.slice(0, 200);
          return koniec(niepowodzenie(`HTTP ${res.statusCode}: ${opis}`));
        }
        stanKanalu.wyslane += 1;
        stanKanalu.ostatniSukcesO = new Date().toISOString();
        koniec(dane);
      });
    });
    /* Bez tego jedno zawieszone polaczenie z api.telegram.org wisi bez konca
       W SRODKU cyklu pollera, a poller ma guard pollInFlight — czyli poczta
       przestaje byc pobierana calkiem. */
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} koniec(niepowodzenie(`timeout ${TG_TIMEOUT_MS} ms`)); });
    req.on('error', e => koniec(niepowodzenie(e.message)));
    req.write(body);
    req.end();
  });
}

async function sendTelegramPhoto(botToken, chatId, imageBuffer, filename, caption) {
  const boundary = '----TgBoundary' + Date.now();
  const nl = '\r\n';
  const mimeType = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const parts = [
    `--${boundary}${nl}Content-Disposition: form-data; name="chat_id"${nl}${nl}${chatId}${nl}`,
    ...(caption ? [`--${boundary}${nl}Content-Disposition: form-data; name="caption"${nl}${nl}${caption}${nl}`] : []),
    `--${boundary}${nl}Content-Disposition: form-data; name="photo"; filename="${filename}"${nl}Content-Type: ${mimeType}${nl}${nl}`,
  ];
  const body = Buffer.concat([
    Buffer.from(parts.join('')),
    imageBuffer,
    Buffer.from(`${nl}--${boundary}--${nl}`),
  ]);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendPhoto`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendTelegramDocument(botToken, chatId, docBuffer, filename, caption) {
  const boundary = '----TgBoundary' + Date.now();
  const nl = '\r\n';
  const mimeType = filename.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
  const parts = [
    `--${boundary}${nl}Content-Disposition: form-data; name="chat_id"${nl}${nl}${chatId}${nl}`,
    ...(caption ? [`--${boundary}${nl}Content-Disposition: form-data; name="caption"${nl}${nl}${caption}${nl}`] : []),
    `--${boundary}${nl}Content-Disposition: form-data; name="document"; filename="${filename}"${nl}Content-Type: ${mimeType}${nl}${nl}`,
  ];
  const body = Buffer.concat([
    Buffer.from(parts.join('')),
    docBuffer,
    Buffer.from(`${nl}--${boundary}--${nl}`),
  ]);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendDocument`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Prosty POST JSON do Bot API (dla answerCallbackQuery / editMessageReplyMarkup).
function tgApi(botToken, method, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Odpowiedz na tapnięcie przycisku (zdejmuje "zegarek" + opcjonalny toast).
function answerCallbackQuery(botToken, callbackQueryId, text) {
  return tgApi(botToken, 'answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) }).catch(() => null);
}

// Usuń/zmień przyciski pod wiadomością (np. po akceptacji — żeby nie kliknąć 2x).
function editMessageReplyMarkup(botToken, chatId, messageId, replyMarkup) {
  return tgApi(botToken, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup || { inline_keyboard: [] } }).catch(() => null);
}

module.exports = { sendTelegram, sendTelegramPhoto, sendTelegramDocument, tgApi, answerCallbackQuery, editMessageReplyMarkup, stanKanalu };
