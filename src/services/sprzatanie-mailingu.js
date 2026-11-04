'use strict';

/* MAILING BEZ ODPOWIEDZI — SPRZĄTANIE WYSŁANYCH (4.11.2026).
 *
 * Skrzynka Nikodema „prawie pełna": ~4 GB, z czego 3,1 GB to 422 duże maile
 * w Wysłanych (2024: 0,77 GB, 2025: 1,87 GB), w dużej części ten sam
 * załącznik wysyłany w kółko. Właściciel: „usuń z wysłanych nasz mailing
 * z 2024 i 2025 tam, gdzie nikt nie odpisał".
 *
 * MAILING = wysłany mail z okresu, który NIE jest odpowiedzią (bez
 * In-Reply-To, temat bez Re:/AW:/Odp:…), a jego temat poszedł do co najmniej
 * `minOdbiorcow` różnych adresów (kampania, nie pojedyncza korespondencja).
 *
 * NIKT NIE ODPISAŁ = od żadnego odbiorcy nie mamy ani jednego maila. Źródła:
 * wszystkie foldery tej skrzynki poza Wysłanymi i Szkicami (także Kosz
 * i Spam), cała poczta przychodząca w CRM ze wszystkich skrzynek (także
 * odfiltrowana — EmailSkip) oraz adresy kontrahentów. Dla domen firmowych
 * liczy się odpowiedź z tej samej domeny (odpisał ktoś inny z firmy); dla
 * gmail/wp/hotmail… tylko z tego samego adresu. Mail zbiorowy zostaje, jeśli
 * odpisał KTOKOLWIEK z odbiorców. Wszystko, co niepewne, zostaje.
 *
 * Domyślnie PRÓBA (tylko czyta i liczy). Kasowanie wymaga `oczekiwane` =
 * liczba z próby: gdy od próby coś się zmieniło (np. ktoś odpisał), nic nie
 * jest kasowane. Kasowanie po UID (UID EXPUNGE) — reszta folderu nietknięta. */

const libmime = require('libmime');
const { polacz, splaszcz, dostepne } = require('./skrzynka-rozmiar');

const MB = 1024 * 1024;
const mb = (b) => Math.round((b / MB) * 10) / 10;
const p = (fn) => new Promise((resolve, reject) => fn((e, x) => (e ? reject(e) : resolve(x))));

const NASZE_DOMENY = /(^|\.)(surfstickbell\.(com|fr|es|pl|eu)|bell\.com\.pl|abcwork\.pl|palac-galiny\.pl)$/i;
const DARMOWE = /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|mac|aol|gmx|web|t-online|wp|o2|onet|op|interia|poczta|tlen|vp|orange|free|sfr|laposte|wanadoo|neuf|libero|virgilio|alice|tiscali|tim|telefonica|movistar|terra|ono|protonmail|proton|pm|yandex|mail|seznam|zoho|btinternet|sky|bluewin|freenet|arcor|online|telenet|skynet|ziggo|kpnmail|planet|home|hetnet|xs4all|chello|sapo|netcabo|zonnet)$/i;
const ADRES = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const ODPOWIEDZ = /^\s*(re|aw|odp|sv|antw|r|ref|rif|res|wg|fw|fwd|tr)\s*:/i;

const adresy = (tekst) => [...new Set((String(tekst || '').match(ADRES) || []).map(a => a.toLowerCase()))];
const domena = (a) => a.split('@')[1] || '';
function rdzenDomeny(d) {
  const cz = String(d).toLowerCase().split('.');
  if (cz.length >= 3 && /^(co|com|org|net|gov|ac|edu)$/.test(cz[cz.length - 2]) && cz[cz.length - 1].length === 2) return cz.slice(-3).join('.');
  return cz.slice(-2).join('.');
}
/** Domena firmy (do dopasowania „odpisał ktoś z tej firmy") albo null dla poczty darmowej. */
function domenaFirmowa(a) {
  const r = rdzenDomeny(domena(a));
  return r && !DARMOWE.test(r.split('.')[0]) ? r : null;
}
const dekoduj = (s) => { try { return libmime.decodeWords(String(s || '')); } catch (_) { return String(s || ''); } };
const normalizujTemat = (s) => dekoduj(s).toLowerCase().replace(/\s+/g, ' ').trim();

