'use strict';

/* CO ZAJMUJE MIEJSCE W SKRZYNCE + SPRZĄTANIE KANARKÓW (3.11.2026).
 *
 * Nikodem dostał „skrzynka prawie pełna" i padło pytanie, czy zapycha ją nasz
 * system. Poller niczego w skrzynkach nie zmienia (czyta w trybie EXAMINE),
 * z dwoma wyjątkami:
 *  - kopia każdego maila wysłanego z CRM ląduje w Wysłanych — tak samo jak
 *    w każdym programie pocztowym;
 *  - KANAREK (test drożności co 6 h): odebrany był kasowany, ale jego kopia
 *    u nadawcy zostawała w Wysłanych. info@ wysyła 40 kanarków na dobę, więc
 *    od 7.09.2026 uzbierało się tam ok. 2,3 tys. testowych maili (niko@ ok.
 *    230). Od 3.11 kanarek idzie bez kopii (`sendMail({kopiaDoWyslanych:false})`),
 *    a stare kopie usuwa `usunKanarki`.
 *
 * `rozmiarSkrzynki` odpowiada, CO zajmuje miejsce: limit serwera (QUOTA),
 * foldery (liczba, MB), maile > 1 MB, maile rozgrzewające (Instantly) i
 * kanarki. Wyłącznie liczby — bez tematów, treści i adresów. Skrzynki
 * otwierane tylko do odczytu. */

const Imap = require('imap');
const { znacznikiRozgrzewania } = require('./rozgrzewanie');

const MARKER_KANARKA = '[CRM-KANAREK]';
const MB = 1024 * 1024;
const mb = (bajty) => Math.round((bajty / MB) * 10) / 10;
const p = (fn) => new Promise((resolve, reject) => fn((e, x) => (e ? reject(e) : resolve(x))));
function zLimitem(obietnica, ms) {
  let budzik;
  const limit = new Promise((_, rej) => { budzik = setTimeout(() => rej(new Error(`przekroczono ${ms / 1000} s`)), ms); });
  return Promise.race([obietnica, limit]).finally(() => clearTimeout(budzik));
}

function polacz(account) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: account.user, password: account.pass, host: account.host, port: account.port || 993,
      tls: true, tlsOptions: { rejectUnauthorized: false },
      connTimeout: 30000, authTimeout: 20000,
      keepalive: false, socketTimeout: 120000,
    });
    let rozstrzygniete = false;
    const raz = (fn, x) => { if (!rozstrzygniete) { rozstrzygniete = true; fn(x); } };
    imap.once('ready', () => raz(resolve, imap));
    imap.once('error', (e) => raz(reject, e));
    imap.once('close', () => raz(reject, new Error('połączenie IMAP zamknięte przed gotowością')));
    imap.connect();
  });
}

function splaszcz(boxes, prefix = '') {
  const out = [];
  for (const [nazwa, box] of Object.entries(boxes || {})) {
    const pelna = prefix ? prefix + box.delimiter + nazwa : nazwa;
    out.push({ nazwa: pelna, atrybuty: box.attribs || [] });
    if (box.children) out.push(...splaszcz(box.children, pelna));
  }
  return out;
}
const dostepne = (foldery) => foldery.filter(f => !f.atrybuty.some(a => /noselect/i.test(a)));

/** [{uid, size, date, temat?}] — `zakres` to '1:*' (numery porządkowe) albo lista UID. */
function pobierzMeta(imap, zakres, { poUid = false, temat = false } = {}) {
  return new Promise((resolve, reject) => {
    const wynik = [];
    const opcje = { size: true };
    if (temat) opcje.bodies = 'HEADER.FIELDS (SUBJECT)';
    const f = poUid ? imap.fetch(zakres, opcje) : imap.seq.fetch(zakres, opcje);
    f.on('message', (msg) => {
      const m = { uid: null, size: 0, date: null, temat: '' };
      msg.on('body', (strumien) => {
        let buf = '';
        strumien.on('data', (d) => { buf += d.toString('utf8'); });
        strumien.once('end', () => { const t = buf.match(/^Subject:\s*(.*(?:\r?\n[ \t].*)*)/im); m.temat = t ? t[1].replace(/\r?\n[ \t]/g, ' ').trim() : ''; });
      });
      msg.once('attributes', (a) => { m.uid = a.uid; m.size = a.size || 0; m.date = a.date || null; });
      msg.once('end', () => wynik.push(m));
    });
    f.once('error', reject);
    f.once('end', () => resolve(wynik));
  });
}

