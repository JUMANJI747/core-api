'use strict';

/* WYMÓG DEKLARACJI CELNEJ (27.11.2026). #12 do Szwajcarii poszło bez deklaracji
 * (sekcja `customs` w zleceniu GK) → GK: „Przesyłka została nadana bez deklaracji
 * celnej wymaganej na tej trasie, co może opóźnić odprawę". Złożonego zlecenia nie
 * da się już uzupełnić — ani API, ani panel GK (tam jest tylko podgląd); zostaje mail
 * do GK. Właściciel: zapisać to jako wymóg, który wolno złamać tylko na jego
 * wyraźne życzenie.
 *
 * Deklaracja jest potrzebna, gdy paczka przekracza granicę obszaru celno-podatkowego
 * UE: kraj spoza UE albo terytorium kraju UE leżące poza tym obszarem. GK nie ma dla
 * tych terytoriów osobnych krajów (Wyspy Kanaryjskie to ES), więc rozpoznajemy je
 * po kodzie pocztowym. */

const UE = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'EL', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'MC', // Monako — w obszarze celnym i VAT UE (przez Francję)
]);

const TERYTORIA = [
  { iso: 'ES', kod: /^(35|38)\d{3}$/, nazwa: 'Wyspy Kanaryjskie' },
  { iso: 'ES', kod: /^(51|52)\d{3}$/, nazwa: 'Ceuta / Melilla' },
  { iso: 'FR', kod: /^(97\d|98[6-8])\d{2}$/, nazwa: 'terytoria zamorskie Francji' },
  { iso: 'FI', kod: /^22\d{3}$/, nazwa: 'Wyspy Alandzkie' },
  { iso: 'DE', kod: /^(27498|78266)$/, nazwa: 'Helgoland / Büsingen' },
  { iso: 'IT', kod: /^(23041|22061)$/, nazwa: "Livigno / Campione d'Italia" },
];

/** Obszar celny adresu: 'UE', ISO kraju spoza UE albo np. 'ES: Wyspy Kanaryjskie';
 *  null, gdy kraju nie podano. */
function obszarCelny(iso, kodPocztowy) {
  const kraj = String(iso || '').trim().toUpperCase();
  if (!kraj) return null;
  const kod = String(kodPocztowy || '').replace(/[\s-]/g, '');
  const t = TERYTORIA.find((x) => x.iso === kraj && x.kod.test(kod));
  if (t) return `${kraj}: ${t.nazwa}`;
  return UE.has(kraj) ? 'UE' : kraj;
}

/** Czy zlecenie wymaga deklaracji celnej. null = nie wymaga; inaczej
 *  { powod, nieznany } (nieznany = nie wiadomo, dokąd jedzie paczka).
 *  Nadawca bez kraju = Polska (nadajemy z Polski). */
function wymogDeklaracji(nadawca, odbiorca) {
  const skad = obszarCelny(nadawca && nadawca.iso, nadawca && nadawca.kod) || 'UE';
  const dokad = obszarCelny(odbiorca && odbiorca.iso, odbiorca && odbiorca.kod);
  if (!dokad) return { nieznany: true, powod: 'nie wiadomo, do jakiego kraju jedzie paczka' };
  if (skad === dokad) return null;
  return { nieznany: false, powod: `${dokad !== 'UE' ? dokad : skad} — poza obszarem celnym UE` };
}

/** Czy body zlecenia GK ma deklarację (sekcja customs z pozycjami towaru). */
function maDeklaracje(customs) {
  return !!(customs && typeof customs === 'object' && Array.isArray(customs.commodities) && customs.commodities.length);
}

module.exports = { UE, TERYTORIA, obszarCelny, wymogDeklaracji, maDeklaracje };
