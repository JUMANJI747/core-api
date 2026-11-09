'use strict';

/* ADRES POD GLOBKURIER — jedno źródło reguł i weryfikacja (9.11.2026).
 *
 * Zamówienie magazynu #5 (Rosignano Marittimo, IT) zostało spakowane w
 * poniedziałek rano, a kurier z auto-listu się nie zamówił: GK odrzucił
 * „Via dell'Industria" / „Rosignano Marittimo (LI)" („Wpisano nieprawidłowy
 * znak…"). Błąd wyszedł dopiero przy pakowaniu, czyli w ostatniej chwili.
 *
 * Teraz te same reguły (czyszczenie pól jak w zamówieniu kuriera,
 * routes/glob-quote.js) sprawdzają adres JUŻ PRZY SKŁADANIU zamówienia:
 *  - `poprawki`    — co zmieniamy sami (apostrof, „(LI)", kod 00000 → 00-000,
 *                    telefon do +kierunkowy…), adres zapisujemy już poprawiony;
 *  - `ostrzezenia` — przejdzie, ale warto wiedzieć (nazwa > 30 znaków będzie
 *                    ucięta, telefon spoza kraju odbiorcy, zły e-mail);
 *  - `bledy`       — GK tego nie przyjmie (brak pola, zły kod pocztowy,
 *                    nieczytelny telefon): auto-list nie da się złożyć. */

const { normalizujTelefon, KIERUNKOWE } = require('./telefon');

function oczyscGk(s, dozwolone) {
  if (!s) return s;
  // \p{L}\p{N} zostawia polskie, hiszpańskie i włoskie litery z akcentami.
  const poza = new RegExp(`[^\\p{L}\\p{N}\\s${dozwolone}]`, 'gu');
  return String(s).replace(poza, ' ').replace(/\s+/g, ' ').trim();
}
// Ukośnik w nazwie („Surfstylefever / Stefan") GK odrzuca — zamieniamy na myślnik.
const gkName = (s) => oczyscGk(String(s || '').replace(/\s*\/\s*/g, ' - '), "\\.,'()\\-@");
/* 9.11.2026: GK w praktyce odrzucił apostrof w ulicy i nawias w mieście,
 * choć z dokumentacji wynikało inaczej. Apostrof → spacja („Via dell
 * Industria" kurier znajdzie), skrót prowincji w nawiasie na końcu miasta
 * („Rosignano Marittimo (LI)") wylatuje. */
