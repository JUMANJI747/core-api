'use strict';

// Odczyt statusu KSeF NASZYCH faktur sprzedażowych (Subject1) i dopisanie
// numeru KSeF do Invoice.ksefNumber — to on zapala ✅ przy fakturze.
//
// DLACZEGO WSPÓLNY SERWIS: KSeF daje tylko 20 zapytań /invoices/query/metadata
// na godzinę. Wcześniej pytały niezależnie: auto-sync z listy faktur (co 10 min)
// ORAZ sprawdzanie po wysyłce (co 5 s przez 2 min = do 24 zapytań na JEDNO
// kliknięcie). Limit padał po pierwszej wysyłce i numery przestawały się
// dociągać — faktury zostawały na „⏳ wysłana" mimo poprawnej wysyłki.
// Teraz KAŻDA ścieżka idzie tędy, z jednym throttlem w Config.

const ksef = require('../ksef-client');

const P = ksef._pick;
const THROTTLE_KEY = 'autosync:ksef:salesStatus';

// Jedno zapytanie do KSeF za podany zakres + dopisanie numerów do faktur.
// Dopasowanie po numerze faktury (iFirma wysyła nasz numer 1:1).
async function syncSalesStatus(prisma, { from, to, dateType = 'Issue' }) {
  const accessToken = await ksef.getAccessToken();
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(new Date(to).getTime() + 24 * 3600 * 1000 - 1).toISOString();
  const metadata = await ksef.queryInvoiceMetadata(accessToken, { subjectType: 'Subject1', from: fromIso, to: toIso, dateType });
  let matched = 0;
  const unmatched = [];
  for (const m of metadata) {
    const number = P(m, 'invoiceNumber', 'number');
    const ksefNumber = P(m, 'ksefNumber', 'ksefReferenceNumber', 'referenceNumber');
    if (!number || !ksefNumber) continue;
    const upd = await prisma.invoice
      .updateMany({ where: { number: String(number), ksefNumber: null }, data: { ksefNumber: String(ksefNumber) } })
      .catch(() => ({ count: 0 }));
    if (upd.count) matched += upd.count; else unmatched.push(number);
  }
  return { found: metadata.length, matched, unmatched, sample: metadata[0] || null };
}

// Wersja z throttlem + poszanowaniem cooldownu po 429. Nic nie rzuca —
// zwraca `skipped` gdy pominięte, żeby wołający mógł to pokazać w UI.
async function syncSalesStatusThrottled(prisma, { minIntervalMs, monthsBack = 2, from, to } = {}) {
  if (!ksef.isConfigured()) return { skipped: 'not-configured' };
  const cooldownMs = ksef.metadataCooldownMs();
  if (cooldownMs > 0) return { skipped: 'cooldown', cooldownMs };

  const cfg = await prisma.config.findUnique({ where: { key: THROTTLE_KEY } }).catch(() => null);
  const ageMs = cfg ? Date.now() - new Date(cfg.value).getTime() : Infinity;
  if (ageMs < minIntervalMs) return { skipped: 'throttled', ageMs };
  const nowIso = new Date().toISOString();
  await prisma.config.upsert({ where: { key: THROTTLE_KEY }, update: { value: nowIso }, create: { key: THROTTLE_KEY, value: nowIso } }).catch(() => {});

  // Zakres: jawny (np. miesiąc oglądany w Księgowości) albo ostatnie miesiące.
  // Throttle jest JEDEN, wspólny dla wszystkich zakresów — inaczej klikanie po
  // miesiącach mnożyłoby zapytania i znów rozjechałby się limit 20/h.
  const now = new Date();
  const start = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  const end = to ? new Date(to) : now;
  try {
    const r = await syncSalesStatus(prisma, { from: start.toISOString(), to: end.toISOString() });
    return { ...r, range: { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) } };
  } catch (e) {
    return { skipped: 'error', error: e.message, cooldownMs: e.cooldownMs || 0 };
  }
}

module.exports = { syncSalesStatus, syncSalesStatusThrottled, THROTTLE_KEY };
