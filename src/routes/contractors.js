'use strict';

const router = require('express').Router();
const { processIfirmaInvoices } = require('../services/ifirma-sync');
const { fetchWithTimeout } = require('../http');
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
