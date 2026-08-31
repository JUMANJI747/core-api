'use strict';
/**
 * eval/z-wynikow.js — bootstrap korpusu ewaluacyjnego z JUŻ WYKONANYCH przebiegów.
 *
 * Odtwarza strukturę surowego odczytu z zapisanych wyników (korpus/wyniki-*),
 * żeby `npm run eval` działał od razu, bez ponownego czytania kart modelem.
 * Rekonstrukcja jest wierna dla wszystkiego, czego używa walidacja (godziny,
 * kolumny, kody, wiersz SUMA); traci jedynie oryginalne formy zapisu typu "8/2"
 * — tam wstawiamy wartość już zsumowaną. Kolejne przebiegi zapisują surowe
 * odczyty wprost (opcja zapiszSurowe), więc ta rekonstrukcja jest jednorazowa.
 *
 * Użycie: node eval/z-wynikow.js <katalog-z-wynikami> [okresNazwa]
 */
const fs = require('fs');
const path = require('path');

const [, , zrodlo, okresArg] = process.argv;
if (!zrodlo) { console.error('uzycie: node eval/z-wynikow.js <katalog> [okres]'); process.exit(1); }
const CEL = path.join(__dirname, '..', 'korpus', 'surowe');
fs.mkdirSync(CEL, { recursive: true });

const s = v => (v === null || v === undefined) ? '' : String(v);
let zapisane = 0, pominiete = 0;

for (const f of fs.readdirSync(zrodlo).filter(x => x.startsWith('nowy-') && x.endsWith('.json'))) {
  const j = JSON.parse(fs.readFileSync(path.join(zrodlo, f), 'utf8'));
  for (const k of j.karty || []) {
    if (!Array.isArray(k.dni) || !k.dni.length) { pominiete++; continue; }
    const glowny = {
      naglowek: { nazwisko: s(k.nazwisko || (k.nazwiskaOdczytane || [])[0]),
        miesiac: s(k.miesiac), rok: k.rokDomyslny ? '' : s(k.rok), norma: s(k.normaZKarty) },
      dni: k.dni.map(d => ({
        d: d.d,
        zapis: { od: s(d.od), do: s(d.do), razem: s(d.razemZapis ?? d.razemWpisane ?? d.razem),
          sto: s(d.sto), nocne: s(d.nocne), uw: s(d.uw), chor: s(d.chor), kod: s(d.kod), notatka: '' },
        wniosek: { razem: s(d.razemWpisane ?? d.razem), sto: s(d.sto), nocne: s(d.nocne),
          uw: s(d.uw), chor: s(d.chor), kod: s(d.kod) },
        pewnosc: d.pewnosc || 'wysoka', uwaga: s(d.uwaga),
      })),
      suma: { zapis: { razem: s(k.wierszSuma), sto: '', nocne: '', uw: '', chor: '' },
        wniosek: { razem: s(k.wierszSuma), sto: '', nocne: '', uw: '', chor: '' },
        pewnosc: 'wysoka', uwaga: '' },
      rozbieznosci: k.rozbieznosci || [],
    };
    const okresNazwa = okresArg || (k.rok && k.miesiac ? `${k.rok}-${String(k.miesiac).padStart(2, '0')}` : 'nieznany');
    const obiekt = f.includes('stajnia') ? 'stajnia' : (f.includes('hotel') ? 'hotel' : 'inne');
    const nazwa = `${okresNazwa}-${obiekt}-${String(k.strona).padStart(2, '0')}.json`;
    fs.writeFileSync(path.join(CEL, nazwa), JSON.stringify({
      etykieta: `${okresNazwa} ${obiekt} s.${k.strona}`,
      okresNazwa, strona: k.strona,
      okres: { rok: k.rok, miesiac: k.miesiac,
        nazwiska: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'korpus', 'pracownicy.json'), 'utf8')).lista,
        stawkiDnia: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'korpus', 'pracownicy.json'), 'utf8')).stawkiDnia || {},
        domyslnaStawkaDnia: 8 },
      glowny,
      nazwisko: { zapis: s((k.nazwiskaOdczytane || [])[1] || k.nazwisko), pewnosc: 'wysoka' },
      slepaKolumna: { dni: k.dni.map(d => ({ d: String(d.d), razem: s(d.razemWpisane ?? d.razem) })),
        suma: s(k.wierszSuma) },
      zrekonstruowane: true,
      // Ptaszek w rubryce UW/Chor. zapisuje sie w wyniku jako null (nie liczba),
      // wiec z samego wyniku nie da sie odtworzyc, KTORE dni byly oznaczone.
      // Taka karta wymaga jednorazowego ponownego odczytu z zapiszSurowe.
      niepelnaRekonstrukcja: ((k.uw || 0) > 0 && !k.dni.some(d => d.uw))
        || ((k.chor || 0) > 0 && !k.dni.some(d => d.chor)),
    }, null, 1), 'utf8');
    zapisane++;
  }
}
console.log(`zapisano ${zapisane} odczytow do ${CEL}` + (pominiete ? ` (pominieto ${pominiete} bez dni)` : ''));
