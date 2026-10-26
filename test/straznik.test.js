'use strict';

/* Testy strażnika (24.10.2026) — wykrywanie obcych ruchów po incydencie
 * Railway. Podstawiona baza i podstawiona wysyłka alertów; zero sieci. */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const st = require(path.join(__dirname, '..', 'src', 'services', 'straznik'));
const { _test: T } = st;

// ── podstawiona baza ────────────────────────────────────────────────────────
function baza(over = {}) {
  const config = new Map();
  const db = {
    config: {
      findUnique: async ({ where }) => (config.has(where.key) ? { key: where.key, value: config.get(where.key) } : null),
      upsert: async ({ where, update, create }) => { config.set(where.key, (config.has(where.key) ? update : create).value); return {}; },
    },
    activityEvent: { findMany: async () => over.zdarzeniaGK || [] },
    warehouseOrder: { findMany: async () => over.magazynGK || [] },
    confirmLock: { findMany: async () => (over.blokady || []).map(n => ({ invoiceNumber: n })) },
    invoice: { findMany: async () => over.fakturyPL || [] },
    esInvoice: { findMany: async () => over.fakturyES || [] },
    $queryRawUnsafe: async (sql, ...args) => {
      if (sql.includes('pg_stat_activity')) return over.bazaKolejne ? (over.bazaKolejne.shift() || []) : (over.baza || []);
      if (sql.includes("type = 'mail.sent_external'") && sql.includes('GROUP BY 1')) return over.wysylki || [];
      if (sql.includes("type = 'mail.sent_external'")) return [{ n: (over.wczesniej || {})[args[0]] || 0 }];
      if (sql.includes('"EmailSkip"')) return over.zwroty || [];
      return [];
    },
  };
  db._config = config;
  return db;
}
function zbieracz() {
  const alerty = [];
  return { alerty, wyslij: async (tekst) => { alerty.push(tekst); return true; } };
}
const zad = (sciezka, { ip = '203.0.113.7', metoda = 'GET', naglowki = {} } = {}) => ({
  method: metoda, originalUrl: sciezka, url: sciezka, path: sciezka.split('?')[0],
  headers: { 'x-real-ip': ip, 'user-agent': 'curl/8.5', ...naglowki }, socket: {},
});

test.beforeEach(() => T.reset());

test('adres klienta: X-Real-IP, potem OSTATNI wpis X-Forwarded-For (pierwszy da się podrobić)', () => {
  assert.equal(T.adresKlienta({ headers: { 'x-real-ip': '198.51.100.9', 'x-forwarded-for': '149.154.167.1, 198.51.100.9' } }), '198.51.100.9');
  assert.equal(T.adresKlienta({ headers: { 'x-forwarded-for': '149.154.167.1, 203.0.113.50' } }), '203.0.113.50');
  assert.equal(T.adresKlienta({ headers: {}, socket: { remoteAddress: '::ffff:10.0.0.5' } }), '10.0.0.5');
});

test('rodzaje tras: API, webhook bota, trasy z tokenem; publiczne pomijane', () => {
  assert.equal(T.rodzajTrasy(zad('/api/admin/query', { metoda: 'POST' })), 'api');
  assert.equal(T.rodzajTrasy(zad('/telegram/webhook/pl', { metoda: 'POST' })), 'tg');
  assert.equal(T.rodzajTrasy(zad('/telegram/webhook/pl/ustaw?secret=x')), 'sekret-bota');
  assert.equal(T.rodzajTrasy(zad('/telegram/webhook/kanary?secret=x')), 'sekret-bota');
  assert.equal(T.rodzajTrasy(zad('/telegram/diag?token=x')), 'token');
  assert.equal(T.rodzajTrasy(zad('/zewn/faktury', { metoda: 'POST' })), 'faktury', 'token faktur systemu mailingowego');
  assert.equal(T.rodzajTrasy(zad('/czytnik/zdrowie')), null, 'publiczne — bez tokenu');
  assert.equal(T.rodzajTrasy(zad('/czytnik/norma?rok=2026&miesiac=8')), null);
  assert.equal(T.rodzajTrasy(zad('/czytnik/pracownicy')), 'token');
  assert.equal(T.rodzajTrasy(zad('/czytnik/odczytaj', { metoda: 'POST' })), 'token');
  assert.equal(T.rodzajTrasy(zad('/karty-pracy/odczytaj', { metoda: 'POST' })), 'token');
  assert.equal(T.rodzajTrasy(zad('/map-data?key=abc')), 'api');
  assert.equal(T.rodzajTrasy(zad('/map-data')), null);
  assert.equal(T.rodzajTrasy(zad('/health')), null);
  assert.equal(T.rodzajTrasy(zad('/img/logo.png')), null);
});

