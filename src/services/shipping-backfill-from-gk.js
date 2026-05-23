'use strict';

const { getOrders } = require('../glob-client');
const { scoreContractor, normalizeContractorName } = require('./contractor-match');

// One-shot backfill: walk ALL historical GK shipments, group by receiver
// (name + address fingerprint) and persist each unique delivery address
// to the matching contractor's extras.locations[].
//
// Before this, contractors only had billing addresses (synced from
// iFirma / Contasimple). User flow w /shipments — wpisuje nazwe ->
// Znajdz -> brakowalo zassanego ship address. Ten backfill fixuje to
// historycznie (jednorazowo); nowe wysylki sa lapane przez
// find-address-in-gk-orders (per-contractor on-demand).
//
// Params (opts):
//   dryRun:    true -> tylko stats, bez prisma.update
//   useLlm:    true -> dla unmatched groups uruchom LLM fuzzy (Haiku)
//   limit:     cap na liczbe GK orders do pobrania (default: all)
//   llmCap:    max liczba LLM calls (default 100, hard ceiling cost)
//   minScore:  prog fuzzy match (default 70)
//
// Return:
//   {
//     totalOrders, uniqueReceivers, uniqueAddresses,
//     exactMatches, fuzzyMatches, llmMatches,
//     locationsAdded, locationsSkippedDup,
//     unmatchedSample: [{ name, city, country, orderCount }],
//     errors: []
//   }
async function backfillShippingFromGk(prisma, opts = {}) {
  const dryRun = !!opts.dryRun;
  const useLlm = !!opts.useLlm;
  const minScore = Number(opts.minScore) || 70;
  const llmCap = Number(opts.llmCap) || 100;
  const targetTotal = Number(opts.limit) || 100000; // de facto: pobierz wszystko

  const stats = {
    totalOrders: 0,
    uniqueReceivers: 0,
    uniqueAddresses: 0,
    exactMatches: 0,
    fuzzyMatches: 0,
    llmMatches: 0,
    llmCalls: 0,
    llmSkippedOverCap: 0,
    locationsAdded: 0,
    locationsSkippedDup: 0,
    contractorsUpdated: 0,
    unmatched: [],
    errors: [],
  };

  // 1) Pobierz wszystkie GK orders (paginacja po 100).
  function extractOrders(data) {
    if (!data) return [];
    if (Array.isArray(data) && data.length === 1 && data[0] && Array.isArray(data[0].results)) {
      return data[0].results;
    }
    if (Array.isArray(data)) return data;
    return data.results || data.items || data.data || [];
  }

  const pageSize = 100;
  const orders = [];
  for (let offset = 0; offset < targetTotal; offset += pageSize) {
    const batchSize = Math.min(pageSize, targetTotal - offset);
    let data;
    try {
      data = await getOrders({ limit: batchSize, offset });
    } catch (e) {
      console.log(`[shipping-backfill-from-gk] page offset=${offset} error: ${e.message}`);
      stats.errors.push(`page ${offset}: ${e.message}`);
      break;
    }
    const batch = extractOrders(data);
    if (offset === 0) {
      console.log(`[shipping-backfill-from-gk] first page batch=${batch.length}`);
    }
    if (batch.length === 0) break;
    orders.push(...batch);
    if (batch.length < batchSize) break;
  }
  stats.totalOrders = orders.length;
  console.log(`[shipping-backfill-from-gk] fetched ${orders.length} GK orders total`);

  if (!orders.length) return stats;

  // 2) Grupuj po (norm(name), addressFingerprint). Kazdy unikalny adres
  //    powinien byc rozpatrzony osobno — ten sam kontrahent moze miec
  //    rozne lokalizacje dostawy.
  const norm = (s) => (s || '').toString().toLowerCase().trim();
  const groups = new Map(); // key: name|fp -> { name, address, orderCount, latestDate }
  for (const o of orders) {
    const r = o.receiverAddress || o.receiver || {};
    const name = (r.name || '').trim();
    if (!name) continue;
    const address = {
      street: r.street || null,
      houseNumber: r.houseNumber || null,
      city: r.city || null,
      postCode: r.postCode || r.zipCode || null,
      country: r.countryCode || r.country || null,
      contactPerson: r.contactPerson || null,
      phone: r.phone || null,
      email: r.email || null,
    };
    const fp = `${norm(address.street)}|${norm(address.city)}|${norm(address.postCode)}`;
    if (fp === '||') continue; // adres totalnie pusty
    const key = `${norm(name)}__${fp}`;
    const date = o.creationDate || o.created_at || o.createdAt || null;
    const prev = groups.get(key);
    if (prev) {
      prev.orderCount += 1;
      if (date && (!prev.latestDate || new Date(date) > new Date(prev.latestDate))) {
        prev.latestDate = date;
      }
    } else {
      groups.set(key, { receiverName: name, address, orderCount: 1, latestDate: date });
    }
  }
  stats.uniqueAddresses = groups.size;

  // 3) Grupuj po samej nazwie — do matchowania kontrahenta (jeden contr.
  //    moze miec wiele adresow ale matchujemy raz per name).
  const byName = new Map(); // norm(name) -> { originalName, addresses: [{address, orderCount, latestDate}] }
  for (const g of groups.values()) {
    const k = norm(g.receiverName);
    if (!byName.has(k)) byName.set(k, { originalName: g.receiverName, addresses: [] });
    byName.get(k).addresses.push({ address: g.address, orderCount: g.orderCount, latestDate: g.latestDate });
  }
  stats.uniqueReceivers = byName.size;
  console.log(`[shipping-backfill-from-gk] unique receivers=${byName.size}, unique addresses=${groups.size}`);

  // 4) Wczytaj wszystkich kontrahentow raz.
  const allContractors = await prisma.contractor.findMany({
    select: { id: true, name: true, nip: true, country: true, city: true, email: true, extras: true },
  });
  // index po znormalizowanej nazwie dla exact match
  const byNormName = new Map();
  for (const c of allContractors) {
    const k = normalizeContractorName(c.name || '');
    if (!byNormName.has(k)) byNormName.set(k, c);
  }
  console.log(`[shipping-backfill-from-gk] loaded ${allContractors.length} contractors`);

  // dla persistencji w obrebie jednego runa — kumulujemy zmiany per contractor
  // (zeby jeden contractor.update zalatwil multi-address)
  const pending = new Map(); // contractorId -> { contractor, newLocations: [] }

  let llm;
  if (useLlm) {
    try { llm = require('./match-gk-order-to-contractor'); } catch (e) {
      console.log('[shipping-backfill-from-gk] LLM helper unavailable:', e.message);
    }
  }

  for (const [normName, entry] of byName.entries()) {
    const { originalName, addresses } = entry;
    let matched = null;
    let matchType = null;

    // a) exact (po znormalizowanej nazwie)
    if (byNormName.has(normName)) {
      matched = byNormName.get(normName);
      matchType = 'exact';
    }

    // b) fuzzy via scoreContractor
    if (!matched) {
      const scored = allContractors
        .map(c => ({ c, score: scoreContractor(c, originalName) }))
        .filter(x => x.score >= minScore)
        .sort((a, b) => b.score - a.score);
      if (scored.length) {
        matched = scored[0].c;
        matchType = 'fuzzy';
      }
    }

    // c) LLM fallback (opcjonalnie)
    if (!matched && useLlm && llm && stats.llmCalls < llmCap) {
      const fakeOrder = {
        receiverAddress: {
          name: originalName,
          city: addresses[0].address.city,
          country: addresses[0].address.country,
          postCode: addresses[0].address.postCode,
        },
      };
      // Top 20 fuzzy candidates (poza progiem) — kontrolujemy koszt promptu.
      const candidates = allContractors
        .map(c => ({ c, score: scoreContractor(c, originalName) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map(x => x.c);
      if (candidates.length) {
        // Wykorzystaj juz istniejacy matcher ale "odwrocony" — szuka
        // ktory kontrahent pasuje do GK ordera. Najprostszy nieinwazyjny
        // sposob: dla kazdego z top-3 kandydatow zapytaj LLM o GK->C match.
        // (Drobny koszt: max 3 calls per unmatched name).
        for (const cand of candidates.slice(0, 3)) {
          if (stats.llmCalls >= llmCap) { stats.llmSkippedOverCap += 1; break; }
          stats.llmCalls += 1;
          try {
            const r = await llm.matchGkOrderToContractor(cand, [fakeOrder]);
            if (r.matched) {
              matched = cand;
              matchType = 'llm';
              break;
            }
          } catch (e) {
            stats.errors.push(`llm ${originalName}: ${e.message}`);
          }
        }
      }
    }

    if (!matched) {
      if (stats.unmatched.length < 50) {
        stats.unmatched.push({
          name: originalName,
          city: addresses[0].address.city,
          country: addresses[0].address.country,
          orderCount: addresses.reduce((s, a) => s + a.orderCount, 0),
        });
      }
      continue;
    }

    if (matchType === 'exact') stats.exactMatches += 1;
    else if (matchType === 'fuzzy') stats.fuzzyMatches += 1;
    else if (matchType === 'llm') stats.llmMatches += 1;

    // 5) Dla kazdego adresu — dedup wzgledem juz istniejacych extras.locations[]
    let bucket = pending.get(matched.id);
    if (!bucket) {
      const fresh = await prisma.contractor.findUnique({ where: { id: matched.id }, select: { id: true, name: true, extras: true } });
      bucket = {
        contractor: fresh,
        existing: Array.isArray(fresh.extras && fresh.extras.locations) ? fresh.extras.locations : [],
        newLocations: [],
      };
      pending.set(matched.id, bucket);
    }

    for (const { address, orderCount, latestDate } of addresses) {
      if (!address.street) continue;
      const fpExisting = (l) => `${norm(l.street)}|${norm(l.city)}|${norm(l.postCode)}`;
      const fpNew = `${norm(address.street)}|${norm(address.city)}|${norm(address.postCode)}`;
      const dup = bucket.existing.some(l => fpExisting(l) === fpNew)
        || bucket.newLocations.some(l => fpExisting(l) === fpNew);
      if (dup) {
        stats.locationsSkippedDup += 1;
        continue;
      }
      bucket.newLocations.push({
        ...address,
        source: `gk_backfill (${matchType})`,
        addedAt: new Date().toISOString(),
        receiverName: originalName,
        gkOrderCount: orderCount,
        gkLatestDate: latestDate,
      });
      stats.locationsAdded += 1;
    }
  }

  // 6) Persist (chyba ze dryRun).
  if (!dryRun) {
    for (const bucket of pending.values()) {
      if (!bucket.newLocations.length) continue;
      const cExtras = (bucket.contractor.extras && typeof bucket.contractor.extras === 'object') ? bucket.contractor.extras : {};
      const merged = [...(Array.isArray(cExtras.locations) ? cExtras.locations : []), ...bucket.newLocations];
      try {
        await prisma.contractor.update({
          where: { id: bucket.contractor.id },
          data: { extras: { ...cExtras, locations: merged } },
        });
        stats.contractorsUpdated += 1;
      } catch (e) {
        stats.errors.push(`update ${bucket.contractor.id}: ${e.message}`);
      }
    }
  }

  stats.unmatchedSample = stats.unmatched;
  delete stats.unmatched;
  console.log(`[shipping-backfill-from-gk] done: exact=${stats.exactMatches} fuzzy=${stats.fuzzyMatches} llm=${stats.llmMatches} locsAdded=${stats.locationsAdded} contractorsUpdated=${stats.contractorsUpdated} dryRun=${dryRun}`);
  return stats;
}

module.exports = { backfillShippingFromGk };
