'use strict';

// Wspólny moduł rozpoznawania krajów. Wcześniej rozproszone w 3 plikach:
// - invoices.js (COUNTRY_NAME_TO_CODE, EU_VAT_PREFIXES, LEGAL_FORM_TO_COUNTRY, normalizeIso, nipPrefixToCountry)
// - glob-helpers.js (COUNTRY_NAME_TO_ISO, normalizeCountry — z fallback slice(0,2))
// - emails.js (EU_VAT_REGEX dla extract-nip)
//
// Tutaj jeden moduł, jedna definicja, importujemy gdzie potrzeba.

// 2-literowe prefiksy NIP w UE (bez PL — lokalny krajowy nie wymaga rozpoznania).
const EU_VAT_PREFIXES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR',
  'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'RO', 'SE',
  'SI', 'SK', 'XI', // XI = Northern Ireland post-Brexit
]);

// Mapowanie nazw krajów (polskie/angielskie/lokalne) → ISO-2.
// Unia tego co wcześniej było w invoices.js i glob-helpers.js — najszersza
// lista, żeby nic nie wypadło przy konsolidacji.
const COUNTRY_NAME_TO_ISO = {
  // Polska
  polska: 'PL', poland: 'PL',
  // Hiszpania
  hiszpania: 'ES', hiszpańska: 'ES', spain: 'ES', espana: 'ES', españa: 'ES',
  // Niemcy
  niemcy: 'DE', germany: 'DE', deutschland: 'DE',
  // Francja
  francja: 'FR', france: 'FR',
  // Włochy
  włochy: 'IT', wlochy: 'IT', italy: 'IT', italia: 'IT',
  // Holandia
  holandia: 'NL', netherlands: 'NL',
  // Portugalia
  portugalia: 'PT', portugal: 'PT',
  // Belgia
  belgia: 'BE', belgium: 'BE',
  // Austria
  austria: 'AT',
  // Dania
  dania: 'DK', denmark: 'DK', danmark: 'DK',
  // Szwecja
  szwecja: 'SE', sweden: 'SE',
  // Irlandia
  irlandia: 'IE', ireland: 'IE', éire: 'IE',
  // Czechy
  czechy: 'CZ', 'czech republic': 'CZ', czechia: 'CZ', česko: 'CZ',
  // Słowacja
  słowacja: 'SK', slowacja: 'SK', slovakia: 'SK',
  // Węgry
  węgry: 'HU', wegry: 'HU', hungary: 'HU',
  // Rumunia
  rumunia: 'RO', romania: 'RO',
  // Bułgaria
  bułgaria: 'BG', bulgaria: 'BG',
  // Chorwacja
  chorwacja: 'HR', croatia: 'HR',
  // Słowenia
  słowenia: 'SI', slowenia: 'SI', slovenia: 'SI',
  // Litwa / Łotwa / Estonia
  litwa: 'LT', lithuania: 'LT',
  łotwa: 'LV', lotwa: 'LV', latvia: 'LV',
  estonia: 'EE',
  // Finlandia
  finlandia: 'FI', finland: 'FI',
  // Pozostałe
  cypr: 'CY', cyprus: 'CY',
  malta: 'MT',
  luksemburg: 'LU', luxembourg: 'LU',
  grecja: 'GR', greece: 'GR',
  norwegia: 'NO', norway: 'NO',
  szwajcaria: 'CH', switzerland: 'CH',
  'wielka brytania': 'GB', uk: 'GB', 'united kingdom': 'GB', anglia: 'GB',
};

// Sufiks formy prawnej → kraj. Używane w fallback derive-country (slabe
// sygnały — gdy NIP/adres brakuje, a nazwa ma typowy sufiks).
const LEGAL_FORM_TO_COUNTRY = [
  { re: /\b(s\.?\s?l\.?\s?u\.?|s\.?\s?l\.?|sociedad limitada)\b/i, country: 'ES' },
  { re: /\b(s\.?\s?a\.?|sociedad an[oó]nima)\b/i, country: 'ES' },
  { re: /\bgmbh\b/i, country: 'DE' },
  { re: /\bag\b/i, country: 'DE' },
  { re: /\bs\.?\s?r\.?\s?l\.?\b/i, country: 'IT' },
  { re: /\bs\.?\s?p\.?\s?a\.?\b/i, country: 'IT' },
  { re: /\bb\.?\s?v\.?\b/i, country: 'NL' },
  { re: /\bs\.?\s?a\.?\s?s\.?\b/i, country: 'FR' },
  { re: /\bs\.?\s?à\.?\s?r\.?\s?l\.?\b/i, country: 'FR' },
  { re: /\bs\.?\s?p\.?\s?z\s?o\.?\s?o\.?\b/i, country: 'PL' },
  { re: /\b(unipessoal\s+)?lda\.?\b/i, country: 'PT' },
  { re: /\bltd\b/i, country: 'GB' },
];

