'use strict';

/* Testy filtra maili rozgrzewających (Instantly warmup, 22.10.2026).
 *
 * Prawdziwy poller (src/inbox-poller.js) na podstawionej skrzynce IMAP i
 * podstawionej bazie, z wyłączoną siecią. Sprawdzamy ZACHOWANIE, nie kod:
 * mail rozgrzewający nie zostawia zapisu, powiadomienia, zadania, wiersza
 * Bell Outreach ani śladu w statystykach, a na serwerze poczty nic się nie
 * zmienia; zwykła odpowiedź klienta przechodzi jak dotąd.
 * Uruchomienie: npm test */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const SRC = path.join(__dirname, '..', 'src');

// ── środowisko: zero sieci, zero prawdziwej bazy ─────────────────────────────
delete process.env.WARMUP_TAGS;
delete process.env.ANTHROPIC_API_KEY;
process.env.BELL_OUTREACH_TOKEN = 'test-token';
process.env.IMAP_ACCOUNTS = JSON.stringify([{ inbox: 'info', user: 'info@surfstickbell.com', pass: 'x', host: 'imap.test', port: 993 }]);
const KONTO = JSON.parse(process.env.IMAP_ACCOUNTS)[0];

const https = require('https');
https.request = () => {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => setImmediate(() => req.emit('error', new Error('sieć wyłączona w testach')));
  req.destroy = () => {};
  req.setTimeout = () => req;
  return req;
};
global.fetch = async () => { throw new Error('sieć wyłączona w testach'); };

// ── rejestr wszystkiego, co poller „zrobił" ─────────────────────────────────
const Z = { telegram: [], push: [], aktywnosc: [], prisma: [], imap: [], log: [] };
const baza = { imapState: new Map(), emaile: [], skipy: [], bell: [], nadpisania: {} };
function wyczysc() {
  for (const k of Object.keys(Z)) Z[k].length = 0;
  baza.imapState.clear(); baza.emaile.length = 0; baza.skipy.length = 0; baza.bell.length = 0; baza.nadpisania = {};
}

function domyslna(metoda) {
  if (metoda === 'findMany' || metoda === 'groupBy') return [];
  if (metoda === 'count') return 0;
  if (metoda.startsWith('find')) return null;
  if (metoda === 'updateMany' || metoda === 'deleteMany') return { count: 0 };
  return { id: 'x' };
}
const zapisz = (model, metoda, args) => Z.prisma.push({ model, metoda, args });
const modele = {
  imapState: {
    findUnique: async ({ where }) => baza.imapState.get(where.inbox) || null,
    upsert: async ({ where, update, create }) => {
      zapisz('imapState', 'upsert', { where, update, create });
      const cur = baza.imapState.get(where.inbox);
      const nowy = cur ? Object.assign(cur, update) : { ...create };
      baza.imapState.set(where.inbox, nowy);
      return nowy;
    },
    update: async ({ where, data }) => {
      zapisz('imapState', 'update', { where, data });
      const cur = baza.imapState.get(where.inbox);
      if (!cur) throw new Error('brak wiersza ImapState');
      return Object.assign(cur, data);
    },
  },
  email: {
    create: async ({ data }) => {
      zapisz('email', 'create', { data });
      const e = { id: `email-${baza.emaile.length + 1}`, ...data };
      baza.emaile.push(e);
      return e;
    },
  },
  emailSkip: {
    upsert: async (args) => { zapisz('emailSkip', 'upsert', args); baza.skipy.push(args.create); return {}; },
  },
  bellOutreachMsg: {
    create: async ({ data }) => { zapisz('bellOutreachMsg', 'create', { data }); baza.bell.push(data); return data; },
  },
};
const fakePrisma = new Proxy(modele, {
  get(cel, model) {
    if (typeof model === 'symbol' || model === 'then') return undefined;
    if (String(model).startsWith('$')) return async (x) => (typeof x === 'function' ? x(fakePrisma) : Array.isArray(x) ? Promise.all(x) : null);
    const znane = cel[model] || {};
    return new Proxy(znane, {
      get(m, metoda) {
        const klucz = `${String(model)}.${String(metoda)}`;
        if (baza.nadpisania[klucz]) return async (args) => { zapisz(String(model), String(metoda), args); return baza.nadpisania[klucz](args); };
        if (metoda in m) return m[metoda];
        return async (args) => { zapisz(String(model), String(metoda), args); return domyslna(String(metoda)); };
      },
    });
  },
});

