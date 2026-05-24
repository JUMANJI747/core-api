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

    // PLACEHOLDER_TRUNCATED_FOR_SAFETY
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
