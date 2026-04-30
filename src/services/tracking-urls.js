'use strict';

// Build a public tracking URL for a parcel given the carrier name and
// tracking number. Telegram (plain text) auto-linkifies full URLs, so
// the agent can include them as-is in messages and the user will get a
// clickable link. Carrier names come from GlobKurier's `carrier.name`
// field (e.g. "DPD", "FedEX", "inPost-Kurier", "DHL").
//
// Returns null if we don't recognize the carrier or have no tracking
// number — the caller should then just omit the link.
function buildTrackingUrl(carrierName, trackingNumber) {
  if (!trackingNumber) return null;
  const tn = String(trackingNumber).trim();
  if (!tn) return null;
  const c = String(carrierName || '').toLowerCase();

  if (c.includes('inpost')) {
    return `https://inpost.pl/sledzenie-przesylek?number=${encodeURIComponent(tn)}`;
  }
  if (c.includes('dpd')) {
    return `https://tracktrace.dpd.com.pl/findParcel?q=${encodeURIComponent(tn)}`;
  }
  if (c.includes('dhl')) {
    return `https://www.dhl.com/pl-pl/home/tracking/tracking-express.html?submit=1&tracking-id=${encodeURIComponent(tn)}`;
  }
  if (c.includes('fedex')) {
    return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(tn)}`;
  }
  if (c.includes('ups')) {
    return `https://www.ups.com/track?tracknum=${encodeURIComponent(tn)}`;
  }
  if (c.includes('gls')) {
    return `https://gls-group.com/PL/pl/sledzenie-paczek?match=${encodeURIComponent(tn)}`;
  }
  if (c.includes('pocztex') || c.includes('poczta')) {
    return `https://emonitoring.poczta-polska.pl/?numer=${encodeURIComponent(tn)}`;
  }

  // Fallback: GlobKurier's own tracking page works for every carrier they
  // resell, but it requires the GK number (not the carrier's tracking).
  // We don't have the GK number here, so return null and let caller decide.
  return null;
}

module.exports = { buildTrackingUrl };
