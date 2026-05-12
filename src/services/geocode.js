'use strict';

const { fetchWithTimeout } = require('../http');

// Nominatim (OpenStreetMap) — free, no API key, 1 req/sec policy.
// Identify ourselves so they don't block us: User-Agent + email.
const USER_AGENT = process.env.NOMINATIM_USER_AGENT
  || 'SurfStickBell-CoreAPI/1.0 (info@surfstickbell.com)';

// Serialize all requests through one chain to respect 1 req/sec.
let lastReqAt = 0;
async function rateLimit() {
  const wait = Math.max(0, 1100 - (Date.now() - lastReqAt));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastReqAt = Date.now();
}

function buildQuery(c) {
  // Direct columns first — strongest signal.
  const direct = [c.address, c.postalCode, c.city, c.province, c.country]
    .filter(Boolean).map(s => String(s).trim());
  if (direct.length >= 2 || (direct.length === 1 && c.address)) return direct.join(', ');

  // Fall back to whatever address-shaped data lives in `extras`.
  const extras = c.extras && typeof c.extras === 'object' ? c.extras : null;
  if (extras) {
    if (Array.isArray(extras.locations) && extras.locations.length) {
      const loc = extras.locations[0];
      const street = [loc.street, loc.houseNumber].filter(Boolean).join(' ');
      const parts = [street, loc.postCode, loc.city, loc.country].filter(Boolean);
      if (parts.length) return parts.join(', ');
    }
    if (extras.billingAddress && typeof extras.billingAddress === 'object') {
      const b = extras.billingAddress;
      const street = [b.street, b.houseNumber].filter(Boolean).join(' ');
      const parts = [street, b.postCode || b.postalCode, b.city, b.country].filter(Boolean);
      if (parts.length) return parts.join(', ');
    }
  }

  // Last resort: whatever single field we have.
  if (direct.length) return direct.join(', ');
  return null;
}

async function geocodeContractor(c) {
  const q = buildQuery(c);
  if (!q) return { status: 'skipped', reason: 'no address' };

  await rateLimit();
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;

  try {
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
    }, 15000);
    if (!res.ok) return { status: 'error', reason: `http ${res.status}` };
    const arr = await res.json();
    if (!Array.isArray(arr) || !arr.length) return { status: 'not_found' };
    const lat = parseFloat(arr[0].lat);
    const lng = parseFloat(arr[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { status: 'error', reason: 'invalid coords' };
    }
    return { status: 'ok', lat, lng };
  } catch (e) {
    return { status: 'error', reason: e.message };
  }
}

// Geocode + persist. Always sets geocodingStatus + geocodedAt so we know we
// tried — that way the backfill job doesn't keep retrying the same misses.
// `model` is the Prisma delegate name: 'contractor' (PL) or 'esContractor' (ES).
async function geocodeAndSave(prisma, contractor, model = 'contractor') {
  const r = await geocodeContractor(contractor);
  const data = {
    geocodedAt: new Date(),
    geocodingStatus: r.status,
    ...(r.status === 'ok' ? { lat: r.lat, lng: r.lng } : {}),
  };
  await prisma[model].update({ where: { id: contractor.id }, data });
  return r;
}

module.exports = { geocodeContractor, geocodeAndSave };
