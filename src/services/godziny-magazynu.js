'use strict';

/* GODZINY PRACY MAGAZYNU (22.11.2026).
 *
 * Właściciel: „jak ktoś kliknie »Powiadom magazyn« w weekend albo po 16, to
 * mail wysyła się o 8 rano". Powód: zamówienie #10 złożone w niedzielę o 21:03,
 * mail do magazynu poszedł o 21:05, a kwadrans później zamówienie trzeba było
 * anulować — magazyn miał już w skrzynce PDF zamówienia, którego nie ma.
 *
 * Reguła: magazyn pracuje pn–pt 8:00–16:00 czasu warszawskiego. Kliknięcie
 * w tych godzinach = mail od razu; poza nimi = mail o 8:00 najbliższego dnia
 * roboczego (w dzień roboczy przed 8:00 — tego samego dnia). Świąt nie liczymy:
 * właściciel prosił o weekendy i godziny.
 *
 * Tu są same obliczenia (czyste, bez bazy); plan wysyłki i cykl, który go
 * realizuje, siedzą w routes/magazyn.js. */

const STREFA = 'Europe/Warsaw';
const godzina = (v, domyslna) => { const n = parseInt(v, 10); return Number.isInteger(n) && n >= 0 && n <= 24 ? n : domyslna; };
const OD = () => godzina(process.env.MAGAZYN_GODZINA_OD, 8);
const DO = () => godzina(process.env.MAGAZYN_GODZINA_DO, 16);

const _czesci = new Intl.DateTimeFormat('en-CA', { timeZone: STREFA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
/** Data i godzina „na zegarze w Warszawie" dla chwili `d`. */
function wWarszawie(d) {
  const p = Object.fromEntries(_czesci.formatToParts(d).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  return { rok: p.year, miesiac: p.month, dzien: p.day, godzina: p.hour, minuta: p.minute, sekunda: p.second };
}
/** Chwila (Date), w której zegar w Warszawie pokazuje podaną datę i godzinę. */
function zWarszawy(rok, miesiac, dzien, godz, minuta = 0) {
  const jakUtc = Date.UTC(rok, miesiac - 1, dzien, godz, minuta, 0);
  const w = wWarszawie(new Date(jakUtc));
  const przesuniecie = Date.UTC(w.rok, w.miesiac - 1, w.dzien, w.godzina, w.minuta, w.sekunda) - jakUtc; // +1 h zimą, +2 h latem
  return new Date(jakUtc - przesuniecie);
}
// 0 = niedziela … 6 = sobota, dla daty kalendarzowej (bez strefy).
const dzienTygodnia = (rok, miesiac, dzien) => new Date(Date.UTC(rok, miesiac - 1, dzien)).getUTCDay();
const roboczy = (rok, miesiac, dzien) => { const t = dzienTygodnia(rok, miesiac, dzien); return t >= 1 && t <= 5; };

const W_DZIEN = ['w niedzielę', 'w poniedziałek', 'we wtorek', 'w środę', 'w czwartek', 'w piątek', 'w sobotę'];
const dwie = (n) => String(n).padStart(2, '0');

/** Kiedy wysłać mail do magazynu, gdy „Powiadom magazyn" kliknięto w chwili `teraz`.
 *  W godzinach pracy: { odRazu: true }.
 *  Poza nimi: { odRazu: false, kiedy: Date, opis: 'w poniedziałek 23.11 o 8:00', powod }. */
function kiedyPowiadomic(teraz = new Date()) {
  const od = OD();
  const dok = DO();
  const t = wWarszawie(teraz);
  const dzisRoboczy = roboczy(t.rok, t.miesiac, t.dzien);
  if (dzisRoboczy && t.godzina >= od && t.godzina < dok) return { odRazu: true };

  // Dziś przed otwarciem → dziś; inaczej szukamy od jutra. Najwyżej tydzień.
  let przesun = dzisRoboczy && t.godzina < od ? 0 : 1;
  let dzien = null;
  for (; przesun <= 8; przesun++) {
    const d = new Date(Date.UTC(t.rok, t.miesiac - 1, t.dzien + przesun));
    const k = { rok: d.getUTCFullYear(), miesiac: d.getUTCMonth() + 1, dzien: d.getUTCDate() };
    if (roboczy(k.rok, k.miesiac, k.dzien)) { dzien = k; break; }
  }
  const kiedy = zWarszawy(dzien.rok, dzien.miesiac, dzien.dzien, od, 0);
  const kiedyDzien = przesun === 0 ? 'dziś' : `${przesun === 1 ? 'jutro, ' : ''}${W_DZIEN[dzienTygodnia(dzien.rok, dzien.miesiac, dzien.dzien)]} ${dwie(dzien.dzien)}.${dwie(dzien.miesiac)}`;
  const powod = !dzisRoboczy ? 'weekend' : (t.godzina < od ? `przed ${od}:00` : `po ${dok}:00`);
  return { odRazu: false, kiedy, opis: `${kiedyDzien} o ${od}:00`, powod };
}

/** „pon. 23.11, 8:00" — krótki zapis terminu dla komunikatów. */
function opisTerminu(kiedy) {
  const t = wWarszawie(new Date(kiedy));
  return `${W_DZIEN[dzienTygodnia(t.rok, t.miesiac, t.dzien)]} ${dwie(t.dzien)}.${dwie(t.miesiac)} o ${t.godzina}:${dwie(t.minuta)}`;
}

module.exports = { kiedyPowiadomic, opisTerminu, wWarszawie, zWarszawy, OD, DO };