/** Nagłówki z bloku „Nazwa: wartość" (z łamaniem linii) → {nazwa: wartość}. */
function parsujNaglowki(tekst) {
  const wynik = {};
  for (const linia of String(tekst || '').replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = linia.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (m) { const k = m[1].toLowerCase(); wynik[k] = wynik[k] ? `${wynik[k]}, ${m[2]}` : m[2]; }
  }
  return wynik;
}

function naglowki(imap, zakres, { poUid = false, pola }) {
  return new Promise((resolve, reject) => {
    const wynik = [];
    const opcje = { size: true, bodies: `HEADER.FIELDS (${pola})` };
    const f = poUid ? imap.fetch(zakres, opcje) : imap.seq.fetch(zakres, opcje);
    f.on('message', (msg) => {
      const m = { uid: null, size: 0, date: null, h: {} };
      msg.on('body', (strumien) => {
        let buf = '';
        strumien.on('data', (d) => { buf += d.toString('utf8'); });
        strumien.once('end', () => { m.h = parsujNaglowki(buf); });
      });
      msg.once('attributes', (a) => { m.uid = a.uid; m.size = a.size || 0; m.date = a.date || null; });
      msg.once('end', () => wynik.push(m));
    });
    f.once('error', reject);
    f.once('end', () => resolve(wynik));
  });
}

const jestWyslane = (f) => f.atrybuty.includes('\\Sent') || /sent|wys[łl]ane/i.test(f.nazwa);
const jestSzkic = (f) => f.atrybuty.includes('\\Drafts') || /draft|szkic|robocze/i.test(f.nazwa);

/** Kto kiedykolwiek do nas napisał: adresy i domeny firmowe. */
async function ktoPisal(prisma, imap, foldery) {
  const adresySet = new Map();
  const domenySet = new Map();
  // adres / domena firmowa → czas OSTATNIEGO maila od nich (ms; brak daty = +∞,
  // czyli „pisał też po naszym" — przy wątpliwości mail zostaje).
  const ostatni = (mapa, k, t) => { if (k && !((mapa.get(k) || -Infinity) >= t)) mapa.set(k, t); };
  const dodaj = (a, t) => { ostatni(adresySet, a, t); ostatni(domenySet, domenaFirmowa(a), t); };
  const czas = (d) => { const t = d ? new Date(d).getTime() : NaN; return Number.isFinite(t) ? t : Infinity; };
  for (const f of foldery) {
    if (jestWyslane(f) || jestSzkic(f)) continue;
    const box = await p(cb => imap.openBox(f.nazwa, true, cb));
    if (!box.messages.total) continue;
    for (const m of await naglowki(imap, '1:*', { pola: 'FROM REPLY-TO SENDER' })) {
      for (const a of adresy(`${m.h.from || ''} ${m.h['reply-to'] || ''} ${m.h.sender || ''}`)) dodaj(a, czas(m.date));
    }
  }
  const zBazy = await prisma.$queryRawUnsafe(
    `SELECT lower("fromEmail") AS a, max("createdAt") AS t FROM "Email" WHERE direction = 'INBOUND' GROUP BY 1
     UNION ALL SELECT lower("fromEmail"), max("createdAt") FROM "EmailSkip" WHERE "fromEmail" IS NOT NULL GROUP BY 1`);
  for (const r of zBazy) for (const a of adresy(r.a)) dodaj(a, czas(r.t));
  // Kontrahenci z CRM: mail do nich zostaje zawsze (to klienci i znane kontakty).
  const kontrahenci = { adresy: new Set(), domeny: new Set() };
  const zKontrahentow = await prisma.$queryRawUnsafe(
    `SELECT lower(value) AS a FROM "ContractorContact" WHERE type = 'email'
     UNION SELECT lower(email) FROM "Contractor" WHERE email IS NOT NULL
     UNION SELECT lower("primaryEmail") FROM "Contractor" WHERE "primaryEmail" IS NOT NULL`);
  for (const r of zKontrahentow) {
    for (const a of adresy(r.a)) {
      kontrahenci.adresy.add(a);
      const d = domenaFirmowa(a);
      if (d) kontrahenci.domeny.add(d);
    }
  }
  return { adresy: adresySet, domeny: domenySet, kontrahenci };
}

const doKontrahenta = (k, pisali) => Boolean(pisali.kontrahenci) && k.odbiorcy.some(a => pisali.kontrahenci.adresy.has(a) || (domenaFirmowa(a) && pisali.kontrahenci.domeny.has(domenaFirmowa(a))));

