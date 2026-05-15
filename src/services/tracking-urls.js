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
    // DPD international: tracking.dpd.de works for every DPD country with
    // a storeId-style locale. PL store + recipient's language is closest
    // to what they'd see in webmail.
    const dpdLocale = { PL: 'PL.pl_PL', DE: 'DE.de_DE', FR: 'FR.fr_FR', ES: 'ES.es_ES',
                       IT: 'IT.it_IT', NL: 'NL.nl_NL', PT: 'PT.pt_PT', BE: 'BE.nl_BE' }[cc] || 'PL.en_EN';
    return `https://tracking.dpd.de/parcelstatus?storeId=${dpdLocale}&query=${encodeURIComponent(tn)}`;
  }
  if (c.includes('dhl')) {
    // DHL global tracker — locale auto-detects from browser, but we set
    // it from country when possible. dhl.com uses dash-separated locale.
    const dhlLocale = { PL: 'pl-pl', DE: 'de-de', FR: 'fr-fr', ES: 'es-es',
                        IT: 'it-it', NL: 'nl-nl', PT: 'pt-pt', GB: 'en-gb' }[cc] || 'global-en';
    return `https://www.dhl.com/${dhlLocale}/home/tracking/tracking-parcel.html?submit=1&tracking-id=${encodeURIComponent(tn)}`;
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
