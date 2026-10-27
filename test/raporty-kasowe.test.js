'use strict';

/* Raporty kasowe (26.10.2026, przeniesione z n8n „Raporty kasowe → Google
 * Sheets"): odczyt, kontrole spójności, weryfikacja, arbitraż, duplikaty,
 * nowy miesiąc, cykl skrzynki i kopia. Claude, arkusz, poczta i baza
 * podstawione — zero sieci. */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const telegram = [];
const sciezkaStraznika = require.resolve(path.join(SRC, 'services', 'straznik.js'));
require.cache[sciezkaStraznika] = { id: sciezkaStraznika, filename: sciezkaStraznika, loaded: true, exports: { alert: async (t) => { telegram.push(t); return true; } } };

const rk = require(path.join(SRC, 'services', 'raporty-kasowe'));
const cyk = require(path.join(SRC, 'services', 'raporty-kasowe-cykl'));

const BAR = { typ: 'bar', data: '05/10/2026', gotowka: 1200.5, netto: 8000, brutto: 9200, rabaty: 50, goscie: 120, sr_brutto: 76.67, sr_netto: 66.67, obrot: 9200, karta: 7999.5, rachunki: 80 };
const WIERSZ_BAR = [[1200.5, 8000, 9200, 50, 120, 76.67, 66.67]];

test('odczyt BAR: zakładka i wiersz z daty, kolumny F–L, opis z kwotami', () => {
  const w = rk.ocenOdczyt('Oto wynik:\n```json\n' + JSON.stringify(BAR) + '\n```');
  assert.equal(w.ok, true);
  assert.equal(w.sheet, 'PAŹDZIERNIK 2026');
  assert.equal(w.row, 8);
  assert.equal(w.range, "'PAŹDZIERNIK 2026'!F8:L8");
  assert.deepEqual(w.values, WIERSZ_BAR);
  assert.match(w.opis, /Gotówka: 1200,50 zł \(kol\. F\)/, 'format pl-PL jak w n8n (4 cyfry bez spacji)');
});

test('odczyt: niespójny BAR → arbitraż; RECEPCJA → C:D; nieznany → pominięcie bez arbitrażu; śmieci → arbitraż; zła data', () => {
  const zly = rk.ocenOdczyt(JSON.stringify({ ...BAR, brutto: 7000 }));
  assert.equal(zly.ok, false); assert.equal(zly.arbitraz, true); assert.match(zly.opis, /brutto nie większe od netto/);
  const sumy = rk.ocenOdczyt(JSON.stringify({ ...BAR, karta: 100 }));
  assert.equal(sumy.arbitraz, true); assert.match(sumy.opis, /nie sumuje się do obrotu/);
  const rec = rk.ocenOdczyt(JSON.stringify({ typ: 'recepcja', data: '31/10/2026', gotowka: 0, netto: 15000 }));
  assert.equal(rec.ok, true); assert.equal(rec.range, "'PAŹDZIERNIK 2026'!C34:D34"); assert.deepEqual(rec.values, [[0, 15000]]);
  const nie = rk.ocenOdczyt('{"typ":"nieznany"}');
  assert.equal(nie.ok, false); assert.ok(!nie.arbitraz); assert.match(nie.temat, /nierozpoznany załącznik/);
  const smieci = rk.ocenOdczyt('Nie mogę odczytać tego dokumentu.');
  assert.equal(smieci.ok, false); assert.equal(smieci.arbitraz, true);
  assert.match(rk.ocenOdczyt('{"typ":"bar","data":"45/13/2026"}').temat, /błędna data/);
});

test('arbitraż: ostatni JSON po analizie; niepewny → powód; wynik niespójny → odrzucony', () => {
  const ok = rk.ocenArbitraz(`Widzę Obr.BRUTTO 9200, goście 120 → 76,67 zł.\n{"pewny": true, "dane": ${JSON.stringify({ ...BAR, data: '06/10/2026' })}}`);
  assert.equal(ok.ok, true); assert.equal(ok.range, "'PAŹDZIERNIK 2026'!F9:L9"); assert.match(ok.temat, /rozstrzygnięty przez arbitraż/);
  assert.deepEqual(rk.ocenArbitraz('analiza... {"pewny": false, "powod": "skan nieczytelny"}'), { ok: false, powod: 'skan nieczytelny' });
  assert.match(rk.ocenArbitraz(`{"pewny": true, "dane": ${JSON.stringify({ ...BAR, sr_brutto: 10, sr_netto: 20 })}}`).powod, /kontroli spójności/);
  assert.match(rk.ocenArbitraz('bez json').powod, /Nie udało się sparsować/);
});