/** Tryb „duze": duże maile, po których ŻADEN odbiorca już do nas nie napisał
 *  (np. katalog wysłany na prośbę, potem cisza). Nie ma znaczenia, czy to
 *  odpowiedź w wątku. Zostają: małe, do kontrahentów z CRM, wewnętrzne
 *  i takie, po których ktoś z odbiorców (albo z jego firmy) napisał. */
function wybierzDuze(wyslane, pisali, { minBajtow = MB } = {}) {
  const zostaja = { male: 0, wewnetrzne: 0, bezOdbiorcy: 0, kontrahenci: 0, odpisalPozniej: 0, bezDaty: 0 };
  const zostajaMB = { kontrahenci: 0, odpisalPozniej: 0 };
  const doUsuniecia = [];
  for (const k of wyslane) {
    if (k.size < minBajtow) { zostaja.male++; continue; }
    const wszyscy = adresy(`${k.h.to || ''} ${k.h.cc || ''} ${k.h.bcc || ''}`);
    k.odbiorcy = wszyscy.filter(a => !NASZE_DOMENY.test(domena(a)));
    if (wszyscy.length && !k.odbiorcy.length) { zostaja.wewnetrzne++; continue; }
    if (!k.odbiorcy.length) { zostaja.bezOdbiorcy++; continue; }
    const t = k.date ? new Date(k.date).getTime() : NaN;
    if (!Number.isFinite(t)) { zostaja.bezDaty++; continue; }
    if (doKontrahenta(k, pisali)) { zostaja.kontrahenci++; zostajaMB.kontrahenci += k.size; continue; }
    const pozniej = k.odbiorcy.some(a => (pisali.adresy.get(a) || -Infinity) > t || (domenaFirmowa(a) && (pisali.domeny.get(domenaFirmowa(a)) || -Infinity) > t));
    if (pozniej) { zostaja.odpisalPozniej++; zostajaMB.odpisalPozniej += k.size; continue; }
    doUsuniecia.push(k);
  }
  return { doUsuniecia, zostaja, zostajaMB: { kontrahenci: mb(zostajaMB.kontrahenci), odpisalPozniej: mb(zostajaMB.odpisalPozniej) } };
}

/** Tryb „pierwsze" (4.11.2026, decyzje właściciela): „wystarczy, że usuniesz
 *  pierwszy mail od nas z załącznikiem, a nie cały wątek — wtedy można usunąć
 *  nawet te, na które ktoś odpowiedział, byle wątek został" oraz „mailing ma
 *  zawsze tę samą strukturę albo temat, zmieniają się tylko kraje, i zawsze
 *  był załącznik".
 *
 *  Pierwsza wersja brała tylko maile otwierające rozmowę (bez Re:/Fwd: i bez
 *  In-Reply-To/References). Próba u Nikodema: 23 maile / 152 MB, a 2,4 GB
 *  siedziało w „odpowiedziach" — mailing szedł jako Re:/Fwd: (przekazany
 *  szablon, odpowiedź na zapytanie z katalogiem). Teraz:
 *   - WĄTEK = temat bez przedrostków Re:/Fwd:/AW:… + odbiorca,
 *   - kasujemy PIERWSZY duży (≥ minMB) mail od nas w wątku — także Re:/Fwd:;
 *     kolejne nasze maile w tym wątku zostają (np. faktura w odpowiedzi),
 *   - MAILING = temat (bez przedrostków) wysłany jako pierwszy duży mail do
 *     ≥ minPowtorzen (domyślnie 3) RÓŻNYCH odbiorców; tematy użyte dla 1–2
 *     osób (umowa, zdjęcia dla jednego klienta) zostają i są w raporcie,
 *   - zostają też: małe, wewnętrzne, poczta przychodząca i (domyślnie) maile
 *     do kontrahentów z CRM — faktury i dokumenty; `zKontrahentami` je dołącza. */