test('zakresy Telegrama i uogólnianie ścieżek', () => {
  assert.ok(T.zTelegrama('149.154.167.220'));
  assert.ok(T.zTelegrama('91.108.6.1'));
  assert.ok(!T.zTelegrama('203.0.113.7'));
  assert.ok(!T.zTelegrama('2001:db8::1'));
  assert.equal(T.sciezkaOgolna('/api/contractors/7f3a2b1c-1111-2222-3333-444455556666/notes?x=1'), '/api/contractors/:id/notes');
  assert.equal(T.sciezkaOgolna('/api/invoices/253/pdf'), '/api/invoices/:n/pdf');
});

test('rejestr: wywołanie z tego samego procesu (bez nagłówków proxy) pomijane; „127.0.0.1" w nagłówku nie ukrywa', () => {
  const wewn = { method: 'POST', originalUrl: '/preprocess-scan', url: '/preprocess-scan', headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } };
  st.zarejestruj(wewn, { statusCode: 200 });
  assert.equal(T.okno.adresy.size, 0);
  st.zarejestruj(zad('/preprocess-scan', { metoda: 'POST', ip: '127.0.0.1' }), { statusCode: 200 });
  assert.equal(T.okno.adresy.size, 1, 'z nagłówkiem proxy liczymy jak każde wywołanie');
});

test('rejestr: panel liczony osobno, nieudane wywołania pominięte, adresy spoza panelu zapamiętane', () => {
  st.zarejestruj(zad('/api/contractors', { naglowki: { 'x-crm-user': 'michal' } }), { statusCode: 200 });
  st.zarejestruj(zad('/api/admin/query', { metoda: 'POST' }), { statusCode: 200 });
  st.zarejestruj(zad('/api/admin/query', { metoda: 'POST', ip: '198.51.100.1' }), { statusCode: 401 });
  st.zarejestruj(zad('/health'), { statusCode: 200 });
  assert.equal(T.okno.panel, 1);
  assert.deepEqual([...T.okno.adresy.keys()], ['203.0.113.7']);
  assert.equal(T.okno.adresy.get('203.0.113.7').n, 1);
});

test('webhook bota: z adresu Telegrama nic, z obcego adresu z poprawnym sekretem — alert od razu', async () => {
  const z = zbieracz();
  st.zarejestruj(zad('/telegram/webhook/pl', { metoda: 'POST', ip: '149.154.167.220' }), { statusCode: 200 }, z);
  st.zarejestruj(zad('/telegram/webhook/pl', { metoda: 'POST', ip: '203.0.113.66' }), { statusCode: 403 }, z);
  assert.equal(z.alerty.length, 0, 'zły sekret = nic się nie stało');
  st.zarejestruj(zad('/telegram/webhook/pl', { metoda: 'POST', ip: '203.0.113.66', naglowki: { 'x-forwarded-for': '149.154.167.1, 203.0.113.66' } }), { statusCode: 200 }, z);
  await new Promise(r => setImmediate(r));
  assert.equal(z.alerty.length, 1);
  assert.match(z.alerty[0], /203\.0\.113\.66/);
});

