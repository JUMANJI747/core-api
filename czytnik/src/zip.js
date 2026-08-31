'use strict';
/**
 * zip.js — minimalny zapis archiwum ZIP (metoda „store", bez kompresji).
 *
 * Potrzebny do jednego: oddać komplet kart jednym pobraniem, ale z osobnym
 * PDF-em na każdy miesiąc. PDF jest już skompresowany wewnętrznie (strumienie
 * FlateDecode), więc deflate na wierzchu dołożyłby ułamek procenta i zależność
 * od kolejnej biblioteki — a Czytnik ma docelowo stać jako osobny, chudy serwis.
 * Format ZIP w wariancie „store" to trzy nagłówki i CRC-32; tyle tu jest.
 *
 * Ograniczenia (świadome): bez ZIP64, więc archiwum do 4 GB i do 65 535 plików;
 * nazwy zapisujemy w UTF-8 (flaga 0x0800).
 */

const TABELA = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ TABELA[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}

/** czas w formacie MS-DOS (2-sekundowa rozdzielczość, rok od 1980) */
function czasDos(d) {
  const czas = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const data = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { czas, data };
}

/**
 * @param {Array<{nazwa: string, dane: Buffer}>} pliki
 * @param {Date} [kiedy] znacznik czasu wpisywany do archiwum
 * @returns {Buffer}
 */
function spakuj(pliki, kiedy = new Date()) {
  const { czas, data } = czasDos(kiedy);
  const czesci = [], katalog = [];
  let offset = 0;

  for (const p of pliki) {
    const nazwa = Buffer.from(p.nazwa, 'utf8');
    const dane = Buffer.isBuffer(p.dane) ? p.dane : Buffer.from(p.dane);
    const crc = crc32(dane);

    const lokalny = Buffer.alloc(30);
    lokalny.writeUInt32LE(0x04034b50, 0);   // sygnatura nagłówka lokalnego
    lokalny.writeUInt16LE(20, 4);           // wersja potrzebna do rozpakowania
    lokalny.writeUInt16LE(0x0800, 6);       // flagi: nazwy w UTF-8
    lokalny.writeUInt16LE(0, 8);            // metoda: bez kompresji
    lokalny.writeUInt16LE(czas, 10);
    lokalny.writeUInt16LE(data, 12);
    lokalny.writeUInt32LE(crc, 14);
    lokalny.writeUInt32LE(dane.length, 18);
    lokalny.writeUInt32LE(dane.length, 22);
    lokalny.writeUInt16LE(nazwa.length, 26);
    lokalny.writeUInt16LE(0, 28);           // brak pola „extra"
    czesci.push(lokalny, nazwa, dane);

    const wpis = Buffer.alloc(46);
    wpis.writeUInt32LE(0x02014b50, 0);      // sygnatura wpisu katalogu centralnego
    wpis.writeUInt16LE(20, 4);              // wersja twórcy
    wpis.writeUInt16LE(20, 6);
    wpis.writeUInt16LE(0x0800, 8);
    wpis.writeUInt16LE(0, 10);
    wpis.writeUInt16LE(czas, 12);
    wpis.writeUInt16LE(data, 14);
    wpis.writeUInt32LE(crc, 16);
    wpis.writeUInt32LE(dane.length, 20);
    wpis.writeUInt32LE(dane.length, 24);
    wpis.writeUInt16LE(nazwa.length, 28);
    wpis.writeUInt32LE(0, 30);              // extra + komentarz + numer dysku
    wpis.writeUInt32LE(0, 34);              // atrybuty wewnętrzne i zewnętrzne
    wpis.writeUInt32LE(0, 38);
    wpis.writeUInt32LE(offset, 42);         // gdzie leży nagłówek lokalny
    katalog.push(wpis, nazwa);

    offset += lokalny.length + nazwa.length + dane.length;
  }

  const cd = Buffer.concat(katalog);
  const koniec = Buffer.alloc(22);
  koniec.writeUInt32LE(0x06054b50, 0);      // sygnatura końca katalogu
  koniec.writeUInt16LE(pliki.length, 8);
  koniec.writeUInt16LE(pliki.length, 10);
  koniec.writeUInt32LE(cd.length, 12);
  koniec.writeUInt32LE(offset, 16);
  return Buffer.concat([...czesci, cd, koniec]);
}

module.exports = { spakuj, crc32 };
