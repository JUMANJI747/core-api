// Ostatnie zdarzenie trackingu GK dla wysyłek W DRODZE — dopisek pod statusem
// na liście ("W trakcie dostarczania", "Gotowa do odbioru w punkcie" itd.).
// Lista zamówień GK daje tylko zgrubny status (IN_TRANSIT); szczegół siedzi
// w GET /order/tracking → latestStatus {type, polska nazwa, data, lokalizacja}.
// Cache w pamięci z TTL — status zmienia się co godziny, nie ma sensu pytać
// GK o każdą paczkę przy każdym wejściu na listę.

const { getOrderTracking } = require('../glob-client');

const TTL_MS = 20 * 60 * 1000;
const _cache = new Map(); // orderNumber → { ev: event|null, ts }
const _inFlight = new Set();
let _bgRunning = false;

// Statusy z listy GK, dla których dopisek ma sens (paczka w drodze) —
// DELIVERED ma już licznik dni, CANCELED/NEW nie mają historii przewoźnika.
const ACTIVE_RE = /in_transit|in_delivery|shipped|ready|picked/i;

// GK location bywa ", Sant'Antioco, , , " — zostaw tylko niepuste człony.
function cleanLocation(loc) {
  if (!loc) return null;
  const parts = String(loc).split(',').map(s => s.trim()).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function pickLatestEvent(tracking) {
  const ev = tracking && tracking.latestStatus;
  if (!ev || !ev.type) return null;
  return {
    type: String(ev.type).toUpperCase(),
    name: ev.name || null,
    date: ev.date || null,
    location: cleanLocation(ev.location),
  };
}

async function fetchOne(num) {
  if (_inFlight.has(num)) return null;
  _inFlight.add(num);
  try {
    const t = await getOrderTracking(num);
    const ev = pickLatestEvent(t);
    _cache.set(num, { ev, ts: Date.now() });
    return ev;
  } catch (e) {
    console.error('[tracking-status]', num, e.message);
    // Też cache'ujemy (null) — błąd GK nie może powodować ponawiania co request.
    _cache.set(num, { ev: null, ts: Date.now() });
    return null;
  } finally {
    _inFlight.delete(num);
  }
}

// items: [{ orderNumber, status }] → Map orderNumber → event.
// Z cache natychmiast; do `limit` brakujących dociąga inline (równolegle),
// reszta (do bgLimit) w tle z throttlem — kolejne wejście trafi w cache.
async function latestTrackingEvents(items, { limit = 8, bgLimit = 40, throttleMs = 250 } = {}) {
  const out = new Map();
  const need = [];
  for (const i of items || []) {
    if (!i || !i.orderNumber || !ACTIVE_RE.test(String(i.status || ''))) continue;
    const num = String(i.orderNumber);
    const hit = _cache.get(num);
    if (hit && Date.now() - hit.ts < TTL_MS) {
      if (hit.ev) out.set(num, hit.ev);
    } else if (!need.includes(num)) {
      need.push(num);
    }
  }
  const inline = need.slice(0, limit);
  await Promise.all(inline.map(async (num) => {
    const ev = await fetchOne(num);
    if (ev) out.set(num, ev);
  }));
  const rest = need.slice(limit, limit + bgLimit);
  if (rest.length && !_bgRunning) {
    _bgRunning = true;
    setImmediate(async () => {
      try {
        for (const num of rest) {
          await fetchOne(num);
          await new Promise(r => setTimeout(r, throttleMs));
        }
      } finally {
        _bgRunning = false;
      }
    });
  }
  return out;
}

module.exports = { latestTrackingEvents };
