"use strict";

/* Testy mostu do Bell Outreach: klasyfikacja (DE/EN/IT/FR), budowa JSON,
 * obsługa 200/400/401/429/5xx/sieć z atrapą fetch i atrapą Prisma.
 * Uruchomienie: npm test  (node --test test/) */

const test = require('node:test');
const assert = require('node:assert/strict');
const bo = require('../src/services/bell-outreach');

// Atrapa wzorców wypisu z pollera (prawdziwe są w inbox-poller.js — jego
// require uruchamia polling, więc tu wstrzykujemy prostą wersję).
const wykryjWypis = (m) => (/abmelden|unsubscribe|keine e-?mails mehr|d(é|e)sabonn|rimuov/i.test(`${m.subject || ''}\n${m.bodyText || ''}`) ? 'atrapa' : null);
const opcje = { wykryjWypis };
const odp = (over) => ({ fromEmail: 'shop@kunde.de', toEmail: 'info@surfstickbell.com', subject: 'AW: Sonnenschutz für Ihr Geschäft', inReplyTo: '<nasz@surfstickbell.com>', bodyText: '', ...over });
const rodzaj = (m) => { const r = bo.rodzajBellOutreach(m, opcje); return r && r.rodzaj; };

test('odmowa krótka → nie_zainteresowany (DE/EN/IT/FR/ES/PL)', () => {
  const cyt = '\n\nAm 12.10.2026 schrieb Surf Stick <info@surfstickbell.com>:\n> Falls das Thema für Sie nicht relevant ist …';
  assert.equal(rodzaj(odp({ bodyText: 'Kein Interesse, danke.' + cyt })), 'nie_zainteresowany');
  assert.equal(rodzaj(odp({ bodyText: 'Nein danke' })), 'nie_zainteresowany');
  assert.equal(rodzaj(odp({ bodyText: 'Kein Bedarf.\nMfG Müller' })), 'nie_zainteresowany');
  assert.equal(rodzaj(odp({ bodyText: 'Nicht relevant für uns.' })), 'nie_zainteresowany');
  assert.equal(rodzaj(odp({ subject: 'RE: Sun protection', bodyText: 'Thanks, but we are not interested.' })), 'nie_zainteresowany');
  assert.equal(rodzaj(odp({ subject: 'R: Protezione solare', bodyText: 'Non siamo interessati, grazie.' })), 'nie_zainteresowany');
  assert.equal(rodzaj(odp({ subject: 'RE: Protection solaire', bodyText: 'Nous ne sommes pas intéressés. Cordialement' })), 'nie_zainteresowany');
  assert.equal(rodzaj(odp({ subject: 'RE: Protección solar', bodyText: 'No estamos interesados.' })), 'nie_zainteresowany');
  assert.equal(rodzaj(odp({ subject: 'Odp: Ochrona', bodyText: 'Nie jesteśmy zainteresowani.' })), 'nie_zainteresowany');
});

test('wątpliwość → odpowiedz, nigdy nie_zainteresowany', () => {
  // odmowa + pytanie
  assert.equal(rodzaj(odp({ bodyText: 'Kein Interesse an Mustern, aber könnten Sie uns die Preisliste schicken?' })), 'odpowiedz');
  // odmowa + zainteresowanie w jednym
  assert.equal(rodzaj(odp({ bodyText: 'Kein Interesse an einer Bestellung jetzt, Katalog bitte trotzdem.' })), 'odpowiedz');
  // długi mail ze słowem „kein Interesse" w środku
  const dlugi = 'Guten Tag, vielen Dank für Ihre Nachricht. ' + 'Wir führen aktuell ein breites Sortiment und prüfen neue Lieferanten jedes Quartal. '.repeat(6) + 'Aktuell kein Interesse, aber melden Sie sich im Frühjahr wieder.';
  assert.equal(rodzaj(odp({ bodyText: dlugi })), 'odpowiedz');
  // zwykła odpowiedź człowieka
  assert.equal(rodzaj(odp({ bodyText: 'Bitte wenden Sie sich an unseren Einkauf: einkauf@kunde.de' })), 'odpowiedz');
});

test('prośba o wypis → wypisz (wzorce wstrzyknięte z pollera)', () => {
  assert.equal(rodzaj(odp({ bodyText: 'Bitte keine E-Mails mehr, abmelden!' })), 'wypisz');
  assert.equal(rodzaj(odp({ subject: 'RE: Sun protection', bodyText: 'Please unsubscribe us.' })), 'wypisz');
  assert.equal(rodzaj(odp({ subject: 'RE: Protection solaire', bodyText: 'Merci de nous désabonner.' })), 'wypisz');
  assert.equal(rodzaj(odp({ subject: 'R: Protezione solare', bodyText: 'Rimuoveteci dalla lista.' })), 'wypisz');
  // „kein Interesse" to odmowa (też czarna lista), nie wypis
  assert.equal(rodzaj(odp({ bodyText: 'Kein Interesse.' })), 'nie_zainteresowany');
});