test('nowy miesiąc liczony po czasie polskim: 31.10 → LISTOPAD; 30.10 → nic; sylwester → STYCZEŃ następnego roku', () => {
  assert.deepEqual(rk.nowyMiesiac(new Date('2026-10-31T03:00:00Z')), { nowa: 'LISTOPAD 2026', zrodlo: 'PAŹDZIERNIK 2026' });
  assert.equal(rk.nowyMiesiac(new Date('2026-10-30T10:00:00Z')), null);
  assert.deepEqual(rk.nowyMiesiac(new Date('2026-12-31T05:00:00Z')), { nowa: 'STYCZEŃ 2027', zrodlo: 'GRUDZIEŃ 2026' });
  assert.equal(rk.nowyMiesiac(new Date('2026-10-31T23:30:00Z')), null, 'w Polsce to już 1.11 — jutro 2-gi');
});

test('kwoty w arkuszu: te same (liczby albo tekst z przecinkiem) vs inne; pusty wiersz', () => {
  assert.equal(rk.teSameKwoty(WIERSZ_BAR, WIERSZ_BAR), true);
  assert.equal(rk.teSameKwoty([['1200,50', '8000', 9200, 50, 120, 76.67, 66.67]], WIERSZ_BAR), true);
  assert.equal(rk.teSameKwoty([[1200.5, 8001, 9200, 50, 120, 76.67, 66.67]], WIERSZ_BAR), false);
  assert.equal(rk.czyWpisane([]), false); assert.equal(rk.czyWpisane([['', null]]), false); assert.equal(rk.czyWpisane([[0]]), true);
});

// ── przepływ jednego załącznika ─────────────────────────────────────────────
function srodowisko({ arkusz = {}, odczyt = BAR, weryfikacja = { zgodne: true }, arbitraz = null, poprawa = { pages: ['UE5H'] } } = {}) {
  const wolania = []; const zapisy = []; const maile = [];
  const deps = {
    claude: async (payload) => {
      const tekst = payload.messages[0].content.find(c => c.type === 'text').text;
      wolania.push({ model: payload.model, tekst, obrazy: payload.messages[0].content.filter(c => c.type !== 'text') });
      if (tekst.startsWith('Dostajesz PDF')) return { content: [{ type: 'text', text: typeof odczyt === 'string' ? odczyt : JSON.stringify(odczyt) }] };
      if (tekst.startsWith('Otrzymujesz dokument')) return { content: [{ type: 'text', text: JSON.stringify(weryfikacja) }] };
      if (tekst.startsWith('Jesteś arbitrem')) return { content: [{ type: 'text', text: arbitraz }] };
      throw new Error('nieznany prompt');
    },
    popraw: async () => { if (poprawa instanceof Error) throw poprawa; return poprawa; },
    arkusz: { pobierz: async (r) => arkusz[r] || [], zapisz: async (r, v) => { zapisy.push({ r, v }); arkusz[r] = v; } },
    wyslij: async (m) => { maile.push(m); },
    ustawienia: { potwierdzenia: ['wlasciciel@example.com', 'recepcja@example.com'], alerty: ['wlasciciel@example.com'] },
  };
  return { deps, wolania, zapisy, maile };
}
const pdf = { filename: 'raport-bar.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 raport'), size: 9000 };

