'use strict';

// Separate in-memory preview store for the Contasimple (ES) flow. We do NOT
// share `invoicePreviews` from src/stores.js — invoices.js does iFirma-only
// confirms by scanning every entry, and a mixed map would risk cross-confirms
// (e.g. agent ES says "tak" and the iFirma confirm picks up an iFirma preview
// that happens to be newer). Two separate maps = no chance of mix-up.

const esInvoicePreviews = new Map();
const PREVIEW_TTL_MS = 30 * 60 * 1000;

function saveEsPreview(id, data) {
  esInvoicePreviews.set(id, { data, expiresAt: Date.now() + PREVIEW_TTL_MS });
}

function getEsPreview(id) {
  const entry = esInvoicePreviews.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    esInvoicePreviews.delete(id);
    return null;
  }
  return entry.data;
}

function deleteEsPreview(id) {
  esInvoicePreviews.delete(id);
}

function getLatestEsPreview() {
  const now = Date.now();
  let bestId = null;
  let bestExpiry = 0;
  for (const [id, entry] of esInvoicePreviews.entries()) {
    if (entry.expiresAt > now && entry.expiresAt > bestExpiry) {
      bestExpiry = entry.expiresAt;
      bestId = id;
    }
  }
  if (!bestId) return null;
  return { id: bestId, data: esInvoicePreviews.get(bestId).data };
}

module.exports = {
  esInvoicePreviews,
  saveEsPreview,
  getEsPreview,
  deleteEsPreview,
  getLatestEsPreview,
};
