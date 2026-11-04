'use strict';
// Alarmy o połączeniach pollera poczty (services/alarmy-poczty.js):
// bez serii „nie działa / działa / nie działa" przy mrugającym serwerze.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/services/alarmy-poczty');
const { nowyStan, ocenCykl } = A._test;

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 3, 8, 0); // 3.11.2026 09:00 w Warszawie
const HOST = 'h22.seohost.pl';
const SKRZYNKI = ['info', 'niko', 'delivery', 'michal', 'sales'];
const TIMEOUT = 'Timed out while authenticating with server';

// Cykl jak w pollerze: przy awarii serwera 3 pierwsze skrzynki dostają błąd,
// resztę bezpiecznik pomija.
const serwerLezy = () => SKRZYNKI.map((inbox, i) => (i < 3
  ? { inbox, host: HOST, ok: false, blad: TIMEOUT }
  : { inbox, host: HOST, ok: false, pominieta: true }));
const wszystkoOk = () => SKRZYNKI.map(inbox => ({ inbox, host: HOST, ok: true }));

/** Przebieg co 5 min od `odMin` do `doMin` włącznie; `wzor(min)` → obserwacje. */
function przebieg(stan, odMin, doMin, wzor) {
  const wiad = [];
  for (let m = odMin; m <= doMin; m += 5) {
    for (const w of ocenCykl(stan, wzor(m), T0 + m * MIN)) wiad.push({ min: m, w });
  }
  return wiad;
}

test('rodzaj błędu: timeout przy logowaniu to serwer, odrzucone hasło to logowanie', () => {
  assert.equal(A.rodzajBledu(TIMEOUT), 'serwer');
  assert.equal(A.rodzajBledu('polaczenie IMAP zamkniete przed gotowoscia'), 'serwer');
  assert.equal(A.rodzajBledu('michal: polaczenie IMAP: przekroczono 60 s'), 'serwer');
  assert.equal(A.rodzajBledu('[UNAVAILABLE] Temporary authentication failure.'), 'serwer');
  assert.equal(A.rodzajBledu('getaddrinfo ENOTFOUND h22.seohost.pl'), 'serwer');
  assert.equal(A.rodzajBledu('[AUTHENTICATIONFAILED] Authentication failed.'), 'logowanie');
  assert.equal(A.rodzajBledu('Invalid credentials (Failure)'), 'logowanie');
  assert.equal(A.rodzajBledu('LOGIN failed.'), 'logowanie');
  assert.equal(A.rodzajBledu('Mailbox does not exist'), 'inny');
});

test('mrugający serwer (jak 3.11 rano: 10 min awarii, 5 min działa) przez 3 h — zero wiadomości', () => {
  const stan = nowyStan();
  const wiad = przebieg(stan, 0, 180, m => (m % 15 === 10 ? wszystkoOk() : serwerLezy()));
  assert.deepEqual(wiad, []);
});

test('awaria 40 min: jeden ⚠️ na cały serwer po 30 min, potem cisza przy mruganiu, jedno ✅ po 30 min stabilnie', () => {
  const stan = nowyStan();
  const wiad = przebieg(stan, 0, 160, (m) => {
    if (m <= 35) return serwerLezy();                     // twarda awaria
    if (m <= 90) return m % 10 === 5 ? wszystkoOk() : serwerLezy(); // mruga; ostatni błąd w 90. minucie
    return wszystkoOk();                                  // stabilnie od 95. minuty
  });
  assert.equal(wiad.length, 2, wiad.map(x => x.w).join('\n---\n'));

  const [awaria, powrot] = wiad;
  assert.equal(awaria.min, 30);
  assert.match(awaria.w, /^⚠️ Poczta nie dochodzi do CRM od 30 min — serwer poczty h22\.seohost\.pl nie odpowiada/);
  assert.match(awaria.w, /info@, niko@, delivery@, michal@, sales@/);
  assert.match(awaria.w, /Timed out while authenticating/);
  assert.doesNotMatch(awaria.w, /IMAP_ACCOUNTS/, 'przy awarii serwera nie odsyłamy do haseł');

  assert.equal(powrot.min, 125);
  assert.match(powrot.w, /^✅ Poczta znów dochodzi — serwer h22\.seohost\.pl działa stabilnie od 30 min/);
  assert.match(powrot.w, /Kłopoty trwały 09:00–10:35 \(1 h 35 min\)/);
});

test('kolejna awaria tuż po powrocie: alarm dopiero 3 h po poprzednim, z prawdziwym czasem trwania', () => {
  const stan = nowyStan();
  const wiad = przebieg(stan, 0, 300, (m) => {
    if (m <= 35) return serwerLezy();
    if (m < 130) return wszystkoOk();   // działa od 40. minuty → ✅ w 70.
    return serwerLezy();                // od 130. minuty znów leży
  });
  assert.deepEqual(wiad.map(x => x.min), [30, 70, 210]);
  assert.match(wiad[2].w, /od 1 h 20 min/);
});

