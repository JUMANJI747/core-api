'use strict';

/**
 * CRM v2 — backfill InvoiceLineItem z iFirma fetchInvoiceDetails dla FV
 * pre-2026 (i 2026 reczne) ktore w bazie maja pusty extras po imporcie
 * przez ifirma-sync. iFirma /listy-faktur nie zwraca pozycji, ale
 * /fakturakraj/{id} (oraz wdt/eksport/proforma) zwraca pelne Pozycje[].
 *
 * EAN w iFirmie zwykle siedzi w stringu Pozycja.NazwaPelna
 * ("BELL Surf Stick Blue 6,8g EAN: 5902082556022"). Wyciagamy regexem.
 *
 * Matching produktu (kolejnosc):
 *   1) regex EAN z NazwaPelna -> Product.ean (direct)
 *   2) fuzzy match po cleanName na Product.name/variant (score >=0.85)
 *   3) LLM Haiku fallback z top-30 kandydatow po fuzzy preselection
 *      (Anthropic API, ANTHROPIC_API_KEY required)
 *
 * Wynik:
 *   - tworzy InvoiceLineItem z productId (jak match), ifirmaLineId=Pozycja.Id
 *   - update Invoice.extras += { pozycjeFromIfirma: [...raw],
 *     backfilledLinesAt, lineMatchingMethod: per-line stats }
 *
 * Idempotent: pomija Invoice z _count.lineItems > 0.
 * Rate-limited: domyslnie 1500ms sleep miedzy fetchInvoiceDetails.
 *
 * Wolane z POST /api/admin/backfill/invoice-lines-from-ifirma.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { fetchInvoiceDetails } = require('../ifirma-client');

let anthropic = null;
function getAnthropic() {
  if (anthropic) return anthropic;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

const LLM_MODEL = process.env.IFIRMA_LINES_BACKFILL_MODEL || 'claude-haiku-4-5-20251001';

// Wyciagnij EAN ze stringa NazwaPelna. iFirma najczesciej zapisuje go jako
// "... EAN: 5902082556022" (z spacjami / dwukropkiem / bez) — tolerancyjny
// regex.
function extractEanFromName(name) {
  if (!name || typeof name !== 'string') return { ean: null, cleanName: name || '' };
  const m = name.match(/\bEAN[\s:]*?(\d{8,14})\b/i);
  if (!m) return { ean: null, cleanName: name.trim() };
  const ean = m[1];
  const cleanName = name.replace(m[0], '').replace(/\s{2,}/g, ' ').trim();
  return { ean, cleanName };
}

// Lokalny fuzzy match — token-based scoring na lowercase name + variant +
// capacity. Score 0..1. >=0.85 to "dobry" match.
//
// Penalty za nadmiar specyfikacji w candidate:
//   "Surf Stick Bell" vs candidate {name:'SURF STICK', variant:'Skin',
//    capacity:'6.8g'} — query nie wspomina koloru ani pojemnosci, wiec
//    candidate ze specyfikacjami dostaje kare. Bez tego wszystkie
//    warianty matchuja tak samo dobrze jak generic (variant=null), co
//    losowo wskazywalo "Skin" zamiast STICK-GENERIC.
function tokenize(s) {
  return (s || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/).filter(Boolean);
}

function scoreNameMatch(needle, candidate) {
  if (!needle || !candidate) return 0;
  const n = tokenize(needle);
  const nameTokens = tokenize(candidate.name);
  const brandTokens = tokenize(candidate.brand);
  const variantTokens = tokenize(candidate.variant);
  const capacityTokens = tokenize(candidate.capacity);
  const all = [...nameTokens, ...brandTokens, ...variantTokens, ...capacityTokens];
  if (n.length === 0 || all.length === 0) return 0;

  const allSet = new Set(all);
  const needleSet = new Set(n);
  let hits = 0;
  for (const t of n) {
    if (allSet.has(t)) { hits++; continue; }
    if ([...allSet].some(x => x.length >= 3 && (x.startsWith(t) || t.startsWith(x)))) hits += 0.5;
  }
  let score = hits / n.length;

  // Penalty: kazdy token z variant/capacity ktorego NIE ma w query
  // odejmuje 0.15 (cap 0.6 zeby nie wpasc ponizej 0.4 z dobrego matcha).
  const extraSpec = [...variantTokens, ...capacityTokens]
    .filter(t => !needleSet.has(t)).length;
  const penalty = Math.min(0.6, extraSpec * 0.15);
  score -= penalty;

  return Math.max(0, Math.min(1, score));
}

async function llmMatchProduct(cleanName, candidates, ctx) {
  const client = getAnthropic();
  if (!client) return { ean: null, method: 'llm-skipped (no key)' };
  if (!candidates.length) return { ean: null, method: 'llm-skipped (no candidates)' };

  const productList = candidates.map(p => {
    const isGeneric = !p.variant && /generic/i.test(p.ean || '');
    const tag = isGeneric ? ' [GENERIC - bez koloru/wariantu]' : '';
    return `- EAN ${p.ean} | ${p.name}${p.variant ? ' / ' + p.variant : ''}${p.capacity ? ' / ' + p.capacity : ''}${tag}`;
  }).join('\n');

  const prompt = `Pozycja z faktury: "${cleanName}"
${ctx.qty ? `Ilosc: ${ctx.qty}` : ''}
${ctx.priceNetto ? `Cena netto: ${ctx.priceNetto} ${ctx.currency || ''}` : ''}

Lista produktow w naszym katalogu (EAN | Nazwa / Wariant / Pojemnosc):
${productList}

ZASADY:
1. Jezeli pozycja NIE wymienia konkretnego koloru (Blue/Pink/Mint/Purple/White/Skin/Black/Brown) ani wariantu — wybierz produkt [GENERIC] (variant=null, czesto z EAN-em jak STICK-GENERIC, MASCARA-GENERIC).
2. Jezeli pozycja wymienia konkretny kolor/wariant — wybierz produkt z dokladnie tym wariantem.
3. Jezeli pozycja to "Box" / "Ekspozytor" / "30szt" — wybierz produkt typu BOX-* (boxowy).
4. Jezeli zadne nie pasuje — zwróć "NONE".

Zwróć TYLKO sam EAN (np. "5902082556022" albo "STICK-GENERIC") lub "NONE". Bez wyjasnien, bez prefixu "EAN:".`;

  try {
    const resp = await client.messages.create({
      model: LLM_MODEL,
      max_tokens: 32,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    // Trim non-EAN trash (spacje, kropki, EAN: prefix) ale zachowaj cyfry+litery+myslnik.
    const text = raw.replace(/^[^A-Za-z0-9-]+|[^A-Za-z0-9-]+$/g, '').replace(/^EAN[:\s]*/i, '');
    if (/^NONE$/i.test(text)) return { ean: null, method: 'llm-none' };
    // Exact match do candidates (LLM moze zwrocic literowy EAN typu
    // STICK-GENERIC, BOX-STICK-30 — nie tylko cyfry).
    const exact = candidates.find(p => p.ean === text);
    if (exact) return { ean: exact.ean, method: 'llm' };
    // Fallback: ktorykolwiek EAN z listy candidates wystepuje w surowym
    // text (LLM dopisal "EAN STICK-GENERIC" zamiast samego "STICK-GENERIC").
    const containsMatch = candidates.find(p => p.ean && raw.includes(p.ean));
    if (containsMatch) return { ean: containsMatch.ean, method: 'llm' };
    return { ean: null, method: `llm-unparseable (${raw.slice(0, 80)})` };
  } catch (e) {
    console.error('[ifirma-lines] LLM match failed:', e.message);
    return { ean: null, method: `llm-error (${e.message.slice(0, 50)})` };
  }
}

