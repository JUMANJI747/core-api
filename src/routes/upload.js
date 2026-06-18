'use strict';

// Chunked upload dla załączników maila. Vercel ma TWARDY limit ~4.5MB na request
// (Server Action / route handler), więc duży plik (np. 13MB PDF) nie przejdzie
// jednym requestem. Front tnie plik na kawałki <4.5MB, wysyła je tu (przez
// proxy), my składamy w całość i trzymamy do czasu wysyłki maila. sendEmail
// bierze gotowy plik po `uploadId` (payload akcji zostaje malutki).
//
// Store in-memory (jak preview/quote) — wystarcza, bo upload+wysyłka dzieją się
// w jednej sesji w sekundach. TTL 30 min sprząta porzucone.

const router = require('express').Router();
const asyncHandler = require('../asyncHandler');
const crypto = require('crypto');

const chunks = new Map();    // uploadId -> { parts:[Buffer], total, filename, contentType, at }
const finalized = new Map(); // id -> { filename, contentType, buffer, at }
const TTL_MS = 30 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [k, v] of chunks) if (now - v.at > TTL_MS) chunks.delete(k);
  for (const [k, v] of finalized) if (now - v.at > TTL_MS) finalized.delete(k);
}
const _t = setInterval(sweep, 5 * 60 * 1000);
if (_t.unref) _t.unref();

router.post('/upload/email-chunk', asyncHandler(async (req, res) => {
  const { uploadId, index, total, filename, contentType, dataBase64 } = req.body || {};
  if (!uploadId || dataBase64 == null || index == null || !total) {
    return res.status(400).json({ error: 'uploadId, index, total, dataBase64 wymagane' });
  }
  let e = chunks.get(uploadId);
  if (!e) { e = { parts: [], total: Number(total), filename: null, contentType: null, at: Date.now() }; chunks.set(uploadId, e); }
  e.parts[Number(index)] = Buffer.from(String(dataBase64), 'base64');
  e.at = Date.now();
  if (filename) e.filename = filename;
  if (contentType) e.contentType = contentType;
  const received = e.parts.filter(Boolean).length;
  res.json({ ok: true, uploadId, received, total: e.total });
}));

router.post('/upload/email-finalize', asyncHandler(async (req, res) => {
  const { uploadId } = req.body || {};
  const e = uploadId && chunks.get(uploadId);
  if (!e) return res.status(404).json({ error: 'upload nie znaleziony / wygasł' });
  const received = e.parts.filter(Boolean).length;
  if (received !== e.total) return res.status(400).json({ error: `niekompletny upload: ${received}/${e.total} kawałków` });
  const buffer = Buffer.concat(e.parts.filter(Boolean));
  const id = crypto.randomUUID();
  finalized.set(id, { filename: e.filename || 'plik', contentType: e.contentType || 'application/octet-stream', buffer, at: Date.now() });
  chunks.delete(uploadId);
  res.json({ ok: true, id, filename: e.filename, size: buffer.length });
}));

// Używane przez send-email: pobierz gotowy plik po id (nie usuwa — TTL sprząta,
// żeby retry wysyłki też zadziałał).
function getFinalizedUpload(id) {
  return finalized.get(id) || null;
}

module.exports = router;
module.exports.getFinalizedUpload = getFinalizedUpload;