const gkStreet = (s) => oczyscGk(String(s || '').replace(/['’`]/g, ' '), '\\.\\-&/,');
const gkCity = (s) => oczyscGk(String(s || '').replace(/\s*\([A-Za-z]{1,3}\)\s*$/, '').replace(/['’`]/g, ' '), '\\.\\-&/');

/* Numer domu i lokalu osobno (zgłoszenie 17.09.2026, „MORSKA 4A/10"). */
function rozbijNumerDomu(surowy) {
  const s = String(surowy || '').trim();
  if (!s) return { dom: '', lokal: '' };
  const ukosnik = s.match(/^([^/\s]+)\s*\/\s*([^/\s]+)$/);
  if (ukosnik) return { dom: ukosnik[1], lokal: ukosnik[2] };
  const lokal = s.match(/^(\S+)\s*(?:m|lok|mieszk\w*)\.?\s*([\w-]+)$/i);
  if (lokal) return { dom: lokal[1], lokal: lokal[2] };
  return { dom: s, lokal: '' };
}
// W numerze GK przyjmuje cyfry, litery i ukośnik. Spacja i kropka — nie.
const numerGk = (s) => String(s || '').replace(/[^0-9A-Za-zĄąĆćĘꣳŃńÓóŚśŹźŻż/-]/g, '').trim();

const MAX_NAZWA = 30; // tyle GK zostawia z nazwy odbiorcy na liście przewozowym

// Format kodu pocztowego w krajach, do których wysyłamy (reszta bez sprawdzania).
const KODY_POCZTOWE = {
  PL: [/^\d{2}-\d{3}$/, '00-000'], DE: [/^\d{5}$/, '5 cyfr'], IT: [/^\d{5}$/, '5 cyfr'], ES: [/^\d{5}$/, '5 cyfr'],
  FR: [/^\d{5}$/, '5 cyfr'], PT: [/^\d{4}-\d{3}$/, '0000-000'], NL: [/^\d{4} ?[A-Z]{2}$/, '1234 AB'], BE: [/^\d{4}$/, '4 cyfry'],
  AT: [/^\d{4}$/, '4 cyfry'], CH: [/^\d{4}$/, '4 cyfry'], CZ: [/^\d{3} ?\d{2}$/, '123 45'], SK: [/^\d{3} ?\d{2}$/, '123 45'],
  DK: [/^\d{4}$/, '4 cyfry'], SE: [/^\d{3} ?\d{2}$/, '123 45'], NO: [/^\d{4}$/, '4 cyfry'], FI: [/^\d{5}$/, '5 cyfr'],
  HU: [/^\d{4}$/, '4 cyfry'], GR: [/^\d{3} ?\d{2}$/, '123 45'], HR: [/^\d{5}$/, '5 cyfr'], SI: [/^\d{4}$/, '4 cyfry'],
  RO: [/^\d{6}$/, '6 cyfr'], BG: [/^\d{4}$/, '4 cyfry'], LT: [/^(LT-)?\d{5}$/, 'LT-12345'], LV: [/^(LV-)?\d{4}$/, 'LV-1234'],
  EE: [/^\d{5}$/, '5 cyfr'], LU: [/^(L-)?\d{4}$/, '4 cyfry'], IE: [/^[A-Z]\d{2}[A-Z\d]? ?[A-Z\d]{4}$/, 'D02 X285'],
  GB: [/^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/, 'SW1A 1AA'],
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const bezSpacji = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Sprawdza i poprawia odbiorcę pod GlobKurier.
 *  Zwraca { adres, poprawki, ostrzezenia, bledy }. `adres` ma te same pola co
 *  `WarehouseOrder.odbiorca` i jest gotowy do zapisu. */
function sprawdzOdbiorce(od) {
  const o = od || {};
  const poprawki = [];
  const ostrzezenia = [];
  const bledy = [];
  const zmiana = (pole, przed, po) => { if (bezSpacji(przed) && bezSpacji(przed) !== po) poprawki.push(`${pole}: „${bezSpacji(przed)}” → „${po}”`); };

  const kraj = (bezSpacji(o.country) || 'PL').toUpperCase();
  const adres = { name: '', street: '', houseNumber: '', apartmentNumber: '', postCode: '', city: '', country: kraj, phone: '', email: '' };

  adres.name = gkName(o.name) || '';
  zmiana('nazwa', o.name, adres.name);
  if (adres.name.length > MAX_NAZWA) {
    const ucieta = adres.name.split(' ').reduce((acc, w) => ((`${acc} ${w}`).trim().length <= MAX_NAZWA ? `${acc} ${w}`.trim() : acc), '');
    ostrzezenia.push(`nazwa ma ${adres.name.length} znaków — na liście przewozowym zostanie „${ucieta}”`);
  }

  // Numer domu: z pola, a gdy pusty — z końca ulicy („Morska 4A/10").
  let ulica = bezSpacji(o.street);
  let numer = bezSpacji(o.houseNumber);
  if (!numer && ulica) {
    const m = ulica.match(/^(.*?[^\d\s,])[\s,]+(\d+[A-Za-z]?(?:\s*\/\s*[\w-]+)?)$/);
    if (m) { numer = m[2]; ulica = m[1]; poprawki.push(`numer domu przeniesiony z ulicy: „${bezSpacji(o.street)}” → ulica „${ulica}”, numer „${numer}”`); }
  }
  const rozbity = rozbijNumerDomu(numer);
  adres.street = gkStreet(ulica) || '';
  zmiana('ulica', ulica, adres.street);
  adres.houseNumber = numerGk(rozbity.dom);
  zmiana('numer domu', rozbity.dom, adres.houseNumber);
  adres.apartmentNumber = bezSpacji(o.apartmentNumber) || rozbity.lokal || '';
  if (!bezSpacji(o.apartmentNumber) && rozbity.lokal) poprawki.push(`lokal „${rozbity.lokal}” przeniesiony do osobnego pola`);

  adres.city = gkCity(o.city) || '';
  zmiana('miasto', o.city, adres.city);

  let kod = bezSpacji(o.postCode).toUpperCase();
  if (kraj === 'PL' && /^\d{5}$/.test(kod)) { const k = `${kod.slice(0, 2)}-${kod.slice(2)}`; poprawki.push(`kod: „${kod}” → „${k}”`); kod = k; }
  adres.postCode = kod;
  const wzor = KODY_POCZTOWE[kraj];
  if (kod && wzor && !wzor[0].test(kod)) bledy.push(`kod pocztowy „${kod}” nie pasuje do ${kraj} (${wzor[1]})`);

  if (!/^[A-Z]{2}$/.test(kraj)) bledy.push(`kraj „${kraj}” — podaj kod ISO, np. DE, IT`);

  const telSurowy = bezSpacji(o.phone);
  if (telSurowy) {
    const tel = normalizujTelefon(telSurowy, kraj);
    if (!tel) {
      bledy.push(`telefon „${telSurowy}” nieczytelny — wpisz z kierunkowym, np. +${KIERUNKOWE[kraj] || '48'}…`);
    } else {
      adres.phone = tel;
      if (tel.slice(1) !== telSurowy.replace(/\D/g, '')) poprawki.push(`telefon: „${telSurowy}” → „${tel}”`);
      const dial = KIERUNKOWE[kraj];
      if (dial && !tel.startsWith(`+${dial}`)) ostrzezenia.push(`telefon ${tel} jest spoza kraju odbiorcy (${kraj}) — GK go nie przyjmie, na liście będzie inny numer (z poprzednich wysyłek albo nasz)`);
    }
  }

  const email = bezSpacji(o.email);
  if (email && !EMAIL.test(email)) ostrzezenia.push(`e-mail „${email}” wygląda na błędny — kurier dostanie nasz adres delivery@`);
  else adres.email = email;

  const braki = [];
  if (!adres.name) braki.push('nazwa');
  if (!adres.street) braki.push('ulica');
  if (!adres.houseNumber) braki.push('numer domu (gdy budynek nie ma numeru: SNC albo bn)');
  if (!adres.postCode) braki.push('kod pocztowy');
  if (!adres.city) braki.push('miasto');
  if (!telSurowy) braki.push('telefon');
  if (braki.length) bledy.unshift(`brakuje: ${braki.join(', ')}`);

  return { adres, poprawki, ostrzezenia, bledy };
}

module.exports = { sprawdzOdbiorce, oczyscGk, gkName, gkStreet, gkCity, rozbijNumerDomu, numerGk, MAX_NAZWA };
