'use strict';

// Helpers do parsowania adresow. Wyodrebnione zeby:
//  - routes/contractors.js przy POST /upsert auto-wyciagal postCode gdy
//    agent wkleil caly adres jako jeden string
//  - services/ifirma-payload.js mial fallback regex jako ostatnia deska
//    ratunku przy budowie payloadu do iFirmy

// Wyciaga kod pocztowy z tekstu — PL i zagraniczne.
//  - PL:  NN-NNN        "11-500 Gizycko" -> "11-500"
//  - PT:  NNNN-NNN      "1990-096 Lisboa" -> "1990-096"
//  - ES/DE/FR/IT/...: 5 cyfr  "Zubiaurre 121, 3B, 20015" -> "20015"
// Dla formy 5-cyfrowej bierzemy OSTATNIE wystapienie (kod zwykle na koncu
// adresu, po numerze budynku), zeby nie zlapac numeru domu.
function extractPostCode(text) {
  if (!text || typeof text !== 'string') return null;
  let m = text.match(/\b(\d{2}-\d{3})\b/);   // PL
  if (m) return m[1];
  m = text.match(/\b(\d{4}-\d{3})\b/);        // PT
  if (m) return m[1];
  const five = text.match(/\b\d{5}\b/g);       // ES/DE/FR/IT/NL itd.
  if (five && five.length) return five[five.length - 1];
  return null;
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