test('przegląd adresów: nowy adres — alert raz, w następnej godzinie już nie; tryb próbny niczego nie zapisuje', async () => {
  const db = baza();
  const z = zbieracz();
  st.zarejestruj(zad('/api/admin/query', { metoda: 'POST' }), { statusCode: 200 });
  const proba = await st.przegladGodzinny(db, { dry: true, wyslij: z.wyslij });
  assert.deepEqual(proba.adresy.nowe, ['203.0.113.7']);
  assert.equal(db._config.has('straznik_znane_adresy'), false, 'próbny przegląd nie zapamiętuje adresu');
  assert.equal(db._config.has('straznik_start'), false, 'próbny przegląd nie ustawia startu');
  z.alerty.length = 0;
  await st.przegladGodzinny(db, { wyslij: z.wyslij });
  assert.equal(z.alerty.filter(a => a.includes('NOWY adres')).length, 1);
  assert.match(z.alerty[0], /203\.0\.113\.7 \(sieć 203\.0\.113\.0\/24\) — 1 wywołań/);
  assert.match(z.alerty[0], /\/api\/admin\/query/);
  z.alerty.length = 0;
  st.zarejestruj(zad('/api/admin/query', { metoda: 'POST' }), { statusCode: 200 });
  await st.przegladGodzinny(db, { wyslij: z.wyslij });
  assert.equal(z.alerty.filter(a => a.includes('NOWY adres')).length, 0, 'znany adres bez alertu');
});

test('przegląd adresów: inny adres z tej samej sieci /24 nie jest nowy; tryb próbny pokazuje treść alertu', async () => {
  const db = baza();
  const z = zbieracz();
  st.zarejestruj(zad('/api/admin/query', { metoda: 'POST', ip: '160.79.106.138' }), { statusCode: 200 });
  const proba = await st.przegladGodzinny(db, { dry: true, wyslij: z.wyslij });
  assert.deepEqual(proba.adresy.noweSieci, ['160.79.106.0/24']);
  assert.ok(z.alerty.some(a => a.includes('NOWY adres') && a.includes('160.79.106.138')), 'próbny przegląd zwraca treść alertu');
  z.alerty.length = 0;
  await st.przegladGodzinny(db, { wyslij: z.wyslij });
  assert.equal(z.alerty.filter(a => a.includes('NOWY adres')).length, 1);
  z.alerty.length = 0;
  st.zarejestruj(zad('/api/admin/query', { metoda: 'POST', ip: '160.79.106.25' }), { statusCode: 200 });
  st.zarejestruj(zad('/api/admin/query', { metoda: 'POST', ip: '198.51.100.77' }), { statusCode: 200 });
  const w = await st.przegladGodzinny(db, { wyslij: z.wyslij });
  assert.deepEqual(w.adresy.noweSieci, ['198.51.100.0/24'], 'tylko obca sieć jest nowa');
  assert.ok(z.alerty.some(a => a.includes('198.51.100.77')) && !z.alerty.some(a => a.includes('160.79.106.25')));
  assert.equal(T.siecAdresu('2001:db8:abcd:12:1::5'), '2001:db8:abcd:12::/64');
});

test('przegląd adresów: wpisy starej wersji (pojedyncze adresy) scalone w sieci; kilka adresów nowej sieci — wszystkie w alercie', async () => {
  const db = baza();
  const z = zbieracz();
  db._config.set('straznik_znane_adresy', JSON.stringify({ '160.79.106.138': { od: '2026-10-24T09:02:00.000Z', ostatnio: '2026-10-24T09:02:00.000Z', n: 3, ua: 'curl/8.5.0' } }));
  st.zarejestruj(zad('/api/admin/query', { metoda: 'POST', ip: '160.79.106.21' }), { statusCode: 200 });
  st.zarejestruj(zad('/poczta/zdrowie', { ip: '192.0.2.10' }), { statusCode: 200 });
  st.zarejestruj(zad('/poczta/zdrowie', { ip: '192.0.2.11' }), { statusCode: 200 });
  const w = await st.przegladGodzinny(db, { wyslij: z.wyslij });
  assert.deepEqual(w.adresy.noweSieci, ['192.0.2.0/24'], 'sieć ze starego wpisu jest znana');
  assert.deepEqual(w.adresy.nowe.sort(), ['192.0.2.10', '192.0.2.11']);
  const zapis = JSON.parse(db._config.get('straznik_znane_adresy'));
  assert.deepEqual(Object.keys(zapis).sort(), ['160.79.106.0/24', '192.0.2.0/24']);
  assert.deepEqual(zapis['160.79.106.0/24'].adresy.sort(), ['160.79.106.138', '160.79.106.21']);
  assert.equal(zapis['160.79.106.0/24'].n, 4);
});