test('przepływ: odczyt → weryfikacja zgodna → zapis → potwierdzenie z oryginałem; poprawiony skan idzie do modelu', async () => {
  const s = srodowisko();
  const w = await rk.przetworzZalacznik(pdf, s.deps);
  assert.equal(w.status, 'wpisany'); assert.equal(w.etap, 'weryfikacja');
  assert.deepEqual(s.zapisy, [{ r: "'PAŹDZIERNIK 2026'!F8:L8", v: WIERSZ_BAR }]);
  assert.deepEqual(s.wolania.map(x => x.model), ['claude-sonnet-5-5', 'claude-sonnet-5-5']);
  assert.equal(s.wolania[0].obrazy[0].source.data, 'UE5H', 'model czyta poprawiony skan');
  assert.ok(s.wolania[1].tekst.includes('"gotowka":1200.5'), 'weryfikator dostaje odczytane wartości');
  assert.equal(s.maile.length, 1);
  assert.deepEqual(s.maile[0].do, ['wlasciciel@example.com', 'recepcja@example.com']);
  assert.match(s.maile[0].temat, /✅ Raport BAR 05\/10\/2026 wpisany/);
  assert.equal(s.maile[0].zalacznik.filename, 'raport-bar.pdf');
});

test('przepływ: dzień już wpisany — te same kwoty cicho, inne kwoty → alert, bez nadpisania i bez weryfikacji', async () => {
  const takie = srodowisko({ arkusz: { "'PAŹDZIERNIK 2026'!F8:L8": WIERSZ_BAR } });
  assert.equal((await rk.przetworzZalacznik(pdf, takie.deps)).status, 'duplikat');
  assert.equal(takie.maile.length, 0); assert.equal(takie.zapisy.length, 0); assert.equal(takie.wolania.length, 1);
  const inne = srodowisko({ arkusz: { "'PAŹDZIERNIK 2026'!F8:L8": [[1, 2, 3, 4, 5, 6, 7]] } });
  assert.equal((await rk.przetworzZalacznik(pdf, inne.deps)).status, 'duplikat_inne_kwoty');
  assert.equal(inne.zapisy.length, 0);
  assert.match(inne.maile[0].temat, /🚨 Duplikat z INNYMI kwotami — raport BAR 05\/10\/2026/);
  assert.deepEqual(inne.maile[0].do, ['wlasciciel@example.com']);
});

