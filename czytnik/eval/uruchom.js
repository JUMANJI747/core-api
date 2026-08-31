'use strict';
/**
 * eval/uruchom.js — ewaluacja reguł walidacji NA ZAPISANYCH ODCZYTACH, bez API.
 *
 * PO CO TO JEST:
 *   Dopracowanie reguł (przerwy, stawki nieobecności, bramka auto) kosztowało
 *   ~$100, bo po każdej zmianie czytaliśmy te same karty modelem od nowa — 13
 *   przebiegów, ~380 stron. A zmieniała się WYŁĄCZNIE walidacja, nie odczyt.
 *   Ten runner przepuszcza zapisane surowe odczyty przez aktualną walidację
 *   i porównuje z wzorcami. Kosztuje ZERO. Model wołamy dopiero wtedy, gdy
 *   zmieniamy sposób czytania obrazów (prompty, cięcie, model).
 *
 * UŻYCIE:
 *   npm run eval                 — cały korpus
 *   npm run eval -- czerwiec     — tylko wskazany okres
 *   npm run eval -- --szczegoly  — dopisz rozbicie każdej niezgodnej karty
 *
 * DANE:
 *   korpus/surowe/<okres>-<obiekt>-<strona>.json   surowy odczyt (zapiszSurowe)
 *   korpus/wzorce/<okres>.json                     wartości potwierdzone przez człowieka
 *                                                  { "wpisy": { "Nazwisko": {C, G, uwaga} } }
 */

const fs = require('fs');
const path = require('path');
const { zszyjIKontroluj } = require('../src/walidacja');

const KORPUS = path.join(__dirname, '..', 'korpus');
const SUROWE = path.join(KORPUS, 'surowe');
const WZORCE = path.join(KORPUS, 'wzorce');

const args = process.argv.slice(2);
const szczegoly = args.includes('--szczegoly');
const filtrOkres = args.find(a => !a.startsWith('--')) || null;

function wczytajWzorce() {
  const w = {};
  if (!fs.existsSync(WZORCE)) return w;
  for (const f of fs.readdirSync(WZORCE).filter(x => x.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(WZORCE, f), 'utf8'));
    w[j.okres || path.basename(f, '.json')] = j.wpisy || {};
  }
  return w;
}

/** normalizacja nazwiska taka sama jak w walidacji (kolejność słów bez znaczenia) */
const klucz = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/Ł/g, 'L').replace(/[^A-Z ]+/g, ' ')
  .trim().split(/\s+/).filter(Boolean).sort().join(' ');

