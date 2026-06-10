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

// Aktywny sweep wygaslych podgladow. Bez tego porzucony preview (nigdy juz
// nieodczytany) zostaje w mapie na zawsze — powolny wyciek w dlugo zyjacym
// procesie. Kasuje tylko juz-wygasle wpisy, wiec zero zmian w zachowaniu.
function sweepExpired(now = Date.now()) {
  for (const [id, entry] of invoicePreviews) {
    if (now > entry.expiresAt) invoicePreviews.delete(id);
  }
}

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const _sweepTimer = setInterval(sweepExpired, SWEEP_INTERVAL_MS);
if (_sweepTimer.unref) _sweepTimer.unref();

module.exports = { invoicePreviews, savePreview, getPreview, sweepExpired };