async function resolveProduct(prisma, productCache, cleanName, ean, ctx) {
  // 1) Direct EAN
  if (ean) {
    if (productCache.has(ean)) return { ...productCache.get(ean), method: 'ean-direct' };
    const p = await prisma.product.findUnique({ where: { ean }, select: { id: true, ean: true, name: true } }).catch(() => null);
    if (p) {
      const result = { productId: p.id, ean: p.ean };
      productCache.set(ean, result);
      return { ...result, method: 'ean-direct' };
    }
    // EAN z FV nie ma w katalogu — nadal zapisujemy bez productId.
    return { productId: null, ean, method: 'ean-not-in-catalog' };
  }

  // Brak EAN — szukamy po nazwie.
  if (!cleanName) return { productId: null, ean: null, method: 'no-name' };

  // 2) Lokalny fuzzy match — load all once (mala tabela <500 produktow).
  if (!productCache.has('__ALL__')) {
    const all = await prisma.product.findMany({
      select: { id: true, ean: true, name: true, variant: true, capacity: true, brand: true },
      where: { active: true },
    });
    productCache.set('__ALL__', all);
  }
  const all = productCache.get('__ALL__');
  const scored = all
    .map(p => ({ p, score: scoreNameMatch(cleanName, p) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const second = scored[1];
  const ambiguous = top && second && (top.score - second.score < 0.1);

  if (top && top.score >= 0.85 && !ambiguous) {
    return { productId: top.p.id, ean: top.p.ean, method: `fuzzy-${top.score.toFixed(2)}` };
  }

  // 3) LLM fallback — gdy:
  //   - top score < 0.85 (slaby match), albo
  //   - top score >= 0.85 ALE ambiguous (>1 candidate w pasmie 0.1 od topu)
  // Top 30 fuzzy candidates do LLM-a (Haiku decyduje).
  const candidates = scored.slice(0, 30).map(x => x.p);
  const llm = await llmMatchProduct(cleanName, candidates, ctx);
  if (llm.ean) {
    const matched = all.find(p => p.ean === llm.ean);
    const method = ambiguous ? `llm-tiebreak (top=${top.score.toFixed(2)},2nd=${second.score.toFixed(2)})` : llm.method;
    return { productId: matched ? matched.id : null, ean: llm.ean, method };
  }
  // LLM nie wybral — jak top jest mocny (>=0.85), bierzemy go mimo
  // ambiguity (lepiej cokolwiek niz nic).
  if (top && top.score >= 0.85) {
    return { productId: top.p.id, ean: top.p.ean, method: `fuzzy-${top.score.toFixed(2)} (llm-skipped: ${llm.method})` };
  }
  return { productId: null, ean: null, method: llm.method };
}

async function processInvoice(prisma, inv, productCache, opts) {
  const { apply, log, verbose } = opts;

  let details = null;
  try {
    details = await fetchInvoiceDetails(inv.ifirmaId, inv.type);
  } catch (e) {
    // iFirma niedostepne/blad dla tej FV -> nie poddajemy sie, sprobujemy PDF nizej.
    if (verbose) log(`  ${inv.number}: fetchDetails blad (${e.message}) -> fallback PDF`);
  }

  // Defensive: fetchInvoiceDetails unwrap-uje response, ale jakby ktos
  // kiedys zmienil unwrap — szukamy tez pod .response.Pozycje.
  const pozycje = details && Array.isArray(details.Pozycje) ? details.Pozycje
    : (details && details.response && Array.isArray(details.response.Pozycje)) ? details.response.Pozycje
    : [];
  if (pozycje.length === 0) {
    // Fallback PDF — iFirma nie zwraca pozycji (np. FV wystawione recznie /
    // innym szablonem). Generowany PDF parsujemy (regex + fallback LLM) i
    // budujemy linie. Bez tego dashboard zaniza sztuki (kwota jest, szt=0).
    const pdfRecords = await buildRecordsFromPdf(prisma, inv, productCache);
    if (!pdfRecords.length) {
      // Trwala porazka (brak PDF / pusty parse) — oznacz, zeby nie mielic
      // iFirmy/LLM w kazdym przebiegu (query wyklucza lineBackfillFailed).
      if (apply) {
        const ce = (inv.extras && typeof inv.extras === 'object') ? inv.extras : {};
        await prisma.invoice.update({ where: { id: inv.id }, data: { extras: { ...ce, lineBackfillFailed: true, lineBackfillFailedAt: new Date().toISOString() } } });
      }
      return { id: inv.id, number: inv.number, error: 'no Pozycje in iFirma + PDF parse empty' };
    }
    if (apply) {
      await prisma.invoiceLineItem.createMany({ data: pdfRecords });
      const currentExtras = (inv.extras && typeof inv.extras === 'object') ? inv.extras : {};
      await prisma.invoice.update({
        where: { id: inv.id },
        data: {
          extras: {
            ...currentExtras,
            items: pdfRecords.map(r => ({ name: r.name, qty: Number(r.qty), priceNetto: Number(r.unitPriceNetto), currency: r.currency, vatRate: r.vatRate })),
            backfilledLinesAt: new Date().toISOString(),
            itemsSource: 'pdf-parse',
          },
        },
      });
    }
    if (verbose) log(`  ${inv.number}: ${pdfRecords.length} pozycji z PDF (iFirma bez Pozycje)`);
    return { id: inv.id, number: inv.number, lineCount: pdfRecords.length, source: 'pdf' };
  }

  const matches = [];
  const records = [];
  for (let i = 0; i < pozycje.length; i++) {
    const poz = pozycje[i];
    const { ean: extractedEan, cleanName } = extractEanFromName(poz.NazwaPelna);
    const ctx = { qty: poz.Ilosc, priceNetto: poz.CenaJednostkowa, currency: inv.currency };
    const resolved = await resolveProduct(prisma, productCache, cleanName, extractedEan, ctx);
    matches.push({
      position: i + 1,
      name: poz.NazwaPelna,
      cleanName, extractedEan,
      matched: { productId: resolved.productId, ean: resolved.ean, method: resolved.method },
    });

    const qty = Number(poz.Ilosc || 0);
    const unitNetto = Number(poz.CenaZRabatem || poz.CenaJednostkowa || 0);
    const vatRateNum = Number(poz.StawkaVat || 0); // 0.23
    const vatPct = vatRateNum >= 0 && vatRateNum <= 1 ? vatRateNum * 100 : vatRateNum;
    const totalNetto = Math.round(unitNetto * qty * 100) / 100;
    const vatAmount = Math.round(totalNetto * (vatPct / 100) * 100) / 100;
    const totalGross = Math.round((totalNetto + vatAmount) * 100) / 100;

    records.push({
      invoiceId: inv.id,
      productId: resolved.productId,
      ean: resolved.ean,
      name: cleanName || poz.NazwaPelna,
      unit: poz.Jednostka || 'szt',
      qty,
      unitPriceNetto: unitNetto,
      vatRate: vatPct === 23 ? '23' : vatPct === 8 ? '8' : vatPct === 5 ? '5' : vatPct === 0 ? '0' : String(vatPct),
      vatAmount,
      totalNetto,
      totalGross,
      currency: inv.currency || 'PLN',
      contractorId: inv.contractorId,
      contractorCountry: inv.contractorCountry,
      issueDate: inv.issueDate,
      ifirmaLineId: poz.Id || null,
      position: i + 1,
      extras: {
        source: 'ifirma-details',
        ifirmaNazwaPelna: poz.NazwaPelna,
        magazynPozycjaId: poz.MagazynPozycjaId || null,
        gtu: poz.GTU && poz.GTU !== 'BRAK' ? poz.GTU : null,
        matchMethod: resolved.method,
      },
    });
  }

  if (apply) {
    await prisma.invoiceLineItem.createMany({ data: records });
    // Update Invoice.extras tez — zeby przyszle re-runy (czy 360) widzialy
    // pozycje od razu bez kolejnego call do iFirmy.
    const currentExtras = (inv.extras && typeof inv.extras === 'object') ? inv.extras : {};
    const updExtras = {
      ...currentExtras,
      pozycjeFromIfirma: pozycje,
      backfilledLinesAt: new Date().toISOString(),
      lineMatchingSummary: matches.map(m => ({ position: m.position, ean: m.matched.ean, method: m.matched.method })),
    };
    await prisma.invoice.update({ where: { id: inv.id }, data: { extras: updExtras } });
  }

  if (verbose) log(`  ${inv.number}: ${records.length} pozycji, methods: ${[...new Set(matches.map(m => m.matched.method))].join(', ')}`);
  return { id: inv.id, number: inv.number, lineCount: records.length, matches };
}

// Buduje rekordy InvoiceLineItem z PDF faktury (gdy iFirma nie zwraca Pozycji).
async function buildRecordsFromPdf(prisma, inv, productCache) {
  if (!inv.ifirmaId) return [];
  const { fetchInvoicePdf } = require('../ifirma-client');
  const { parseIfirmaPdfItems } = require('./ifirma-pdf-parser');
  const rodzaj = inv.ifirmaType || inv.type || 'wdt';
  let pdf;
  try {
    pdf = await fetchInvoicePdf(inv.number, rodzaj, inv.ifirmaId);
  } catch (e) {
    console.error(`[ifirma-lines-backfill] fetchInvoicePdf failed for ${inv.number}: ${e.message}`);
    return [];
  }
  let items = [];
  try {
    ({ items } = await parseIfirmaPdfItems(pdf));
  } catch (e) {
    console.error(`[ifirma-lines-backfill] PDF parse failed for ${inv.number}: ${e.message}`);
    return [];
  }
  if (!items || !items.length) return [];

  const records = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const qty = Number(it.qty || 0);
    if (!(qty > 0)) continue;
    const unitNetto = Number(it.priceNetto || 0);
    const vatPct = it.vatRate != null && !isNaN(Number(it.vatRate)) ? Number(it.vatRate) : 0;
    const totalNetto = Math.round(unitNetto * qty * 100) / 100;
    const vatAmount = Math.round(totalNetto * (vatPct / 100) * 100) / 100;
    const totalGross = Math.round((totalNetto + vatAmount) * 100) / 100;
    const { ean, cleanName } = extractEanFromName(it.name);
    let productId = null;
    try {
      productId = (await resolveProduct(prisma, productCache, cleanName, ean, { qty, priceNetto: unitNetto, currency: inv.currency })).productId;
    } catch (_) { /* match best-effort */ }
    records.push({
      invoiceId: inv.id,
      productId,
      ean: ean || null,
      name: cleanName || it.name,
      unit: 'szt',
      qty,
      unitPriceNetto: unitNetto,
      vatRate: String(vatPct),
      vatAmount,
      totalNetto,
      totalGross,
      currency: it.currency || inv.currency || 'PLN',
      contractorId: inv.contractorId,
      contractorCountry: inv.contractorCountry,
      issueDate: inv.issueDate,
      ifirmaLineId: null,
      position: i + 1,
      extras: { source: 'pdf-parse' },
    });
  }
  return records;
}

async function runBackfill(prisma, opts = {}) {
  const apply = !!opts.apply;
  const verbose = !!opts.verbose;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const limit = Number.isFinite(opts.limit) ? opts.limit : 20;
  const sleepMs = Number.isFinite(opts.sleepMs) ? opts.sleepMs : 1500;

  log(`backfill invoice-lines-from-ifirma apply=${apply} limit=${limit} sleep=${sleepMs}ms`);

  // Wszystkie FV ktore maja ifirmaId, sa typu fakturowego (nie korekta) i
  // nie maja jeszcze lineItems. type=null tez bierzemy (czesto staremi).
  const invoices = await prisma.invoice.findMany({
    where: {
      ifirmaId: { not: null },
      lineItems: { none: {} },
      NOT: { extras: { path: ['lineBackfillFailed'], equals: true } }, // pomijamy trwale porazki
    },
    orderBy: { issueDate: 'desc' },
    take: limit,
    select: {
      id: true, number: true, ifirmaId: true, type: true,
      contractorId: true, contractorCountry: true,
      currency: true, issueDate: true, extras: true,
    },
  });

  log(`found ${invoices.length} candidate invoices (cap limit=${limit})`);

  const productCache = new Map();
  const results = [];
  const errors = [];
  let totalLines = 0;
  let llmCalls = 0;
  let directEan = 0;
  let fuzzyMatched = 0;
  let unmatched = 0;

  for (let i = 0; i < invoices.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, sleepMs));
    const inv = invoices[i];
    log(`[${i + 1}/${invoices.length}] processing ${inv.number} (ifirmaId=${inv.ifirmaId}, type=${inv.type || '?'})`);
    const r = await processInvoice(prisma, inv, productCache, { apply, log, verbose });
    if (r.error) errors.push(r);
    else {
      results.push(r);
      totalLines += r.lineCount;
      for (const m of (r.matches || [])) {
        if (m.matched.method === 'ean-direct') directEan++;
        else if (m.matched.method && m.matched.method.startsWith('fuzzy-')) fuzzyMatched++;
        else if (m.matched.method === 'llm') llmCalls++;
        if (!m.matched.productId) unmatched++;
      }
    }
  }

  return {
    apply, processed: invoices.length, errors: errors.length, totalLinesCreated: apply ? totalLines : 0,
    matchStats: { directEan, fuzzyMatched, llmCalls, unmatched },
    sample: results.slice(0, 5),
    errorsSample: errors.slice(0, 5),
  };
}

module.exports = { runBackfill, extractEanFromName, scoreNameMatch };