function main() {
  if (!fs.existsSync(SUROWE)) {
    console.error(`Brak katalogu ${SUROWE}.\n` +
      'Zapisz surowe odczyty, wolajac /czytnik/odczytaj z {"zapiszSurowe": true}\n' +
      'i zrzucajac pole "surowe" kazdej karty do korpus/surowe/.');
    process.exit(1);
  }
  const wzorce = wczytajWzorce();
  const pliki = fs.readdirSync(SUROWE).filter(f => f.endsWith('.json'))
    .filter(f => !filtrOkres || f.includes(filtrOkres));
  if (!pliki.length) { console.error('Brak zapisanych odczytow' + (filtrOkres ? ` dla "${filtrOkres}"` : '')); process.exit(1); }

  const wyniki = [];
  for (const f of pliki.sort()) {
    const z = JSON.parse(fs.readFileSync(path.join(SUROWE, f), 'utf8'));
    const okres = z.okres || {};
    const w = zszyjIKontroluj(z.glowny, z.nazwisko, okres, z.strona ?? null, z.slepaKolumna);
    const etykieta = z.etykieta || f.replace('.json', '');
    const wzorzecOkresu = wzorce[z.okresNazwa || (okres.rok && okres.miesiac
      ? `${okres.rok}-${String(okres.miesiac).padStart(2, '0')}` : '')] || {};
    const wz = Object.entries(wzorzecOkresu)
      .find(([n]) => klucz(n) === klucz(w.nazwisko))?.[1] || null;
    wyniki.push({ etykieta, w, wz, niepelna: !!z.niepelnaRekonstrukcja });
  }

  /* ---------------------------------------------------------------- raport */
  const auto = wyniki.filter(x => x.w.status === 'auto');
  const niepelne = wyniki.filter(x => x.niepelna);
  const zWzorcem = wyniki.filter(x => x.wz && x.wz.C !== undefined && x.wz.C !== null && !x.niepelna);
  const trafione = zWzorcem.filter(x => Math.abs((x.w.C ?? NaN) - x.wz.C) < 0.011);
  const bledneAuto = zWzorcem.filter(x => x.w.status === 'auto' && Math.abs((x.w.C ?? NaN) - x.wz.C) >= 0.011);
  const wstrzymaneDobre = zWzorcem.filter(x => x.w.status !== 'auto' && Math.abs((x.w.C ?? NaN) - x.wz.C) < 0.011);
  const bezC = wyniki.filter(x => x.w.C === null || x.w.C === undefined);

  const p = (etykieta, wartosc, ile) =>
    console.log(`  ${etykieta.padEnd(42)} ${String(wartosc).padStart(5)}` +
      (ile ? `  ${(100 * wartosc / ile).toFixed(0)}%` : ''));

  console.log(`\nEWALUACJA NA ZAPISANYCH ODCZYTACH  (${wyniki.length} kart, 0 wywolan API)`);
  console.log('-'.repeat(62));
  p('kart automatycznych', auto.length, wyniki.length);
  p('kart bez wyniku (okladki, nieczytelne)', bezC.length, wyniki.length);
  if (niepelne.length) {
    p('kart z niepelna rekonstrukcja (ptaszki)', niepelne.length, wyniki.length);
  }
  if (zWzorcem.length) {
    console.log(`\n  wzgledem wzorcow (${zWzorcem.length} kart z potwierdzona wartoscia):`);
    p('trafiona wartosc C', trafione.length, zWzorcem.length);
    p('BLEDNE AUTO (wpuszczone ze zla liczba)', bledneAuto.length, zWzorcem.length);
    p('wstrzymane, choc wartosc dobra', wstrzymaneDobre.length, zWzorcem.length);
  } else {
    console.log('\n  brak wzorcow do porownania - dodaj korpus/wzorce/<okres>.json');
  }

  if (bledneAuto.length) {
    console.log('\nBLEDNE AUTO - to jest blad krytyczny:');
    for (const x of bledneAuto) {
      console.log(`  ${x.etykieta}  ${x.w.nazwisko}: system ${x.w.C}, wzorzec ${x.wz.C}`);
    }
  }

  const rozne = zWzorcem.filter(x => Math.abs((x.w.C ?? NaN) - x.wz.C) >= 0.011);
  if (rozne.length) {
    console.log(`\nROZNICE wobec wzorca (${rozne.length}):`);
    for (const x of rozne) {
      console.log(`  ${x.etykieta.padEnd(26)} ${String(x.w.nazwisko).padEnd(24)}` +
        ` system ${String(x.w.C).padStart(7)}  wzorzec ${String(x.wz.C).padStart(7)}` +
        `  [${x.w.status}]`);
      if (szczegoly) {
        console.log(`      dni ${x.w.sumaDni} + 100% ${x.w.sto} + UW ${x.w.uw} + chor ${x.w.chor}` +
          ` | sciezki: ${(x.w.sciezki?.zgodne || []).join(',') || '-'}`);
        for (const s of (x.w.sporne || []).slice(0, 4)) {
          console.log(`      ? dz.${s.dzien}/${s.pole}: ${String(s.uwaga || '').slice(0, 88)}`);
        }
      }
    }
  }
  if (niepelne.length) {
    console.log(`\nNIEPELNA REKONSTRUKCJA (${niepelne.length}) - odtworzone ze starych wynikow,`);
    console.log('bez oznaczen dziennych w UW/Chor. Wymagaja jednorazowego odczytu z zapiszSurowe:');
    for (const x of niepelne.slice(0, 12)) console.log(`  ${x.etykieta}  ${x.w.nazwisko || ''}`);
    if (niepelne.length > 12) console.log(`  ... i ${niepelne.length - 12} wiecej`);
  }
  console.log();
  // kod wyjscia: blad krytyczny = 1, zeby dalo sie wpiac w CI
  process.exit(bledneAuto.length ? 1 : 0);
}

main();
