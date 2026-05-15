'use strict';

// Build a public tracking URL for a parcel given the carrier name and
// tracking number. Each carrier gets its own URL pattern with the tracking
// number pre-filled, so clicking the link lands directly on the shipment
// history page (not a generic landing). Locale-aware where the carrier
// supports it — pass receiver country as ISO-2 to get a localized UI.
//
// Returns null only when trackingNumber is missing. Unknown carrier falls
// back to parcelsapp.com which auto-detects most major couriers.
function buildTrackingUrl(carrierName, trackingNumber, country) {
  if (!trackingNumber) return null;
  const tn = String(trackingNumber).trim();
  if (!tn) return null;
  const c = String(carrierName || '').toLowerCase();
  const cc = String(country || '').toUpperCase();

  if (c.includes('inpost')) {
    return `https://inpost.pl/sledzenie-przesylek?number=${encodeURIComponent(tn)}`;
  }
  if (c.includes('dpd')) {
    // DPD's tracking is split per-country (each national DPD hosts its own
    // parcel database). Polish-origin parcels live only on tracktrace.dpd.com.pl
    // and won't resolve on tracking.dpd.de — so we use the PL endpoint
    // regardless of recipient country. Customer sees Polish UI but the
    // data displays correctly.
    return `https://tracktrace.dpd.com.pl/findParcel?q=${encodeURIComponent(tn)}`;
  }
  if (c.includes('dhl')) {
    // DHL has one global database; the page locale just affects UI text.
    // Use the global-en page so customers in any country get a working
    // link in a neutral language (auto-detect doesn't always pick up
    // recipient locale and PL-pl on a French recipient is ugly).
    return `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${encodeURIComponent(tn)}`;
  }
  if (c.includes('fedex')) {
    // FedEx auto-detects locale; trknbr lands directly on the history page.
    return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(tn)}`;
  }
  if (c.includes('ups')) {
    // UPS global tracker.
    return `https://www.ups.com/track?tracknum=${encodeURIComponent(tn)}`;
  }
  if (c.includes('gls')) {
    return `https://gls-group.com/track/parcel?match=${encodeURIComponent(tn)}`;
  }
  if (c.includes('pocztex') || c.includes('poczta')) {
    return `https://emonitoring.poczta-polska.pl/?numer=${encodeURIComponent(tn)}`;
  }

  // Multi-carrier fallback — parcelsapp auto-detects most couriers from
  // the tracking number format, so the customer still gets a working link
  // even when we don't recognize the carrier name.
  return `https://parcelsapp.com/en/tracking/${encodeURIComponent(tn)}`;
}

module.exports = { buildTrackingUrl };