const PRZEDROSTKI = /^\s*((re|aw|odp|sv|antw|r|ref|rif|res|wg|fw|fwd|tr|rv|enc|vs)\s*(\[\d+\])?\s*:\s*)+/i;
function rodzajMaila(k) {
  if (/^\s*(wg|fw|fwd|tr|rv|enc)\s*:/i.test(k.tematPelny)) return 'przekazane';
  if (PRZEDROSTKI.test(k.tematPelny) || k.h['in-reply-to'] || k.h.references) return 'odpowiedzi';
  return 'nowe';
}
function wybierzPierwsze(wyslane, pisali, { minBajtow = MB, zKontrahentami = false, minPowtorzen = 3 } = {}) {
  const zostaja = { male: 0, wewnetrzne: 0, bezOdbiorcy: 0, kontrahenci: 0, kolejneWWatku: 0, jednorazowe: 0 };
  const zostajaMB = { kontrahenci: 0, kolejneWWatku: 0, jednorazowe: 0 };
  const duze = [];
  for (const k of wyslane) {
    if (k.size < minBajtow) { zostaja.male++; continue; }
    k.tematPelny = dekoduj(k.h.subject).trim();
    k.klucz = normalizujTemat(k.tematPelny.replace(PRZEDROSTKI, ''));
    const wszyscy = adresy(`${k.h.to || ''} ${k.h.cc || ''} ${k.h.bcc || ''}`);
    k.odbiorcy = wszyscy.filter(a => !NASZE_DOMENY.test(domena(a)));
    if (wszyscy.length && !k.odbiorcy.length) { zostaja.wewnetrzne++; continue; }
    if (!k.odbiorcy.length) { zostaja.bezOdbiorcy++; continue; }
    if (!zKontrahentami && doKontrahenta(k, pisali)) { zostaja.kontrahenci++; zostajaMB.kontrahenci += k.size; continue; }
    const t = k.date ? new Date(k.date).getTime() : NaN;
    k.t = Number.isFinite(t) ? t : Infinity;
    duze.push(k);
  }
  // Pierwszy duży mail od nas w każdym wątku (temat bez przedrostków + odbiorca).
  duze.sort((a, b) => (a.t - b.t) || (a.uid - b.uid));
  const watki = new Set();
  const pierwsze = [];
  for (const k of duze) {
    const klucze = k.odbiorcy.map(a => `${k.klucz}|${a}`);
    const nowyWatek = klucze.some(x => !watki.has(x));
    for (const x of klucze) watki.add(x);
    if (!nowyWatek) { zostaja.kolejneWWatku++; zostajaMB.kolejneWWatku += k.size; continue; }
    pierwsze.push(k);
  }
  // Ilu RÓŻNYM odbiorcom poszedł dany temat jako pierwszy duży mail.
  const odbiorcyTematu = new Map();
  for (const k of pierwsze) {
    if (!odbiorcyTematu.has(k.klucz)) odbiorcyTematu.set(k.klucz, new Set());
    for (const a of k.odbiorcy) odbiorcyTematu.get(k.klucz).add(a);
  }
  const powtarzalne = { n: 0, bajty: 0, tematow: new Set() };
  const jednorazowe = { n: 0, bajty: 0 };
  const rodzaje = { nowe: 0, odpowiedzi: 0, przekazane: 0 };
  const tematy = new Map();
  const doUsuniecia = [];
  let zOdpowiedzia = 0;
  for (const k of pierwsze) {
    const ilu = odbiorcyTematu.get(k.klucz).size;
    if (ilu >= 3) { powtarzalne.n++; powtarzalne.bajty += k.size; powtarzalne.tematow.add(k.klucz); } else { jednorazowe.n++; jednorazowe.bajty += k.size; }
    if (ilu < minPowtorzen) { zostaja.jednorazowe++; zostajaMB.jednorazowe += k.size; continue; }
    rodzaje[rodzajMaila(k)]++;
    if (k.odbiorcy.some(a => pisali.adresy.has(a) || (domenaFirmowa(a) && pisali.domeny.has(domenaFirmowa(a))))) zOdpowiedzia++;
    if (!tematy.has(k.klucz)) tematy.set(k.klucz, { temat: k.tematPelny.replace(PRZEDROSTKI, '').slice(0, 80), n: 0, bajty: 0 });
    const t = tematy.get(k.klucz);
    t.n++;
    t.bajty += k.size;
    doUsuniecia.push(k);
  }
  return {
    doUsuniecia, zostaja, zOdpowiedzia, rodzaje,
    zostajaMB: { kontrahenci: mb(zostajaMB.kontrahenci), kolejneWWatku: mb(zostajaMB.kolejneWWatku), jednorazowe: mb(zostajaMB.jednorazowe) },
    // Podział pierwszych dużych maili (niezależnie od minPowtorzen): mailing vs pojedyncze.
    podzial: {
      powtarzalne: { n: powtarzalne.n, mb: mb(powtarzalne.bajty), tematow: powtarzalne.tematow.size },
      jednorazowe: { n: jednorazowe.n, mb: mb(jednorazowe.bajty) },
    },
    tematy: [...tematy.values()].sort((a, b) => b.bajty - a.bajty).slice(0, 20).map(t => ({ temat: t.temat, n: t.n, mb: mb(t.bajty) })),
  };
}