test('alert nazywa użyty sekret i oznacza podgląd linku z urządzenia Apple (24.10: iPhone właściciela, link z instrukcji)', async () => {
  const db = baza();
  const z = zbieracz();
  const apple = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0';
  st.zarejestruj(zad('/telegram/webhook/pl/ustaw?secret=x', { ip: '172.226.148.43', naglowki: { 'user-agent': apple } }), { statusCode: 200 });
  st.zarejestruj(zad('/api/contractors', { ip: '198.51.100.5' }), { statusCode: 200 });
  await st.przegladGodzinny(db, { wyslij: z.wyslij });
  const a = z.alerty.find(t => t.includes('NOWY adres'));
  assert.ok(a, 'jest alert');
  const [bot, api] = a.split('• ').slice(1);
  assert.match(bot, /użyty sekret: sekret webhooka bota/);
  assert.match(bot, /podgląd linku z urządzenia Apple/);
  assert.match(api, /użyty sekret: klucz API CRM/);
  assert.doesNotMatch(api, /podgląd linku/);
  assert.match(a, /wymień: sekret webhooka bota .*; klucz API CRM|wymień: klucz API CRM .*; sekret webhooka bota/);
  assert.doesNotMatch(a, /PREPROCESS_TOKEN/, 'tokenu nikt nie użył — nie każemy go wymieniać');
  assert.equal(T.podgladLinku('curl/8.5.0'), null);
  assert.equal(T.podgladLinku('TelegramBot (like TwitterBot)'), 'podgląd linku w komunikatorze');
});

test('przegląd adresów: ponad próg wywołań z jednego adresu — alert', async () => {
  const db = baza();
  const z = zbieracz();
  for (let i = 0; i <= st.PROG_WYWOLAN; i++) st.zarejestruj(zad('/czytnik/odczytaj', { metoda: 'POST', ip: '198.51.100.20' }), { statusCode: 200 });
  await st.przegladGodzinny(db, { wyslij: z.wyslij });
  assert.ok(z.alerty.some(a => a.includes(`${st.PROG_WYWOLAN + 1} wywołań w godzinę`) && a.includes('198.51.100.20')));
});

test('GlobKurier: alert tylko dla zamówień po starcie strażnika, których nie złożył CRM', async () => {
  const db = baza({ zdarzeniaGK: [{ shipmentNumber: 'GKGK261024000001' }], magazynGK: [{ gkNumber: 'GK261024000002' }] });
  db._config.set('straznik_start', JSON.stringify('2026-10-24T08:00:00Z')); // 10:00 w Warszawie
  const z = zbieracz();
  const wynik = await st.przegladGodzinny(db, { wyslij: z.wyslij, zamowieniaGK: async () => [
    { number: 'GK261023999999', creationDate: '2026-10-23 12:00:00', status: 'IN_PROGRESS' },
    { number: 'GK261024000001', creationDate: '2026-10-24 10:30:00', status: 'IN_PROGRESS' },
    { number: 'GK261024000002', creationDate: '2026-10-24 10:40:00', status: 'IN_PROGRESS' },
    { number: 'GK261024000003', creationDate: '2026-10-24 11:00:00', status: 'IN_PROGRESS', priceGross: 412.5, receiverAddress: { name: 'Obcy Odbiorca', city: 'Lagos' } },
  ] });
  assert.deepEqual(wynik.gk.obce, ['GK261024000003']);
  const a = z.alerty.find(x => x.includes('GlobKurier'));
  assert.ok(a && a.includes('412.5') && a.includes('Obcy Odbiorca'));
});

test('faktury: alert tylko dla faktur spoza CRM (bez blokady wystawienia)', async () => {
  const db = baza({
    blokady: ['253/2026', '2026-0190'],
    fakturyPL: [{ number: '253/2026', contractorName: 'Wet tarifa', grossAmount: 135, currency: 'EUR' }, { number: '254/2026', contractorName: 'Ktoś Obcy', grossAmount: 9999, currency: 'PLN' }],
    fakturyES: [{ number: '2026-0190', contractorName: 'Kanary', totalAmount: 50 }],
  });
  const z = zbieracz();
  const wynik = await st.przegladGodzinny(db, { wyslij: z.wyslij, zamowieniaGK: async () => [] });
  assert.deepEqual(wynik.faktury.obce, ['254/2026']);
  assert.ok(z.alerty.some(a => a.includes('254/2026') && a.includes('Ktoś Obcy')));
});

