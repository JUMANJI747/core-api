'use strict';

// Agresywna normalizacja adresu zeby dedup zlapal warianty typu:
//   "C/ Mayor 12" == "Calle Mayor 12" == "Calle Mayor, 12" == "C Mayor 12 "
//   "ul. Krakowska 5" == "Krakowska 5" == "ulica Krakowska 5"
function normStreet(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    // strip street prefixes (multilang)
    .replace(/^(c\/|calle|cl\.?|carrer|avenida|avda\.?|av\.?|paseo|plaza|pza\.?|carretera|ctra\.?|camino|ul\.?|ulica|aleja|al\.?|str\.?|strasse|straße|via|viale|piazza|rue|boulevard|bd\.?|impasse|chemin|road|rd\.?|street|st\.?|drive|dr\.?|lane|ln\.?|avenue|ave\.?)\s+/i, '')
    // strip punctuation
    .replace(/[.,;:'"()\[\]\/\\\-—–]/g, ' ')
    // collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

function normCity(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/[.,;:'"()]/g, '').trim();
}

function normPostCode(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/[\s\-]/g, '');
}

function fingerprint(loc) {
  return `${normStreet(loc.street)}|${normCity(loc.city)}|${normPostCode(loc.postCode)}`;
}

// Dedup tablicy lokalizacji - keep first occurrence po addedAt asc (najstarsze).
// Merge contactPerson/phone/email z duplikatow (preferuj non-null).
function dedupLocations(locations) {
  if (!Array.isArray(locations)) return { result: [], removed: 0 };
  const byFp = new Map(); // fp -> {keptIdx, merged}
  for (let i = 0; i < locations.length; i++) {
    const loc = locations[i];
    const fp = fingerprint(loc);
    if (fp === '||') continue; // adres calkowicie pusty - drop
    if (!byFp.has(fp)) {
      byFp.set(fp, { ...loc, _gkOrderCounts: [loc.gkOrderCount || 1] });
    } else {
      // merge - zachowaj non-null pola, sum order counts
      const kept = byFp.get(fp);
      kept.contactPerson = kept.contactPerson || loc.contactPerson;
      kept.phone = kept.phone || loc.phone;
      kept.email = kept.email || loc.email;
      kept.houseNumber = kept.houseNumber || loc.houseNumber;
      kept.country = kept.country || loc.country;
      // zachowaj najnowszy addedAt + suma orderCount
      if (loc.addedAt && (!kept.addedAt || new Date(loc.addedAt) > new Date(kept.addedAt))) {
        kept.addedAt = loc.addedAt;
      }
      kept._gkOrderCounts.push(loc.gkOrderCount || 1);
    }
  }
  const result = Array.from(byFp.values()).map(loc => {
    const totalCount = loc._gkOrderCounts.reduce((a, b) => a + b, 0);
    delete loc._gkOrderCounts;
    if (totalCount > 1) loc.gkOrderCount = totalCount;
    return loc;
  });
  return { result, removed: (locations.length - result.length) };
}

module.exports = { dedupLocations, normStreet, normCity, normPostCode, fingerprint };
