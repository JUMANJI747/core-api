'use strict';

const invoicePreviews = new Map();
const PREVIEW_TTL_MS = 30 * 60 * 1000;

function savePreview(id, data) {
  invoicePreviews.set(id, { data, expiresAt: Date.now() + PREVIEW_TTL_MS });
}

function getPreview(id) {
  const entry = invoicePreviews.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { invoicePreviews.delete(id); return null; }
  return entry.data;
}

module.exports = { invoicePreviews, savePreview, getPreview };
