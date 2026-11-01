'use strict';

/* TELEFONY W FORMACIE MIĘDZYNARODOWYM (1.11.2026).
 *
 * GlobKurier dla zagranicy przyjmuje tylko pełny numer (+49…, +33…) bez zera
 * krajowego. A parser adresów (model AI) przekręcał długie numery: ten sam
 * niemiecki numer zapisany na 5 sposobów dał 5 złych wyników (zgubione albo
 * dopisane cyfry, zostawione zero po +49) — i paczka do salted GmbH utknęła na
 * „To nie jest prawidłowy numer telefonu dla kraju Niemcy".
 *
 * Dlatego numer bierzemy WPROST z wklejonego tekstu (`telefonZTekstu`), a
 * odpowiedź modelu służy tylko za podpowiedź, który z numerów w tekście jest
 * telefonem. `normalizujTelefon` sprowadza każdy zapis do +<kierunkowy><numer>
 * (tego samego używa zamówienie kuriera w glob-quote.js). */

// ISO-2 → kierunkowy (subset E.164).
const KIERUNKOWE = {
  PL: '48', DE: '49', FR: '33', IT: '39', ES: '34', NL: '31', BE: '32',
  AT: '43', CZ: '420', SK: '421', HU: '36', SE: '46', DK: '45', FI: '358',
  NO: '47', GB: '44', IE: '353', PT: '351', RO: '40', BG: '359', HR: '385',
  SI: '386', LT: '370', LV: '371', EE: '372', GR: '30', CY: '357', MT: '356',
  LU: '352', CH: '41', AE: '971',
};
const KODY = [...new Set(Object.values(KIERUNKOWE))].sort((a, b) => b.length - a.length);
// Tylko we Włoszech zero należy do numeru także w zapisie międzynarodowym
// (+39 02…). Wszędzie indziej zero krajowe znika: 0157… → +49 157….
const ZOSTAW_ZERO = new Set(['39']);
// Najkrótszy numer krajowy (bez zera i kierunkowego). Rozstrzyga zapis bez
// „+": „4512345678" to duński numer z kierunkowym, a „45123456" — krajowy.
const MIN_KRAJOWY = { PL: 9, IT: 9, FR: 9, ES: 9, PT: 9, CZ: 9, SK: 9, NL: 9, CH: 9, RO: 9, GB: 9, GR: 10 };

/** Dowolny zapis → „+<kierunkowy><numer>" albo null. `krajIso` potrzebny
 *  tylko dla numerów zapisanych krajowo (bez „+" i bez „00"). */
function normalizujTelefon(surowy, krajIso) {
  if (surowy == null) return null;
  // „(0)" w zapisie międzynarodowym = zero krajowe do pominięcia.
  let s = String(surowy).replace(/\(\s*0\s*\)/g, '');
  s = s.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  if (!/\d/.test(s)) return null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  const iso = krajIso ? String(krajIso).trim().toUpperCase() : '';
  const dial = KIERUNKOWE[iso] || null;
  if (s.startsWith('+')) {
    const cyfry = s.slice(1);
    const kod = KODY.find(k => cyfry.startsWith(k));
    if (kod && !ZOSTAW_ZERO.has(kod) && cyfry[kod.length] === '0') s = '+' + kod + cyfry.slice(kod.length + 1);
  } else if (dial) {
    if (s.startsWith('0')) s = '+' + dial + (ZOSTAW_ZERO.has(dial) ? s : s.replace(/^0+/, ''));
    else if (s.startsWith(dial) && s.length - dial.length >= (MIN_KRAJOWY[iso] || 8)) s = '+' + s;
    else s = '+' + dial + s;
  } else {
    return null; // zapis krajowy, a kraju nie znamy — nie zgadujemy
  }
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

// Słowa, po których stoi telefon („Tel.:", „Mobil", „T:", „WhatsApp"…).
const ETYKIETA = /(?:^|[^\p{L}])(?:tel|tél|telefon|telefono|teléfono|phone|fon|mobil|mobile|móvil|movil|cell|cellulare|handy|portable|gsm|whats\s?app|t|m|p)\.?\s*[:.]?\s*$/iu;
// Ciąg cyfr z typowymi separatorami (bez przejścia do nowej linii, żeby kod
// pocztowy z następnej linii nie skleił się z telefonem).
const CIAG = /\+?\d[\d \t  ().\/-]*\d/g;

/** Wszystkie numery z tekstu: [{numer, pewny}] — `pewny`, gdy zapis ma „+"
 *  albo „00", albo stoi po etykiecie telefonu. */
function telefonyWTekscie(tekst, krajIso) {
  const t = String(tekst || '');
  const wynik = [];
  const dodaj = (surowy, pewny) => {
    const numer = normalizujTelefon(surowy, krajIso);
    if (!numer) return false;
    const byl = wynik.find(w => w.numer === numer);
    if (byl) byl.pewny = byl.pewny || pewny;
    else wynik.push({ numer, pewny });
    return true;
  };
  for (const m of t.matchAll(CIAG)) {
    const przed = t.slice(Math.max(0, m.index - 30), m.index).split('\n').pop();
    const pewny = /^(\+|00)/.test(m[0]) || ETYKIETA.test(przed);
    if (dodaj(m[0], pewny)) continue;
    // Za długi ciąg = kilka numerów obok siebie („030 123456 / 0157 805473").
    for (const czesc of m[0].split(/\s+[\/|]\s+|\s{2,}/)) dodaj(czesc, pewny || /^\s*(\+|00)/.test(czesc));
  }
  return wynik;
}

function odleglosc(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let lewy = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const gora = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, lewy + (a[i - 1] === b[j - 1] ? 0 : 1));
      lewy = gora;
    }
  }
  return d[b.length];
}

/** Telefon do formularza: numer z tekstu, model tylko podpowiada, który.
 *  - podpowiedź jest w tekście → ona,
 *  - podpowiedź przekręcona o 1–3 cyfry → najbliższy numer z tekstu,
 *  - brak podpowiedzi albo zupełnie inna, a w tekście jeden wyraźny numer → on,
 *  - nic z tego → znormalizowana podpowiedź (albo null). */
function telefonZTekstu(tekst, podpowiedz, krajIso) {
  const numery = telefonyWTekscie(tekst, krajIso);
  const hint = normalizujTelefon(podpowiedz, krajIso);
  const pewne = numery.filter(n => n.pewny);
  if (hint && numery.some(n => n.numer === hint)) return hint;
  const cyfryHint = hint ? hint.slice(1) : String(podpowiedz || '').replace(/\D/g, '');
  if (cyfryHint.length >= 6) {
    let naj = null;
    let najD = Infinity;
    for (const n of numery) {
      const d = odleglosc(cyfryHint, n.numer.slice(1));
      if (d < najD || (d === najD && n.pewny && !naj.pewny)) { naj = n; najD = d; }
    }
    if (naj && najD <= Math.min(3, Math.floor((naj.numer.length - 1) / 4))) return naj.numer;
  }
  if (pewne.length === 1) return pewne[0].numer;
  return hint;
}

module.exports = { KIERUNKOWE, normalizujTelefon, telefonyWTekscie, telefonZTekstu };
