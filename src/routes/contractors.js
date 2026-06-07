'use strict';

const router = require('express').Router();
const { processIfirmaInvoices } = require('../services/ifirma-sync');
const { fetchWithTimeout } = require('../http');
const { verifyVat } = require('../vies');
const { findAddressInContractorEmails, saveAddressToContractorLocations } = require('../services/address-from-emails');
const { findAddressInGkOrders } = require('../services/find-address-in-gk-orders');
const { backfillShippingFromGk } = require('../services/shipping-backfill-from-gk');
const { scoreContractor } = require('../services/contractor-match');
const { geocodeAndSave } = require('../services/geocode');
const { geocodeContractor } = require('../services/geocode');
const { normalizeAddress } = require('../services/llm-geocode');
const { searchContractor: ifirmaSearchContractor, upsertContractor: ifirmaUpsertContractor } = require('../ifirma-client');
const { extractPostCode, extractCityAfterPostCode } = require('../utils/address');

// Fire-and-forget geocode after upsert. We don't block the response; if
// Nominatim is slow / down we still return the contractor. The 1 req/sec
// limiter inside geocode.js serializes everything globally.
function scheduleGeocode(prisma, contractor) {
  if (!contractor) return;
  const addrChanged = contractor.address || contractor.city || contractor.country;
  if (!addrChanged) return;
  // Skip re-geocoding if we already have coords and the address-shaped fields
  // didn't change since. Cheap heuristic: only refetch when lat/lng are missing.
  if (contractor.lat != null && contractor.lng != null) return;
  setImmediate(async () => {
    try { await geocodeAndSave(prisma, contractor); }
    catch (e) { console.error('[geocode] background failed:', e.message); }
  });
}

// ============ ROUTES ============