test('zainteresowanie → zainteresowany', () => {
  assert.equal(rodzaj(odp({ bodyText: 'Bitte senden Sie uns den Katalog und die Preisliste.' })), 'zainteresowany');
  assert.equal(rodzaj(odp({ subject: 'RE: Protection solaire', bodyText: 'Pouvez-vous nous envoyer votre catalogue et vos tarifs ?' })), 'zainteresowany');
  assert.equal(rodzaj(odp({ subject: 'R: Protezione solare', bodyText: 'Siamo interessati, inviateci il listino prezzi.' })), 'zainteresowany');
  assert.equal(rodzaj(odp({ subject: 'RE: Sun protection', bodyText: 'Could you send samples and a price list?' })), 'zainteresowany');
});

test('autoresponder: nagłówek, temat, treść, ocena modelu', () => {
  assert.equal(rodzaj(odp({ autoSubmitted: 'auto-replied', bodyText: 'Ich bin bis 30.10. nicht im Büro.' })), 'autoresponder');
  assert.equal(rodzaj(odp({ subject: 'Automatische Antwort: Sonnenschutz für Ihr Geschäft', inReplyTo: null, bodyText: 'Vielen Dank für Ihre Nachricht.' })), 'autoresponder');
  assert.equal(rodzaj(odp({ subject: 'Out of Office: Sun protection', bodyText: 'I am currently out of the office.' })), 'autoresponder');
  assert.equal(rodzaj(odp({ subject: 'Réponse automatique : Protection solaire', bodyText: 'Je suis absent jusqu’au 2 novembre.' })), 'autoresponder');
  assert.equal(rodzaj(odp({ subject: 'Risposta automatica: Protezione solare', bodyText: 'Sono fuori sede.' })), 'autoresponder');
  assert.equal(rodzaj(odp({ category: 'AUTO_REPLY', bodyText: 'Danke für Ihre Nachricht, wir melden uns.' })), 'autoresponder');
});

test('odbicie: nadawca/temat/DSN + adres_odbity', () => {
  const dsn = bo.rodzajBellOutreach({ fromEmail: 'mailer-daemon@mail.kunde.de', subject: 'Undeliverable: Sonnenschutz für Ihr Geschäft', bodyText: 'Delivery has failed.\n\nFinal-Recipient: rfc822; shop@kunde.de\nStatus: 5.1.1\nAction: failed' }, opcje);
  assert.equal(dsn.rodzaj, 'odbicie');
  assert.equal(dsn.adresOdbity, 'shop@kunde.de');
  const de = bo.rodzajBellOutreach({ fromEmail: 'postmaster@web.de', subject: 'Unzustellbar: Sonnenschutz', bodyText: 'Die Nachricht an laden@beispiel.de konnte nicht zugestellt werden. Absender: info@surfstickbell.com' }, opcje);
  assert.equal(de.rodzaj, 'odbicie');
  assert.equal(de.adresOdbity, 'laden@beispiel.de');
  // DSN w treści, nadawca zwykły
  const tresc = bo.rodzajBellOutreach({ fromEmail: 'noreply@mx.provider.it', subject: 'Delivery Status Notification (Failure)', bodyText: 'Original-Recipient: rfc822;negozio@esempio.it\nFinal-Recipient: rfc822;negozio@esempio.it' }, opcje);
  assert.equal(tresc.rodzaj, 'odbicie');
  assert.equal(tresc.adresOdbity, 'negozio@esempio.it');
});

test('pomijane: newsletter, nasze maile, nie-odpowiedź', () => {
  assert.equal(bo.rodzajBellOutreach(odp({ inReplyTo: null, subject: 'Newsletter Oktober', listUnsubscribe: '<mailto:x>', bodyText: 'Angebote der Woche …' }), opcje), null);
  assert.equal(bo.rodzajBellOutreach(odp({ fromEmail: 'info@surfstickbell.com' }), opcje), null);
  assert.equal(bo.rodzajBellOutreach(odp({ direction: 'OUTBOUND' }), opcje), null);
  assert.equal(bo.rodzajBellOutreach({ fromEmail: 'sklep@nowy.pl', subject: 'Zamówienie 123', bodyText: 'Proszę o 20 sztuk sticków, faktura na firmę …' }, opcje), null);
  // odpowiedź-newsletter (List-Unsubscribe + In-Reply-To) nadal przechodzi jako odpowiedź
  assert.equal(rodzaj(odp({ listUnsubscribe: '<mailto:x>', bodyText: 'Danke, wir melden uns.' })), 'odpowiedz');
});

