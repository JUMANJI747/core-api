'use strict';

const { getOrders } = require('../glob-client');
const { matchGkOrderToContractor } = require('./match-gk-order-to-contractor');

// Scan recent GK orders for a delivery address that matches the given
// contractor. Two-tier matching:
//   1. Token / prefix on contractor.name (free, instant)
//   2. LLM fuzzy match on top 150 candidates if token returns nothing
//      (~$0.02 per call — Haiku 4.5)
//
// On hit, persists to contractor.extras.locations[] so subsequent quotes
// hit the cached path. Returns the resolved address payload + sourceLabel.
async function findAddressInGkOrders(prisma, contractor, opts = {}) {
  if (!contractor) return { found: false, reason: 'no_contractor' };

  const limit = opts.limit || 200;
  const ordersData = await getOrders({ limit });
  const orders = (ordersData && (ordersData.results || ordersData.items || ordersData.data))
    || (Array.isArray(ordersData) ? ordersData : []);

  console.log(`[find-address-in-gk-orders] contractor="${contractor.name}" id=${contractor.id}, scanned=${orders.length}`);

  if (!orders.length) return { found: false, reason: 'no_orders', scanned: 0 };

  // 1. Token / prefix match.
  const norm = (s) => (s || '').toString().toLowerCase().trim();
  const q = norm(contractor.name || '');
  const tokens = q.split(/\s+/).filter(t => t.length >= 4);
  const matched = orders.filter(o => {
    const r = o.receiverAddress || o.receiver || {};
    const name = norm(r.name || '') + ' ' + norm(r.contactPerson || '');
    if (q && name.includes(q)) return true;
    if (!tokens.length) return false;
    const hits = tokens.filter(t => {
      if (name.includes(t)) return true;
      const prefix = t.slice(0, Math.min(5, t.length));
      return prefix.length >= 4 && name.includes(prefix);
    }).length;
    const minHits = tokens.length === 1 ? 1 : 2;
    return hits >= minHits;
  });
  matched.sort((a, b) => new Date(b.creationDate || b.created_at || b.createdAt || 0) - new Date(a.creationDate || a.created_at || a.createdAt || 0));

  console.log(`[find-address-in-gk-orders] token-match: q="${q}", tokens=[${tokens.join(',')}], matched=${matched.length}`);

  let chosen = matched[0] || null;
  let matchMethod = chosen ? 'token' : null;

  // 2. LLM fuzzy match.
  if (!chosen) {
    console.log('[find-address-in-gk-orders] token miss → calling LLM matcher');
    const llmMatch = await matchGkOrderToContractor(contractor, orders);
    console.log(`[find-address-in-gk-orders] LLM result: matched=${llmMatch.matched} index=${llmMatch.index} reason="${(llmMatch.reason || '').slice(0, 200)}"`);
    if (llmMatch.matched) {
      chosen = orders[llmMatch.index];
      matchMethod = 'llm';
    } else {
      return { found: false, reason: llmMatch.reason || 'no_match', scanned: orders.length };
    }
  }

  const r = chosen.receiverAddress || chosen.receiver || {};
  const address = {
    street: r.street || null,
    houseNumber: r.houseNumber || null,
    city: r.city || null,
    postCode: r.postCode || r.zipCode || null,
    country: r.countryCode || r.country || null,
    contactPerson: r.contactPerson || null,
    phone: r.phone || null,
    email: r.email || null,
    source: `gk_orders_history (${matchMethod})`,
    addedAt: new Date().toISOString(),
  };

  // Persist to extras.locations[] so we don't pay again next time.
  let saved = false;
  if (address.street) {
    const cExtras = (typeof contractor.extras === 'object' && contractor.extras) || {};
    const locs = Array.isArray(cExtras.locations) ? [...cExtras.locations] : [];
    const normL = (s) => (s || '').toString().toLowerCase().trim();
    const dup = locs.find(l =>
      normL(l.street) === normL(address.street) &&
      normL(l.city) === normL(address.city) &&
      normL(l.postCode) === normL(address.postCode)
    );
    if (!dup) {
      locs.push(address);
      await prisma.contractor.update({ where: { id: contractor.id }, data: { extras: { ...cExtras, locations: locs } } });
      saved = true;
    }
  }

  return { found: true, address, matchMethod, scanned: orders.length, savedToLocations: saved };
}

module.exports = { findAddressInGkOrders };