// ── podstawiona skrzynka IMAP (node-imap) ───────────────────────────────────
const skrzynka = { INBOX: [], Sent: [] };
const OPERACJE_ZAPISU = ['addFlags', 'setFlags', 'delFlags', 'addKeywords', 'setKeywords', 'delKeywords', 'move', 'copy', 'expunge', 'append', 'delBox', 'renameBox'];
class FakeImap extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; this.otwarta = null; this.zniszczone = false; FakeImap.instancje.push(this); }
  connect() {
    // Wolny serwer: połączenie dla wskazanego konta „wisi", dopóki test go nie zwolni.
    if (FakeImap.trzymaj.has(this.opts && this.opts.user)) {
      FakeImap.wstrzymane.push(this);
      this.zwolnij = () => this.emit('ready');
      return;
    }
    setImmediate(() => this.emit('ready'));
  }
  end() { Z.imap.push({ op: 'end' }); }
  destroy() { this.zniszczone = true; Z.imap.push({ op: 'destroy' }); }
  getBoxes(cb) {
    cb(null, {
      INBOX: { attribs: [], delimiter: '/', children: null },
      Sent: { attribs: ['\\Sent'], delimiter: '/', children: null },
    });
  }
  openBox(nazwa, tylkoOdczyt, cb) {
    Z.imap.push({ op: 'openBox', nazwa, tylkoOdczyt });
    this.otwarta = nazwa;
    const lista = skrzynka[nazwa] || [];
    const maxUid = lista.reduce((m, x) => Math.max(m, x.uid), 0);
    cb(null, { messages: { total: lista.length, unseen: 0 }, uidvalidity: 7, uidnext: maxUid + 1 });
  }
  search(kryteria, cb) {
    Z.imap.push({ op: 'search', kryteria });
    let uids = (skrzynka[this.otwarta] || []).map(x => x.uid);
    for (const k of kryteria) {
      if (Array.isArray(k) && k[0] === 'UID') { const od = Number(String(k[1]).split(':')[0]); uids = uids.filter(u => u >= od); }
    }
    cb(null, uids);
  }
  fetch(uids, opcje) {
    Z.imap.push({ op: 'fetch', uids: [...uids], markSeen: !!(opcje && opcje.markSeen) });
    const f = new EventEmitter();
    const lista = (skrzynka[this.otwarta] || []).filter(x => uids.includes(x.uid));
    setImmediate(async () => {
      const konce = [];
      let seq = 0;
      for (const m of lista) {
        const msg = new EventEmitter();
        f.emit('message', msg, ++seq);
        msg.emit('attributes', { uid: m.uid, date: new Date() });
        const strumien = new PassThrough();
        konce.push(new Promise(ok => strumien.on('end', () => { msg.emit('end'); ok(); })));
        msg.emit('body', strumien, { which: '' });
        strumien.end(Buffer.from(m.raw));
      }
      await Promise.all(konce);
      setImmediate(() => f.emit('end'));
    });
    return f;
  }
}
FakeImap.instancje = [];
FakeImap.trzymaj = new Set();
FakeImap.wstrzymane = [];
for (const op of OPERACJE_ZAPISU) {
  FakeImap.prototype[op] = function (...a) { Z.imap.push({ op }); const cb = a[a.length - 1]; if (typeof cb === 'function') cb(null); };
}

// ── podmiana modułów, zanim poller się załaduje ─────────────────────────────
function wstrzyknij(plik, exportsObj) {
  require.cache[plik] = { id: plik, filename: plik, loaded: true, exports: exportsObj };
}
const zSrc = rel => require.resolve(path.join(SRC, rel));
wstrzyknij(require.resolve('imap', { paths: [SRC] }), FakeImap);
wstrzyknij(zSrc('db'), fakePrisma);
wstrzyknij(zSrc('telegram-utils'), {
  sendTelegram: async (t, c, tekst) => { Z.telegram.push(String(tekst)); return { ok: true }; },
  sendTelegramPhoto: async () => { Z.telegram.push('[zdjęcie]'); return { ok: true }; },
  sendTelegramDocument: async () => { Z.telegram.push('[dokument]'); return { ok: true }; },
  stanKanalu: { wyslane: 0, bledy: 0 },
});
wstrzyknij(zSrc('services/telegram-helper'), {
  resolveTelegram: async () => ({ token: 'T', chatId: 'C', ready: true }),
  resolveToken: async () => ({ token: 'T' }),
  resolveChatId: async () => ({ chatId: 'C' }),
});
wstrzyknij(zSrc('routes/push'), { sendPushToAll: async (p, payload) => { Z.push.push(payload); } });
wstrzyknij(zSrc('services/activity-log'), { logActivity: (p, ev) => { Z.aktywnosc.push(ev); } });
wstrzyknij(zSrc('order-llm-parser'), { parseOrderWithLLM: async () => null });
wstrzyknij(zSrc('vies'), { verifyVat: async () => ({ valid: false }) });
wstrzyknij(zSrc('services/contractor-match'), { findBestContractors: async () => [], sameContractorName: () => false });

// Log: przechwytujemy, żeby sprawdzić, że nie ma w nim adresów ani tematów
// maili rozgrzewających.
const oryginalnyLog = console.log;
const oryginalnyWarn = console.warn;
const oryginalnyError = console.error;
const lap = (...a) => Z.log.push(a.map(String).join(' '));
console.log = lap; console.warn = lap; console.error = lap;

const poller = require(path.join(SRC, 'inbox-poller'));
poller.stopPolling();
const rozgrzewanie = require(path.join(SRC, 'services/rozgrzewanie'));
const bellOutreach = require(path.join(SRC, 'services/bell-outreach'));
const { zbadajSkrzynke } = require(path.join(SRC, 'routes/poczta-zdrowie'));

test.after(() => { console.log = oryginalnyLog; console.warn = oryginalnyWarn; console.error = oryginalnyError; });