test('przepływ: weryfikacja się nie zgadza → arbitraż mocniejszym modelem → zapis i potwierdzenie arbitrażu', async () => {
  const s = srodowisko({ weryfikacja: { zgodne: false, bledy: 'gotówka to 1250,50' }, arbitraz: `analiza\n{"pewny": true, "dane": ${JSON.stringify({ ...BAR, gotowka: 1250.5, karta: 7949.5 })}}` });
  const w = await rk.przetworzZalacznik(pdf, s.deps);
  assert.equal(w.status, 'wpisany'); assert.equal(w.etap, 'arbitraz');
  assert.deepEqual(s.wolania.map(x => x.model), ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-opus-4-8']);
  assert.ok(s.wolania[2].tekst.includes('Zastrzeżenia weryfikatora: gotówka to 1250,50'));
  assert.equal(s.zapisy[0].v[0][0], 1250.5);
  assert.match(s.maile[0].temat, /rozstrzygnięty przez arbitraż/);
});

test('przepływ: wynik arbitrażu też sprawdzany na duplikat (n8n wpisywał od razu); arbiter niepewny → wstrzymany', async () => {
  const dup = srodowisko({ odczyt: { ...BAR, brutto: 7000 }, arbitraz: `{"pewny": true, "dane": ${JSON.stringify({ ...BAR, data: '06/10/2026' })}}`, arkusz: { "'PAŹDZIERNIK 2026'!F9:L9": [[9, 9, 9, 9, 9, 9, 9]] } });
  const w = await rk.przetworzZalacznik(pdf, dup.deps);
  assert.equal(w.status, 'duplikat_inne_kwoty'); assert.equal(w.etap, 'arbitraz');
  assert.equal(dup.zapisy.length, 0);
  assert.deepEqual(dup.wolania.map(x => x.model), ['claude-sonnet-5-5', 'claude-opus-4-8'], 'niespójny odczyt idzie prosto do arbitrażu');
  const nie = srodowisko({ weryfikacja: { zgodne: false, bledy: 'nieczytelne' }, arbitraz: '{"pewny": false, "powod": "skan rozmazany"}' });
  const w2 = await rk.przetworzZalacznik(pdf, nie.deps);
  assert.equal(w2.status, 'wstrzymany'); assert.equal(nie.zapisy.length, 0);
  assert.match(nie.maile[0].temat, /🚨 Nawet arbitraż nie rozstrzygnął — raport BAR 05\/10\/2026 WSTRZYMANY/);
  assert.match(nie.maile[0].tekst, /Powód arbitra: skan rozmazany/);
});

test('przepływ: HEIC → alert bez modelu; nierozpoznany → alert; awaria poprawy skanu → czytamy oryginał i zgłaszamy', async () => {
  const heic = srodowisko();
  const w = await rk.przetworzZalacznik({ filename: 'IMG_1.HEIC', contentType: 'image/heic', content: Buffer.from('x') }, heic.deps);
  assert.equal(w.status, 'pominiety'); assert.equal(heic.wolania.length, 0); assert.match(heic.maile[0].temat, /HEIC/);
  const nie = srodowisko({ odczyt: { typ: 'nieznany' } });
  assert.equal((await rk.przetworzZalacznik(pdf, nie.deps)).status, 'pominiety');
  assert.match(nie.maile[0].temat, /nierozpoznany załącznik/);
  const awaria = srodowisko({ poprawa: new Error('HTTP 401 — zly token') });
  const w3 = await rk.przetworzZalacznik(pdf, awaria.deps);
  assert.equal(w3.status, 'wpisany');
  assert.match(w3.awariaPoprawy, /raport-bar\.pdf: HTTP 401/);
  assert.equal(awaria.wolania[0].obrazy[0].type, 'document', 'model czyta oryginalny PDF');
});

test('załączniki do odczytu: bez obrazków z treści i drobnych logo; PDF, duże zdjęcie i HEIC tak', () => {
  assert.equal(cyk.doOdczytu({ contentType: 'application/pdf', size: 500 }), true);
  assert.equal(cyk.doOdczytu({ contentType: 'image/jpeg', size: 300000 }), true);
  assert.equal(cyk.doOdczytu({ contentType: 'image/png', size: 300000, related: true, cid: 'logo@x' }), false);
  assert.equal(cyk.doOdczytu({ contentType: 'image/png', size: 4000 }), false);
  assert.equal(cyk.doOdczytu({ contentType: 'image/heic', size: 4000 }), true, 'HEIC przechodzi, żeby wysłać instrukcję');
});

// ── cykl skrzynki i kopia — podstawiona baza ────────────────────────────────
function baza() {
  const config = new Map([[rk.KLUCZ_USTAWIENIA, JSON.stringify({ arkuszId: 'ARK', potwierdzenia: ['w@example.com'], alerty: ['w@example.com'], nadawcy: [] })]]);
  const raporty = new Map(); const kopie = [];
  return {
    _config: config, _raporty: raporty, _kopie: kopie,
    config: {
      findUnique: async ({ where }) => (config.has(where.key) ? { key: where.key, value: config.get(where.key) } : null),
      upsert: async ({ where, update, create }) => { config.set(where.key, (config.has(where.key) ? update : create).value); return {}; },
    },
    raportKasowy: { findUnique: async ({ where }) => raporty.get(where.klucz) || null, create: async ({ data }) => { raporty.set(data.klucz, data); return data; } },
    kopiaArkusza: { create: async ({ data }) => { kopie.push(data); return data; }, deleteMany: async () => ({ count: 0 }) },
  };
}
const stanSkrzynki = (db) => JSON.parse(db._config.get(rk.KLUCZ_STAN) || 'null');
const KONTO = { login: 'bot@example.com', haslo: 'x', imap: { host: 'imap.example.com', port: 993 }, smtp: { host: 'smtp.example.com', port: 465 } };

test('cykl: pierwsze uruchomienie zaczyna od teraz; nowe maile przerobione raz (po restarcie bez dubli); filtr nadawców', async () => {
  const db = baza(); cyk._test.ustawPrisma(db);
  const s = srodowisko();
  const deps = { konto: KONTO, claude: s.deps.claude, popraw: s.deps.popraw, arkusz: s.deps.arkusz, wyslij: s.deps.wyslij };
  let w = await cyk.cykl({ ...deps, pobierzMaile: async () => ({ uidValidity: 7, gora: 100, maile: [] }) });
  assert.equal(w.ok, true);
  assert.deepEqual(stanSkrzynki(db), { uidValidity: 7, lastUid: 100 });
  const maile = [{ uid: 101, messageId: '<a@x>', from: 'bar@hotel.pl', subject: 'raport', attachments: [pdf, { filename: 'logo.png', contentType: 'image/png', size: 3000, content: Buffer.from('x') }] }];
  w = await cyk.cykl({ ...deps, pobierzMaile: async (k, st) => { assert.deepEqual(st, { uidValidity: 7, lastUid: 100 }); return { uidValidity: 7, gora: 101, maile }; } });
  assert.equal(w.zalacznikow, 1, 'logo pominięte');
  assert.deepEqual(w.statusy, { wpisany: 1 });
  assert.deepEqual(stanSkrzynki(db), { uidValidity: 7, lastUid: 101 });
  assert.equal([...db._raporty.values()][0].status, 'wpisany');
  const przed = s.zapisy.length;
  w = await cyk.cykl({ ...deps, pobierzMaile: async () => ({ uidValidity: 7, gora: 101, maile }) });
  assert.equal(w.zalacznikow, 0, 'ten sam załącznik po restarcie — pominięty'); assert.equal(s.zapisy.length, przed);
  db._config.set(rk.KLUCZ_USTAWIENIA, JSON.stringify({ arkuszId: 'ARK', potwierdzenia: [], alerty: [], nadawcy: ['recepcja@hotel.pl'] }));
  w = await cyk.cykl({ ...deps, pobierzMaile: async () => ({ uidValidity: 7, gora: 102, maile: [{ ...maile[0], uid: 102 }] }) });
  assert.equal(w.maili, 0, 'nadawca spoza listy');
  assert.equal(stanSkrzynki(db).lastUid, 102);
});

test('cykl: zaległe od daty — stan z datą, potem znowu po UID; błąd skrzynki 3× z rzędu → jeden alert', async () => {
  const db = baza(); cyk._test.ustawPrisma(db);
  await cyk.przetworzOd('2026-10-24');
  assert.deepEqual(stanSkrzynki(db), { od: '2026-10-24' });
  await assert.rejects(() => cyk.przetworzOd('24.10.2026'), /RRRR-MM-DD/);
  const s = srodowisko();
  const deps = { konto: KONTO, claude: s.deps.claude, popraw: s.deps.popraw, arkusz: s.deps.arkusz, wyslij: s.deps.wyslij };
  await cyk.cykl({ ...deps, pobierzMaile: async (k, st) => { assert.equal(st.od, '2026-10-24'); return { uidValidity: 7, gora: 120, maile: [] }; } });
  assert.deepEqual(stanSkrzynki(db), { uidValidity: 7, lastUid: 120 }, 'brak maili od daty → stan na górę skrzynki, nie na początek');
  telegram.length = 0;
  for (let i = 0; i < 4; i++) await cyk.cykl({ ...deps, pobierzMaile: async () => { throw new Error('Invalid credentials'); } });
  assert.equal(telegram.length, 1);
  assert.match(telegram[0], /Raporty kasowe: skrzynka bota albo arkusz nie działają od 3 cykli/);
});

test('kopia o 4:00: XLSX do bazy; 31.10 nowa zakładka LISTOPAD z kopii PAŹDZIERNIKA i czyszczenie danych; błąd kopii → alert', async () => {
  const db = baza(); cyk._test.ustawPrisma(db);
  const dzialania = []; const maile = [];
  const ark = {
    xlsx: async () => Buffer.from('PK xlsx'),
    zakladki: async () => ({ sheets: [{ properties: { title: 'PAŹDZIERNIK 2026', sheetId: 42 } }] }),
    duplikuj: async (id, nazwa) => dzialania.push(['duplikuj', id, nazwa]),
    wyczysc: async (nazwa) => dzialania.push(['wyczysc', nazwa]),
  };
  const w = await cyk.kopiaIZakladka({ konto: KONTO, arkusz: ark, wyslij: async (m) => maile.push(m), teraz: new Date('2026-10-31T03:05:00Z') });
  assert.equal(db._kopie[0].nazwa, 'BACKUP_RAPORTY_KASOWE_2026-10-31.xlsx');
  assert.deepEqual(dzialania, [['duplikuj', 42, 'LISTOPAD 2026'], ['wyczysc', 'LISTOPAD 2026']]);
  assert.equal(w.zakladka, 'LISTOPAD 2026');
  assert.match(maile[0].temat, /📅 Utworzono zakładkę LISTOPAD 2026/);
  const zle = { ...ark, xlsx: async () => { throw new Error('403 brak dostępu'); } };
  const maile2 = [];
  await cyk.kopiaIZakladka({ konto: KONTO, arkusz: zle, wyslij: async (m) => maile2.push(m), teraz: new Date('2026-10-20T03:05:00Z') });
  assert.match(maile2[0].temat, /❌ Backup arkusza raportów kasowych nie wykonał się/);
  assert.match(maile2[0].tekst, /403 brak dostępu/);
});

test('dane skrzynki: z env, a bez env z Config (ustawiane przez API, bez zmian w Railway)', async () => {
  const db = baza(); cyk._test.ustawPrisma(db);
  const przed = { ...process.env };
  delete process.env.RAPORTY_POCZTA_LOGIN; delete process.env.RAPORTY_POCZTA_HASLO;
  try {
    assert.equal(await cyk.kontoAktywne(), null);
    db._config.set(cyk.KLUCZ_POCZTA, JSON.stringify({ login: 'bot@bell.example', haslo: 'h', imap: 'bell1.example:993', smtp: 'bell1.example:465' }));
    const k = await cyk.kontoAktywne();
    assert.deepEqual(k.imap, { host: 'bell1.example', port: 993 });
    assert.deepEqual(k.smtp, { host: 'bell1.example', port: 465 });
    process.env.RAPORTY_POCZTA_LOGIN = 'env@bell.example'; process.env.RAPORTY_POCZTA_HASLO = 'e';
    assert.equal((await cyk.kontoAktywne()).login, 'env@bell.example', 'env ma pierwszeństwo');
    assert.deepEqual((await cyk.kontoAktywne()).imap, { host: 'imap.bell.example', port: 993 }, 'domyślny host z domeny');
  } finally {
    for (const k of ['RAPORTY_POCZTA_LOGIN', 'RAPORTY_POCZTA_HASLO']) { if (przed[k] === undefined) delete process.env[k]; else process.env[k] = przed[k]; }
  }
});

test('chwilowa awaria (Claude/arkusz) — raport w kolejce: 2 ponowienia bez śladu i bez przesuwania skrzynki, za 3. razem błąd i mail', async () => {
  const db = baza(); cyk._test.ustawPrisma(db); cyk._test.reset();
  db._config.set(rk.KLUCZ_STAN, JSON.stringify({ uidValidity: 7, lastUid: 100 }));
  const s = srodowisko();
  let awaria = true;
  const claude = async (p) => { if (awaria) throw new Error('529 overloaded'); return s.deps.claude(p); };
  const mail = { uid: 101, messageId: '<m@x>', from: 'bar@hotel.pl', subject: 'raport', attachments: [pdf] };
  const deps = { konto: KONTO, claude, popraw: s.deps.popraw, arkusz: s.deps.arkusz, wyslij: s.deps.wyslij, pobierzMaile: async () => ({ uidValidity: 7, gora: 101, maile: [mail] }) };
  for (let i = 1; i <= 2; i++) {
    const w = await cyk.cykl(deps);
    assert.match(w.ponowienie, new RegExp(`529 overloaded — ponowię w następnym cyklu \\(${i}/3\\)`));
    assert.equal(db._raporty.size, 0, 'bez śladu — spróbujemy znowu');
    assert.equal(stanSkrzynki(db).lastUid, 100, 'skrzynka nie przesunięta za ten mail');
  }
  awaria = false;
  const ok = await cyk.cykl(deps);
  assert.deepEqual(ok.statusy, { wpisany: 1 }, 'trzecia próba się udała');
  assert.equal(stanSkrzynki(db).lastUid, 101);
  // Trwała awaria: 3 próby → błąd, mail do właściciela, kolejka idzie dalej.
  cyk._test.reset();
  const db2 = baza(); cyk._test.ustawPrisma(db2);
  db2._config.set(rk.KLUCZ_STAN, JSON.stringify({ uidValidity: 7, lastUid: 100 }));
  awaria = true; s.maile.length = 0;
  for (let i = 0; i < 3; i++) await cyk.cykl(deps);
  assert.equal([...db2._raporty.values()][0].status, 'blad');
  assert.equal(stanSkrzynki(db2).lastUid, 101);
  assert.ok(s.maile.some(m => /❌ Raport kasowy — błąd przetwarzania/.test(m.temat) && /3 próby/.test(m.tekst)));
});

test('arkusz niedostępny (nieudostępniony) → błąd cyklu przed dotknięciem maili; pusta skrzynka nie sprawdza arkusza', async () => {
  const db = baza(); cyk._test.ustawPrisma(db); cyk._test.reset();
  db._config.set(rk.KLUCZ_STAN, JSON.stringify({ uidValidity: 7, lastUid: 100 }));
  const s = srodowisko();
  let sprawdzen = 0;
  const ark = { ...s.deps.arkusz, zakladki: async () => { sprawdzen++; throw new Error('The caller does not have permission'); } };
  const deps = { konto: KONTO, claude: s.deps.claude, popraw: s.deps.popraw, arkusz: ark, wyslij: s.deps.wyslij };
  const w = await cyk.cykl({ ...deps, pobierzMaile: async () => ({ uidValidity: 7, gora: 101, maile: [{ uid: 101, from: 'bar@hotel.pl', subject: 'r', attachments: [pdf] }] }) });
  assert.equal(w.ok, false); assert.match(w.blad, /does not have permission/);
  assert.equal(stanSkrzynki(db).lastUid, 100); assert.equal(db._raporty.size, 0); assert.equal(s.wolania.length, 0);
  await cyk.cykl({ ...deps, pobierzMaile: async () => ({ uidValidity: 7, gora: 101, maile: [] }) });
  assert.equal(sprawdzen, 1, 'bez maili nie pytamy arkusza');
});

test('kopia zapasowa bez Drive: XLSX z danych i formuł wszystkich zakładek (nazwy wg zasad Excela)', async () => {
  const buf = await cyk._test.zbudujXlsx(['PAŹDZIERNIK 2026', 'Zła/nazwa: [x]'], [
    { values: [['', 'Dzień', 'Gotówka'], ['', 1, 395], ['', 'Suma', '=SUM(C2:C2)']] },
    { values: [['a']] },
  ]);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.deepEqual(wb.worksheets.map(w => w.name), ['PAŹDZIERNIK 2026', 'Zła_nazwa_ _x_']);
  const ws = wb.getWorksheet('PAŹDZIERNIK 2026');
  assert.equal(ws.getCell('C2').value, 395);
  assert.deepEqual(ws.getCell('C3').value, { formula: 'SUM(C2:C2)' });
  assert.equal(ws.getCell('A1').value, null, 'puste komórki zostają puste');
});

test('kopia: Drive wyłączone w projekcie Google → kopia danych przez Sheets API bez alarmu; obie drogi padają → alert', async () => {
  const db = baza(); cyk._test.ustawPrisma(db);
  const maile = [];
  const ark = { xlsx: async () => { throw new Error('Google Drive API has not been used in project 1 before or it is disabled'); }, xlsxZArkuszy: async () => Buffer.from('PK dane'), zakladki: async () => ({ sheets: [] }) };
  const w = await cyk.kopiaIZakladka({ konto: KONTO, arkusz: ark, wyslij: async (m) => maile.push(m), teraz: new Date('2026-10-27T05:00:00Z') });
  assert.equal(w.kopia.metoda, 'sheets');
  assert.match(w.kopia.uwaga, /Drive niedostępne/);
  assert.equal(db._kopie[0].nazwa, 'BACKUP_RAPORTY_KASOWE_2026-10-27_dane.xlsx');
  assert.equal(maile.length, 0);
  const zle = { ...ark, xlsxZArkuszy: async () => { throw new Error('Sheets 500'); } };
  await cyk.kopiaIZakladka({ konto: KONTO, arkusz: zle, wyslij: async (m) => maile.push(m), teraz: new Date('2026-10-27T05:00:00Z') });
  assert.match(maile[0].temat, /❌ Backup arkusza raportów kasowych nie wykonał się/);
  assert.match(maile[0].tekst, /Sheets 500/);
});