test('złe hasło jednej skrzynki: ⚠️ po 2 cyklach z radą o IMAP_ACCOUNTS, potem cisza, ✅ po naprawie', () => {
  const stan = nowyStan();
  const zle = '[AUTHENTICATIONFAILED] Authentication failed.';
  const wiad = przebieg(stan, 0, 120, m => SKRZYNKI.map(inbox => (inbox === 'michal' && m < 60
    ? { inbox, host: HOST, ok: false, blad: zle }
    : { inbox, host: HOST, ok: true })));
  assert.deepEqual(wiad.map(x => x.min), [5, 90]);
  assert.match(wiad[0].w, /^⚠️ Skrzynka michal@ nie loguje się do serwera poczty \(h22\.seohost\.pl\)/);
  assert.match(wiad[0].w, /IMAP_ACCOUNTS/);
  assert.match(wiad[1].w, /^✅ Skrzynka michal@ znów pobiera pocztę/);
});

test('złe hasło przez dobę: jedno przypomnienie „Nadal” po 24 h', () => {
  const stan = nowyStan();
  const wiad = przebieg(stan, 0, 25 * 60, () => [{ inbox: 'michal', host: HOST, ok: false, blad: 'LOGIN failed.' }]);
  assert.deepEqual(wiad.map(x => x.min), [5, 5 + 24 * 60]);
  assert.match(wiad[1].w, /^⚠️ Nadal: Skrzynka michal@/);
});

test('nierozpoznany błąd jednej skrzynki: dopiero po 30 min i bez rady o haśle', () => {
  const stan = nowyStan();
  const wiad = przebieg(stan, 0, 60, () => [
    { inbox: 'info', host: HOST, ok: true },
    { inbox: 'sales', host: HOST, ok: false, blad: 'Mailbox does not exist' },
  ]);
  assert.deepEqual(wiad.map(x => x.min), [30]);
  assert.match(wiad[0].w, /^⚠️ Skrzynka sales@ nie pobiera poczty od 30 min/);
  assert.doesNotMatch(wiad[0].w, /IMAP_ACCOUNTS/);
});

test('4.11: mieszane błędy serwera (timeout / zakonczone / socket) przez godzinę — jedna wiadomość', () => {
  assert.equal(A.rodzajBledu('polaczenie IMAP zakonczone przed gotowoscia'), 'serwer');
  assert.equal(A.rodzajBledu('This socket has been ended by the other party'), 'serwer');
  const bledy = ['Timed out while authenticating with server', 'polaczenie IMAP zakonczone przed gotowoscia', 'This socket has been ended by the other party', 'Nieznany błąd serwera XYZ'];
  const stan = nowyStan();
  const wiad = przebieg(stan, 0, 60, m => SKRZYNKI.map((inbox, i) => ({ inbox, host: HOST, ok: false, blad: bledy[(i + m / 5) % bledy.length] })));
  assert.equal(wiad.length, 1, wiad.map(x => x.w).join('\n---\n'));
  assert.match(wiad[0].w, /^⚠️ Poczta nie dochodzi do CRM od 30 min — serwer poczty/);
});

test('incydenty skrzynek z błędem serwera zapisane przed poprawką znikają po cichu', () => {
  const stan = nowyStan({ skrzynkiAlarmy: {
    niko: { rodzaj: 'inny', host: HOST, od: T0, alarmO: T0, blad: 'polaczenie IMAP zakonczone przed gotowoscia' },
    sales: { rodzaj: 'inny', host: HOST, od: T0, alarmO: T0, blad: 'Mailbox does not exist' },
    michal: { rodzaj: 'logowanie', host: HOST, od: T0, alarmO: T0, blad: 'LOGIN failed.' },
  } });
  assert.deepEqual(Object.keys(stan.skrzynkiAlarmy).sort(), ['michal', 'sales']);
  assert.equal(stan.zmiana, true);
});

test('redeploy w trakcie awarii: stan z Config — bez drugiego ⚠️, „✅” dochodzi', async () => {
  const baza = {};
  const prisma = { config: {
    findUnique: async ({ where }) => (baza[where.key] != null ? { value: baza[where.key] } : null),
    upsert: async ({ where, update, create }) => { baza[where.key] = (baza[where.key] != null ? update : create).value; },
  } };
  const wyslane = [];
  const wyslij = async (w) => { wyslane.push(w); };

  A._test.reset();
  for (let m = 0; m <= 30; m += 5) await A.poCyklu(prisma, serwerLezy(), wyslij, T0 + m * MIN);
  assert.equal(wyslane.length, 1);
  assert.ok(JSON.parse(baza.poczta_alarmy).serwery[HOST], 'otwarty incydent zapisany w Config');
  assert.ok(A.ostatniBladSkrzynki('info') > 0, 'kanarek wie o świeżej awarii skrzynki');

  A._test.reset(); // nowy proces po wdrożeniu — pamięć skrzynek pusta
  for (let m = 35; m <= 60; m += 5) await A.poCyklu(prisma, serwerLezy(), wyslij, T0 + m * MIN);
  assert.equal(wyslane.length, 1, 'po redeployu nie ma drugiego ⚠️');
  for (let m = 65; m <= 95; m += 5) await A.poCyklu(prisma, wszystkoOk(), wyslij, T0 + m * MIN);
  assert.equal(wyslane.length, 2);
  assert.match(wyslane[1], /^✅ Poczta znów dochodzi/);
  assert.deepEqual(JSON.parse(baza.poczta_alarmy).serwery, {}, 'incydent zamknięty');
  A._test.reset();
});
