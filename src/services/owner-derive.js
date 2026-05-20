'use strict';

// Reguła biznesowa: kontrahentów z Fuerteventury obsługuje Rogacz, resztę
// Nikodem. Wywołane przy sync (auto-set na nowych rekordach) i przy
// endpoint POST /contractors/backfill-owners (jednorazowy rebackfill).
//
// Detekcja Fuerteventury:
//   - kod pocztowy 356xx — w prowincji Las Palmas tylko Fuerteventura ma
//     zakres 35600-35699 (Gran Canaria: 35001-35499, Lanzarote: 35500-35599)
//   - nazwa miasta / municypalitet z listy
//   - province zawiera "Fuerteventura"

const FUERTE_CITIES = [
  'puerto del rosario', 'corralejo', 'morro jable', 'costa calma',
  'caleta de fuste', 'gran tarajal', 'antigua', 'la oliva',
  'pajara', 'pájara', 'tuineje', 'betancuria', 'el cotillo',
  'lajares', 'villaverde', 'tarajalejo', 'esquinzo', 'fuerteventura',
];

function isFuerteventura({ postalCode, city, province } = {}) {
  const zip = (postalCode || '').trim();
  if (/^356\d{2}$/.test(zip)) return true;
  const cityL = (city || '').toLowerCase().trim();
  if (cityL && FUERTE_CITIES.some(m => cityL.includes(m))) return true;
  const provinceL = (province || '').toLowerCase().trim();
  if (provinceL.includes('fuerteventura')) return true;
  return false;
}

function resolveOwnerFromAddress(c) {
  return isFuerteventura(c) ? 'rogacz' : 'nikodem';
}

module.exports = { isFuerteventura, resolveOwnerFromAddress };