test('budujPaczke: pola wymagane, limit 200, odbicie z adresem', () => {
  const rows = Array.from({ length: 205 }, (_, i) => ({
    skrzynka: 'info@surfstickbell.com', od: `s${i}@kunde.de`, messageId: `<m${i}@kunde.de>`, rodzaj: 'odpowiedz', data: new Date('2026-10-20T15:00:00Z'),
    inReplyTo: '<x@surfstickbell.com>', references: '<a@x> <b@x>', temat: 'AW: Test', adresOdbity: null,
  }));
  rows[0] = { ...rows[0], rodzaj: 'odbicie', adresOdbity: 'dead@kunde.de' };
  const p = bo.budujPaczke(rows);
  assert.equal(p.zrodlo, 'crm');
  assert.equal(p.wiadomosci.length, 200);
  const w = p.wiadomosci[1];
  assert.deepEqual(Object.keys(w).sort(), ['data', 'in_reply_to', 'message_id', 'od', 'references', 'rodzaj', 'skrzynka', 'temat'].sort());
  assert.equal(w.data, '2026-10-20T15:00:00.000Z');
  assert.equal(p.wiadomosci[0].adres_odbity, 'dead@kunde.de');
  assert.ok(!('adres_odbity' in w));
  assert.ok(!JSON.stringify(p).includes('bodyText'));
});

// --- atrapa Prisma: tylko to, czego używa wyslijKolejke ---
function atrapaPrisma(rows) {
  const pasuje = (r, where) => {
    if (where.messageId && typeof where.messageId === 'string') return r.messageId === where.messageId;
    if (where.messageId && Array.isArray(where.messageId.in)) return where.messageId.in.includes(r.messageId);
    if (where.status) return r.status === where.status;
    return true;
  };
  return {
    rows,
    bellOutreachMsg: {
      findMany: async ({ where, take }) => rows.filter(r => pasuje(r, where || {})).slice(0, take || 200),
      updateMany: async ({ where, data }) => {
        let n = 0;
        for (const r of rows) if (pasuje(r, where)) { n++; for (const [k, v] of Object.entries(data)) r[k] = (v && typeof v === 'object' && 'increment' in v) ? (r[k] || 0) + v.increment : v; }
        return { count: n };
      },
    },
    config: { findUnique: async () => null, upsert: async () => null },
  };
}
const wiersze = () => [
  { messageId: '<a@kunde.de>', skrzynka: 'info@surfstickbell.com', od: 'a@kunde.de', rodzaj: 'odpowiedz', data: new Date(), status: 'nowy', proby: 0, createdAt: new Date() },
  { messageId: '<b@kunde.de>', skrzynka: 'info@surfstickbell.com', od: 'b@kunde.de', rodzaj: 'nie_zainteresowany', data: new Date(), status: 'nowy', proby: 0, createdAt: new Date() },
  { messageId: '<c@kunde.de>', skrzynka: 'michal@surfstickbell.com', od: 'c@kunde.de', rodzaj: 'odpowiedz', data: new Date(), status: 'nowy', proby: 0, createdAt: new Date() },
];
const atrapaFetch = (status, body) => { const wywolania = []; const f = async (url, opts) => { wywolania.push({ url, opts }); if (status === 'siec') throw new Error('ECONNRESET'); return { status, json: async () => body }; }; f.wywolania = wywolania; return f; };

test.beforeEach(() => { bo.zerujStan(); bo.ustawPlanowanie(() => null); process.env.BELL_OUTREACH_TOKEN = 'test-token'; delete process.env.BELL_OUTREACH_DRY_RUN; });

