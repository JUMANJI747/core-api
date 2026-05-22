'use strict';

// Helpers do parsowania adresow. Wyodrebnione zeby:
//  - routes/contractors.js przy POST /upsert auto-wyciagal postCode gdy
//    agent wkleil caly adres jako jeden string
//  - services/ifirma-payload.js mial fallback regex jako ostatnia deska
//    ratunku przy budowie payloadu do iFirmy

// Wyciaga PL kod pocztowy (\d{2}-\d{3}) z tekstu.
// np. "ul. Jagielly 1A, 11-500 Gizycko" -> "11-500".
function extractPostCode(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/\b(\d{2}-\d{3})\b/);
  return m ? m[1] : null;
}

// Wyciaga miasto po kodzie pocztowym ("11-500 Gizycko" -> "Gizycko").
// Tylko jak postCode juz znaleziony. Defensywne ograniczenia 2-50 znakow.
function extractCityAfterPostCode(text, postCode) {
  if (!text || !postCode || typeof text !== 'string') return null;
  const idx = text.indexOf(postCode);
  if (idx < 0) return null;
  const after = text.slice(idx + postCode.length);
  const m = after.match(/^[,\s]+([A-Za-zÀ-ſ][\wÀ-ſ\s-]+?)(?:[,\s]|$)/);
  if (!m) return null;
  const city = m[1].trim().replace(/[,;]+$/, '');
  if (city.length < 2 || city.length > 50) return null;
  return city;
}

module.exports = { extractPostCode, extractCityAfterPostCode };