/** Raport rozmiaru jednej skrzynki. */
async function rozmiarSkrzynki(account, { limitMs = 150000 } = {}) {
  const start = Date.now();
  const imap = await polacz(account);
  try {
    const wynik = { skrzynka: account.inbox, host: account.host, limit: null, razemMB: 0, foldery: [], niepelny: false };
    if (typeof imap.serverSupports === 'function' && imap.serverSupports('QUOTA')) {
      try {
        const q = await zLimitem(p(cb => imap.getQuotaRoot('INBOX', cb)), 20000);
        const st = Object.values(q || {}).map(r => r && r.storage).find(Boolean);
        // RFC 2087: STORAGE w jednostkach 1024 bajtów
        if (st && st.limit) wynik.limit = { uzyteMB: mb(st.usage * 1024), limitMB: mb(st.limit * 1024), procent: Math.round((st.usage / st.limit) * 100) };
      } catch (e) { wynik.limitBlad = e.message; }
    }
    const znaczniki = znacznikiRozgrzewania();
    for (const f of dostepne(splaszcz(await p(cb => imap.getBoxes(cb))))) {
      if (Date.now() - start > limitMs) { wynik.niepelny = true; break; }
      let box;
      try { box = await p(cb => imap.openBox(f.nazwa, true, cb)); }
      catch (e) { wynik.foldery.push({ nazwa: f.nazwa, blad: e.message }); continue; }
      const folder = { nazwa: f.nazwa, wiadomosci: box.messages.total, mb: 0, duzeNad1MB: { n: 0, mb: 0 }, kanarki: { n: 0, kb: 0 }, rozgrzewanie: null };
      if (box.messages.total > 0) {
        const wszystkie = await zLimitem(pobierzMeta(imap, '1:*'), 60000);
        const rozmiar = new Map(wszystkie.map(m => [m.uid, m.size]));
        const suma = (uidy) => uidy.reduce((s, u) => s + (rozmiar.get(u) || 0), 0);
        const duze = wszystkie.filter(m => m.size > MB);
        folder.mb = mb(wszystkie.reduce((s, m) => s + m.size, 0));
        folder.duzeNad1MB = { n: duze.length, mb: mb(duze.reduce((s, m) => s + m.size, 0)), latami: {}, czesteRozmiary: [] };
        // Z którego roku są duże maile (data serwera) — co można zarchiwizować.
        for (const m of duze) {
          const rok = m.date ? String(new Date(m.date).getFullYear()) : '?';
          const r = folder.duzeNad1MB.latami[rok] || (folder.duzeNad1MB.latami[rok] = { n: 0, mb: 0 });
          r.n += 1;
          r.mb = Math.round((r.mb + m.size / MB) * 10) / 10;
        }
        // Wiele maili tej samej wielkości = ten sam załącznik wysyłany w kółko
        // (np. katalog). Rozmiar zaokrąglony do 0,5 MB, tylko grupy ≥ 5.
        const grupy = new Map();
        for (const m of duze) { const k = Math.round((m.size / MB) * 2) / 2; grupy.set(k, (grupy.get(k) || 0) + 1); }
        folder.duzeNad1MB.czesteRozmiary = [...grupy.entries()].filter(([, n]) => n >= 5)
          .sort((a, b) => b[1] * b[0] - a[1] * a[0]).slice(0, 3).map(([okMB, n]) => ({ okMB, n }));
        const kanarki = await p(cb => imap.search([['SUBJECT', MARKER_KANARKA]], cb)).catch(() => []);
        folder.kanarki = { n: kanarki.length, kb: Math.round(suma(kanarki) / 1024) };
        try {
          const rozgrz = new Set();
          for (const z of znaczniki) for (const u of await zLimitem(p(cb => imap.search([['TEXT', z]], cb)), 30000)) rozgrz.add(u);
          folder.rozgrzewanie = { n: rozgrz.size, mb: mb(suma([...rozgrz])) };
        } catch (_) { /* wolne wyszukiwanie — bez tej liczby */ }
      }
      wynik.razemMB += folder.mb;
      wynik.foldery.push(folder);
    }
    wynik.razemMB = Math.round(wynik.razemMB * 10) / 10;
    wynik.foldery.sort((a, b) => (b.mb || 0) - (a.mb || 0));
    return wynik;
  } finally {
    try { imap.end(); } catch (_) {}
  }
}

