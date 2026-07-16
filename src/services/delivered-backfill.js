// Uzupełnianie daty doręczenia (Transaction.deliveredAt) z historii trackingu GK.
//
// Lista zamówień GK NIE zwraca daty doręczenia — mamy ją w bazie tylko wtedy,
// gdy tracker sam złapał przejście na DELIVERED. Dla paczek dostarczonych poza
// nim (starsze wysyłki, brak transakcji) GET /v1/order/tracking zwraca pełną
// historię statusów z datami — bierzemy datę zdarzenia DELIVERED_TO_RECEIVER
// i zapisujemy do Transaction (update istniejącej po shipmentNumber albo
// minimalny wpis source='delivered-backfill'), żeby kolejne listy czytały
// z bazy bez ponownego wołania GK. Używane w /glob/orders i GET /invoices —
// badge "DELIVERED · X dni temu".

const { getOrderTracking } = require('../glob-client');

// Typy zdarzeń GK oznaczające fizyczne doręczenie do odbiorcy (NIE do magazynu
// czy punktu — DELIVERED_TO_MAGAZINE / READY_TO_RECEIVE_IN_POINT to jeszcze
// nie doręczenie).
const DONE_TYPES = new Set(['DELIVERED_TO_RECEIVER', 'DELIVERED']);

// GK daje "2026-07-13 09:49:00" — spacja zamiast T; strefa lokalna, dla
// liczby dni bez znaczenia.
function parseGkDate(s) {
  if (!s) return null;
  const d = new Date(String(s).trim().replace(' ', 'T'));
  return Number.isFinite(d.getTime()) ? d : null;
}

// Data doręczenia z odpowiedzi /order/tracking: najpóźniejsze zdarzenie
// DELIVERED_TO_RECEIVER ze statuses[], fallback na latestStatus.
function extractDeliveredDate(tracking) {
  let best = null;
  const consider = (ev) => {
    if (!ev) return;
    const type = String(ev.type || '').toUpperCase();
    const name = String(ev.name || '').toLowerCase();
    if (!DONE_TYPES.has(type) && !/dostarczono do odbiorcy|delivered to receiver/.test(name)) return;
    const d = parseGkDate(ev.date);
    if (d && (!best || d > best)) best = d;
  };
  for (const ev of (tracking && tracking.statuses) || []) consider(ev);
  consider(tracking && tracking.latestStatus);
  return best;
}

// Anty-race między równoległymi requestami list (nie odpytuj tego samego
// numeru dwa razy naraz) + jeden background-run naraz.
const _inFlight = new Set();
let _bgRunning = false;

async function processOne(prisma, item) {
  const num = String(item.orderNumber);
  if (_inFlight.has(num)) return null;
  _inFlight.add(num);
  try {
    const t = await getOrderTracking(num);
    const d = extractDeliveredDate(t);
    if (!d) return null;
    const tx = await prisma.transaction.findFirst({
      where: { shipmentNumber: num },
      orderBy: { occurredAt: 'desc' },
    });
    if (tx) {
      if (!tx.deliveredAt) {
        await prisma.transaction.update({ where: { id: tx.id }, data: { hasDelivered: true, deliveredAt: d } });
      }
    } else {
      await prisma.transaction.create({
        data: {
          contractorId: item.contractorId || null,
          contractorName: item.receiverName || null,
          shipmentNumber: num,
          shipmentHash: item.hash || null,
          occurredAt: (item.creationDate && parseGkDate(item.creationDate)) || d,
          hasShipped: true,
          hasDelivered: true,
          deliveredAt: d,
          source: 'delivered-backfill',
          matchReason: 'data doręczenia z historii trackingu GK (backfill)',
        },
      });
    }
    console.log(`[delivered-backfill] ${num} → doręczono ${d.toISOString()}`);
    return d;
  } catch (e) {
    console.error('[delivered-backfill]', num, e.message);
    return null;
  } finally {
    _inFlight.delete(num);
  }
}

// items: [{ orderNumber, status, deliveredAt, hash?, creationDate?,
//           contractorId?, receiverName? }]
// Zwraca Map orderNumber → Date dla numerów dociągniętych INLINE (limit
// równoległych wywołań GK — nie blokujemy listy dziesiątkami requestów).
// Reszta (do bgLimit) leci w tle po kolei z throttlem — kolejne wejście na
// listę przeczyta ją już z bazy. bgLimit 200 = całe jedno wejście na listę
// (100 wysyłek + faktury) dociąga się za jednym razem; to jednorazowy
// backfill, potem daty są w bazie.
async function backfillDeliveredDates(prisma, items, { limit = 8, bgLimit = 200, throttleMs = 300 } = {}) {
  const need = (items || []).filter(i =>
    i && i.orderNumber && !i.deliveredAt && /^deliver/i.test(String(i.status || '')));
  const found = new Map();
  if (!need.length) return found;

  const inline = need.slice(0, limit);
  await Promise.all(inline.map(async (i) => {
    const d = await processOne(prisma, i);
    if (d) found.set(String(i.orderNumber), d);
  }));

  const rest = need.slice(limit, limit + bgLimit);
  if (rest.length && !_bgRunning) {
    _bgRunning = true;
    setImmediate(async () => {
      try {
        for (const i of rest) {
          await processOne(prisma, i);
          await new Promise(r => setTimeout(r, throttleMs));
        }
      } finally {
        _bgRunning = false;
      }
    });
  }
  return found;
}

module.exports = { backfillDeliveredDates, extractDeliveredDate };
