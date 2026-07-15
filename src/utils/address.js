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
//  - SI/AT/CH/BE/DK/HU/NO/...: 4 cyfry  "9240 Ljutomer" -> "9240"
// Dla formy 5-cyfrowej bierzemy OSTATNIE wystapienie (kod zwykle na koncu
// adresu, po numerze budynku), zeby nie zlapac numeru domu. Dla 4-cyfrowej
// (kolizja z numerem domu) wymagamy by kod SASIADOWAL z nazwa miasta.
function extractPostCode(text) {
  if (!text || typeof text !== 'string') return null;
  let m = text.match(/\b(\d{2}-\d{3})\b/);   // PL
  if (m) return m[1];
  m = text.match(/\b(\d{4}-\d{3})\b/);        // PT
  if (m) return m[1];
  // IE Eircode: klucz trasowania (litera+2 cyfry, np. D03/A65, specjalny D6W)
  // + 4 znaki alfanum. — "D03 YK40". Litera na starcie odróżnia od numeru domu.
  m = text.match(/\b((?:[A-Z]\d{2}|D6W)\s?[A-Z0-9]{4})\b/i);
  if (m) return m[1].toUpperCase();
  // UK: "SW1A 1AA", "M1 1AE", "B33 8TH" (część zewn. + spacja + cyfra+2 litery)
  m = text.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2})\b/i);
  if (m) return m[1].toUpperCase();
  // NL: "1012 AB" (4 cyfry + 2 litery jako CAŁE słowo — "9240 Ljutomer" nie łapie)
  m = text.match(/\b(\d{4}\s?[A-Z]{2})\b/i);
  if (m) return m[1].toUpperCase();
  const five = text.match(/\b\d{5}\b/g);       // ES/DE/FR/IT itd.
  if (five && five.length) return five[five.length - 1];
  // 4-cyfrowe: tylko gdy przylega do nazwy miasta — "9240 Ljutomer" albo
  // "Ljutomer 9240" — by NIE zlapac numeru domu ("ulica 4" ma 1 cyfre, ale
  // np. "Main St 1234" mialaby; forma "NNNN Miasto" jest jednoznaczna).
  let four = text.match(/(?:^|[,\s])(\d{4})\s+[A-Za-zÀ-ſ]/);   // "9240 Ljutomer"
  if (four) return four[1];
  four = text.match(/[A-Za-zÀ-ſ.]\s*,\s*(\d{4})\b/);            // "Ljutomer, 9240"
  if (four) return four[1];
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
