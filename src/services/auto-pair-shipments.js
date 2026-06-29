'use strict';

// Auto-parowanie faktur z wysyłkami GlobKurier — POŁĄCZENIEM JEST KONTRAHENT.
// Łączymy wysyłkę z FV tylko gdy odbiorca wysyłki to TEN kontrahent (dokładna
// nazwa znormalizowana ALBO zapisany adres kontrahenta: kod+miasto) i data FV
// jest w oknie ±7 dni od nadania (przy kilku wysyłkach — najbliższa data).
//
// To NIE jest dawne „dopasowanie po słowie" (łapało cudze listy bo obie nazwy
// miały „surf"). Tu sygnałem jest TOŻSAMOŚĆ kontrahenta, nie podobieństwo słów.
// Zapisuje jawny link (Invoice.shipmentNumber) — widoczny i rozłączalny.

const { normalizeContractorName } = require('./contractor-match');

const WINDOW_MS = (Number(process.env.AUTOPAIR_WINDOW_DAYS) || 7) * 86400000;
const LOOKBACK_MS = 120 * 86400000;

const norm = s => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
const isCanceled = s => ['CANCELED', 'CANCELLED'].includes((s.status || '').toUpperCase());

async function autoPairShipments(prisma, getGkOrders) {
  const since = new Date(Date.now() - LOOKBACK_MS);
  const invs = await prisma.invoice.findMany({
    where: { shipmentNumber: null, contractorId: { not: null }, issueDate: { gte: since } },
    select: { id: true, contractorId: true, contractorName: true, issueDate: true },
    orderBy: { issueDate: 'desc' },
  });
  if (!invs.length) return { paired: 0 };

  const orders = (await getGkOrders()) || [];
  if (!orders.length) return { paired: 0 };

  // Numery GK już użyte na jakiejkolwiek FV — nie dublujemy.
  const used = new Set(
    (await prisma.invoice.findMany({ where: { shipmentNumber: { not: null } }, select: { shipmentNumber: true } }))
      .map(i => String(i.shipmentNumber)),
  );

  // Adresy (kod+miasto) per kontrahent — do dopasowania „wysyłka na adres kontrahenta".
  const contractorIds = [...new Set(invs.map(i => i.contractorId))];
  const contractors = await prisma.contractor.findMany({
    where: { id: { in: contractorIds } },
    select: { id: true, extras: true, city: true, postCode: true },
  });
  const addrKeys = new Map();
  for (const c of contractors) {
    const keys = new Set();
    const add = (pc, city) => { const k = `${norm(pc)}|${norm(city)}`; if (norm(pc) || norm(city)) keys.add(k); };
    const ex = (c.extras && typeof c.extras === 'object') ? c.extras : {};
    add(c.postCode, c.city);
    if (ex.billingAddress) add(ex.billingAddress.postCode, ex.billingAddress.city);
    if (Array.isArray(ex.locations)) for (const l of ex.locations) add(l.postCode, l.city);
    addrKeys.set(c.id, keys);
  }

  const cand = orders
    .filter(o => o.number && !used.has(String(o.number)))
    .map(o => ({
      o, taken: false,
      nameKey: normalizeContractorName(o.receiverName || ''),
      addrKey: `${norm(o.receiver && o.receiver.postCode)}|${norm(o.receiver && o.receiver.city)}`,
      time: o.date ? new Date(o.date).getTime() : null,
    }));
  if (!cand.length) return { paired: 0 };

  let paired = 0;
  for (const inv of invs) {
    const invNameKey = normalizeContractorName(inv.contractorName || '');
    const invTime = new Date(inv.issueDate).getTime();
    const keys = addrKeys.get(inv.contractorId) || new Set();
    let best = null, bestDiff = Infinity, bestCanceled = true;
    for (const c of cand) {
      if (c.taken || c.time == null) continue;
      const nameMatch = invNameKey && c.nameKey && invNameKey === c.nameKey;
      const addrMatch = c.addrKey !== '|' && keys.has(c.addrKey);
      if (!nameMatch && !addrMatch) continue;
      const d = Math.abs(invTime - c.time);
      if (d > WINDOW_MS) continue;
      const canc = isCanceled(c.o);
      if ((bestCanceled && !canc) || (canc === bestCanceled && d < bestDiff)) { best = c; bestDiff = d; bestCanceled = canc; }
    }
    if (best) {
      try {
        await prisma.invoice.update({
          where: { id: inv.id },
          data: { shipmentNumber: String(best.o.number), shipmentHash: best.o.hash || null, shipmentCarrier: best.o.carrier || null },
        });
        best.taken = true; used.add(String(best.o.number)); paired++;
      } catch (_) { /* best-effort */ }
    }
  }
  return { paired };
}

// Odpalenie w tle (fire-and-forget) — nie blokuje odpowiedzi GET.
let _running = false;
async function autoPairInBackground(prisma, getGkOrders) {
  if (_running) return;
  _running = true;
  try {
    const r = await autoPairShipments(prisma, getGkOrders);
    if (r.paired) console.log(`[auto-pair] powiązano ${r.paired} FV z wysyłkami`);
  } catch (e) {
    console.error('[auto-pair] failed:', e.message);
  } finally {
    _running = false;
  }
}

module.exports = { autoPairShipments, autoPairInBackground };