test('skrzynki: uśpiona skrzynka wysyła, fala wysyłek, fala zwrotów — alerty; zwykły ruch bez alertu', async () => {
  const db = baza({
    wysylki: [{ inbox: 'niko', n: 2 }, { inbox: 'sales', n: 1 }, { inbox: 'info', n: 15 }],
    wczesniej: { niko: 30, sales: 0, info: 25 },
    zwroty: [{ inbox: 'delivery', n: 6 }, { inbox: 'niko', n: 1 }],
  });
  const z = zbieracz();
  const wynik = await st.przegladGodzinny(db, { wyslij: z.wyslij, zamowieniaGK: async () => [] });
  assert.deepEqual(wynik.skrzynki.alerty.sort(), ['delivery:zwroty', 'info', 'sales'].sort());
  assert.ok(z.alerty.some(a => a.includes('sales@') && a.includes('30 dni')));
  assert.ok(z.alerty.some(a => a.includes('info@') && a.includes('15 maili')));
  assert.ok(z.alerty.some(a => a.includes('6 zwrotów') && a.includes('delivery@')));
  assert.ok(!z.alerty.some(a => a.includes('niko@')), 'niko — zwykły ruch');
});

test('baza: obcy adres zgłaszany dopiero przy drugim przeglądzie z rzędu (nakładanie kontenerów przy wdrożeniu)', async () => {
  const z = zbieracz();
  const obcy = [{ ip: '203.0.113.99', usename: 'postgres', application_name: 'psql' }];
  const db = baza({ baza: [], bazaKolejne: [obcy, obcy, []] });
  const deps = { wyslij: z.wyslij, webhookInfo: async () => null };
  await st.przegladCzesty(db, deps);
  assert.equal(z.alerty.length, 0, 'pierwsze zobaczenie — czekamy');
  const w2 = await st.przegladCzesty(db, deps);
  assert.deepEqual(w2.baza.zgloszone, ['203.0.113.99']);
  assert.ok(z.alerty[0].includes('OBCE połączenie z bazą') && z.alerty[0].includes('psql'));
  const w3 = await st.przegladCzesty(db, deps);
  assert.deepEqual(w3.baza.zgloszone, []);
});

test('baza: przegląd próbny nie zalicza pierwszego zobaczenia', async () => {
  const z = zbieracz();
  const obcy = [{ ip: '203.0.113.99', usename: 'postgres', application_name: 'psql' }];
  const db = baza({ bazaKolejne: [obcy, obcy, obcy] });
  const deps = { wyslij: z.wyslij, webhookInfo: async () => null };
  await st.przegladCzesty(db, { ...deps, dry: true });
  const w = await st.przegladCzesty(db, deps);
  assert.deepEqual(w.baza.zgloszone, [], 'po próbie to wciąż pierwsze prawdziwe zobaczenie');
  const w2 = await st.przegladCzesty(db, deps);
  assert.deepEqual(w2.baza.zgloszone, ['203.0.113.99']);
});

test('webhooki bota: zdjęty albo na obcym adresie — alert; poprawny — ok', async (t) => {
  const przed = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = 'https://crm-backend.example.app';
  t.after(() => { if (przed === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = przed; });
  const z = zbieracz();
  const webhooki = {
    pl: { url: 'https://crm-backend.example.app/telegram/webhook/pl' },
    kanary: { url: 'https://evil.example.net/telegram/webhook/kanary' },
  };
  const db = baza({ baza: [] });
  const w = await st.przegladCzesty(db, { wyslij: z.wyslij, webhookInfo: async (s) => webhooki[s] });
  assert.equal(w.webhooki.pl, 'ok');
  assert.match(w.webhooki.kanary, /obcy adres/);
  webhooki.pl = { url: '' };
  const w2 = await st.przegladCzesty(db, { wyslij: z.wyslij, webhookInfo: async (s) => webhooki[s] });
  assert.match(w2.webhooki.pl, /ZDJĘTY/);
  assert.equal(z.alerty.length, 3);
});

test('godzina w Warszawie do porównań z GlobKurier', () => {
  assert.equal(T.lokalnieWarszawa(new Date('2026-10-24T08:00:00Z')), '2026-10-24 10:00:00');
  assert.equal(T.lokalnieWarszawa(new Date('2026-12-01T08:00:00Z')), '2026-12-01 09:00:00');
});