// Regex EU VAT numbers — pełen zestaw prefiksów + per-country pattern.
// Używane w extract-nip do skanowania treści maili.
const EU_VAT_REGEX = new RegExp([
  '\\bAT[U]?\\d{8,9}\\b',
  '\\bBE[01]?\\d{9}\\b',
  '\\bBG\\d{9,10}\\b',
  '\\bCY\\d{8}[A-Z]\\b',
  '\\bCZ\\d{8,10}\\b',
  '\\bDE\\d{9}\\b',
  '\\bDK\\d{8}\\b',
  '\\bEE\\d{9}\\b',
  '\\bEL\\d{9}\\b',
  '\\bES[A-Z0-9]\\d{7}[A-Z0-9]\\b',
  '\\bFI\\d{8}\\b',
  '\\bFR[A-Z0-9]{2}\\d{9}\\b',
  '\\bGB\\d{9}(\\d{3})?\\b',
  '\\bHR\\d{11}\\b',
  '\\bHU\\d{8}\\b',
  '\\bIE\\d[A-Z0-9+*]\\d{5}[A-Z]{1,2}\\b',
  '\\bIT\\d{11}\\b',
  '\\bLT(\\d{9}|\\d{12})\\b',
  '\\bLU\\d{8}\\b',
  '\\bLV\\d{11}\\b',
  '\\bMT\\d{8}\\b',
  '\\bNL\\d{9}B\\d{2}\\b',
  '\\bPL\\d{10}\\b',
  '\\bPT\\d{9}\\b',
  '\\bRO\\d{2,10}\\b',
  '\\bSE\\d{12}\\b',
  '\\bSI\\d{8}\\b',
  '\\bSK\\d{10}\\b',
].join('|'), 'gi');

// Dowolny zapis kraju → ISO-2. Zwraca null gdy nie da się rozpoznać.
// "Polska"/"POLSKA"/"Poland"/"PL" → "PL". "Hiszpania"/"Spain"/"ES" → "ES".
function normalizeIso(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  const key = v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return COUNTRY_NAME_TO_ISO[key] || null;
}

// Wariant z fallback — gdy nieznana nazwa, zwraca pierwsze 2 znaki uppercase.
// Używane w glob-quote/glob-helpers gdzie historycznie był taki fallback.
// Dla NOWEGO kodu używaj normalizeIso() (bezpieczniejsze, null gdy nie wiadomo).
function normalizeIsoLoose(value) {
  const strict = normalizeIso(value);
  if (strict) return strict;
  if (!value) return null;
  const v = String(value).trim();
  if (!v) return null;
  return v.toUpperCase().slice(0, 2);
}

// Wyciąga prefiks UE z NIP-u (np. "ES36100525R" → "ES"). Zwraca null
// gdy NIP polski (10 cyfr) lub nie pasuje do schematu UE. EL → GR.
function nipPrefixToCountry(nip) {
  if (!nip) return null;
  const clean = String(nip).replace(/[\s.-]/g, '').toUpperCase();
  const m = clean.match(/^([A-Z]{2})[A-Z0-9]+$/);
  if (!m) return null;
  const prefix = m[1];
  if (prefix === 'EL') return 'GR';
  return EU_VAT_PREFIXES.has(prefix) ? prefix : null;
}

// Próbuje wyciągnąć kraj z sufiksu formy prawnej w nazwie firmy.
function legalFormToCountry(name) {
  if (!name) return null;
  for (const { re, country } of LEGAL_FORM_TO_COUNTRY) {
    if (re.test(name)) return country;
  }
  return null;
}

// ISO-2 → polska nazwa kraju (dla iFirma pole Kraj na fakturze krajowej dla
// ZAGRANICZNEGO kontrahenta — iFirma wymaga nazwy kraju, inaczej waliduje kod
// pocztowy jako polski).
const ISO_TO_PL_NAME = {
  PL: 'Polska', ES: 'Hiszpania', DE: 'Niemcy', FR: 'Francja', IT: 'Włochy',
  NL: 'Holandia', PT: 'Portugalia', BE: 'Belgia', AT: 'Austria', DK: 'Dania',
  SE: 'Szwecja', IE: 'Irlandia', CZ: 'Czechy', SK: 'Słowacja', HU: 'Węgry',
  RO: 'Rumunia', BG: 'Bułgaria', HR: 'Chorwacja', SI: 'Słowenia', LT: 'Litwa',
  LV: 'Łotwa', EE: 'Estonia', FI: 'Finlandia', CY: 'Cypr', MT: 'Malta',
  LU: 'Luksemburg', GR: 'Grecja', NO: 'Norwegia', CH: 'Szwajcaria', GB: 'Wielka Brytania',
};

// Zwraca wartość pola iFirma "Kraj" dla ZAGRANICZNEGO kontrahenta (polska nazwa
// kraju). Dla PL / pustego / nieznanego → 'Polska'. Przyjmuje ISO-2 albo nazwę.
function toIfirmaKraj(country) {
  const c = String(country || '').trim();
  if (!c || /^(pl|polska|poland)$/i.test(c)) return 'Polska';
  const iso = normalizeIso(c) || c.toUpperCase();
  return ISO_TO_PL_NAME[iso] || c;
}

// Rozdziela NIP UE na { prefix, number }. iFirma wymaga OSOBNO prefiksu UE
// (pole PrefiksUE) i samego numeru (pole NIP) — inaczej KSeF odrzuca faktury
// zagraniczne. "ESG75117341" → { prefix:'ES', number:'G75117341' }.
// PL / bez prefiksu → { prefix:null, number:cyfry }.
function splitEuVat(nip) {
  const raw = String(nip || '').replace(/[\s-]/g, '').toUpperCase();
  const m = raw.match(/^([A-Z]{2})([0-9A-Z].*)$/);
  if (m && EU_VAT_PREFIXES.has(m[1])) return { prefix: m[1], number: m[2] };
  if (/^PL\d/.test(raw)) return { prefix: null, number: raw.slice(2) }; // krajowy — bez prefiksu
  return { prefix: null, number: raw };
}

module.exports = {
  EU_VAT_PREFIXES,
  COUNTRY_NAME_TO_ISO,
  ISO_TO_PL_NAME,
  LEGAL_FORM_TO_COUNTRY,
  EU_VAT_REGEX,
  normalizeIso,
  normalizeIsoLoose,
  nipPrefixToCountry,
  legalFormToCountry,
  toIfirmaKraj,
  splitEuVat,
};