/** Wybór maili do skasowania (czysta funkcja — testowana osobno). */
function wybierz(wyslane, pisali, { minOdbiorcow = 5 } = {}) {
  const odbiorcyTematu = new Map();
  for (const k of wyslane) {
    const wszyscy = adresy(`${k.h.to || ''} ${k.h.cc || ''} ${k.h.bcc || ''}`);
    k.odbiorcy = wszyscy.filter(a => !NASZE_DOMENY.test(domena(a)));
    k.wewnetrzny = wszyscy.length > 0 && k.odbiorcy.length === 0;
    k.temat = normalizujTemat(k.h.subject);
    k.odpowiedz = Boolean(k.h['in-reply-to']) || ODPOWIEDZ.test(dekoduj(k.h.subject));
    if (!k.odpowiedz && k.temat) {
      if (!odbiorcyTematu.has(k.temat)) odbiorcyTematu.set(k.temat, new Set());
      for (const a of k.odbiorcy) odbiorcyTematu.get(k.temat).add(a);
    }
  }
  const zostaja = { odpowiedzi: 0, wewnetrzne: 0, bezOdbiorcy: 0, pojedyncze: 0, ktosOdpisal: 0 };
  const kampanie = new Map();
  const doUsuniecia = [];
  for (const k of wyslane) {
    if (k.odpowiedz) { zostaja.odpowiedzi++; continue; }
    if (k.wewnetrzny) { zostaja.wewnetrzne++; continue; }
    if (!k.odbiorcy.length) { zostaja.bezOdbiorcy++; continue; }
    if (!k.temat || (odbiorcyTematu.get(k.temat) || new Set()).size < minOdbiorcow) { zostaja.pojedyncze++; continue; }
    if (!kampanie.has(k.temat)) kampanie.set(k.temat, { temat: dekoduj(k.h.subject).trim().slice(0, 90), wyslano: 0, odpisalo: 0, doUsuniecia: 0, bajty: 0 });
    const c = kampanie.get(k.temat);
    c.wyslano++;
    const odpisal = doKontrahenta(k, pisali) || k.odbiorcy.some(a => pisali.adresy.has(a) || (domenaFirmowa(a) && pisali.domeny.has(domenaFirmowa(a))));
    if (odpisal) { zostaja.ktosOdpisal++; c.odpisalo++; continue; }
    c.doUsuniecia++;
    c.bajty += k.size;
    doUsuniecia.push(k);
  }
  return { doUsuniecia, zostaja, kampanie: [...kampanie.values()] };
}

