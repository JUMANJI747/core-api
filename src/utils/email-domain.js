'use strict';

// Darmowe / publiczne domeny pocztowe — NIE kojarzymy po nich kontrahenta
// (bo np. z gmaila pisze wielu roznych ludzi). Domena firmowa (np. euromipe.com)
// jest unikalna dla firmy -> mozna nia linkowac kazdego pracownika.
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com',
  'outlook.com', 'outlook.de', 'outlook.fr', 'outlook.es', 'hotmail.com', 'hotmail.co.uk',
  'hotmail.fr', 'hotmail.es', 'hotmail.it', 'live.com', 'live.co.uk', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.es', 'yahoo.fr', 'yahoo.it', 'yahoo.de', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.de', 'gmx.net', 'web.de', 't-online.de',
  'wp.pl', 'o2.pl', 'interia.pl', 'interia.eu', 'onet.pl', 'op.pl', 'gazeta.pl', 'vp.pl', 'poczta.onet.pl', 'poczta.fm',
  'orange.fr', 'free.fr', 'sfr.fr', 'laposte.net', 'wanadoo.fr',
  'libero.it', 'virgilio.it', 'alice.it', 'tin.it',
  'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'seznam.cz',
  'telenet.be', 'ziggo.nl', 'kpnmail.nl', 'home.nl',
]);

// Wyciaga domene z adresu email (lowercase). Zwraca null gdy brak/niepoprawny.
function emailDomain(email) {
  const m = String(email || '').toLowerCase().trim().match(/@([^@\s>"',;]+)/);
  if (!m) return null;
  return m[1].replace(/[.>,;"']+$/, '') || null;
}

function isFreeMailDomain(domain) {
  if (!domain) return true;
  return FREE_MAIL.has(String(domain).toLowerCase());
}

// Domena firmowa = jest domeną maila i NIE jest darmowa/publiczna. Inaczej null.
function companyDomain(email) {
  const d = emailDomain(email);
  if (!d || isFreeMailDomain(d)) return null;
  return d;
}

module.exports = { FREE_MAIL, emailDomain, isFreeMailDomain, companyDomain };
