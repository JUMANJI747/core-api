'use strict';

const https = require('https');

async function sendTelegram(botToken, chatId, text, opts = {}) {
  // Default to plain text. parse_mode='HTML' chokes on Markdown-style **bold**
  // that LLMs love to emit ("Can't find end of the entity"). Caller can opt
  // back into HTML or MarkdownV2 if they hand-craft escaped content.
  const payload = { chat_id: chatId, text };
  if (opts.parseMode) payload.parse_mode = opts.parseMode;
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
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

module.exports = { sendTelegram, sendTelegramPhoto, sendTelegramDocument };