/** Próba albo kasowanie mailingu bez odpowiedzi w Wysłanych jednej skrzynki. */
async function sprzatnijMailing(prisma, account, { tryb = 'mailing', od = '2024-01-01', do: doDnia = '2026-01-01', minOdbiorcow = 5, minMB = 1, zKontrahentami = false, minPowtorzen = 3, proba = true, oczekiwane = null } = {}) {
  if (!['mailing', 'duze', 'pierwsze'].includes(tryb)) throw new Error('tryb: "mailing", "duze" albo "pierwsze"');
  if (!proba && !Number.isInteger(oczekiwane)) throw new Error('kasowanie wymaga `oczekiwane` = liczby maili z próby');
  const imap = await polacz(account);
  try {
    const foldery = dostepne(splaszcz(await p(cb => imap.getBoxes(cb))));
    const pisali = await ktoPisal(prisma, imap, foldery);

    const wyslane = [];
    const validity = {};
    for (const f of foldery.filter(jestWyslane)) {
      const box = await p(cb => imap.openBox(f.nazwa, true, cb));
      validity[f.nazwa] = box.uidvalidity;
      if (!box.messages.total) continue;
      const uidy = await p(cb => imap.search([['SINCE', new Date(`${od}T00:00:00Z`)], ['BEFORE', new Date(`${doDnia}T00:00:00Z`)]], cb));
      if (!uidy.length) continue;
      for (const m of await naglowki(imap, uidy, { poUid: true, pola: 'TO CC BCC SUBJECT IN-REPLY-TO REFERENCES' })) wyslane.push({ folder: f.nazwa, ...m });
    }

    const duze = tryb !== 'mailing';
    const wybor = tryb === 'pierwsze' ? wybierzPierwsze(wyslane, pisali, { minBajtow: minMB * MB, zKontrahentami, minPowtorzen })
      : tryb === 'duze' ? wybierzDuze(wyslane, pisali, { minBajtow: minMB * MB })
        : wybierz(wyslane, pisali, { minOdbiorcow });
    const { doUsuniecia } = wybor;
    const latami = {};
    for (const k of doUsuniecia) {
      const rok = k.date ? String(new Date(k.date).getUTCFullYear()) : '?';
      const r = latami[rok] || (latami[rok] = { n: 0, mb: 0 });
      r.n += 1;
      r.mb = Math.round((r.mb + k.size / MB) * 10) / 10;
    }
    const wynik = {
      skrzynka: account.inbox, proba, tryb, okres: { od, do: doDnia }, ...(duze ? { minMB } : { minOdbiorcow }),
      ...(tryb === 'pierwsze' ? { zKontrahentami, minPowtorzen } : {}),
      wyslanychWOkresie: wyslane.length,
      doUsuniecia: { n: doUsuniecia.length, mb: mb(doUsuniecia.reduce((s, k) => s + k.size, 0)), latami },
      zostaja: wybor.zostaja,
      ...(tryb === 'pierwsze' ? { wsrodUsuwanychZOdpowiedzia: wybor.zOdpowiedzia, rodzajeUsuwanych: wybor.rodzaje, podzial: wybor.podzial, tematy: wybor.tematy } : {}),
      ...(duze ? {
        zostajaMB: wybor.zostajaMB,
        // Kilka największych do wglądu właściciela: data, firma odbiorcy, MB, temat.
        przyklady: [...doUsuniecia].sort((a, b) => b.size - a.size).slice(0, 8).map(k => ({
          data: k.date ? new Date(k.date).toISOString().slice(0, 10) : null,
          do: [...new Set(k.odbiorcy.map(domena))].join(', ').slice(0, 60),
          mb: mb(k.size),
          temat: dekoduj(k.h.subject).trim().slice(0, 70),
        })),
      } : {
        kampanie: wybor.kampanie.sort((a, b) => b.bajty - a.bajty).slice(0, 25).map(c => ({ temat: c.temat, wyslano: c.wyslano, odpisalo: c.odpisalo, doUsuniecia: c.doUsuniecia, mb: mb(c.bajty) })),
      }),
      usunieto: 0,
    };
    if (proba) return wynik;

    if (doUsuniecia.length !== oczekiwane) {
      wynik.blad = `od próby zmieniła się liczba maili do usunięcia (${oczekiwane} → ${doUsuniecia.length}) — nic nie skasowano, zrób próbę jeszcze raz`;
      return wynik;
    }
    if (!imap.serverSupports('UIDPLUS')) {
      wynik.blad = 'serwer nie obsługuje UID EXPUNGE — nic nie skasowano';
      return wynik;
    }
    const poFolderach = new Map();
    for (const k of doUsuniecia) {
      if (!poFolderach.has(k.folder)) poFolderach.set(k.folder, []);
      poFolderach.get(k.folder).push(k.uid);
    }
    for (const [folder, uidy] of poFolderach) {
      const box = await p(cb => imap.openBox(folder, false, cb));
      if (box.uidvalidity !== validity[folder]) { wynik.blad = `folder ${folder} zmienił numerację w trakcie — przerwane`; break; }
      for (let i = 0; i < uidy.length; i += 200) {
        const partia = uidy.slice(i, i + 200);
        await p(cb => imap.addFlags(partia, '\\Deleted', cb));
        await p(cb => imap.expunge(partia, cb));
        wynik.usunieto += partia.length;
      }
    }
    return wynik;
  } finally {
    try { imap.end(); } catch (_) {}
  }
}

module.exports = { sprzatnijMailing, _test: { wybierz, wybierzDuze, wybierzPierwsze, parsujNaglowki, domenaFirmowa, normalizujTemat } };