router.post('/upsert', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const body = req.body;

    // Normalize empty strings to null
    const trim = v => (v && typeof v === 'string' && v.trim()) ? v.trim() : null;
    const n = {
      name: trim(body.name),
      nip: trim(body.nip),
      phone: trim(body.phone),
      email: trim(body.email),
      country: trim(body.country),
      city: trim(body.city),
      address: trim(body.address),
      postCode: trim(body.postCode) || trim(body.postalCode) || trim(body.zipCode) || null,
      notes: trim(body.notes),
      type: body.type || 'BUSINESS',
      tags: Array.isArray(body.tags) ? body.tags.filter(t => t && String(t).trim()) : [],
      source: trim(body.source) || 'api',
      extras: body.extras || {},
    };

    if (!n.name) return res.status(400).json({ error: 'name required' });

    // Auto-extract postCode + city z address jak agent wkleil caly adres
    // jako jeden string (np. "ul. Jagielly 1A, 11-500 Gizycko"). Helpers
    // w utils/address.js wspoldzielone z services/ifirma-payload.js.
    if (!n.postCode && n.address) {
      const zip = extractPostCode(n.address);
      if (zip) {
        n.postCode = zip;
        console.log(`[contractors/upsert] auto-extract postCode "${zip}" z address "${n.address}"`);
      }
    }
    // Fallback: wyciagnij postCode z city (np. "11-500 Gizycko" lub "Gizycko 11-500")
    if (!n.postCode && n.city) {
      const zip = extractPostCode(n.city);
      if (zip) {
        n.postCode = zip;
        n.city = n.city.replace(zip, '').replace(/[,\s]+/g, ' ').trim();
        console.log(`[contractors/upsert] auto-extract postCode "${zip}" z city "${n.city}"`);
      }
    }
    if (!n.city && n.address && n.postCode) {
      const city = extractCityAfterPostCode(n.address, n.postCode);
      if (city) {
        n.city = city;
        console.log(`[contractors/upsert] auto-extract city "${city}" z address`);
      }
    }

    // Canonicalize: postCode + address fields trafiaja do extras.billingAddress.
    // Bez tego pole nie ma gdzie usiasc — Contractor model nie ma kolumny
    // postCode, a iFirma push (auto-sync + invoice-confirm) potrzebuje go
    // strukturalnie. extras.billingAddress to standardowe miejsce (czytane
    // tez przez invoices.js przy budowie payloadu FV).
    function buildBillingAddress(existingBilling) {
      const eb = (existingBilling && typeof existingBilling === 'object') ? existingBilling : {};
      const street = n.address || eb.street || null;
      const city = n.city || eb.city || null;
      const postCode = n.postCode || eb.postCode || null;
      const country = n.country || eb.country || null;
      // Tylko zapisuj jak cos sensownego mamy
      if (!street && !city && !postCode && !country) return null;
      return {
        street, city, postCode, country,
        source: eb.source || n.source || 'upsert',
        updatedAt: new Date().toISOString(),
      };
    }

    // Optional delivery address — appended to extras.locations[] (idempotent).
    // This is the shipping address; distinct from the billing/main address
    // on the contractor row. A contractor can have many delivery locations.
    // n8n LLM tools sometimes serialize objects as JSON strings — accept both.
    let deliveryAddress = null;
    if (body.deliveryAddress) {
      if (typeof body.deliveryAddress === 'object' && !Array.isArray(body.deliveryAddress)) {
        deliveryAddress = body.deliveryAddress;
      } else if (typeof body.deliveryAddress === 'string' && body.deliveryAddress.trim()) {
        try { deliveryAddress = JSON.parse(body.deliveryAddress); }
        catch (_) { /* invalid JSON / plain text — silently ignore */ }
      }
      if (deliveryAddress && (typeof deliveryAddress !== 'object' || Array.isArray(deliveryAddress))) {
        deliveryAddress = null;
      }
    }

    function appendLocation(locations, addr, fallbackCountry) {
      const list = Array.isArray(locations) ? [...locations] : [];
      if (!addr || (!addr.street && !addr.city)) return { list, added: false };
      const norm = (s) => (s || '').toString().toLowerCase().trim();
      const newLoc = {
        street: addr.street || null,
        houseNumber: addr.houseNumber || null,
        city: addr.city || null,
        postCode: addr.postCode || null,
        country: addr.country || fallbackCountry || null,
        contactPerson: addr.contactPerson || null,
        phone: addr.phone || null,
        email: addr.email || null,
        source: addr.source || 'upsert',
        addedAt: new Date().toISOString(),
      };
      const dup = list.find(l =>
        norm(l.street) === norm(newLoc.street) &&
        norm(l.city) === norm(newLoc.city) &&
        norm(l.postCode) === norm(newLoc.postCode)
      );
      if (dup) return { list, added: false };
      list.push(newLoc);
      return { list, added: true };
    }

    // Find existing: by NIP, then by email, then by exact name
    let existing = null;
    if (n.nip) existing = await prisma.contractor.findUnique({ where: { nip: n.nip } });
    if (!existing && n.email) existing = await prisma.contractor.findFirst({ where: { email: { equals: n.email, mode: 'insensitive' } } });
    if (!existing && !n.nip) existing = await prisma.contractor.findFirst({ where: { name: { equals: n.name, mode: 'insensitive' } } });

    let contractor;
    let deliveryAddressAdded = false;
    if (existing) {
      const mergedExtras = { ...(existing.extras || {}), ...n.extras };

      // Merge billingAddress: nowe pola top-level (address/city/country/postCode)
      // mocza istniejace extras.billingAddress.* (z preserve).
      const newBilling = buildBillingAddress(mergedExtras.billingAddress);
      if (newBilling) mergedExtras.billingAddress = newBilling;

      if (n.nip && existing.nip && n.nip !== existing.nip) {
        mergedExtras.nipList = Array.from(new Set([existing.nip, n.nip, ...(mergedExtras.nipList || [])]));
      }
      if (n.phone && existing.phone && n.phone !== existing.phone) {
        mergedExtras.phoneList = Array.from(new Set([existing.phone, n.phone, ...(mergedExtras.phoneList || [])]));
      }
      if (n.email && existing.email && n.email.toLowerCase() !== existing.email.toLowerCase()) {
        mergedExtras.emailList = Array.from(new Set([existing.email, n.email, ...(mergedExtras.emailList || [])]));
      }

      if (deliveryAddress) {
        const { list, added } = appendLocation(mergedExtras.locations, deliveryAddress, n.country || existing.country);
        mergedExtras.locations = list;
        deliveryAddressAdded = added;
      }

      const mergedTags = Array.from(new Set([...(existing.tags || []), ...n.tags]));

      contractor = await prisma.contractor.update({
        where: { id: existing.id },
        data: {
          name: n.name,
          ...(n.nip ? { nip: n.nip } : {}),
          ...(body.type !== undefined ? { type: n.type } : {}),
          ...(n.phone ? { phone: n.phone } : {}),
          ...(n.email ? { email: n.email } : {}),
          ...(n.address !== null ? { address: n.address } : {}),
          ...(n.city !== null ? { city: n.city } : {}),
          ...(n.country !== null ? { country: n.country } : {}),
          ...(n.notes !== null ? { notes: n.notes } : {}),
          ...(body.source !== undefined ? { source: n.source } : {}),
          extras: mergedExtras,
          tags: mergedTags,
        },
      });
    } else {
      const createExtras = { ...n.extras };
      const newBilling = buildBillingAddress(createExtras.billingAddress);
      if (newBilling) createExtras.billingAddress = newBilling;
      if (deliveryAddress) {
        const { list, added } = appendLocation(createExtras.locations, deliveryAddress, n.country);
        createExtras.locations = list;
        deliveryAddressAdded = added;
      }
      contractor = await prisma.contractor.create({
        data: {
          name: n.name,
          nip: n.nip,
          type: n.nip ? 'BUSINESS' : (n.type || 'PERSON'),
          phone: n.phone,
          email: n.email,
          country: n.country,
          city: n.city,
          address: n.address,
          notes: n.notes,
          extras: createExtras,
          tags: n.tags,
          source: n.source,
        },
      });
    }
    res.json(deliveryAddress ? { ...contractor, deliveryAddressAdded } : contractor);
    scheduleGeocode(prisma, contractor);
    // Fire-and-forget push do iFirmy (jak NIP istnieje). Zapewnia ze przy
    // pierwszej probie wystawienia FV kontrahent w iFirmie ma juz aktualne
    // dane (postCode, ulica, miasto). Bez tego iFirma tworzyla kontrahenta
    // auto z inline body FV ale czasem bez postCode -> FV padala.
    if (contractor.nip) {
      setImmediate(async () => {
        try {
          const billing = (contractor.extras && contractor.extras.billingAddress) || {};
          const result = await ifirmaUpsertContractor({
            name: contractor.name,
            nip: contractor.nip,
            address: contractor.address || billing.street || '',
            city: contractor.city || billing.city || '',
            postCode: billing.postCode || '',
            country: contractor.country || billing.country || 'Polska',
            email: contractor.email || '',
            phone: contractor.phone || '',
          });
          console.log(`[contractors/upsert] auto-sync iFirma OK: ${contractor.nip} → ${result.action} id=${result.identifier}`);
        } catch (e) {
          console.warn(`[contractors/upsert] auto-sync iFirma failed (non-fatal): ${contractor.nip} → ${e.message}`);
        }
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backfill: geocode every contractor that has an address but no coords yet.
// Hits both PL Contractor and ES EsContractor models. Respects Nominatim's
// 1 req/sec policy (handled in geocode service). Skips rows already marked
// geocodingStatus = 'ok' or 'not_found' so reruns are cheap.
// Pass { force: true } to retry not_found / error rows.
router.post('/geocode-all', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const force = req.body && req.body.force === true;
  try {
    // PL: address/city are required, but extras may also carry locations[] /
    // billingAddress — we filter generously here and let the geocode service
    // reject rows that yield empty queries (status: 'skipped').
    const plWhere = force
      ? {}
      : { OR: [{ geocodingStatus: null }, { geocodingStatus: 'error' }] };
    const pl = await prisma.contractor.findMany({
      where: plWhere,
      select: { id: true, name: true, address: true, city: true, country: true, extras: true },
    });

    const esWhere = force
      ? {}
      : { OR: [{ geocodingStatus: null }, { geocodingStatus: 'error' }] };
    const es = await prisma.esContractor.findMany({
      where: esWhere,
      select: { id: true, name: true, address: true, city: true, province: true, country: true, postalCode: true, extras: true },
    });

    const stats = { pl: { total: pl.length, ok: 0, not_found: 0, error: 0, skipped: 0 },
                    es: { total: es.length, ok: 0, not_found: 0, error: 0, skipped: 0 } };

    for (const c of pl) {
      const r = await geocodeAndSave(prisma, c, 'contractor');
      stats.pl[r.status] = (stats.pl[r.status] || 0) + 1;
      console.log(`[geocode-all/pl] ${c.name} → ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
    }
    for (const c of es) {
      const r = await geocodeAndSave(prisma, c, 'esContractor');
      stats.es[r.status] = (stats.es[r.status] || 0) + 1;
      console.log(`[geocode-all/es] ${c.name} → ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
    }

    res.json({ ok: true, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pulls billing addresses from iFirma for every PL contractor that has a
// NIP but no usable address yet, then geocodes them. iFirma stores full
// address per NIP — we just lazily import on demand.
// Body: { force?: boolean, limit?: number }
// `force: true` re-fetches even if extras.billingAddress already exists.
// `limit` caps how many contractors to process (default: all).
router.post('/import-addresses-ifirma', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const force = req.body && req.body.force === true;
  const limit = req.body && Number(req.body.limit) > 0 ? Number(req.body.limit) : null;
  try {
    const where = force
      ? { nip: { not: null } }
      : {
          AND: [
            { nip: { not: null } },
            { OR: [{ address: null }, { address: '' }] },
            { OR: [{ city: null }, { city: '' }] },
          ],
        };
    const all = await prisma.contractor.findMany({
      where,
      select: { id: true, name: true, nip: true, country: true, extras: true },
    });
    const candidates = limit ? all.slice(0, limit) : all;
    const stats = { total: candidates.length, fetched: 0, no_data: 0, ifirma_error: 0,
                    geocoded_ok: 0, geocoded_not_found: 0, geocoded_error: 0, geocoded_skipped: 0 };

    for (const c of candidates) {
      // 1) iFirma fetch — 1 req/sec to be polite (sleep before each request).
      await new Promise(r => setTimeout(r, 1000));
      let ifirmaRow = null;
      try {
        ifirmaRow = await ifirmaSearchContractor(c.nip);
      } catch (e) {
        console.error(`[import-addr/ifirma] ${c.name} (${c.nip}) → error:`, e.message);
        stats.ifirma_error++;
        continue;
      }
      if (!ifirmaRow || (!ifirmaRow.Ulica && !ifirmaRow.Miejscowosc)) {
        stats.no_data++;
        console.log(`[import-addr/ifirma] ${c.name} (${c.nip}) → no_data`);
        continue;
      }
      const billingAddress = {
        street: [ifirmaRow.Ulica, ifirmaRow.NumerDomu].filter(Boolean).join(' ').trim(),
        city: ifirmaRow.Miejscowosc || '',
        postCode: ifirmaRow.KodPocztowy || '',
        country: ifirmaRow.Kraj || ifirmaRow.KrajKod || c.country || 'Polska',
        source: 'ifirma',
        importedAt: new Date().toISOString(),
      };
      const newExtras = { ...(c.extras || {}), billingAddress };
      await prisma.contractor.update({ where: { id: c.id }, data: { extras: newExtras } });
      stats.fetched++;
      console.log(`[import-addr/ifirma] ${c.name} → ${billingAddress.street}, ${billingAddress.city}`);

      // 2) Geocode right away. buildQuery now reads extras.billingAddress.
      const r = await geocodeAndSave(prisma, { ...c, extras: newExtras }, 'contractor');
      const key = `geocoded_${r.status}`;
      stats[key] = (stats[key] || 0) + 1;
    }
    res.json({ ok: true, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// LLM fallback for rows Nominatim couldn't geocode. We take whatever
// address text we have (extras.billingAddress / direct cols), pass it to
// Claude Haiku to extract clean { city, country, postalCode }, then ask
// Nominatim for "city, country" — that almost never fails. Precision
// drops to city-level (~1-3km) which is fine for the map.
// Body: { dryRun?: bool, limit?: number, model?: 'pl'|'es'|'both' }
router.post('/geocode-llm-fallback', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const dryRun = req.body && req.body.dryRun === true;
  const limit = req.body && Number(req.body.limit) > 0 ? Number(req.body.limit) : null;
  const which = (req.body && req.body.model) || 'both';
  try {
    const stats = {
      pl: { total: 0, llm_ok: 0, llm_fail: 0, geocoded: 0, still_missing: 0 },
      es: { total: 0, llm_ok: 0, llm_fail: 0, geocoded: 0, still_missing: 0 },
    };
    const examples = [];

    async function processBatch(rows, kind, modelName) {
      stats[kind].total = rows.length;
      for (const c of rows) {
        // Build the raw text we send to LLM — best signal available.
        let raw = '';
        if (kind === 'pl') {
          const ba = c.extras && c.extras.billingAddress;
          if (ba) raw = [ba.street, ba.postCode, ba.city, ba.country].filter(Boolean).join(', ');
          if (!raw) raw = [c.address, c.city, c.country].filter(Boolean).join(', ');
        } else {
          raw = [c.address, c.postalCode, c.city, c.province, c.country].filter(Boolean).join(', ');
        }
        if (!raw) { stats[kind].still_missing++; continue; }

        const norm = await normalizeAddress(raw);
        if (!norm || !norm.city || !norm.country) {
          stats[kind].llm_fail++;
          if (!dryRun) {
            await prisma[modelName].update({
              where: { id: c.id },
              data: { geocodingStatus: 'llm_failed', geocodedAt: new Date() },
            });
          }
          examples.push({ kind, name: c.name, raw, llm: norm });
          continue;
        }
        stats[kind].llm_ok++;

        // Geocode the clean "city, country" form (skip postal — adding it
        // sometimes makes Nominatim too literal).
        const fake = { address: '', city: norm.city, country: norm.country };
        const r = await geocodeContractor(fake);
        if (r.status === 'ok') {
          if (!dryRun) {
            await prisma[modelName].update({
              where: { id: c.id },
              data: {
                lat: r.lat,
                lng: r.lng,
                geocodedAt: new Date(),
                geocodingStatus: 'ok_llm', // distinguish so we can audit later
              },
            });
          }
          stats[kind].geocoded++;
        } else {
          stats[kind].still_missing++;
          if (!dryRun) {
            await prisma[modelName].update({
              where: { id: c.id },
              data: { geocodingStatus: 'llm_failed', geocodedAt: new Date() },
            });
          }
          examples.push({ kind, name: c.name, raw, llm: norm, geocode: r });
        }
      }
    }

    if (which === 'pl' || which === 'both') {
      const pl = await prisma.contractor.findMany({
        where: { geocodingStatus: { in: ['not_found', 'error'] } },
        select: { id: true, name: true, address: true, city: true, country: true, extras: true },
        ...(limit ? { take: limit } : {}),
      });
      await processBatch(pl, 'pl', 'contractor');
    }
    if (which === 'es' || which === 'both') {
      const es = await prisma.esContractor.findMany({
        where: { geocodingStatus: { in: ['not_found', 'error'] } },
        select: { id: true, name: true, address: true, city: true, province: true, country: true, postalCode: true, extras: true },
        ...(limit ? { take: limit } : {}),
      });
      await processBatch(es, 'es', 'esContractor');
    }

    res.json({ ok: true, dryRun, stats, examples: examples.slice(0, 10) });
  } catch (e) {
    console.error('[geocode-llm-fallback] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Lists rows whose geocoded location is suspiciously far from the centre
// of Europe. Tunable — Bonaire / US / other intentional exports stay
// visible until the user explicitly clears them.
// Query: ?radiusKm=4000 (default), ?lat=50&lng=10 (default centre)
router.get('/geocode-outliers', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const centreLat = Number(req.query.lat) || 50;
  const centreLng = Number(req.query.lng) || 10;
  const radiusKm = Number(req.query.radiusKm) || 4000;

  // Haversine in km
  function distanceKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const toRad = d => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  try {
    const pl = await prisma.contractor.findMany({
      where: { lat: { not: null }, lng: { not: null }, geocodingStatus: { in: ['ok', 'ok_llm'] } },
      select: { id: true, name: true, country: true, city: true, lat: true, lng: true, geocodingStatus: true, extras: true },
    });
    const es = await prisma.esContractor.findMany({
      where: { lat: { not: null }, lng: { not: null }, geocodingStatus: { in: ['ok', 'ok_llm'] } },
      select: { id: true, name: true, country: true, province: true, city: true, lat: true, lng: true, geocodingStatus: true },
    });

    const outliers = [];
    for (const c of pl) {
      const d = distanceKm(centreLat, centreLng, c.lat, c.lng);
      if (d > radiusKm) {
        const ba = c.extras && c.extras.billingAddress;
        outliers.push({
          kind: 'pl', id: c.id, name: c.name,
          country: c.country, city: c.city,
          billingAddress: ba ? `${ba.street || ''}, ${ba.postCode || ''} ${ba.city || ''}, ${ba.country || ''}` : null,
          lat: c.lat, lng: c.lng, distanceKm: Math.round(d),
          geocodingStatus: c.geocodingStatus,
        });
      }
    }
    for (const c of es) {
      const d = distanceKm(centreLat, centreLng, c.lat, c.lng);
      if (d > radiusKm) {
        outliers.push({
          kind: 'es', id: c.id, name: c.name,
          country: c.country, province: c.province, city: c.city,
          lat: c.lat, lng: c.lng, distanceKm: Math.round(d),
          geocodingStatus: c.geocodingStatus,
        });
      }
    }
    outliers.sort((a, b) => b.distanceKm - a.distanceKm);
    res.json({ ok: true, count: outliers.length, outliers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Clears lat/lng + marks status as 'suspect_outlier' for the given ids.
// Idempotent — useful after /geocode-outliers review to drop bogus pins.
// Body: { ids: ['uuid', ...], kind: 'pl' | 'es' }
router.post('/geocode-clear', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  const kind = (req.body && req.body.kind) || 'pl';
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  const model = kind === 'es' ? 'esContractor' : 'contractor';
  try {
    const r = await prisma[model].updateMany({
      where: { id: { in: ids } },
      data: { lat: null, lng: null, geocodingStatus: 'suspect_outlier' },
    });
    res.json({ ok: true, cleared: r.count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/import-ifirma', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { invoices } = req.body;
    if (!Array.isArray(invoices) || !invoices.length) return res.status(400).json({ error: 'invoices array required' });
    const result = await processIfirmaInvoices(invoices, prisma);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/verify-nip', async (req, res) => {
  try {
    let { nip, country } = req.body;
    if (!nip) return res.status(400).json({ error: 'nip required' });
    nip = nip.trim().replace(/[\s\-]/g, '').toUpperCase();
    if (country) country = country.trim().toUpperCase();

    const hasPrefix = /^[A-Z]{2}/.test(nip);
    if (!hasPrefix) {
      if (country) {
        nip = country + nip;
      } else if (/^\d{10}$/.test(nip)) {
        nip = 'PL' + nip;
      } else {
        return res.status(400).json({ error: "Cannot determine country for NIP. Provide country (e.g. 'ES') or use a NIP with country prefix (e.g. 'ESB12345678')." });
      }
    }

    const isPolish = /^PL\d{10}$/.test(nip);

    if (isPolish) {
      const nipNum = nip.slice(2);
      const today = new Date().toISOString().slice(0, 10);

      const mfRes = await fetchWithTimeout(`https://wl-api.mf.gov.pl/api/search/nip/${nipNum}?date=${today}`, {}, 10000);
      if (mfRes.status === 404) return res.status(404).json({ error: 'Company not found' });
      if (!mfRes.ok) return res.status(502).json({ error: 'MF API error', status: mfRes.status });

      const mfData = await mfRes.json();
      const s = mfData?.result?.subject;
      if (!s) return res.status(404).json({ error: 'Company not found' });

      return res.json({ source: 'MF', nip: nipNum, name: s.name, regon: s.regon, krs: s.krs, address: s.workingAddress, statusVat: s.statusVat });
    } else {
      const countryCode = nip.slice(0, 2);
      const vatNumber = nip.slice(2);

      const v = await verifyVat(countryCode, vatNumber);
      console.log(`[verify-nip] VIES ${nip}: status=${v.status} valid=${v.valid} userError=${v.userError || '-'}`);

      // Usluga VIES nie zdolala zweryfikowac (kraj niedostepny / limit / timeout).
      // NIE raportuj jako "nieaktywny" — to falszywy negatyw.
      if (v.status === 'unknown') {
        return res.json({
          source: 'VIES',
          nip, countryCode, vatNumber,
          valid: null,
          status: 'unknown',
          verifiable: false,
          name: v.name, address: v.address, requestDate: v.requestDate,
          userError: v.userError,
          message: `VIES nie mógł teraz zweryfikować ${nip} — usługa VIES kraju ${countryCode} jest chwilowo niedostępna lub przekroczono limit (${v.userError || 'brak odpowiedzi'}). To NIE oznacza, że NIP jest błędny. Spróbuj ponownie za chwilę albo sprawdź ręcznie na stronie VIES. Kontrahenta można zapisać mimo to.`,
        });
      }

      return res.json({ source: 'VIES', nip, countryCode, vatNumber, valid: v.valid, status: v.status, name: v.name, address: v.address, requestDate: v.requestDate });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ustaw tryb VAT kontrahenta.
//  - mode='domestic' -> zawsze NORMALNA FV z VAT 23% (krajowa), nawet gdy klient
//    z UE i VIES nieaktywny (np. stowarzyszenie). Zapis: extras.vatMode='domestic'.
//  - mode='auto' (lub 'wdt') -> usun override (domyslnie WDT 0% gdy UE+aktywny VIES).
router.post('/vat-mode', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    let { contractorId, nip, search, contractorSearch, mode } = req.body || {};
    search = search || contractorSearch;
    mode = String(mode || '').toLowerCase();
    if (mode === 'wdt') mode = 'auto';
    if (!['domestic', 'auto'].includes(mode)) {
      return res.status(400).json({ error: "mode musi byc 'domestic' albo 'auto'" });
    }

    let contractor = null;
    if (contractorId) contractor = await prisma.contractor.findUnique({ where: { id: contractorId } }).catch(() => null);
    if (!contractor && nip) {
      const n = String(nip).replace(/[\s-]/g, '');
      contractor = await prisma.contractor.findFirst({ where: { nip: { contains: n, mode: 'insensitive' } } }).catch(() => null);
    }
    if (!contractor && search) {
      contractor = await prisma.contractor.findFirst({ where: { name: { contains: String(search), mode: 'insensitive' } }, orderBy: { updatedAt: 'desc' } }).catch(() => null);
    }
    if (!contractor) return res.status(404).json({ error: 'Nie znaleziono kontrahenta (podaj contractorId, nip albo search/contractorSearch)' });

    const extras = (typeof contractor.extras === 'object' && contractor.extras) ? contractor.extras : {};
    const newExtras = { ...extras };
    if (mode === 'domestic') newExtras.vatMode = 'domestic';
    else delete newExtras.vatMode;
    await prisma.contractor.update({ where: { id: contractor.id }, data: { extras: newExtras } });

    return res.json({
      ok: true,
      contractorId: contractor.id,
      name: contractor.name,
      vatMode: newExtras.vatMode || 'auto',
      message: mode === 'domestic'
        ? `Ustawiono: ${contractor.name} bedzie fakturowany NORMALNA FV z VAT 23% (krajowa, waluta EUR), mimo UE.`
        : `Przywrocono automatyczny tryb VAT dla ${contractor.name} (WDT 0% gdy UE + aktywny VIES).`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { search, country, tag, limit } = req.query;
  const take = parseInt(limit) || 50;
  const where = {};
  if (search) where.name = { contains: search, mode: 'insensitive' };
  if (country) where.country = { equals: country, mode: 'insensitive' };
  if (tag) where.tags = { has: tag };
  const contractors = await prisma.contractor.findMany({ where, take, orderBy: { updatedAt: 'desc' } });

  // Contact-name match: user pisze "wystaw FV dla Marco" - Marco to imie
  // kontaktu w extras.contacts[].name, nie nazwa firmy. Lokalny JS filter
  // (jsonpath w Prismie ograniczony; <2000 rekordow z extras to <100ms).
  // Dolaczamy match'e do wyniku z `name contains` dedup po id.
  let merged = [...contractors];
  if (search && !tag) {
    const searchLower = String(search).toLowerCase().trim();
    if (searchLower.length >= 2) {
      try {
        const candidatesWithExtras = await prisma.contractor.findMany({
          where: country ? { country: { equals: country, mode: 'insensitive' } } : {},
          select: { id: true, name: true, nip: true, country: true, email: true, primaryEmail: true, phone: true, city: true, address: true, tags: true, source: true, extras: true, createdAt: true, updatedAt: true },
          take: 2000,
        });
        const contactMatches = candidatesWithExtras.filter(c => {
          const ex = c.extras;
          if (!ex || typeof ex !== 'object') return false;
          const contacts = ex.contacts;
          if (!Array.isArray(contacts)) return false;
          return contacts.some(ct => {
            if (!ct || typeof ct !== 'object') return false;
            const nm = (ct.name || ct.personName || '').toString().toLowerCase();
            return nm && nm.includes(searchLower);
          });
        });
        const existingIds = new Set(merged.map(c => c.id));
        for (const cm of contactMatches) {
          if (existingIds.has(cm.id)) continue;
          if (merged.length >= take) break;
          merged.push({ ...cm, matchedBy: 'contact' });
          existingIds.add(cm.id);
        }
        if (contactMatches.length) {
          console.log(`[contractors/search] contact-name match: "${search}" → ${contactMatches.length} kontrahentow z dopasowaniem w extras.contacts`);
        }
      } catch (e) {
        console.warn('[contractors/search] contact-name match failed (non-fatal):', e.message);
      }
    }
  }

  // Enrich kazdy wiersz o shippingAddress (merged: ContractorAddress shipping/billing,
  // extras.locations[0], extras.billingAddress, fallback Contractor.address/city/country).
  // Frontend /shipments uzywa tego do auto-fill po klik "Znajdz".
  async function enrichWithShippingAddress(c) {
    try {
      const cExtras = c.extras || {};

      // 1. Preferuj extras.locations[0] (deliv addr explicit z agent flow)
      const locations = Array.isArray(cExtras.locations) ? cExtras.locations : [];
      if (locations.length) {
        const loc = locations[0];
        if (loc.street || loc.city || loc.postCode) {
          return {
            ...c,
            shippingAddress: {
              street: loc.street || '',
              postCode: loc.postCode || '',
              city: loc.city || '',
              country: loc.country || c.country || '',
              phone: loc.phone || c.phone || '',
              email: loc.email || c.primaryEmail || c.email || '',
              source: 'extras.locations[0]',
            },
          };
        }
      }

      // 2. ContractorAddress (CRM v2) - shipping > billing
      const addr = await prisma.contractorAddress.findFirst({
        where: { contractorId: c.id, type: { in: ['shipping', 'delivery', 'billing'] } },
        orderBy: [{ type: 'asc' }, { isPrimary: 'desc' }, { updatedAt: 'desc' }],
      }).catch(() => null);
      if (addr && (addr.street || addr.city)) {
        return {
          ...c,
          shippingAddress: {
            street: addr.street || '',
            postCode: addr.postalCode || '',
            city: addr.city || '',
            country: addr.country || c.country || '',
            phone: c.phone || '',
            email: c.primaryEmail || c.email || '',
            source: `contractorAddress.${addr.type}`,
          },
        };
      }

      // 3. extras.billingAddress (canonical billing in extras)
      const billing = cExtras.billingAddress;
      if (billing && (billing.street || billing.city || billing.postCode)) {
        return {
          ...c,
          shippingAddress: {
            street: billing.street || '',
            postCode: billing.postCode || '',
            city: billing.city || '',
            country: billing.country || c.country || '',
            phone: c.phone || '',
            email: c.primaryEmail || c.email || '',
            source: 'extras.billingAddress',
          },
        };
      }

      // 4. Fallback - Contractor.address/city/country + regex postCode
      const postCodeFromAddr = c.address ? (extractPostCode(c.address) || '') : '';
      if (c.address || c.city) {
        return {
          ...c,
          shippingAddress: {
            street: c.address || '',
            postCode: postCodeFromAddr || cExtras.postCode || cExtras.zipCode || '',
            city: c.city || '',
            country: c.country || '',
            phone: c.phone || '',
            email: c.primaryEmail || c.email || '',
            source: 'contractor.row',
          },
        };
      }

      // 5. Nic
      return { ...c, shippingAddress: null };
    } catch (e) {
      console.warn('[enrichShippingAddress] failed:', e.message);
      return { ...c, shippingAddress: null };
    }
  }

  // Fuzzy fallback: if naive `name contains` (and contact match) failed
  // (e.g. "holaola" vs "Hola Ola" — spacing differs) and no other filter
  // narrowed the set, load all contractors and score them against the
  // search term.
  if (search && merged.length === 0 && !country && !tag) {
    const all = await prisma.contractor.findMany({
      select: { id: true, name: true, nip: true, country: true, email: true, phone: true, city: true, address: true, tags: true, source: true, extras: true, createdAt: true, updatedAt: true },
      take: 500,
    });
    const scored = all
      .map(c => ({ c, score: scoreContractor(c, search) }))
      .filter(x => x.score >= 50)
      .sort((a, b) => b.score - a.score)
      .slice(0, take);
    if (scored.length) {
      console.log(`[contractors/search] fuzzy fallback: "${search}" → ${scored.length} match(es), top: "${scored[0].c.name}" (score ${scored[0].score})`);
      const enrichedFuzzy = await Promise.all(scored.map(x => enrichWithShippingAddress(x.c)));
      return res.json(enrichedFuzzy);
    }
  }

  const enriched = await Promise.all(merged.map(c => enrichWithShippingAddress(c)));
  res.json(enriched);
});

// GET /api/contractors/map-points — dokladne dane (lat, lng, last invoice,
// open transactions) dla mapy w Dashboard. Pod auth middleware (x-api-key).
// UWAGA: musi byc PRZED router.get('/:id') — inaczej 'map-points' matchuje :id.
router.get('/map-points', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const pl = await prisma.contractor.findMany({
      where: { lat: { not: null }, lng: { not: null }, geocodingStatus: { in: ['ok', 'ok_llm'] } },
      select: { id: true, name: true, lat: true, lng: true, address: true, city: true, country: true, nip: true },
    });
    const es = await prisma.esContractor.findMany({
      where: { lat: { not: null }, lng: { not: null }, geocodingStatus: { in: ['ok', 'ok_llm'] } },
      select: { id: true, name: true, lat: true, lng: true, address: true, city: true, province: true, postalCode: true, country: true },
    });

    const invoiceById = new Map();
    const openTxById = new Map();
    if (pl.length) {
      const plIds = pl.map(c => c.id);
      const lastInvoices = await prisma.$queryRaw`
        SELECT DISTINCT ON ("contractorId") "contractorId", "number", "issueDate", "grossAmount", "currency"
        FROM "Invoice" WHERE "contractorId" = ANY(${plIds})
        ORDER BY "contractorId", "issueDate" DESC
      `;
      lastInvoices.forEach(r => invoiceById.set(r.contractorId, r));
      const openCounts = await prisma.transaction.groupBy({
        by: ['contractorId'],
        where: { contractorId: { in: plIds }, OR: [{ hasPayment: false }, { hasDelivered: false }] },
        _count: { _all: true },
      });
      openCounts.forEach(r => openTxById.set(r.contractorId, r._count._all));
    }

    const points = [
      ...pl.map(c => ({
        id: c.id, source: 'PL', name: c.name, lat: c.lat, lng: c.lng,
        address: c.address || null, city: c.city || null, country: c.country || null, nip: c.nip || null,
        lastInvoice: invoiceById.has(c.id) ? {
          number: invoiceById.get(c.id).number,
          date: invoiceById.get(c.id).issueDate,
          amount: invoiceById.get(c.id).grossAmount,
          currency: invoiceById.get(c.id).currency,
        } : null,
        openTransactions: openTxById.get(c.id) || 0,
      })),
      ...es.map(c => ({
        id: c.id, source: 'ES', name: c.name, lat: c.lat, lng: c.lng,
        address: c.address || null, city: c.city || null, country: c.country || null,
        province: c.province || null, postalCode: c.postalCode || null,
        lastInvoice: null, openTransactions: 0,
      })),
    ];
    res.json({ ok: true, count: points.length, points });
  } catch (e) {
    console.error('[contractors/map-points]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const c = await prisma.contractor.findUnique({ where: { id: req.params.id }, include: { deals: true, consignments: true, emails: { take: 10, orderBy: { createdAt: 'desc' } } } });
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(c);
});

// CRM v2 Etap 3.1 — Customer 360 bundle. Jeden call zwraca pelny widok
// kontrahenta: dane + kontakty + adresy + linked Canarias + FV PL/ES +
// maile (zarowno po contractorId jak i po dopasowaniu adresu z
// ContractorContact, bo nie wszystkie maile sa juz zlinkowane) +
// transakcje + stats. ActivityEvent timeline dolaczamy w commicie #13
// po wdrozeniu Etapu 4.
//
// Query params: limitInvoices, limitEmails, limitTransactions (cap 200).
router.get('/:id/360', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { id } = req.params;
  const limitInvoices = Math.min(parseInt(req.query.limitInvoices) || 20, 200);
  const limitEmails = Math.min(parseInt(req.query.limitEmails) || 20, 200);
  const limitTransactions = Math.min(parseInt(req.query.limitTransactions) || 20, 200);
  const limitActivity = Math.min(parseInt(req.query.limitActivity) || 50, 500);

  try {
    const contractor = await prisma.contractor.findUnique({
      where: { id },
      include: {
        contacts: { orderBy: [{ isPrimary: 'desc' }, { type: 'asc' }, { createdAt: 'asc' }] },
        addresses: { orderBy: [{ isPrimary: 'desc' }, { type: 'asc' }, { createdAt: 'asc' }] },
      },
    });
    if (!contractor) return res.status(404).json({ error: 'not found' });

    // Linked Canarias contractor (cross-ref PL <-> ES, jednokierunkowo z PL).
    const linkedEs = contractor.linkedEsContractorId
      ? await prisma.esContractor.findUnique({ where: { id: contractor.linkedEsContractorId } })
      : null;

    // Email pool po adresach z ContractorContact + flat email/primaryEmail.
    // Nie wszystkie maile maja contractorId (np. info@ web-orders, nowe
    // konwersacje przed auto-matchem), wiec dorzucamy match po fromEmail/
    // toEmail z wszystkich znanych adresow tego kontrahenta. Dedup po
    // Email.id w resp.
    const emailValues = new Set();
    for (const ct of contractor.contacts) {
      if (ct.type === 'email' && ct.value) emailValues.add(ct.value.toLowerCase());
    }
    if (contractor.primaryEmail) emailValues.add(contractor.primaryEmail.toLowerCase());
    if (contractor.email) emailValues.add(contractor.email.toLowerCase());
    const emailAddrs = [...emailValues];

    const emailWhere = emailAddrs.length
      ? { OR: [
          { contractorId: id },
          { fromEmail: { in: emailAddrs, mode: 'insensitive' } },
          { toEmail: { in: emailAddrs, mode: 'insensitive' } },
        ] }
      : { contractorId: id };

    // Invoices PL — wszystkie polaczone z tym Contractor.
    // Invoices ES — przez linkedEs (jak null to pusto).
    // Transactions — po contractorId. Wszystkie tasks w parallel.
    const [
      invoicesPl,
      invoicesEs,
      emails,
      transactions,
      invoiceCountPl,
      invoiceCountEs,
      lastInvoicePl,
      lastInvoiceEs,
      lastShipment,
      revenuePlAgg,
      revenueEurPlAgg,
      revenueEsAgg,
    ] = await Promise.all([
      prisma.invoice.findMany({
        where: { contractorId: id },
        orderBy: { issueDate: 'desc' },
        take: limitInvoices,
        select: {
          id: true, number: true, issueDate: true, dueDate: true,
          grossAmount: true, currency: true, status: true, type: true, ifirmaId: true,
          _count: { select: { lineItems: true } },
        },
      }),
      linkedEs ? prisma.esInvoice.findMany({
        where: { contractorId: linkedEs.id },
        orderBy: { invoiceDate: 'desc' },
        take: limitInvoices,
        select: {
          id: true, number: true, invoiceDate: true, expirationDate: true,
          totalAmount: true, currency: true, status: true, contasimpleId: true,
          _count: { select: { lineItems: true } },
        },
      }) : Promise.resolve([]),
      prisma.email.findMany({
        where: emailWhere,
        orderBy: { createdAt: 'desc' },
        take: limitEmails,
        select: {
          id: true, direction: true, inbox: true, fromEmail: true, fromName: true, toEmail: true,
          subject: true, bodyPreview: true, createdAt: true, tags: true,
          _count: { select: { attachments: true } },
        },
      }),
      prisma.transaction.findMany({
        where: { contractorId: id },
        orderBy: { occurredAt: 'desc' },
        take: limitTransactions,
        select: {
          id: true, occurredAt: true, amount: true, currency: true,
          hasOrder: true, hasInvoice: true, hasShipped: true, hasDelivered: true, hasPayment: true,
          invoiceNumber: true, shipmentNumber: true, trackingNumber: true,
        },
      }),
      prisma.invoice.count({ where: { contractorId: id } }),
      linkedEs ? prisma.esInvoice.count({ where: { contractorId: linkedEs.id } }) : Promise.resolve(0),
      prisma.invoice.findFirst({ where: { contractorId: id }, orderBy: { issueDate: 'desc' }, select: { issueDate: true } }),
      linkedEs ? prisma.esInvoice.findFirst({ where: { contractorId: linkedEs.id }, orderBy: { invoiceDate: 'desc' }, select: { invoiceDate: true } }) : Promise.resolve(null),
      prisma.transaction.findFirst({ where: { contractorId: id, hasShipped: true }, orderBy: { occurredAt: 'desc' }, select: { occurredAt: true } }),
      prisma.invoice.aggregate({ where: { contractorId: id, currency: 'PLN' }, _sum: { grossAmount: true } }),
      prisma.invoice.aggregate({ where: { contractorId: id, currency: 'EUR' }, _sum: { grossAmount: true } }),
      linkedEs ? prisma.esInvoice.aggregate({ where: { contractorId: linkedEs.id }, _sum: { totalAmount: true } }) : Promise.resolve({ _sum: { totalAmount: null } }),
    ]);

    // attachments _count -> hasAttachments boolean (lzejsze do zuzycia po stronie UI).
    const emailsShaped = emails.map(e => ({
      id: e.id,
      direction: e.direction,
      inbox: e.inbox,
      fromEmail: e.fromEmail,
      fromName: e.fromName,
      toEmail: e.toEmail,
      subject: e.subject,
      bodyPreview: e.bodyPreview,
      createdAt: e.createdAt,
      tags: e.tags,
      hasAttachments: (e._count && e._count.attachments > 0) || false,
    }));

    // lineCount z _count.lineItems (InvoiceLineItem / EsInvoiceLineItem
    // dochodzi w commicie #5 — Etap 2.2). UI dostaje rzeczywista liczbe
    // pozycji per FV, 0 oznacza "brak danych w bazie" (legacy + nie
    // backfilled).
    const invoicesPlShaped = invoicesPl.map(({ _count, ...i }) => ({
      ...i,
      lineCount: (_count && _count.lineItems) || 0,
    }));
    const invoicesEsShaped = invoicesEs.map(({ _count, ...i }) => ({
      ...i,
      lineCount: (_count && _count.lineItems) || 0,
    }));

    // lastContactAt — bierzemy najnowszy email niezaleznie od direction.
    const lastContactAt = emailsShaped.length ? emailsShaped[0].createdAt : null;
    const lastInvoicePlAt = lastInvoicePl && lastInvoicePl.issueDate;
    const lastInvoiceEsAt = lastInvoiceEs && lastInvoiceEs.invoiceDate;
    const lastInvoiceAt = [lastInvoicePlAt, lastInvoiceEsAt]
      .filter(Boolean)
      .sort((a, b) => new Date(b) - new Date(a))[0] || null;
    const lastShipmentAt = lastShipment && lastShipment.occurredAt;

    // Revenue — decimal sumy z Prismy wracaja jako Decimal albo string,
    // ujednolicamy do stringa zeby JSON nie sknocil precyzji.
    const toStr = (v) => v == null ? '0' : String(v);
    const totalRevenuePLN = toStr(revenuePlAgg._sum.grossAmount);
    const totalRevenueEUR_pl = revenueEurPlAgg._sum.grossAmount;
    const totalRevenueEUR_es = revenueEsAgg._sum.totalAmount;
    const eurSum = (Number(totalRevenueEUR_pl || 0) + Number(totalRevenueEUR_es || 0));
    const totalRevenueEUR = (Math.round(eurSum * 100) / 100).toFixed(2);

    // CRM v2 etap 4.6 — activity timeline. Wyciagamy ostatnie N eventow
    // bezposrednio po contractorId, juz po Etapie 4 hookach + backfillu.
    let activity = [];
    try {
      activity = await prisma.activityEvent.findMany({
        where: { contractorId: id },
        orderBy: { createdAt: 'desc' },
        take: limitActivity,
        select: { id: true, type: true, summary: true, source: true, actorType: true, actorId: true, tags: true, createdAt: true, emailId: true, invoiceId: true, esInvoiceId: true, transactionId: true, shipmentNumber: true, trackingNumber: true },
      });
    } catch (_) { activity = []; }

    res.json({
      contractor,
      linkedEs,
      invoices: { pl: invoicesPlShaped, es: invoicesEsShaped },
      emails: emailsShaped,
      transactions,
      activity,
      stats: {
        totalRevenuePLN,
        totalRevenueEUR,
        invoiceCountPL: invoiceCountPl,
        invoiceCountES: invoiceCountEs,
        invoiceCount: invoiceCountPl + invoiceCountEs,
        emailCount: emailsShaped.length, // wraca tyle ile zwrocilismy (limit), nie globalnie
        lastContactAt,
        lastInvoiceAt,
        lastShipmentAt,
      },
    });
  } catch (e) {
    console.error('[contractors/:id/360] error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/alias', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { alias } = req.body;
    if (!alias || typeof alias !== 'string') return res.status(400).json({ error: 'alias required' });
    const c = await prisma.contractor.findUnique({ where: { id: req.params.id } });
    if (!c) return res.status(404).json({ error: 'contractor not found' });
    const extras = c.extras || {};
    const aliases = Array.isArray(extras.aliases) ? extras.aliases : [];
    const normalized = alias.trim().toLowerCase();
    if (!aliases.includes(normalized)) aliases.push(normalized);
    await prisma.contractor.update({ where: { id: req.params.id }, data: { extras: { ...extras, aliases } } });
    res.json({ ok: true, aliases });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Append a delivery address to extras.locations[] (idempotent on
// street+city+postCode). Body fields are all optional individually but at
// least street or city must be present. Used by the agent after pulling
// an address from VIES / GK history / mails / user input.
router.post('/:id/delivery-address', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { street, city, postCode, country, houseNumber, contactPerson, phone, email, source } = req.body || {};
    if (!street && !city) return res.status(400).json({ error: 'Provide at least street or city' });

    const c = await prisma.contractor.findUnique({ where: { id: req.params.id } });
    if (!c) return res.status(404).json({ error: 'contractor not found' });

    const extras = (typeof c.extras === 'object' && c.extras) || {};
    const locations = Array.isArray(extras.locations) ? [...extras.locations] : [];
    const norm = (s) => (s || '').toString().toLowerCase().trim();

    const nowIso = new Date().toISOString();
    const newLoc = {
      street: street || null,
      houseNumber: houseNumber || null,
      city: city || null,
      postCode: postCode || null,
      country: country || c.country || null,
      contactPerson: contactPerson || null,
      phone: phone || null,
      email: email || null,
      source: source || 'manual',
      addedAt: nowIso,
      lastUsedAt: nowIso,
    };

    const dupIdx = locations.findIndex(l =>
      norm(l.street) === norm(newLoc.street) &&
      norm(l.city) === norm(newLoc.city) &&
      norm(l.postCode) === norm(newLoc.postCode)
    );
    if (dupIdx !== -1) {
      const updated = { ...locations[dupIdx], lastUsedAt: nowIso };
      locations[dupIdx] = updated;
      await prisma.contractor.update({
        where: { id: req.params.id },
        data: { extras: { ...extras, locations } },
      });
      return res.json({ ok: true, deduplicated: true, location: updated, lastUsedAt: nowIso, totalLocations: locations.length });
    }

    locations.push(newLoc);
    await prisma.contractor.update({
      where: { id: req.params.id },
      data: { extras: { ...extras, locations } },
    });
    res.json({ ok: true, location: newLoc, lastUsedAt: nowIso, totalLocations: locations.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Punktowy import GK delivery addresses do KONKRETNEGO kontrahenta po
// wskazanej nazwie odbiorcy z GK orders. Use case: backfill auto nie
// zlapal pary (np. GK "ID Logistics Super Pharm" vs CRM "Super Pharm",
// zbyt daleko od fuzzy progu) — user wybiera contractor.id w CRM i
// podaje receiverName z GK, my dociagamy unikalne adresy do
// extras.locations[] z source='gk_import_by_receiver'.
// Body: { receiverName: string } (required, 400 jak brak)
router.post('/:id/import-gk-by-receiver', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const receiverName = (req.body && req.body.receiverName) || null;
    if (!receiverName || !String(receiverName).trim()) {
      return res.status(400).json({ error: 'receiverName (string) required in body' });
    }

    const c = await prisma.contractor.findUnique({ where: { id: req.params.id } });
    if (!c) return res.status(404).json({ error: 'contractor not found' });

    // Reuse tej samej sciezki co backfill: getOrders z paginacja po 100,
    // ten sam wrapper unwrap (results / array / etc.).
    const { getOrders } = require('../glob-client');
    function extractOrders(data) {
      if (!data) return [];
      if (Array.isArray(data) && data.length === 1 && data[0] && Array.isArray(data[0].results)) {
        return data[0].results;
      }
      if (Array.isArray(data)) return data;
      return data.results || data.items || data.data || [];
    }

    const pageSize = 100;
    const targetTotal = 100000;
    const orders = [];
    for (let offset = 0; offset < targetTotal; offset += pageSize) {
      let data;
      try {
        data = await getOrders({ limit: pageSize, offset });
      } catch (e) {
        console.log(`[import-gk-by-receiver] page offset=${offset} error: ${e.message}`);
        break;
      }
      const batch = extractOrders(data);
      if (batch.length === 0) break;
      orders.push(...batch);
      if (batch.length < pageSize) break;
    }
    console.log(`[import-gk-by-receiver] fetched ${orders.length} GK orders, filtering by receiverName="${receiverName}"`);

    // Filter case+space insensitive po nazwie odbiorcy. GK realnie trzyma
    // nazwe w receiverAddress.name (czasem receiver.name); spec wspomina
    // delivery.receiverName, wiec sprawdzamy wszystkie warianty.
    const target = String(receiverName).trim().toLowerCase();
    const matched = orders.filter(o => {
      const r = o.receiverAddress || o.receiver || {};
      const candidates = [r.name, o.delivery && o.delivery.receiverName, o.delivery && o.delivery.name];
      return candidates.some(n => String(n || '').trim().toLowerCase() === target);
    });
    console.log(`[import-gk-by-receiver] matched ${matched.length}/${orders.length} orders`);

    // Dedup adresow (street|houseNumber|postCode|city|country, lowercased).
    // Adresy w tej samej normalizacji co backfill (receiverAddress fields).
    const norm = (s) => (s || '').toString().toLowerCase().trim();
    const seen = new Map(); // fp -> address
    for (const o of matched) {
      const r = o.receiverAddress || o.receiver || {};
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
      const fp = `${norm(address.street)}|${norm(address.houseNumber)}|${norm(address.postCode)}|${norm(address.city)}|${norm(address.country)}`;
      if (fp === '||||') continue; // adres pusty
      if (!seen.has(fp)) seen.set(fp, address);
    }
    const uniqueAddresses = Array.from(seen.values());
    console.log(`[import-gk-by-receiver] unique addresses=${uniqueAddresses.length}`);

    // Dla kazdego unikalnego adresu — ta sama logika co
    // POST /:id/delivery-address: dedup wzgledem istniejacych
    // extras.locations[] po (street|city|postCode) i push.
    const extras = (typeof c.extras === 'object' && c.extras) || {};
    const locations = Array.isArray(extras.locations) ? [...extras.locations] : [];
    let locationsAdded = 0;
    let locationsSkippedDup = 0;
    for (const a of uniqueAddresses) {
      const dup = locations.find(l =>
        norm(l.street) === norm(a.street) &&
        norm(l.city) === norm(a.city) &&
        norm(l.postCode) === norm(a.postCode)
      );
      if (dup) { locationsSkippedDup += 1; continue; }
      locations.push({
        street: a.street || null,
        houseNumber: a.houseNumber || null,
        city: a.city || null,
        postCode: a.postCode || null,
        country: a.country || c.country || null,
        contactPerson: a.contactPerson || null,
        phone: a.phone || null,
        email: a.email || null,
        source: 'gk_import_by_receiver',
        receiverName: receiverName,
        addedAt: new Date().toISOString(),
      });
      locationsAdded += 1;
    }

    if (locationsAdded > 0) {
      await prisma.contractor.update({
        where: { id: req.params.id },
        data: { extras: { ...extras, locations } },
      });
    }

    res.json({
      ok: true,
      contractorId: c.id,
      receiverName,
      ordersMatched: matched.length,
      uniqueAddresses: uniqueAddresses.length,
      locationsAdded,
      locationsSkippedDup,
      sampleAddresses: uniqueAddresses.slice(0, 5),
    });
  } catch (e) {
    console.error('[import-gk-by-receiver] error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// Search contractor's INBOUND emails for a delivery address (signature /
// "ship to" / "dostawa" lines). Calls Claude (Haiku 4.5) — has a token
// cost, so it's a separate endpoint that the agent invokes only when the
// user explicitly chooses "szukaj w mailach". On hit, the address is
// persisted to extras.locations[] so future quotes don't re-pay.
router.post('/:id/find-address-in-emails', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const c = await resolveContractorFromRequest(prisma, req);
    const fallbackEmail = (req.body && req.body.email) || null;
    if (!c && !fallbackEmail) {
      return res.status(404).json({ error: 'contractor not found — provide :id, body.contractorName, or body.email' });
    }

    const limit = (req.body && Number(req.body.limit)) || 10;
    const result = await findAddressInContractorEmails(prisma, { contractorId: c && c.id, email: (c && c.email) || fallbackEmail }, { limit });
    if (!result.found) {
      return res.json({ ok: false, found: false, reason: result.reason || 'not_found', contractor: c ? { id: c.id, name: c.name } : null });
    }
    const saved = c ? await saveAddressToContractorLocations(prisma, c.id, result.address) : false;
    res.json({ ok: true, found: true, address: result.address, savedToLocations: saved, contractor: c ? { id: c.id, name: c.name } : null });
  } catch (e) {
    console.error('[find-address-in-emails] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Search recent GK shipments for a delivery address matching this
// contractor (token match + LLM fuzzy fallback). Opt-in because the
// LLM call costs ~$0.02 per miss; the agent invokes only when the
// user explicitly asks for "szukaj w starych wysyłkach".
// Resolve a contractor from path :id or, if id == '_' (sentinel for "lookup
// by name"), from request body.contractorName via fuzzy match. Lets the
// stateless logistics agent invoke the tool with just a name when it
// doesn't have the UUID from a previous turn.
async function resolveContractorFromRequest(prisma, req) {
  const id = req.params.id;
  if (id && id !== '_' && id !== 'lookup') {
    const byId = await prisma.contractor.findUnique({ where: { id } });
    if (byId) return byId;
  }
  const name = (req.body && (req.body.contractorName || req.body.contractor_name || req.body.name)) || null;
  if (!name) return null;

  const all = await prisma.contractor.findMany({
    select: { id: true, name: true, nip: true, country: true, email: true, address: true, city: true, extras: true },
  });
  const scored = all
    .map(c => ({ contractor: c, score: scoreContractor(c, name) }))
    .filter(x => x.score >= 50)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  return prisma.contractor.findUnique({ where: { id: scored[0].contractor.id } });
}

router.post('/:id/find-address-in-gk-orders', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    console.log(`[find-address-in-gk-orders] req: id=${req.params.id}, body=${JSON.stringify(req.body || {}).slice(0, 200)}`);
    const c = await resolveContractorFromRequest(prisma, req);
    if (!c) {
      console.log('[find-address-in-gk-orders] contractor not resolved');
      return res.status(404).json({ error: 'contractor not found (provide :id or body.contractorName)' });
    }
    console.log(`[find-address-in-gk-orders] resolved contractor: ${c.name} (id=${c.id})`);

    const limit = (req.body && Number(req.body.limit)) || 200;
    const result = await findAddressInGkOrders(prisma, c, { limit });
    console.log(`[find-address-in-gk-orders] result: found=${result.found}, matchMethod=${result.matchMethod || 'n/a'}, reason="${(result.reason || '').slice(0, 150)}"`);
    if (!result.found) {
      return res.json({ ok: false, found: false, reason: result.reason, scanned: result.scanned || 0, contractor: { id: c.id, name: c.name } });
    }
    res.json({ ok: true, found: true, ...result, contractor: { id: c.id, name: c.name } });
  } catch (e) {
    console.error('[find-address-in-gk-orders] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id/price', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { price, typ } = req.body;
    if (price == null) return res.status(400).json({ error: 'price required' });
    if (typ !== 'brutto' && typ !== 'netto') return res.status(400).json({ error: "typ must be 'brutto' or 'netto'" });
    const c = await prisma.contractor.findUnique({ where: { id: req.params.id } });
    if (!c) return res.status(404).json({ error: 'contractor not found' });
    const extras = { ...(c.extras || {}), lastPrice: price, lastPriceTyp: typ };
    await prisma.contractor.update({ where: { id: req.params.id }, data: { extras } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One-shot backfill — przeleci po WSZYSTKICH historycznych GK orderach,
// zmatchuje odbiorcow z baza kontrahentow (exact -> fuzzy >=70 ->
// opcjonalnie LLM) i dopisze pelne adresy dostawy do extras.locations[].
// Trigger manualny (curl/PowerShell), nie cron — zmiana DB scope-wide.
router.post('/backfill-shipping-from-gk', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const body = req.body || {};
    const opts = {
      dryRun: !!body.dryRun,
      useLlm: !!body.useLlm,
      limit: body.limit != null ? Number(body.limit) : undefined,
      llmCap: body.llmCap != null ? Number(body.llmCap) : undefined,
      minScore: body.minScore != null ? Number(body.minScore) : undefined,
    };
    console.log(`[backfill-shipping-from-gk] start opts=${JSON.stringify(opts)}`);
    const result = await backfillShippingFromGk(prisma, opts);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[backfill-shipping-from-gk] error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// One-shot cleanup: dedup extras.locations[] z agresywna normalizacja.
// Batched + logged zeby Railway nie zabijal procesu OOM.
// Body: { dryRun?, minLocations? (default 2), limit? (default 50), offset? (default 0) }
router.post('/dedup-locations', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { dedupLocations, fingerprint } = require('../services/dedup-locations');
  const dryRun = !!req.body.dryRun;
  const minLocations = Number(req.body.minLocations) || 2;
  const limit = Math.min(Number(req.body.limit) || 50, 200); // CAP at 200 per call
  const offset = Number(req.body.offset) || 0;

  try {
    // Page contractors. Returns batch of `limit` contractors starting at offset.
    // User wola endpoint wielokrotnie (offset=0, 50, 100, ...) zeby przejsc
    // przez wszystkich bez OOM-a.
    const contractors = await prisma.contractor.findMany({
      select: { id: true, name: true, extras: true },
      orderBy: { id: 'asc' },
      skip: offset,
      take: limit,
    });

    const stats = {
      offset,
      limit,
      batchSize: contractors.length,
      contractorsWithLocations: 0,
      contractorsProcessed: 0,
      totalLocationsBefore: 0,
      totalLocationsAfter: 0,
      removed: 0,
      contractorsUpdated: 0,
      anomalies: [],
      errors: [],
    };

    console.log(`[dedup-locations] batch offset=${offset} limit=${limit} got=${contractors.length} dryRun=${dryRun}`);

    for (const c of contractors) {
      try {
        const extras = c.extras || {};
        const locations = Array.isArray(extras.locations) ? extras.locations : [];
        if (!locations.length) continue;
        stats.contractorsWithLocations += 1;
        if (locations.length < minLocations) continue;
        stats.contractorsProcessed += 1;
        stats.totalLocationsBefore += locations.length;

        const { result, removed } = dedupLocations(locations);
        stats.totalLocationsAfter += result.length;
        stats.removed += removed;

        if (result.length > 5) {
          stats.anomalies.push({
            contractorId: c.id,
            name: c.name,
            locationsBefore: locations.length,
            locationsAfter: result.length,
            sample: result.slice(0, 3).map(l => ({
              street: l.street,
              city: l.city,
              postCode: l.postCode,
              fp: fingerprint(l),
            })),
          });
        }

        if (!dryRun && removed > 0) {
          await prisma.contractor.update({
            where: { id: c.id },
            data: { extras: { ...extras, locations: result } },
          });
          stats.contractorsUpdated += 1;
          console.log(`[dedup-locations] updated ${c.name}: ${locations.length} -> ${result.length}`);
        }
      } catch (e) {
        stats.errors.push(`${c.name}: ${e.message}`);
        console.error(`[dedup-locations] error on ${c.name}:`, e.message);
      }
    }

    const hasMore = contractors.length === limit;
    res.json({ ok: true, dryRun, hasMore, nextOffset: hasMore ? offset + limit : null, ...stats });
  } catch (e) {
    console.error('[dedup-locations] fatal:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Rollback GK backfill: usuwa wszystkie extras.locations[] gdzie source
// zaczyna sie od 'gk_backfill'. Use case: po skrzepieniu na fuzzy match
// zbyt liberalnym (minScore=70 zmieszal kontrahentow), trzeba zaczac
// od poczatku z wyzszym progiem.
// Body: { dryRun?: boolean }
router.post('/rollback-gk-backfill', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const dryRun = !!req.body.dryRun;
  try {
    const contractors = await prisma.contractor.findMany({
      select: { id: true, name: true, extras: true },
    });
    const stats = { scanned: contractors.length, contractorsAffected: 0, locationsRemoved: 0, contractorsUpdated: 0, errors: [] };
    for (const c of contractors) {
      try {
        const extras = c.extras || {};
        const locations = Array.isArray(extras.locations) ? extras.locations : [];
        if (!locations.length) continue;
        const kept = locations.filter(l => !(l.source && String(l.source).startsWith('gk_backfill')));
        const removed = locations.length - kept.length;
        if (removed === 0) continue;
        stats.contractorsAffected += 1;
        stats.locationsRemoved += removed;
        if (!dryRun) {
          await prisma.contractor.update({
            where: { id: c.id },
            data: { extras: { ...extras, locations: kept } },
          });
          stats.contractorsUpdated += 1;
        }
      } catch (e) {
        stats.errors.push(`${c.name}: ${e.message}`);
      }
    }
    res.json({ ok: true, dryRun, ...stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual remove single location by index (uzywane do recznego czyszczenia
// anomalii po backfill - np. user widzi w UI ze "Chalupy" jest u AWA SURF
// po blednym fuzzy match, usuwa).
// Body: { locationIndex: number }
router.post('/:id/remove-location', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const id = req.params.id;
  const idx = Number(req.body.locationIndex);
  if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'locationIndex (number >=0) required' });
  try {
    const c = await prisma.contractor.findUnique({ where: { id }, select: { id: true, name: true, extras: true } });
    if (!c) return res.status(404).json({ error: 'contractor not found' });
    const extras = c.extras || {};
    const locations = Array.isArray(extras.locations) ? [...extras.locations] : [];
    if (idx >= locations.length) return res.status(400).json({ error: `locationIndex out of range (have ${locations.length})` });
    const removed = locations.splice(idx, 1)[0];
    await prisma.contractor.update({
      where: { id },
      data: { extras: { ...extras, locations } },
    });
    res.json({ ok: true, removed, remaining: locations.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One-shot backfill — przeleci po WSZYSTKICH kontrahentach i dla kazdego
// pobiera GK ordery, matchuje po nazwie odbiorcy (exact lowercased) i
// ustawia extras.locations[i].lastUsedAt = max(istniejacy, najnowsza data
// matchujacego ordera) dla pasujacych adresow (street|city|postCode norm).
// Body: { dryRun?: boolean, limit?: number (default null = wszyscy) }
router.post('/backfill-location-last-used', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const body = req.body || {};
    const dryRun = !!body.dryRun;
    const limit = body.limit != null ? Number(body.limit) : null;

    const norm = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
    const fpAddr = (l) => `${norm(l.street)}|${norm(l.city)}|${norm(l.postCode)}`;

    const { getOrders } = require('../glob-client');
    function extractOrders(data) {
      if (!data) return [];
      if (Array.isArray(data) && data.length === 1 && data[0] && Array.isArray(data[0].results)) {
        return data[0].results;
      }
      if (Array.isArray(data)) return data;
      return data.results || data.items || data.data || [];
    }

    const allContractors = await prisma.contractor.findMany({
      select: { id: true, name: true, extras: true },
      ...(limit ? { take: limit } : {}),
    });
    console.log(`[backfill-location-last-used] start: contractors=${allContractors.length}, dryRun=${dryRun}`);

    const stats = {
      ok: true,
      scanned: 0,
      contractorsAffected: 0,
      locationsUpdated: 0,
      sampleUpdates: [],
      errors: [],
    };

    for (const c of allContractors) {
      stats.scanned += 1;
      if (stats.scanned % 20 === 0) {
        console.log(`[backfill-location-last-used] progress: ${stats.scanned}/${allContractors.length}, affected=${stats.contractorsAffected}, locsUpdated=${stats.locationsUpdated}`);
      }

      const extras = (typeof c.extras === 'object' && c.extras) || {};
      const locations = Array.isArray(extras.locations) ? extras.locations.map(l => ({ ...l })) : [];
      if (!locations.length) continue;

      const targetName = norm(c.name);
      if (!targetName) continue;

      // Pobierz GK ordery (paging po 100).
      const pageSize = 100;
      const targetTotal = 100000;
      const orders = [];
      for (let offset = 0; offset < targetTotal; offset += pageSize) {
        let data;
        try {
          data = await getOrders({ limit: pageSize, offset });
        } catch (e) {
          console.log(`[backfill-location-last-used] contractor=${c.id} page offset=${offset} error: ${e.message}`);
          stats.errors.push(`contractor ${c.id} page ${offset}: ${e.message}`);
          break;
        }
        const batch = extractOrders(data);
        if (batch.length === 0) break;
        orders.push(...batch);
        if (batch.length < pageSize) break;
      }

      // Filtruj ordery po nazwie odbiorcy (exact lowercased).
      const matched = orders.filter(o => {
        const r = o.receiverAddress || o.receiver || {};
        const candidates = [r.name, o.delivery && o.delivery.receiverName, o.delivery && o.delivery.name];
        return candidates.some(n => norm(n) === targetName);
      });
      if (!matched.length) continue;

      // Build map fp -> latest date among matched orders.
      const dateByFp = new Map();
      for (const o of matched) {
        const r = o.receiverAddress || o.receiver || {};
        const addr = {
          street: r.street || null,
          city: r.city || null,
          postCode: r.postCode || r.zipCode || null,
        };
        const fp = fpAddr(addr);
        if (fp === '||') continue;
        const date = o.creationDate || o.created_at || o.createdAt || null;
        if (!date) continue;
        const prev = dateByFp.get(fp);
        if (!prev || new Date(date) > new Date(prev)) dateByFp.set(fp, date);
      }
      if (!dateByFp.size) continue;

      let contractorChanged = false;
      for (let i = 0; i < locations.length; i++) {
        const loc = locations[i];
        const fp = fpAddr(loc);
        if (fp === '||') continue;
        const orderDate = dateByFp.get(fp);
        if (!orderDate) continue;
        const orderIso = new Date(orderDate).toISOString();
        const prev = loc.lastUsedAt ? new Date(loc.lastUsedAt).toISOString() : null;
        const next = (prev && prev >= orderIso) ? prev : orderIso;
        if (next !== prev) {
          locations[i] = { ...loc, lastUsedAt: next };
          contractorChanged = true;
          stats.locationsUpdated += 1;
          if (stats.sampleUpdates.length < 5) {
            stats.sampleUpdates.push({
              contractorId: c.id,
              contractorName: c.name,
              locationIndex: i,
              addressFp: fp,
              prevLastUsedAt: prev,
              newLastUsedAt: next,
            });
          }
        }
      }

      if (contractorChanged) {
        stats.contractorsAffected += 1;
        if (!dryRun) {
          try {
            await prisma.contractor.update({
              where: { id: c.id },
              data: { extras: { ...extras, locations } },
            });
          } catch (e) {
            console.log(`[backfill-location-last-used] update FAIL ${c.id}: ${e.message}`);
            stats.errors.push(`update ${c.id}: ${e.message}`);
          }
        }
      }
    }

    console.log(`[backfill-location-last-used] done: scanned=${stats.scanned}, affected=${stats.contractorsAffected}, locsUpdated=${stats.locationsUpdated}, dryRun=${dryRun}`);
    res.json(stats);
  } catch (e) {
    console.error('[backfill-location-last-used] error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// Wariant LLM: fuzzy matching adresow z GK orderow do extras.locations[]
// uzywajac Claude Haiku 4.5. Toleruje literowki, skroty (ul./str.), rozne
// kolejnosci czesci adresu, oraz roznice w nazwie odbiorcy (NAIXX vs Naixx S.L.).
// Body: { dryRun?: boolean, limit?: number|null, confidenceThreshold?: number (0.7),
//   onlyMissing?: boolean (true) }
router.post('/backfill-location-last-used-llm', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const body = req.body || {};
    const dryRun = !!body.dryRun;
    const limit = body.limit != null ? Number(body.limit) : null;
    const confidenceThreshold = body.confidenceThreshold != null ? Number(body.confidenceThreshold) : 0.7;
    const onlyMissing = body.onlyMissing != null ? !!body.onlyMissing : true;

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }

    const AnthropicPkg = require('@anthropic-ai/sdk');
    const Anthropic = AnthropicPkg.default || AnthropicPkg;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const MODEL = 'claude-haiku-4-5-20251001';

    const norm = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();

    // Inline Levenshtein (max ~15 lines).
    function lev(a, b) {
      a = a || ''; b = b || '';
      if (a === b) return 0;
      if (!a.length) return b.length;
      if (!b.length) return a.length;
      const dp = new Array(b.length + 1);
      for (let j = 0; j <= b.length; j++) dp[j] = j;
      for (let i = 1; i <= a.length; i++) {
        let prev = dp[0]; dp[0] = i;
        for (let j = 1; j <= b.length; j++) {
          const tmp = dp[j];
          dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
          prev = tmp;
        }
      }
      return dp[b.length];
    }

    const { getOrders } = require('../glob-client');
    function extractOrders(data) {
      if (!data) return [];
      if (Array.isArray(data) && data.length === 1 && data[0] && Array.isArray(data[0].results)) {
        return data[0].results;
      }
      if (Array.isArray(data)) return data;
      return data.results || data.items || data.data || [];
    }

    const allContractorsRaw = await prisma.contractor.findMany({
      select: { id: true, name: true, extras: true },
      ...(limit ? { take: limit } : {}),
    });

    const allContractors = onlyMissing
      ? allContractorsRaw.filter(c => {
          const extras = (typeof c.extras === 'object' && c.extras) || {};
          const locs = Array.isArray(extras.locations) ? extras.locations : [];
          return locs.some(l => l && l.lastUsedAt == null);
        })
      : allContractorsRaw;

    console.log(`[backfill-loc-llm] start: contractors=${allContractors.length} (raw=${allContractorsRaw.length}), dryRun=${dryRun}, threshold=${confidenceThreshold}, onlyMissing=${onlyMissing}`);

    // Pobierz GK ordery raz.
    const pageSize = 100;
    const targetTotal = 100000;
    const allOrders = [];
    for (let offset = 0; offset < targetTotal; offset += pageSize) {
      let data;
      try {
        data = await getOrders({ limit: pageSize, offset });
      } catch (e) {
        console.log(`[backfill-loc-llm] orders page offset=${offset} error: ${e.message}`);
        break;
      }
      const batch = extractOrders(data);
      if (batch.length === 0) break;
      allOrders.push(...batch);
      if (batch.length < pageSize) break;
    }
    console.log(`[backfill-loc-llm] fetched orders=${allOrders.length}`);

    // Buduj indeks Map<lowercased receiverName, Array<order>>.
    const ordersByName = new Map();
    const flatOrders = [];
    for (const o of allOrders) {
      const r = o.receiverAddress || o.receiver || {};
      const recvName = r.name || (o.delivery && (o.delivery.receiverName || o.delivery.name)) || null;
      const date = o.creationDate || o.created_at || o.createdAt || null;
      const flat = {
        id: o.id || o.uuid || null,
        date,
        receiverName: recvName,
        street: r.street || null,
        city: r.city || null,
        postCode: r.postCode || r.zipCode || null,
        country: r.country || null,
      };
      flatOrders.push(flat);
      const key = norm(recvName);
      if (!key) continue;
      if (!ordersByName.has(key)) ordersByName.set(key, []);
      ordersByName.get(key).push(flat);
    }

    const SYSTEM_PROMPT = `Jestes asystentem ktory dopasowuje adresy dostaw z zamowien do zapisanych lokalizacji kontrahenta. Dla danego kontrahenta dostaniesz:
- jego nazwe + tablice jego zapisanych lokalizacji (kazda ma indeks i adres)
- tablice zamowien z systemu GK (kazde ma indeks, date, nazwe odbiorcy, ulice, miasto, kod, kraj)

Twoje zadanie: dla kazdego zamowienia zdecyduj czy adres dostawy pasuje do ktorejs zapisanej lokalizacji kontrahenta. Toleruj:
- literowki, rozne wielkosci liter
- skroty: "ul.", "str.", "c/", "avda.", "pol. ind."
- rozne kolejnosci czesci adresu, dodatkowe przecinki/spacje
- nazwa odbiorcy moze sie roznic od nazwy kontrahenta (np. "NAIXX" vs "Naixx S.L.", "surfmarket" vs "SurfMarket Vigo")
- ta sama lokalizacja zapisana 2x z drobnymi roznicami -> matchuj do TEJ z nizszym indeksem

Zwroc TYLKO JSON, bez markdown, bez komentarza. Format:
{"matches":[{"orderIdx":0,"locationIdx":0,"confidence":0.95}]}

Pomin zamowienia ktore nie pasuja do zadnej lokalizacji (nie wlaczaj ich w \`matches\`). \`confidence\` to liczba 0-1.`;

    const stats = {
      ok: true,
      scanned: 0,
      contractorsAffected: 0,
      locationsUpdated: 0,
      llmCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      sampleUpdates: [],
      errors: [],
    };

    for (const c of allContractors) {
      stats.scanned += 1;
      if (stats.scanned % 10 === 0) {
        console.log(`[backfill-loc-llm] progress: ${stats.scanned}/${allContractors.length}, affected=${stats.contractorsAffected}, locsUpdated=${stats.locationsUpdated}, llmCalls=${stats.llmCalls}`);
      }

      const extras = (typeof c.extras === 'object' && c.extras) || {};
      const locations = Array.isArray(extras.locations) ? extras.locations.map(l => ({ ...l })) : [];
      if (!locations.length) continue;
      const targetName = norm(c.name);
      if (!targetName) continue;

      const firstTok = targetName.split(' ')[0] || '';
      // Znajdz kandydatow.
      const candidateSet = new Map(); // id-or-idx -> flat
      for (let i = 0; i < flatOrders.length; i++) {
        const fo = flatOrders[i];
        const rn = norm(fo.receiverName);
        if (!rn) continue;
        let match = false;
        if (firstTok && (rn.includes(firstTok) || targetName.includes(rn.split(' ')[0] || ''))) {
          match = true;
        } else if (lev(rn, targetName) < 4) {
          match = true;
        }
        if (match) candidateSet.set(fo.id || `idx-${i}`, fo);
      }

      let candidates = Array.from(candidateSet.values());
      if (!candidates.length) continue;

      if (candidates.length > 50) {
        candidates = candidates
          .slice()
          .sort((a, b) => {
            const da = a.date ? new Date(a.date).getTime() : 0;
            const db = b.date ? new Date(b.date).getTime() : 0;
            return db - da;
          })
          .slice(0, 50);
      }

      // Build user message.
      const locLines = locations.map((l, i) => `[${i}] ${l.street || ''}, ${l.city || ''}, ${l.postCode || ''}, ${l.country || ''}`).join('\n');
      const ordLines = candidates.map((o, i) => `[${i}] ${o.date || ''} | ${o.receiverName || ''} | ${o.street || ''}, ${o.city || ''}, ${o.postCode || ''}, ${o.country || ''}`).join('\n');
      const userMessage = `Kontrahent: ${c.name}\nLokalizacje:\n${locLines}\n\nZamowienia GK:\n${ordLines}`;

      let resp;
      try {
        resp = await client.messages.create({
          model: MODEL,
          max_tokens: 2000,
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: userMessage }],
        });
        stats.llmCalls += 1;
      } catch (e) {
        console.log(`[backfill-loc-llm] LLM FAIL ${c.id}: ${e.message}`);
        stats.errors.push({ contractorId: c.id, message: `llm: ${e.message}` });
        continue;
      }

      if (resp && resp.usage) {
        stats.totalInputTokens += (resp.usage.input_tokens || 0) + (resp.usage.cache_read_input_tokens || 0) + (resp.usage.cache_creation_input_tokens || 0);
        stats.totalOutputTokens += resp.usage.output_tokens || 0;
      }

      const txt = (resp && resp.content && resp.content[0] && resp.content[0].text) || '';
      let parsed;
      try {
        parsed = JSON.parse(txt);
      } catch (e) {
        // Try to strip markdown fences.
        const cleaned = txt.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        try { parsed = JSON.parse(cleaned); } catch (e2) {
          console.log(`[backfill-loc-llm] parse FAIL ${c.id}: ${e2.message} raw=${txt.slice(0, 200)}`);
          stats.errors.push({ contractorId: c.id, message: `parse: ${e2.message}` });
          continue;
        }
      }

      const matches = (parsed && Array.isArray(parsed.matches)) ? parsed.matches : [];
      if (!matches.length) continue;

      // Zbierz najnowsza date per locationIdx.
      const dateByLocIdx = new Map();
      for (const m of matches) {
        if (!m || typeof m.locationIdx !== 'number' || typeof m.orderIdx !== 'number') continue;
        const conf = Number(m.confidence);
        if (!(conf >= confidenceThreshold)) continue;
        const ord = candidates[m.orderIdx];
        if (!ord || !ord.date) continue;
        if (m.locationIdx < 0 || m.locationIdx >= locations.length) continue;
        const prev = dateByLocIdx.get(m.locationIdx);
        if (!prev || new Date(ord.date) > new Date(prev)) {
          dateByLocIdx.set(m.locationIdx, ord.date);
        }
      }

      let contractorChanged = false;
      for (const [idx, orderDate] of dateByLocIdx.entries()) {
        const loc = locations[idx];
        if (!loc) continue;
        const orderIso = new Date(orderDate).toISOString();
        const prev = loc.lastUsedAt ? new Date(loc.lastUsedAt).toISOString() : null;
        const next = (prev && prev >= orderIso) ? prev : orderIso;
        if (next !== prev) {
          locations[idx] = { ...loc, lastUsedAt: next };
          contractorChanged = true;
          stats.locationsUpdated += 1;
          if (stats.sampleUpdates.length < 10) {
            stats.sampleUpdates.push({
              contractorId: c.id,
              contractorName: c.name,
              locationIndex: idx,
              prevLastUsedAt: prev,
              newLastUsedAt: next,
            });
          }
        }
      }

      if (contractorChanged) {
        stats.contractorsAffected += 1;
        if (!dryRun) {
          try {
            await prisma.contractor.update({
              where: { id: c.id },
              data: { extras: { ...extras, locations } },
            });
          } catch (e) {
            console.log(`[backfill-loc-llm] update FAIL ${c.id}: ${e.message}`);
            stats.errors.push({ contractorId: c.id, message: `update: ${e.message}` });
          }
        }
      }
    }

    console.log(`[backfill-loc-llm] done: scanned=${stats.scanned}, affected=${stats.contractorsAffected}, locsUpdated=${stats.locationsUpdated}, llmCalls=${stats.llmCalls}, inTok=${stats.totalInputTokens}, outTok=${stats.totalOutputTokens}, dryRun=${dryRun}`);
    res.json(stats);
  } catch (e) {
    console.error('[backfill-loc-llm] error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});


module.exports = router;