test('200: wysłane + pominięte wg odpowiedzi, skrzynka spoza kampanii zapamiętana', async () => {
  const p = atrapaPrisma(wiersze());
  let zapamietane = null;
  p.config.upsert = async ({ create }) => { zapamietane = JSON.parse(create.value); };
  const f = atrapaFetch(200, { ok: true, przyjete: 2, juz_byly: 0, dopasowane: 1, czarna_lista: { adresy: 1, domeny: 1 }, pominiete: [{ nr: 3, message_id: '<c@kunde.de>', powod: 'skrzynka spoza tej kampanii' }] });
  const r = await bo.wyslijKolejke(p, { fetchImpl: f });
  assert.equal(r.wyslano, 2);
  assert.equal(p.rows[0].status, 'wyslany');
  assert.equal(p.rows[1].status, 'wyslany');
  assert.equal(p.rows[2].status, 'pominiety');
  assert.equal(p.rows[2].powod, 'skrzynka spoza tej kampanii');
  assert.deepEqual(zapamietane, ['michal@surfstickbell.com']);
  const req = f.wywolania[0];
  assert.ok(req.url.endsWith('/api/surf_stick/odpowiedzi'));
  assert.equal(req.opts.headers.Authorization, 'Bearer test-token');
  const body = JSON.parse(req.opts.body);
  assert.equal(body.wiadomosci.length, 3);
  assert.equal(body.wiadomosci[1].rodzaj, 'nie_zainteresowany');
});

test('400: błąd danych — wiersze oznaczone, bez ponowień', async () => {
  const p = atrapaPrisma(wiersze());
  const r = await bo.wyslijKolejke(p, { fetchImpl: atrapaFetch(400, { ok: false, error: 'brak pola rodzaj' }) });
  assert.equal(r.blad, 400);
  assert.ok(p.rows.every(x => x.status === 'blad' && /400/.test(x.powod)));
  assert.equal(bo._stan.nastepnaProbaO, 0);
});

test('401: zły token — nic nie oznaczone, pauza godzinę', async () => {
  const p = atrapaPrisma(wiersze());
  const teraz = Date.now();
  const r = await bo.wyslijKolejke(p, { fetchImpl: atrapaFetch(401, { ok: false }), now: () => teraz });
  assert.equal(r.blad, 401);
  assert.ok(p.rows.every(x => x.status === 'nowy'));
  assert.equal(bo._stan.nastepnaProbaO, teraz + 60 * 60 * 1000);
  const r2 = await bo.wyslijKolejke(p, { fetchImpl: atrapaFetch(200, { ok: true }), now: () => teraz + 1000 });
  assert.equal(r2.pominieto, 'czekam na ponowienie');
});

test('429 / 5xx / sieć: ponowienia 1, 2, 4, 8 min, potem następny cykl', async () => {
  const p = atrapaPrisma(wiersze());
  const teraz = Date.now();
  const zaplanowane = [];
  bo.ustawPlanowanie((fn, ms) => { zaplanowane.push(ms); return null; });
  for (const [i, status] of [[0, 429], [1, 503], [2, 'siec'], [3, 502]].entries()) {
    const r = await bo.wyslijKolejke(p, { fetchImpl: atrapaFetch(status, {}), now: () => teraz, force: true });
    assert.equal(r.ponowienie, true);
    assert.equal(r.za_min, [1, 2, 4, 8][i]);
  }
  assert.deepEqual(zaplanowane, [60000, 120000, 240000, 480000]);
  const r5 = await bo.wyslijKolejke(p, { fetchImpl: atrapaFetch(503, {}), now: () => teraz, force: true });
  assert.equal(r5.ponowienie, false);
  assert.equal(bo._stan.nastepnaProbaO, 0);
  assert.ok(p.rows.every(x => x.status === 'nowy'));
});

test('tryb próbny: paczka wypisana, fetch nietknięty, wiersze zostają', async () => {
  const p = atrapaPrisma(wiersze());
  const f = atrapaFetch(200, { ok: true });
  const r = await bo.wyslijKolejke(p, { fetchImpl: f, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.paczka.wiadomosci.length, 3);
  assert.equal(f.wywolania.length, 0);
  assert.ok(p.rows.every(x => x.status === 'nowy'));
});

test('brak tokenu: nic nie wysyłamy, kolejka czeka', async () => {
  delete process.env.BELL_OUTREACH_TOKEN;
  const p = atrapaPrisma(wiersze());
  const f = atrapaFetch(200, { ok: true });
  const r = await bo.wyslijKolejke(p, { fetchImpl: f });
  assert.equal(r.pominieto, 'brak tokenu');
  assert.equal(f.wywolania.length, 0);
});

test('adresSkrzynki: konto IMAP → To z własnej domeny → nazwa skrzynki', () => {
  assert.equal(bo.adresSkrzynki({ kontoAdres: 'Info@SurfStickBell.com', toEmail: 'alias@surfstickbell.com', inbox: 'info' }), 'info@surfstickbell.com');
  assert.equal(bo.adresSkrzynki({ toEmail: 'info@surfstickbell.fr', inbox: 'info_fr' }), 'info@surfstickbell.fr');
  assert.equal(bo.adresSkrzynki({ toEmail: 'ktos@obcy.de', inbox: 'niko' }), 'niko@surfstickbell.com');
});
