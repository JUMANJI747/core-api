'use strict';

// Numer KSeF czytany z IFIRMY zamiast z API KSeF.
//
// Odkrycie (sonda /invoices/ksef-probe): iFirma w szczegółach faktury zwraca
// pola `NumerKSEF` i `StatusKSEF`. To iFirma wysyła nasze FV do KSeF, więc zna
// numer od razu — także dla wysyłek zrobionych ręcznie w panelu iFirmy, o
// których nasz system w ogóle nie wie. A API iFirmy NIE ma limitu 20 zapytań/h
// jak /invoices/query/metadata w KSeF, przez który ptaszki potrafiły wisieć
// godzinami. KSeF zostaje jako zapas (ręczny sync-sales-status) i do kosztów.
//
// Ochrona iFirmy (jej API też nie lubi serii żądań):
//  - throttle 400 ms między wywołaniami W RAMACH przebiegu,
//  - globalna blokada `running` — przebiegi NIE nakładają się na siebie
//    (monthly-report, guzik, timer po masowej wysyłce, autosync),
//  - `syncMissingFromIfirmaThrottled` — throttle w Config pod WŁASNYM kluczem
//    (celowo innym niż kanał KSeF `autosync:ksef:salesStatus` — to niezależne
//    limity, wspólny klucz wzajemnie by je dusił),
//  - pamięć „kiedy ostatnio pytaliśmy o tę FV”: pętla najpierw bierze faktury
//    dawno niesprawdzane (ogon nie głoduje, gdy czoło listy wisi bez numeru),
//    a polling ksef-status nie młóci iFirmy z kilku kart naraz.

const IFIRMA_THROTTLE_MS = 400;
const POLL_COOLDOWN_MS = 8000; // ksef-status poll co 10 s → drugi tab nie dubluje

const lastChecked = new Map(); // invoiceId → ts ostatniego pytania do iFirmy
function markChecked(id) {
  lastChecked.set(id, Date.now());
  if (lastChecked.size > 3000) {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [k, v] of lastChecked) if (v < cutoff) lastChecked.delete(k);
  }
}

let running = false; // jeden przebieg pętli naraz (cały proces)

const THROTTLE_KEY = 'autosync:ksef:ifirmaSales';

// Jedna faktura: pobierz szczegóły z iFirmy, zapisz numer KSeF gdy jest.
// Zwraca numer albo null (jeszcze nie nadany / FV nie wysłana).
async function pullKsefNumberFromIfirma(prisma, inv) {
  if (!inv || !inv.ifirmaId) return null;
  markChecked(inv.id);
  const { fetchInvoiceDetails } = require('../ifirma-client');
  const det = await fetchInvoiceDetails(inv.ifirmaId, inv.ifirmaType || inv.type);
  const root = (det && det.response) ? det.response : det;
  const num = root && (root.NumerKSEF || root.NumerKSeF || root.numerKSEF || root.numerKsef);
  if (!num) return null;
  await prisma.invoice.update({ where: { id: inv.id }, data: { ksefNumber: String(num) } }).catch(() => {});
  return String(num);
}

// Czy o tę fakturę pytaliśmy iFirmę przed chwilą (dedup pollingu ksef-status).
function checkedRecently(invoiceId, windowMs = POLL_COOLDOWN_MS) {
  const ts = lastChecked.get(invoiceId);
  return !!ts && (Date.now() - ts) < windowMs;
}

// `to` z monthRange to sama data ('2026-07-31') — new Date() da północ i FV
// z ostatniego dnia miesiąca wypadałyby z zakresu (stary kanał KSeF jawnie
// dodawał +24h−1ms). Datę bez godziny rozciągamy do końca dnia.
function endOfDayIfDateOnly(to) {
  const d = new Date(to);
  return /^\d{4}-\d{2}-\d{2}$/.test(String(to).trim())
    ? new Date(d.getTime() + 24 * 3600 * 1000 - 1)
    : d;
}