/** Foldery, w których mogą leżeć kanarki: odebrane (INBOX) i kopie u nadawcy. */
const folderKanarkow = (f) => f.nazwa.toUpperCase() === 'INBOX' || f.atrybuty.includes('\\Sent') || /sent|wys[łl]ane/i.test(f.nazwa);

/** Kasuje testowe maile CRM (temat z [CRM-KANAREK]) z INBOX i Wysłanych.
 *  `proba` (domyślnie TAK) tylko liczy. Kasuje WYŁĄCZNIE wiadomości, których
 *  temat — przeczytany z serwera — zawiera znacznik; w INBOX tylko starsze niż
 *  2 h (świeży kanarek czeka jeszcze na odbiór przez poller). Kasowanie po UID
 *  (UID EXPUNGE), więc nie rusza niczego, co program pocztowy oznaczył do
 *  usunięcia. */
async function usunKanarki(account, { proba = true, mlodszeNizMs = 2 * 60 * 60 * 1000 } = {}) {
  const imap = await polacz(account);
  try {
    const wynik = { skrzynka: account.inbox, proba, foldery: [], razem: 0, razemKB: 0 };
    for (const f of dostepne(splaszcz(await p(cb => imap.getBoxes(cb)))).filter(folderKanarkow)) {
      await p(cb => imap.openBox(f.nazwa, proba, cb)); // próba = tylko do odczytu
      const znalezione = await p(cb => imap.search([['SUBJECT', MARKER_KANARKA]], cb));
      if (!znalezione.length) continue;
      const meta = await pobierzMeta(imap, znalezione, { poUid: true, temat: true });
      const granica = Date.now() - mlodszeNizMs;
      const inbox = f.nazwa.toUpperCase() === 'INBOX';
      const doUsuniecia = meta.filter(m => m.temat.includes(MARKER_KANARKA) && !(inbox && m.date && new Date(m.date).getTime() > granica));
      const uidy = doUsuniecia.map(m => m.uid);
      const kb = Math.round(doUsuniecia.reduce((s, m) => s + m.size, 0) / 1024);
      const pozycja = { nazwa: f.nazwa, kanarki: uidy.length, kb, usunieto: 0 };
      if (!proba && uidy.length) {
        if (!imap.serverSupports('UIDPLUS')) {
          pozycja.blad = 'serwer nie obsługuje UID EXPUNGE — nic nie skasowano';
        } else {
          for (let i = 0; i < uidy.length; i += 500) {
            const partia = uidy.slice(i, i + 500);
            await p(cb => imap.addFlags(partia, '\\Deleted', cb));
            await p(cb => imap.expunge(partia, cb));
            pozycja.usunieto += partia.length;
          }
        }
      }
      wynik.foldery.push(pozycja);
      wynik.razem += uidy.length;
      wynik.razemKB += kb;
    }
    return wynik;
  } finally {
    try { imap.end(); } catch (_) {}
  }
}

module.exports = { rozmiarSkrzynki, usunKanarki, MARKER_KANARKA, polacz, splaszcz, dostepne };