// ── budowanie wiadomości RFC 822 ────────────────────────────────────────────
let nrWiadomosci = 0;
function wiadomosc({ uid, from = 'Partner Warmup <lena@warm-partner.io>', to = 'info@surfstickbell.com', subject, text, html, inReplyTo }) {
  nrWiadomosci++;
  const naglowki = [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`,
    `Message-ID: <test-${nrWiadomosci}@test.local>`, 'Date: Wed, 21 Oct 2026 10:00:00 +0000', 'MIME-Version: 1.0',
  ];
  if (inReplyTo) naglowki.push(`In-Reply-To: <${inReplyTo}>`);
  let tresc;
  if (html && text) {
    naglowki.push('Content-Type: multipart/alternative; boundary="GRANICA"');
    tresc = `--GRANICA\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n--GRANICA\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n--GRANICA--`;
  } else if (html) {
    naglowki.push('Content-Type: text/html; charset=utf-8');
    tresc = html;
  } else {
    naglowki.push('Content-Type: text/plain; charset=utf-8');
    tresc = text || '';
  }
  return { uid, raw: `${naglowki.join('\r\n')}\r\n\r\n${tresc}\r\n`, from, subject };
}

function przygotujInbox(lastUid, wiadomosci) {
  wyczysc();
  baza.imapState.set('info', { inbox: 'info', lastUid, uidValidity: 7 });
  skrzynka.INBOX = wiadomosci;
}

const dotknieteModele = () => new Set(Z.prisma.map(z => z.model));
const OPERACJE_ZAPISU_WYKONANE = () => Z.imap.filter(x => OPERACJE_ZAPISU.includes(x.op));

function sprawdzBrakSladow(maile, opis) {
  assert.equal(baza.emaile.length, 0, `${opis}: nic nie zapisane w Email`);
  assert.equal(baza.skipy.length, 0, `${opis}: brak EmailSkip (statystyki)`);
  assert.equal(baza.bell.length, 0, `${opis}: nic do Bell Outreach`);
  assert.equal(Z.telegram.length, 0, `${opis}: brak Telegrama`);
  assert.equal(Z.push.length, 0, `${opis}: brak pusha`);
  assert.equal(Z.aktywnosc.length, 0, `${opis}: brak wpisu w dzienniku aktywności`);
  assert.deepEqual([...dotknieteModele()].filter(m => m !== 'imapState'), [], `${opis}: baza dotknięta tylko w ImapState (UID + ślad)`);
  assert.deepEqual(OPERACJE_ZAPISU_WYKONANE(), [], `${opis}: żadnej zmiany na serwerze poczty`);
  assert.ok(Z.imap.filter(x => x.op === 'openBox').every(x => x.tylkoOdczyt === true), `${opis}: skrzynka otwarta tylko do odczytu`);
  assert.ok(Z.imap.filter(x => x.op === 'fetch').every(x => x.markSeen === false), `${opis}: pobranie bez oznaczania jako przeczytane`);
  for (const m of maile) {
    const adres = (m.from.match(/<([^>]+)>/) || [])[1];
    for (const linia of Z.log) {
      assert.ok(!linia.includes(adres), `${opis}: adres nadawcy w logu: ${linia}`);
      assert.ok(!linia.includes(m.subject), `${opis}: temat w logu: ${linia}`);
    }
  }
}

// ── 1. rozpoznawanie ────────────────────────────────────────────────────────

test('znacznik w temacie w dowolnej wielkości liter', () => {
  delete process.env.WARMUP_TAGS;
  assert.equal(rozgrzewanie.jestRozgrzewaniem({ subject: 'Quick question 4ASVTZE' }), '4ASVTZE');
  assert.equal(rozgrzewanie.jestRozgrzewaniem({ subject: 'quick question 4asvtze' }), '4ASVTZE');
  assert.equal(rozgrzewanie.jestRozgrzewaniem({ subject: 'Re: 4aSvTzE lunch' }), '4ASVTZE');
});

test('znacznik tylko w treści: tekst albo surowy HTML', () => {
  delete process.env.WARMUP_TAGS;
  assert.equal(rozgrzewanie.jestRozgrzewaniem({ subject: 'Hello', text: 'Thanks!\n\n4ASVTZE' }), '4ASVTZE');
  assert.equal(rozgrzewanie.jestRozgrzewaniem({ subject: 'Hello', html: '<p>Hi</p><span style="display:none">4asvtze</span>' }), '4ASVTZE');
  assert.equal(rozgrzewanie.jestRozgrzewaniem({ subject: 'Hello', bodyHtml: '<div>x 4ASVTZE</div>' }), '4ASVTZE');
  assert.equal(rozgrzewanie.jestRozgrzewaniem({ subject: 'Hello', text: 'Nice shots!', html: '<p>Nice shots!</p><div data-w="4asvtze"></div>' }), '4ASVTZE');
});

test('zwykła odpowiedź klienta bez znacznika nie jest rozgrzewaniem', () => {
  delete process.env.WARMUP_TAGS;
  assert.equal(rozgrzewanie.jestRozgrzewaniem({ subject: 'Re: Sonnenschutz fuer Ihr Geschaeft', text: 'Bitte senden Sie uns den Katalog.' }), null);
  assert.equal(rozgrzewanie.jestRozgrzewaniem({ subject: 'Re: 4ASVTZ', text: 'prawie znacznik, ale nie ten' }), null);
});

test('WARMUP_TAGS z dwoma znacznikami; pusta lista = znacznik domyślny', () => {
  process.env.WARMUP_TAGS = ' 4ASVTZE , XQ7PLM2 ';
  assert.deepEqual(rozgrzewanie.znacznikiRozgrzewania(), ['4ASVTZE', 'XQ7PLM2']);
  assert.equal(rozgrzewanie.jestRozgrzewaniem({ subject: 'Hi 4asvtze' }), '4ASVTZE');
  assert.equal(rozgrzewanie.jestRozgrzewaniem({ subject: 'Hi', text: 'tail xq7plm2' }), 'XQ7PLM2');
  assert.equal(rozgrzewanie.jestRozgrzewaniem({ subject: 'Re: Angebot', text: 'normal' }), null);
  process.env.WARMUP_TAGS = ' , ';
  assert.deepEqual(rozgrzewanie.znacznikiRozgrzewania(), ['4ASVTZE']);
  delete process.env.WARMUP_TAGS;
  assert.deepEqual(rozgrzewanie.znacznikiRozgrzewania(), ['4ASVTZE']);
  assert.deepEqual(rozgrzewanie.kryteriaBezRozgrzewania(), [['!SUBJECT', '4ASVTZE']]);
});

// ── 2. poller: nowe maile w INBOX ───────────────────────────────────────────

test('poller: temat ze znacznikiem (różna wielkość liter) — pominięty, bez powiadomienia, bez zmian na serwerze', async () => {
  delete process.env.WARMUP_TAGS;
  const maile = [
    wiadomosc({ uid: 101, subject: 'Quick question about your schedule 4ASVTZE', text: 'Hi, how is it going?' }),
    wiadomosc({ uid: 102, from: 'Mark Warm <mark@warmnet.example>', subject: 're: lunch next week 4asvtze', text: 'Sounds good', inReplyTo: 'x@warmnet.example' }),
    wiadomosc({ uid: 103, from: 'Ola <ola@inny-warm.example>', subject: 'Fwd: ideas 4aSvTzE', text: 'See below' }),
  ];
  przygotujInbox(100, maile);
  rozgrzewanie.zacznijCykl(1);
  await poller._test.processAccount(KONTO);
  const cykl = rozgrzewanie.zakonczCykl();

  sprawdzBrakSladow(maile, 'temat');
  const st = baza.imapState.get('info');
  assert.equal(st.lastUid, 103, 'UID poszedł do przodu — następny cykl ich nie pobierze');
  assert.ok(st.rozgrzewanieO instanceof Date, 'ślad dla /poczta/zdrowie');
  assert.equal(cykl.inbox, 3);
  assert.equal(cykl.pominieto, 3);
  assert.ok(Z.log.some(l => l === '[rozgrzewanie] cykl 1: pominięto 3 (INBOX 3, Wysłane 0, rescan 0)'), 'jedna linia z samą liczbą');
});

test('poller: znacznik tylko w treści (tekst albo HTML) — też pominięty', async () => {
  delete process.env.WARMUP_TAGS;
  const maile = [
    wiadomosc({ uid: 201, subject: 'Following up on our call', text: 'Let me know what you think.\n\n4ASVTZE' }),
    wiadomosc({ uid: 202, from: 'Kim <kim@warm-html.example>', subject: 'Re: design draft', html: '<p>Looks great!</p><span style="font-size:1px;color:#fff">4asvtze</span>' }),
    // Znacznik WYŁĄCZNIE w znacznikach HTML (atrybut, komentarz) — nie ma go w
    // tekście, który parser wyciąga z HTML. Sprawdza ścieżkę „surowy HTML".
    wiadomosc({ uid: 203, from: 'Rui <rui@warm-attr.example>', subject: 'Re: photos', html: '<p>Nice shots!</p><div data-w="4ASVTZE"></div><!-- 4asvtze -->' }),
  ];
  przygotujInbox(200, maile);
  await poller._test.processAccount(KONTO);
  sprawdzBrakSladow(maile, 'treść');
  assert.equal(baza.imapState.get('info').lastUid, 203);
});

test('poller: zwykła odpowiedź klienta (Re: …) bez znacznika — zapis, Telegram, push i Bell jak dotąd', async () => {
  delete process.env.WARMUP_TAGS;
  const klient = wiadomosc({
    uid: 301, from: 'Anna Berger <anna@kunde-shop.de>', subject: 'Re: Sonnenschutz fuer Ihr Geschaeft',
    text: 'Guten Tag, bitte senden Sie uns den Katalog und die Preisliste.', inReplyTo: 'nasz-1@surfstickbell.com',
  });
  const rozgrz = wiadomosc({ uid: 302, subject: 'Thoughts on Q4 4ASVTZE', text: 'warmup' });
  przygotujInbox(300, [klient, rozgrz]);
  await poller._test.processAccount(KONTO);

  assert.equal(baza.emaile.length, 1, 'tylko mail klienta w CRM');
  assert.equal(baza.emaile[0].fromEmail, 'anna@kunde-shop.de');
  assert.equal(baza.emaile[0].direction, 'INBOUND');
  assert.ok(Z.telegram.some(t => t.includes('anna@kunde-shop.de') && t.includes('Temat:')), 'zwykłe powiadomienie Telegram');
  assert.ok(!Z.telegram.some(t => t.includes('Thoughts on Q4')), 'rozgrzewanie bez Telegrama');
  assert.equal(Z.push.length, 1, 'jeden push — dla klienta');
  assert.equal(baza.bell.length, 1, 'odpowiedź klienta trafia do Bell Outreach');
  assert.equal(baza.bell[0].rodzaj, 'zainteresowany');
  assert.ok(Z.aktywnosc.some(a => a.type === 'mail.received'), 'wpis w aktywności dla klienta');
  assert.equal(baza.imapState.get('info').lastUid, 302);
  assert.deepEqual(OPERACJE_ZAPISU_WYKONANE(), []);
});

test('poller: WARMUP_TAGS z dwoma znacznikami — oba pominięte, klient przechodzi', async () => {
  process.env.WARMUP_TAGS = '4ASVTZE,XQ7PLM2';
  const maile = [
    wiadomosc({ uid: 401, subject: 'Catch up soon 4ASVTZE', text: 'hi' }),
    wiadomosc({ uid: 402, from: 'Ben <ben@warm-two.example>', subject: 'Project update', text: 'All good.\n\nxq7plm2' }),
  ];
  const klient = wiadomosc({ uid: 403, from: 'Luca <luca@negozio.it>', subject: 'R: Protezione solare', text: 'Grazie, inviateci il listino prezzi.', inReplyTo: 'nasz-2@surfstickbell.com' });
  przygotujInbox(400, [...maile, klient]);
  await poller._test.processAccount(KONTO);
  assert.deepEqual(baza.emaile.map(e => e.fromEmail), ['luca@negozio.it']);
  assert.ok(!Z.telegram.some(t => t.includes('ben@warm-two.example') || t.includes('Catch up soon')));
  assert.equal(baza.imapState.get('info').lastUid, 403);
  delete process.env.WARMUP_TAGS;
});

// ── 3. inne foldery i ścieżki czytania ──────────────────────────────────────

test('Wysłane: rozgrzewanie wysłane z naszej skrzynki nie trafia do CRM', async () => {
  delete process.env.WARMUP_TAGS;
  wyczysc();
  baza.imapState.set('info:sent', { inbox: 'info:sent', lastUid: 10 });
  const rozgrz = wiadomosc({ uid: 11, from: 'Surf Stick <info@surfstickbell.com>', to: 'lena@warm-partner.io', subject: 'Checking in 4ASVTZE', text: 'hello' });
  const zwykly = wiadomosc({ uid: 12, from: 'Surf Stick <info@surfstickbell.com>', to: 'anna@kunde-shop.de', subject: 'Angebot Surf Stick', text: 'Anbei unser Angebot.' });
  skrzynka.Sent = [rozgrz, zwykly];
  await poller._test.processSentItems(KONTO);
  assert.deepEqual(baza.emaile.map(e => [e.direction, e.toEmail]), [['OUTBOUND', 'anna@kunde-shop.de']]);
  assert.equal(baza.imapState.get('info:sent').lastUid, 12);
  assert.ok(!Z.aktywnosc.some(a => String(a.summary).includes('Checking in')));
  assert.deepEqual(OPERACJE_ZAPISU_WYKONANE(), []);
  assert.ok(Z.imap.filter(x => x.op === 'openBox').every(x => x.tylkoOdczyt === true));
});

test('rescan (godzinny / po przerwie): rozgrzewanie nie jest dopisywane do CRM', async () => {
  delete process.env.WARMUP_TAGS;
  const rozgrz = wiadomosc({ uid: 51, subject: 'Weekend plans 4ASVTZE', text: 'hi' });
  const klient = wiadomosc({ uid: 52, from: 'Anna Berger <anna@kunde-shop.de>', subject: 'Re: Sonnenschutz', text: 'Danke, wir melden uns.', inReplyTo: 'nasz-3@surfstickbell.com' });
  przygotujInbox(60, [rozgrz, klient]);
  const wynik = await poller.rescanInboxSince('info', 2);
  assert.equal(wynik.rozgrzewanie, 1);
  assert.equal(wynik.added, 1);
  assert.deepEqual(baza.emaile.map(e => e.fromEmail), ['anna@kunde-shop.de']);
  assert.equal(Z.telegram.length, 0, 'rescan nigdy nie powiadamia');
  assert.ok(Z.log.some(l => l === '[rozgrzewanie] rescan info: pominięto 1'));
  assert.deepEqual(OPERACJE_ZAPISU_WYKONANE(), []);
  const szukanie = Z.imap.find(x => x.op === 'search');
  assert.deepEqual(szukanie.kryteria.slice(1), [['!SUBJECT', '4ASVTZE']], 'rescan odcina rozgrzewanie już w SEARCH');
});

// ── 4. Bell Outreach ────────────────────────────────────────────────────────

test('Bell Outreach: rozgrzewanie nie wchodzi do kolejki ani do wysyłki', async () => {
  delete process.env.WARMUP_TAGS;
  wyczysc();
  const r = await bellOutreach.kolejkujZMaila(fakePrisma, { messageId: '<w@x>', fromEmail: 'lena@warm-partner.io', subject: 'Re: hello 4ASVTZE', bodyText: 'ok', inReplyTo: '<a@b>' }, { inbox: 'info' });
  assert.equal(r, null);
  assert.equal(baza.bell.length, 0);

  const wiersze = [
    { messageId: '<w1@x>', skrzynka: 'info@surfstickbell.com', od: 'lena@warm-partner.io', temat: 'Re: lunch 4asvtze', rodzaj: 'odpowiedz', data: new Date(), status: 'nowy' },
    { messageId: '<k1@x>', skrzynka: 'info@surfstickbell.com', od: 'anna@kunde-shop.de', temat: 'Re: Sonnenschutz', rodzaj: 'odpowiedz', data: new Date(), status: 'nowy' },
  ];
  const wyslane = [];
  const fetchImpl = async (url, o) => { wyslane.push(JSON.parse(o.body)); return { status: 200, json: async () => ({ ok: true, przyjete: 1, juz_byly: 0, dopasowane: 1, czarna_lista: { adresy: 0, domeny: 0 }, pominiete: [] }) }; };
  await bellOutreach.wyslijWiersze(fakePrisma, wiersze, { fetchImpl });
  assert.equal(wyslane.length, 1);
  assert.deepEqual(wyslane[0].wiadomosci.map(w => w.message_id), ['<k1@x>']);
  const oznaczenie = Z.prisma.find(z => z.model === 'bellOutreachMsg' && z.metoda === 'updateMany' && z.args.data.powod === 'rozgrzewanie');
  assert.ok(oznaczenie, 'wiersz z rozgrzewania oznaczony jako pominięty');
  assert.deepEqual(oznaczenie.args.where.messageId.in, ['<w1@x>']);
});

// ── 5. maile, które już są w CRM (punkt 4) ──────────────────────────────────

test('oznaczIstniejace: tag + przeczytane, zadania zamknięte, aktywność schowana, Bell pominięty; dry tylko liczy', async () => {
  process.env.WARMUP_TAGS = '4ASVTZE,XQ7PLM2';
  wyczysc();
  baza.nadpisania['email.findMany'] = async () => [
    { id: 'e1', messageId: '<a@x>', direction: 'INBOUND' },
    { id: 'e2', messageId: '<b@x>', direction: 'OUTBOUND' },
  ];
  baza.nadpisania['email.updateMany'] = async () => ({ count: 2 });
  baza.nadpisania['task.updateMany'] = async () => ({ count: 1 });
  baza.nadpisania['activityEvent.updateMany'] = async () => ({ count: 2 });
  baza.nadpisania['bellOutreachMsg.updateMany'] = async () => ({ count: 1 });
  const w = await rozgrzewanie.oznaczIstniejace(fakePrisma);
  assert.deepEqual({ maili: w.maili, przych: w.przychodzacych, wych: w.wychodzacych, zadan: w.zadan, akt: w.aktywnosci, bell: w.bell }, { maili: 2, przych: 1, wych: 1, zadan: 1, akt: 2, bell: 1 });

  const szukanie = Z.prisma.find(z => z.model === 'email' && z.metoda === 'findMany').args.where;
  assert.equal(szukanie.OR.length, 8, '2 znaczniki × temat/podgląd/treść/HTML');
  assert.ok(szukanie.OR.every(w => Object.values(w)[0].mode === 'insensitive'));
  const upd = Z.prisma.find(z => z.model === 'email' && z.metoda === 'updateMany').args;
  assert.deepEqual(upd.where, { id: { in: ['e1', 'e2'] } });
  assert.deepEqual(upd.data, { isRead: true, tags: { push: 'rozgrzewanie' } });
  const zad = Z.prisma.find(z => z.model === 'task' && z.metoda === 'updateMany').args;
  assert.equal(zad.data.status, 'DONE');
  const bell = Z.prisma.find(z => z.model === 'bellOutreachMsg' && z.metoda === 'updateMany').args;
  assert.deepEqual(bell.data, { status: 'pominiety', powod: 'rozgrzewanie' });

  wyczysc();
  baza.nadpisania['email.findMany'] = async () => [{ id: 'e1', messageId: '<a@x>', direction: 'INBOUND' }];
  const d = await rozgrzewanie.oznaczIstniejace(fakePrisma, { dry: true });
  assert.equal(d.dry, true);
  assert.equal(d.maili, 1);
  assert.ok(!Z.prisma.some(z => z.metoda === 'updateMany'), 'dry nic nie zmienia');
  delete process.env.WARMUP_TAGS;
});

// ── 6. /poczta/zdrowie: rozgrzewanie nie robi fałszywego „gubimy" ───────────

test('/poczta/zdrowie: najnowsza na serwerze jest rozgrzewająca — ślad zapobiega fałszywemu „gubimy"', async () => {
  const godzinaTemu = n => new Date(Date.now() - n * 3600 * 1000);
  class ImapZdrowie extends EventEmitter {
    connect() { setImmediate(() => this.emit('ready')); }
    end() {}
    destroy() {}
    openBox(n, ro, cb) { cb(null, { messages: { total: 5, unseen: 0 }, uidvalidity: 7, uidnext: 101 }); }
    get seq() {
      return { fetch: () => {
        const f = new EventEmitter();
        setImmediate(() => { const m = new EventEmitter(); f.emit('message', m); m.emit('attributes', { date: godzinaTemu(0.2) }); f.emit('end'); });
        return f;
      } };
    }
  }
  const przygotuj = (rozgrzewanieO) => {
    wyczysc();
    baza.imapState.set('info', { inbox: 'info', lastUid: 100, uidValidity: 7, lastOkAt: new Date(), rozgrzewanieO });
    baza.nadpisania['email.findFirst'] = async () => ({ createdAt: godzinaTemu(6) });
    baza.nadpisania['kanarekPoczty.findFirst'] = async () => ({ nadawca: 'niko', wyslanoO: godzinaTemu(1), potwierdzonoO: godzinaTemu(0.99) });
  };
  przygotuj(null);
  const bez = await zbadajSkrzynke(ImapZdrowie, KONTO);
  assert.equal(bez.stan, 'gubimy', 'bez śladu: dawny fałszywy alarm');
  przygotuj(godzinaTemu(0.1));
  const ze = await zbadajSkrzynke(ImapZdrowie, KONTO);
  assert.notEqual(ze.stan, 'gubimy', 'ze śladem rozgrzewania: nie gubimy');
  const liczniki = Z.prisma.filter(z => z.model === 'email' && (z.metoda === 'count' || z.metoda === 'findFirst'));
  assert.ok(liczniki.length >= 3 && liczniki.every(z => JSON.stringify(z.args.where).includes('rozgrzewanie')), 'liczniki maili bez tagu rozgrzewanie');
});

// ── 7. zawieszony cykl pollera (22.10.2026) ─────────────────────────────────

const czekajAz = async (warunek, opis, ile = 2000) => {
  for (let i = 0; i < ile; i++) { if (warunek()) return; await new Promise(r => setImmediate(r)); }
  throw new Error(`nie doczekałem się: ${opis}`);
};

test('zawieszony cykl: porzucony kończy się na granicy skrzynki i nie zwalnia blokady nowego cyklu', { timeout: 20000 }, async (t) => {
  const kontaPrzed = process.env.IMAP_ACCOUNTS;
  const INFO = 'info@surfstickbell.com';
  const NIKO = 'niko@surfstickbell.com';
  process.env.IMAP_ACCOUNTS = JSON.stringify([
    { inbox: 'info', user: INFO, pass: 'x', host: 'imap.test', port: 993 },
    { inbox: 'niko', user: NIKO, pass: 'x', host: 'imap.test', port: 993 },
  ]);
  t.after(() => { process.env.IMAP_ACCOUNTS = kontaPrzed; FakeImap.trzymaj.clear(); });
  wyczysc();
  baza.imapState.set('info', { inbox: 'info', lastUid: 10, uidValidity: 7 });
  baza.imapState.set('niko', { inbox: 'niko', lastUid: 20, uidValidity: 7 });
  skrzynka.INBOX = []; skrzynka.Sent = [];
  FakeImap.instancje.length = 0; FakeImap.wstrzymane.length = 0; FakeImap.trzymaj.clear();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const polaczeniaDla = user => FakeImap.instancje.filter(i => i.opts.user === user).length;

  // Cykl A utyka na połączeniu z info@ (wolny serwer poczty).
  FakeImap.trzymaj.add(INFO);
  const cyklA = poller.pollAll();
  await czekajAz(() => FakeImap.wstrzymane.length === 1, 'A czeka na info@');
  assert.equal(poller._test.stanCyklu().etapCyklu, 'info: INBOX');

  // 16 minut później tick startuje cykl B; ten utknie na niko@.
  t.mock.timers.tick(16 * 60 * 1000);
  FakeImap.trzymaj.delete(INFO);
  FakeImap.trzymaj.add(NIKO);
  const cyklB = poller.pollAll();
  await czekajAz(() => FakeImap.wstrzymane.length === 2, 'B czeka na niko@');
  FakeImap.trzymaj.delete(NIKO); // dalsze połączenia B (Wysłane niko@) idą normalnie
  const alert = Z.telegram.find(m => m.includes('porzucony'));
  assert.ok(alert && alert.includes('utknął na: info: INBOX'), 'alert mówi, gdzie cykl utknął');
  assert.ok(!alert.includes('z żadnej skrzynki'), 'alert nie twierdzi, że nie pobierano z żadnej skrzynki');

  // A się odwiesza: kończy info@ i wychodzi — nie idzie do niko@ i nie rusza blokady B.
  FakeImap.wstrzymane[0].zwolnij();
  await cyklA;
  assert.equal(polaczeniaDla(NIKO), 1, 'porzucony cykl A nie otworzył niko@ (to jedno połączenie jest B)');
  assert.equal(poller._test.stanCyklu().pollInFlight, true, 'blokada należy nadal do B');

  // Kolejny tick, gdy B trwa: pominięty, żaden trzeci cykl nie rusza.
  const instancjiPrzed = FakeImap.instancje.length;
  await poller.pollAll();
  assert.equal(FakeImap.instancje.length, instancjiPrzed, 'trzeci cykl nie wystartował');
  assert.ok(Z.log.some(l => l.includes('poprzedni cykl wciąż trwa')));

  // B kończy normalnie i dopiero on zwalnia blokadę.
  FakeImap.wstrzymane[1].zwolnij();
  await cyklB;
  assert.equal(poller._test.stanCyklu().pollInFlight, false);
  assert.equal(polaczeniaDla(NIKO), 2, 'B: INBOX + Wysłane niko@');
});

test('połączenie, które nawiąże się po limicie czasu, jest od razu zamykane (bez osieroconych sesji)', { timeout: 20000 }, async (t) => {
  wyczysc();
  FakeImap.instancje.length = 0; FakeImap.wstrzymane.length = 0; FakeImap.trzymaj.clear();
  t.after(() => FakeImap.trzymaj.clear());
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  FakeImap.trzymaj.add(KONTO.user);
  const przebieg = poller._test.processSentItems(KONTO);
  await czekajAz(() => FakeImap.wstrzymane.length === 1, 'połączenie wisi');
  t.mock.timers.tick(60 * 1000);
  await przebieg;
  assert.ok(Z.log.some(l => l.includes('połączenie IMAP (Wysłane): przekroczono 60 s')), 'limit czasu zadziałał');
  const sesja = FakeImap.wstrzymane[0];
  assert.equal(sesja.zniszczone, false);
  sesja.zwolnij();
  await czekajAz(() => sesja.zniszczone, 'spóźnione połączenie zamknięte');
  assert.ok(sesja.zniszczone);
});


// ── 8. wolny serwer poczty: bezpiecznik, kanarki obok cyklu, kopia do Wysłanych ──

test('bezpiecznik: po 3 skrzynkach bez połączenia reszta czeka do następnego cyklu, cykl się kończy', { timeout: 20000 }, async (t) => {
  const kontaPrzed = process.env.IMAP_ACCOUNTS;
  const konta = ['a1', 'a2', 'a3', 'a4'].map(n => ({ inbox: n, user: `${n}@surfstickbell.com`, pass: 'x', host: 'imap.test', port: 993 }));
  process.env.IMAP_ACCOUNTS = JSON.stringify(konta);
  t.after(() => { process.env.IMAP_ACCOUNTS = kontaPrzed; FakeImap.trzymaj.clear(); });
  wyczysc();
  for (const k of konta) baza.imapState.set(k.inbox, { inbox: k.inbox, lastUid: 5, uidValidity: 7 });
  skrzynka.INBOX = []; skrzynka.Sent = [];
  FakeImap.instancje.length = 0; FakeImap.wstrzymane.length = 0; FakeImap.trzymaj.clear();
  for (const k of konta) FakeImap.trzymaj.add(k.user);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });

  const cykl = poller.pollAll();
  for (let i = 1; i <= 3; i++) {
    await czekajAz(() => FakeImap.wstrzymane.length === i, `połączenie ${i} wisi`);
    t.mock.timers.tick(60 * 1000);
  }
  await cykl;
  assert.equal(FakeImap.instancje.filter(x => x.opts.user === 'a4@surfstickbell.com').length, 0, 'czwarta skrzynka nie próbowała się łączyć');
  assert.equal(FakeImap.instancje.length, 3, 'żadnych prób Wysłanych przy niedziałającym serwerze');
  assert.ok(Z.log.some(l => l.includes('nie odpowiada') && l.includes('pominięte: a4')));
  assert.ok(Z.telegram.some(m => m.includes('Serwer poczty imap.test nie odpowiada')), 'jeden alert o serwerze');
  assert.equal(poller._test.stanCyklu().pollInFlight, false, 'cykl zakończony, nie porzucony');
});

test('kanarki idą obok cyklu: zawieszone SMTP nie trzyma odbioru poczty', { timeout: 20000 }, async (t) => {
  const kontaPrzed = process.env.IMAP_ACCOUNTS;
  process.env.IMAP_ACCOUNTS = JSON.stringify([
    { inbox: 'info', user: 'info@surfstickbell.com', pass: 'x', host: 'imap.test', port: 993 },
    { inbox: 'niko', user: 'niko@surfstickbell.com', pass: 'x', host: 'imap.test', port: 993 },
  ]);
  const plikPollera = require.resolve(path.join(SRC, 'inbox-poller'));
  const plikMailSender = zSrc('mail-sender');
  const mailSenderPrzed = require.cache[plikMailSender];
  t.after(() => { process.env.IMAP_ACCOUNTS = kontaPrzed; require.cache[plikMailSender] = mailSenderPrzed; });
  wyczysc();
  baza.imapState.set('info', { inbox: 'info', lastUid: 5, uidValidity: 7 });
  baza.imapState.set('niko', { inbox: 'niko', lastUid: 5, uidValidity: 7 });
  skrzynka.INBOX = []; skrzynka.Sent = [];
  FakeImap.trzymaj.clear();
  let wysylek = 0;
  wstrzyknij(plikMailSender, { sendMail: () => { wysylek++; return new Promise(() => {}); }, getAccounts: () => JSON.parse(process.env.IMAP_ACCOUNTS) });
  // Świeży moduł pollera = cykl nr 1, w którym idą kanarki.
  delete require.cache[plikPollera];
  const swiezy = require(plikPollera);
  swiezy.stopPolling();
  await swiezy.pollAll();
  assert.equal(swiezy._test.stanCyklu().pollInFlight, false, 'cykl skończył się, choć SMTP wisi');
  await czekajAz(() => wysylek === 1, 'kanarek wystartował w tle');
  assert.ok(Z.prisma.some(z => z.model === 'kanarekPoczty' && z.metoda === 'create'));
});

test('kopia do Wysłanych: limit 90 s, spóźnione połączenie zamknięte bez kopiowania', { timeout: 20000 }, async (t) => {
  const { appendToSent } = require(path.join(SRC, 'imap-sent'));
  wyczysc();
  FakeImap.instancje.length = 0; FakeImap.wstrzymane.length = 0; FakeImap.trzymaj.clear();
  t.after(() => FakeImap.trzymaj.clear());
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  FakeImap.trzymaj.add(KONTO.user);
  const kopia = appendToSent(KONTO, 'From: a@b\r\nSubject: x\r\n\r\ny');
  await czekajAz(() => FakeImap.wstrzymane.length === 1, 'połączenie wisi');
  t.mock.timers.tick(90 * 1000);
  const wynik = await kopia;
  assert.equal(wynik.ok, false);
  assert.match(wynik.reason, /przekroczono 90 s/);
  const sesja = FakeImap.wstrzymane[0];
  sesja.zwolnij();
  await czekajAz(() => sesja.zniszczone, 'spóźnione połączenie zamknięte');
  assert.ok(!Z.imap.some(x => x.op === 'append'), 'nic nie skopiowano po limicie');
});