// Wszystkie FV bez numeru KSeF (z ifirmaId) w zakresie dat → dopytaj iFirmę.
// budgetMs pilnuje limitu 60 s proxy — i musi zostawić zapas na NAJGORSZE
// pojedyncze wywołanie (HTTP timeout iFirmy to 30 s), bo budżet sprawdzamy
// PRZED wywołaniem: wołający inline daje budgetMs ≤ 25000. Czego nie zdążymy,
// wraca w `remaining` — kolejny przebieg dokończy (pamięć lastChecked sprawia,
// że następnym razem na przód pętli trafią te POMINIĘTE, nie te same co teraz).
async function syncMissingFromIfirma(prisma, { from, to, limit = 60, budgetMs = 25000, throttleMs = IFIRMA_THROTTLE_MS } = {}) {
  if (running) return { skipped: 'busy' };
  running = true;
  try {
    const where = { ksefNumber: null, ifirmaId: { not: null } };
    if (from || to) {
      where.issueDate = {};
      if (from) where.issueDate.gte = new Date(from);
      if (to) where.issueDate.lte = endOfDayIfDateOnly(to);
    }
    // Proformy nie są fakturami — KSeF ich nie przyjmuje, numeru nie dostaną
    // nigdy. Bez tego filtra wisiałyby jako wieczni kandydaci i każdy przebieg
    // mieliłby je w kółko.
    where.NOT = [
      { type: { contains: 'proforma', mode: 'insensitive' } },
      { ifirmaType: { contains: 'proforma', mode: 'insensitive' } },
    ];
    const cap = Math.max(1, Math.min(limit, 200));
    const rows = await prisma.invoice.findMany({
      where,
      orderBy: { issueDate: 'desc' },
      take: Math.min(cap * 3, 400),
      select: { id: true, number: true, ifirmaId: true, ifirmaType: true, type: true },
    });
    // Najpierw dawno niesprawdzane — rotacja zamiast wiecznego mielenia czoła.
    rows.sort((a, b) => (lastChecked.get(a.id) || 0) - (lastChecked.get(b.id) || 0));
    const picked = rows.slice(0, cap);

    const started = Date.now();
    let checked = 0;
    let got = 0;
    let errorCount = 0;
    const stillPending = []; // iFirma odpowiedziała, ale numeru (jeszcze) nie ma
    const remaining = [];    // nie zdążyliśmy w budżecie czasu
    const errors = [];
    for (let i = 0; i < picked.length; i++) {
      const inv = picked[i];
      if (Date.now() - started > budgetMs) { remaining.push(inv.number); continue; }
      checked++;
      try {
        const num = await pullKsefNumberFromIfirma(prisma, inv);
        if (num) got++; else stillPending.push(inv.number);
      } catch (e) {
        errorCount++;
        if (errors.length < 10) errors.push({ number: inv.number, error: e.message });
      }
      if (i < picked.length - 1) await new Promise(r => setTimeout(r, throttleMs));
    }
    return {
      source: 'ifirma',
      candidates: rows.length,
      checked,
      got,
      errorCount,
      stillPending,
      remaining,
      errors,
    };
  } finally {
    running = false;
  }
}

// Wersja z throttlem w Config (własny klucz!) — dla przebiegów W TLE odpalanych
// z ruchu (monthly-report, lista faktur). Check-and-set przez warunkowy
// updateMany, żeby dwa równoległe wejścia nie wystartowały obu przebiegów.
async function syncMissingFromIfirmaThrottled(prisma, { minIntervalMs, ...opts } = {}) {
  const nowIso = new Date().toISOString();
  const cfg = await prisma.config.findUnique({ where: { key: THROTTLE_KEY } }).catch(() => null);
  if (!cfg) {
    try {
      await prisma.config.create({ data: { key: THROTTLE_KEY, value: nowIso } });
    } catch (_) {
      return { skipped: 'raced' };
    }
  } else {
    const ageMs = Date.now() - new Date(cfg.value).getTime();
    if (ageMs < minIntervalMs) return { skipped: 'throttled', ageMs };
    const upd = await prisma.config
      .updateMany({ where: { key: THROTTLE_KEY, value: cfg.value }, data: { value: nowIso } })
      .catch(() => ({ count: 0 }));
    if (!upd.count) return { skipped: 'raced' };
  }
  return syncMissingFromIfirma(prisma, opts);
}

module.exports = {
  pullKsefNumberFromIfirma,
  syncMissingFromIfirma,
  syncMissingFromIfirmaThrottled,
  checkedRecently,
};
