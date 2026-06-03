'use strict';

const { fetchWithTimeout } = require('./http');

const VIES_URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';

// userError zwracane przez VIES gdy usluga NIE BYLA W STANIE zweryfikowac
// numeru (np. baza danego panstwa czlonkowskiego niedostepna / limit zapytan).
// To NIE znaczy, ze NIP jest bledny — czesty przypadek dla FR/ES.
const SERVICE_ERRORS = new Set([
  'MS_UNAVAILABLE',
  'MS_MAX_CONCURRENT_REQ',
  'GLOBAL_MAX_CONCURRENT_REQ',
  'SERVICE_UNAVAILABLE',
  'TIMEOUT',
  'IP_BLOCKED',
  'INVALID_REQUESTER_INFO',
]);

// Trojstanowa weryfikacja numeru VAT w VIES.
// Zwraca { status, valid, name, address, requestDate, userError }:
//   status='valid'   -> numer aktywny (valid=true)
//   status='invalid' -> numer NA PEWNO nieaktywny/nieistniejacy (valid=false)
//   status='unknown' -> nie udalo sie zweryfikowac (usluga niedostepna/limit/
//                       timeout/blad sieci); valid=null. NIE traktowac jak invalid!
async function verifyVat(countryCode, vatNumber, timeoutMs = 20000) {
  const cc = String(countryCode || '').trim().toUpperCase();
  const num = String(vatNumber || '').replace(/[\s.\-]/g, '').toUpperCase();

  let data;
  try {
    const res = await fetchWithTimeout(VIES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ countryCode: cc, vatNumber: num }),
    }, timeoutMs);
    if (!res.ok) {
      return { status: 'unknown', valid: null, name: null, address: null, requestDate: null, userError: `HTTP_${res.status}` };
    }
    data = await res.json();
  } catch (e) {
    return { status: 'unknown', valid: null, name: null, address: null, requestDate: null, userError: e.message || 'NETWORK_ERROR' };
  }

  const userError = data.userError || null;
  let status;
  if (data.valid === true) {
    status = 'valid';
  } else if (userError && SERVICE_ERRORS.has(userError)) {
    status = 'unknown';
  } else if (data.valid === false) {
    // Jawny negatyw (userError 'INVALID' lub brak) — numer faktycznie nieaktywny.
    status = 'invalid';
  } else {
    // Brak pola valid i nieznany userError — bezpieczniej jako "nie wiem".
    status = 'unknown';
  }

  return {
    status,
    valid: status === 'valid' ? true : status === 'invalid' ? false : null,
    name: data.name || null,
    address: data.address || null,
    requestDate: data.requestDate || null,
    userError,
  };
}

module.exports = { verifyVat, VIES_URL, SERVICE_ERRORS };
