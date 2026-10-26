'use strict';

/* RAPORTY KASOWE — połączenia i harmonogram (26.10.2026). Logika odczytu:
 * services/raporty-kasowe.js. Tu: skrzynka bota (IMAP po UID, nic nie
 * oznaczamy), Claude (SDK, klucz z env), poprawa skanów (/preprocess-scan
 * w tym procesie), Google Sheets/Drive (konto serwisowe), maile z konta bota
 * (SMTP), kopia o 4:00 i zakładka nowego miesiąca.
 *
 * Konfiguracja:
 *  - env RAPORTY_POCZTA_LOGIN, RAPORTY_POCZTA_HASLO (sekret — tylko Railway),
 *    opcjonalnie RAPORTY_POCZTA_IMAP / RAPORTY_POCZTA_SMTP („host[:port]";
 *    domyślnie imap.<domena> i smtp.<domena> loginu). Bez loginu i hasła moduł
 *    śpi (nic nie czyta, nic nie wysyła).
 *  - Config `raporty_kasowe`: { arkuszId, potwierdzenia: [...], alerty: [...],
 *    nadawcy: [] (pusta = od wszystkich) } — adresy poza kodem.
 *  - Konto Google: GOOGLE_SERVICE_ACCOUNT_JSON (to samo co do Arkuszy);
 *    arkusz musi być udostępniony jego adresowi jako edytor. */

const rk = require('./raporty-kasowe');

let _prisma = null;
const db = () => _prisma || require('../db');

// ── konfiguracja ────────────────────────────────────────────────────────────
function hostPort(wartosc, domyslnyHost, domyslnyPort) {
  const [h, p] = String(wartosc || '').trim().split(':');
  return { host: h || domyslnyHost, port: Number(p) || domyslnyPort };
}
function kontoZ({ login, haslo, imap, smtp } = {}) {
  const l = String(login || '').trim();
  const h = String(haslo || '');
  if (!l || !h) return null;
  const domena = l.split('@')[1] || '';
  return { login: l, haslo: h, imap: hostPort(imap, `imap.${domena}`, 993), smtp: hostPort(smtp, `smtp.${domena}`, 465) };
}
// Skrzynka z env (Railway)…
function konto() {
  return kontoZ({ login: process.env.RAPORTY_POCZTA_LOGIN, haslo: process.env.RAPORTY_POCZTA_HASLO, imap: process.env.RAPORTY_POCZTA_IMAP, smtp: process.env.RAPORTY_POCZTA_SMTP });
}
// …a gdy jej tam nie ma — z Config `raporty_kasowe_poczta` {login, haslo,
// imap, smtp} (jak tokeny botów: ustawiane przez API, bez zmian w Railway).
const KLUCZ_POCZTA = 'raporty_kasowe_poczta';
async function kontoAktywne() {
  return konto() || kontoZ((await czytaj(KLUCZ_POCZTA, null)) || {});
}
async function czytaj(klucz, domyslnie) {
  try { const r = await db().config.findUnique({ where: { key: klucz } }); return r && r.value ? JSON.parse(r.value) : domyslnie; } catch { return domyslnie; }
}
async function zapisz(klucz, wartosc) {
  const value = JSON.stringify(wartosc);
  await db().config.upsert({ where: { key: klucz }, update: { value }, create: { key: klucz, value } });
}
async function ustawienia() {
  const u = await czytaj(rk.KLUCZ_USTAWIENIA, {});
  return {
    arkuszId: u.arkuszId || null,
    potwierdzenia: Array.isArray(u.potwierdzenia) ? u.potwierdzenia : [],
    alerty: Array.isArray(u.alerty) ? u.alerty : [],
    nadawcy: Array.isArray(u.nadawcy) ? u.nadawcy.map(a => String(a).toLowerCase()) : [],
  };
}

// ── Google (konto serwisowe) ────────────────────────────────────────────────
let _google = null;
function google() {
  if (_google) return _google;
  const { google: g } = require('googleapis');
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  const auth = new g.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'] });
  _google = { sheets: g.sheets({ version: 'v4', auth }), drive: g.drive({ version: 'v3', auth }), email: credentials.client_email || null };
  return _google;
}
function arkusz(arkuszId) {
  const { sheets } = google();
  return {
    pobierz: async (range) => (await sheets.spreadsheets.values.get({ spreadsheetId: arkuszId, range, valueRenderOption: 'UNFORMATTED_VALUE' })).data.values || [],
    zapisz: async (range, values) => { await sheets.spreadsheets.values.update({ spreadsheetId: arkuszId, range, valueInputOption: 'RAW', requestBody: { range, majorDimension: 'ROWS', values } }); },
    zakladki: async () => ((await sheets.spreadsheets.get({ spreadsheetId: arkuszId, fields: 'properties.title,sheets.properties' })).data),
    duplikuj: async (sourceSheetId, newSheetName) => { await sheets.spreadsheets.batchUpdate({ spreadsheetId: arkuszId, requestBody: { requests: [{ duplicateSheet: { sourceSheetId, newSheetName } }] } }); },
    wyczysc: async (nazwa) => { await sheets.spreadsheets.values.batchClear({ spreadsheetId: arkuszId, requestBody: { ranges: [`'${nazwa}'!B4:M34`] } }); },
    xlsx: async () => Buffer.from((await google().drive.files.export({ fileId: arkuszId, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, { responseType: 'arraybuffer' })).data),
  };
}

// ── Claude, poprawa skanu, mail ─────────────────────────────────────────────
let _claude = null;
async function claude(payload) {
  if (!_claude) {
    const Anthropic = require('@anthropic-ai/sdk');
    _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 180000, maxRetries: 3 });
  }
  return _claude.messages.create(payload);
}
async function popraw(data, mime) {
  const res = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/preprocess-scan`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': process.env.PREPROCESS_TOKEN || '' },
    body: JSON.stringify({ data, mime }), signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${(await res.text().catch(() => '')).slice(0, 120)}`);
  return res.json();
}
function nadawca(k) {
  return async ({ do: odbiorcy, temat, tekst, zalacznik }) => {
    const lista = (Array.isArray(odbiorcy) ? odbiorcy : [odbiorcy]).filter(Boolean);
    if (!lista.length) { console.warn(`[raporty-kasowe] brak odbiorców dla „${temat}" — ustaw Config raporty_kasowe`); return; }
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({ host: k.smtp.host, port: k.smtp.port, secure: k.smtp.port === 465, auth: { user: k.login, pass: k.haslo }, connectionTimeout: 30000, greetingTimeout: 30000, socketTimeout: 60000 });
    await t.sendMail({ from: k.login, to: lista.join(', '), subject: temat, text: tekst, ...(zalacznik ? { attachments: [zalacznik] } : {}) });
  };
}

// ── skrzynka bota (IMAP, tylko odczyt) ──────────────────────────────────────
function polacz(k) {
  const Imap = require('imap');
  return new Promise((resolve, reject) => {
    const imap = new Imap({ user: k.login, password: k.haslo, host: k.imap.host, port: k.imap.port, tls: true, tlsOptions: { rejectUnauthorized: false }, connTimeout: 30000, authTimeout: 20000, socketTimeout: 90000 });
    let gotowe = false;
    imap.once('ready', () => { if (!gotowe) { gotowe = true; resolve(imap); } });
    imap.once('error', (e) => { if (!gotowe) { gotowe = true; reject(e); } });
    imap.connect();
  });
}
const zamknij = (imap) => { try { imap.end(); } catch (_) { /* już zamknięte */ } };

/* Nowe maile: UID > lastUid (albo od daty po POST /od). Zwraca listę maili
 * z załącznikami i aktualny uidValidity. Nic nie oznacza na serwerze. */
async function pobierzMaile(k, stan, limit = 15) {
  const { simpleParser } = require('mailparser');
  const imap = await polacz(k);
  try {
    const box = await new Promise((res, rej) => imap.openBox('INBOX', true, (e, b) => (e ? rej(e) : res(b))));
    const uidValidity = Number(box.uidvalidity);
    let lastUid = stan.uidValidity === uidValidity ? Number(stan.lastUid || 0) : null;
    // `gora` = najwyższy UID w skrzynce; gdy nie ma nic do zrobienia, stan
    // przesuwa się tutaj (inaczej następny cykl czytałby całą historię).
    const gora = Number(box.uidnext) - 1;
    if (lastUid == null && !stan.od) {
      // Pierwsze uruchomienie: zaczynamy od TERAZ (stare maile przerobił n8n).
      return { uidValidity, gora, maile: [] };
    }
    const kryteria = stan.od ? [['SINCE', new Date(`${stan.od}T00:00:00Z`)]] : [['UID', `${lastUid + 1}:*`]];
    const od = stan.od ? 0 : lastUid;
    const uids = (await new Promise((res, rej) => imap.search(kryteria, (e, u) => (e ? rej(e) : res(u || [])))))
      .map(Number).filter(u => u > od).sort((a, b) => a - b).slice(0, limit);
    const maile = [];
    for (const uid of uids) {
      const surowy = await new Promise((res, rej) => {
        const f = imap.fetch(uid, { bodies: '', struct: false });
        let bufor = null;
        f.on('message', (m) => m.on('body', (s) => { const cz = []; s.on('data', c => cz.push(c)); s.once('end', () => { bufor = Buffer.concat(cz); }); }));
        f.once('error', rej);
        f.once('end', () => res(bufor));
      });
      if (!surowy) continue;
      const m = await simpleParser(surowy);
      maile.push({ uid, messageId: m.messageId || null, from: ((m.from && m.from.value && m.from.value[0] && m.from.value[0].address) || '').toLowerCase(), subject: m.subject || '', attachments: m.attachments || [] });
    }
    return { uidValidity, gora, maile };
  } finally { zamknij(imap); }
}

// Załączniki do odczytu: bez obrazków osadzonych w treści i drobnych logo.
function doOdczytu(a) {
  const ct = String(a.contentType || '').toLowerCase();
  const obraz = ct.startsWith('image/');
  if (obraz && (a.related || a.contentDisposition === 'inline' || a.cid)) return false;
  if (obraz && !/hei[cf]/.test(ct) && (a.size || (a.content && a.content.length) || 0) < rk.MIN_OBRAZ_B) return false;
  return true;
}

// ── cykl: skrzynka → raporty ────────────────────────────────────────────────
let wToku = false;
let bledyZRzedu = 0;
const ostatnie = { cykl: null, kopia: null };
// Próby załączników, które wywaliły się w trakcie (arkusz, Claude, sieć).
// Do 3 prób załącznik NIE jest zapisywany jako przerobiony, a stan skrzynki
// nie przesuwa się za jego mail — następny cykl spróbuje ponownie.
const MAX_PROB = 3;
const proby = new Map();

async function cykl(deps = {}) {
  const k = deps.konto || await kontoAktywne();
  if (!k) return { ok: false, powod: 'brak danych skrzynki bota (Config raporty_kasowe_poczta albo env RAPORTY_POCZTA_*)' };
  if (wToku) return { ok: false, powod: 'poprzedni cykl jeszcze trwa' };
  wToku = true;
  const wynik = { kiedy: new Date().toISOString(), maili: 0, zalacznikow: 0, statusy: {} };
  try {
    const ust = await ustawienia();
    if (!ust.arkuszId) throw new Error('brak arkuszId w Config raporty_kasowe');
    const stan = await czytaj(rk.KLUCZ_STAN, {});
    const r = await (deps.pobierzMaile || pobierzMaile)(k, stan);
    bledyZRzedu = 0;
    const z = {
      claude: deps.claude || claude, popraw: deps.popraw || popraw, arkusz: deps.arkusz || arkusz(ust.arkuszId),
      wyslij: deps.wyslij || nadawca(k), ustawienia: ust,
    };
    // Arkusz niedostępny (np. nieudostępniony kontu serwisowemu) → błąd cyklu
    // PRZED dotknięciem maili: nic nie oznaczamy, nic nie przepada.
    if (r.maile.length && typeof z.arkusz.zakladki === 'function') await z.arkusz.zakladki();
    let przerwij = null;
    for (const mail of r.maile) {
      if (ust.nadawcy.length && !ust.nadawcy.some(a => mail.from.includes(a))) { await zapisz(rk.KLUCZ_STAN, { uidValidity: r.uidValidity, lastUid: mail.uid }); continue; }
      wynik.maili++;
      const awarie = [];
      let n = 0;
      for (const a of mail.attachments.filter(doOdczytu)) {
        const klucz = `${r.uidValidity}:${mail.uid}:${n++}:${a.filename || ''}`.slice(0, 250);
        if (await db().raportKasowy.findUnique({ where: { klucz } })) continue; // już przerobiony (restart)
        wynik.zalacznikow++;
        let w;
        try { w = await rk.przetworzZalacznik(a, z); proby.delete(klucz); } catch (e) {
          const proba = (proby.get(klucz) || 0) + 1;
          proby.set(klucz, proba);
          console.error(`[raporty-kasowe] ${a.filename} (próba ${proba}/${MAX_PROB}):`, e.message);
          if (proba < MAX_PROB) { przerwij = `${a.filename}: ${String(e.message).slice(0, 200)} — ponowię w następnym cyklu (${proba}/${MAX_PROB})`; break; }
          proby.delete(klucz);
          w = { status: 'blad', szczegoly: String(e.message).slice(0, 500) };
        }
        if (w.awariaPoprawy) awarie.push(w.awariaPoprawy);
        wynik.statusy[w.status] = (wynik.statusy[w.status] || 0) + 1;
        await db().raportKasowy.create({ data: {
          klucz, uid: mail.uid, messageId: mail.messageId, nadawca: mail.from, plik: a.filename || null, typ: w.typ || null, data: w.data || null,
          zakladka: w.sheet || null, wiersz: w.row || null, wartosci: w.values || undefined, etap: w.etap || null, status: w.status, szczegoly: w.szczegoly ? String(w.szczegoly).slice(0, 2000) : null,
        } });
        if (w.status === 'blad') await z.wyslij({ do: ust.alerty, temat: `❌ Raport kasowy — błąd przetwarzania (${a.filename || 'załącznik'})`, tekst: `Nie udało się przetworzyć załącznika ${a.filename || ''} z maila „${mail.subject}" (${mail.from}) — ${MAX_PROB} próby, co 3 minuty.\n\nBłąd: ${w.szczegoly}\n\nNic nie zostało wpisane. Wpisz wartości ręcznie albo poproś Claude o ponowne przetworzenie od daty tego maila.` }).catch(() => {});
      }
      if (przerwij) break; // ten mail jeszcze raz w następnym cyklu
      if (awarie.length) {
        await z.wyslij({ do: ust.alerty, temat: '🔧 Poprawianie jakości skanów nie działa — raporty czytane w gorszej jakości', tekst: `Usługa poprawy skanów (/preprocess-scan) nie odpowiedziała, więc raport poszedł do odczytu jako oryginał.\n\nTo NIE zatrzymało przetwarzania — kwoty zostały odczytane normalnie, ale bez prostowania skanu odczyt jest mniej pewny i częściej trafia do arbitrażu.\n\nSzczegóły:\n${awarie.map(a => '  • ' + a).join('\n')}` }).catch(() => {});
      }
      // Po każdym mailu (także w trybie „od daty" — UID rosną z czasem, więc
      // następny cykl pociągnie dalsze maile po UID, a data przestaje być potrzebna).
      await zapisz(rk.KLUCZ_STAN, { uidValidity: r.uidValidity, lastUid: mail.uid });
    }
    if (!r.maile.length) await zapisz(rk.KLUCZ_STAN, { uidValidity: r.uidValidity, lastUid: r.gora });
    if (przerwij) wynik.ponowienie = przerwij;
    wynik.ok = true;
  } catch (e) {
    bledyZRzedu++;
    wynik.ok = false; wynik.blad = e.message;
    console.error('[raporty-kasowe] cykl:', e.message);
    if (bledyZRzedu === 3) {
      require('./straznik').alert(`⚠️ Raporty kasowe: skrzynka bota albo arkusz nie działają od 3 cykli (${String(e.message).slice(0, 200)}). Raporty czekają w skrzynce — nic nie ginie, przerobię je, gdy połączenie wróci.`, `raporty-kasowe:${new Date().toISOString().slice(0, 10)}`).catch(() => {});
    }
  } finally {
    wToku = false;
    ostatnie.cykl = wynik;
  }
  return wynik;
}

/* Przetwórz od daty (np. zaległe po awarii n8n): kolejne cykle czytają maile
 * od tej daty; załączniki już przerobione przez ten moduł są pomijane, a te
 * z n8n przejdą kontrolę duplikatu w arkuszu (te same kwoty → nic). */
async function przetworzOd(od) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(od || ''))) throw new Error('od: data RRRR-MM-DD');
  await zapisz(rk.KLUCZ_STAN, { od });
}

// ── 4:00: kopia XLSX do bazy + zakładka nowego miesiąca ─────────────────────
async function kopiaIZakladka(deps = {}) {
  const k = deps.konto || await kontoAktywne();
  const ust = await ustawienia();
  const ark = deps.arkusz || arkusz(ust.arkuszId);
  const wyslij = deps.wyslij || (k ? nadawca(k) : async () => {});
  const teraz = deps.teraz || new Date();
  const wynik = { kiedy: teraz.toISOString() };
  try {
    const plik = await ark.xlsx();
    const d = rk.dataWarszawa(teraz);
    const nazwa = `BACKUP_RAPORTY_KASOWE_${d.rok}-${String(d.miesiac).padStart(2, '0')}-${String(d.dzien).padStart(2, '0')}.xlsx`;
    await db().kopiaArkusza.create({ data: { nazwa, rozmiar: plik.length, dane: plik } });
    await db().kopiaArkusza.deleteMany({ where: { createdAt: { lt: new Date(teraz.getTime() - 60 * 24 * 3600 * 1000) } } });
    wynik.kopia = { nazwa, rozmiar: plik.length };
  } catch (e) {
    wynik.kopia = { blad: e.message };
    await wyslij({ do: ust.alerty, temat: '❌ Backup arkusza raportów kasowych nie wykonał się', tekst: `Codzienna kopia arkusza raportów kasowych nie powiodła się (${teraz.toISOString().slice(0, 16).replace('T', ' ')} UTC).\n\nBłąd: ${e.message}` }).catch(() => {});
  }
  try {
    const plan = rk.nowyMiesiac(teraz);
    if (plan) {
      const meta = await ark.zakladki();
      const props = (meta.sheets || []).map(s => s.properties);
      if (props.some(p => p.title === plan.nowa)) wynik.zakladka = 'już jest';
      else {
        const src = props.find(p => p.title === plan.zrodlo);
        if (!src) throw new Error(`Nie znaleziono zakładki źródłowej: ${plan.zrodlo}`);
        await ark.duplikuj(src.sheetId, plan.nowa);
        await ark.wyczysc(plan.nowa);
        await wyslij({ do: ust.alerty, temat: `📅 Utworzono zakładkę ${plan.nowa}`, tekst: `Jutro nowy miesiąc — utworzyłem zakładkę ${plan.nowa} na bazie ${plan.zrodlo} (struktura i formuły skopiowane, dane wyczyszczone). Arkusz gotowy na raporty od 1-go.` });
        wynik.zakladka = plan.nowa;
      }
    }
  } catch (e) {
    wynik.zakladka = { blad: e.message };
    await wyslij({ do: ust.alerty, temat: '❌ Nie udało się utworzyć zakładki nowego miesiąca', tekst: `Błąd: ${e.message}\n\nUtwórz zakładkę ręcznie (kopia bieżącego miesiąca, wyczyść B4:M34), zanim przyjdą raporty z 1-go.` }).catch(() => {});
  }
  ostatnie.kopia = wynik;
  return wynik;
}

// ── harmonogram ────────────────────────────────────────────────────────────
function uruchom(prisma) {
  _prisma = prisma;
  // Timery chodzą zawsze; bez danych skrzynki cykl kończy się od razu (dane
  // mogą dojść w Config bez restartu).
  const jedenCykl = () => cykl().catch(e => console.error('[raporty-kasowe]', e.message));
  setTimeout(jedenCykl, 60 * 1000).unref();
  setInterval(jedenCykl, 3 * 60 * 1000).unref();
  // Kopia raz na dobę po 4:00 (Warszawa); dzień zapisany w Config, więc
  // restart nie robi drugiej kopii.
  setInterval(async () => {
    try {
      const godz = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', hour: '2-digit', hour12: false }).format(new Date()));
      const d = rk.dataWarszawa(new Date());
      const dzis = `${d.rok}-${String(d.miesiac).padStart(2, '0')}-${String(d.dzien).padStart(2, '0')}`;
      if (godz < 4 || (await czytaj(rk.KLUCZ_DZIEN, null)) === dzis) return;
      if (!(await ustawienia()).arkuszId || !(await kontoAktywne())) return; // moduł nieskonfigurowany
      await zapisz(rk.KLUCZ_DZIEN, dzis);
      await kopiaIZakladka();
    } catch (e) { console.error('[raporty-kasowe] kopia:', e.message); }
  }, 10 * 60 * 1000).unref();
  console.log('[raporty-kasowe] timery: skrzynka co 3 min (gdy są dane skrzynki), kopia i nowy miesiąc po 4:00');
}

/* Próba połączenia bez czytania i wysyłania: logowanie IMAP + otwarcie
 * skrzynki tylko do odczytu, SMTP — samo powitanie i logowanie (verify). */
async function testPolaczen(k) {
  const wynik = {};
  try {
    const imap = await polacz(k);
    try { const b = await new Promise((res, rej) => imap.openBox('INBOX', true, (e, x) => (e ? rej(e) : res(x)))); wynik.imap = { ok: true, wiadomosci: b.messages && b.messages.total }; } finally { zamknij(imap); }
  } catch (e) { wynik.imap = { ok: false, blad: String(e.message).slice(0, 200) }; }
  try {
    const nodemailer = require('nodemailer');
    await nodemailer.createTransport({ host: k.smtp.host, port: k.smtp.port, secure: k.smtp.port === 465, auth: { user: k.login, pass: k.haslo }, connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 30000 }).verify();
    wynik.smtp = { ok: true };
  } catch (e) { wynik.smtp = { ok: false, blad: String(e.message).slice(0, 200) }; }
  return wynik;
}

// Stan dla /api/raporty-kasowe/stan (bez sekretów).
async function stan({ testPolaczenia = false } = {}) {
  const k = await kontoAktywne();
  const ust = await ustawienia();
  let dostepArkusza = null;
  let kontoGoogle = null;
  try { kontoGoogle = google().email; } catch (e) { kontoGoogle = `błąd: ${e.message}`; }
  if (ust.arkuszId && process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try { const m = await arkusz(ust.arkuszId).zakladki(); dostepArkusza = { ok: true, tytul: m.properties && m.properties.title, zakladek: (m.sheets || []).length }; } catch (e) { dostepArkusza = { ok: false, blad: String(e.message).slice(0, 200) }; }
  }
  const ostatnieRaporty = await db().raportKasowy.findMany({ orderBy: { createdAt: 'desc' }, take: 20, select: { createdAt: true, plik: true, typ: true, data: true, status: true, etap: true, zakladka: true, wiersz: true, szczegoly: true } });
  const kopie = await db().kopiaArkusza.findMany({ orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, nazwa: true, rozmiar: true, createdAt: true } });
  return {
    wlaczone: !!k, skrzynka: k ? { login: k.login, imap: `${k.imap.host}:${k.imap.port}`, smtp: `${k.smtp.host}:${k.smtp.port}`, zrodlo: konto() ? 'env' : 'config' } : null,
    polaczenia: k && testPolaczenia ? await testPolaczen(k) : undefined,
    ustawienia: { arkuszId: ust.arkuszId, potwierdzenia: ust.potwierdzenia, alerty: ust.alerty, nadawcy: ust.nadawcy },
    modele: rk.MODELE(), kontoGoogle, dostepArkusza, stanSkrzynki: await czytaj(rk.KLUCZ_STAN, null),
    ostatniCykl: ostatnie.cykl, ostatniaKopia: ostatnie.kopia, ostatnieRaporty, kopie,
  };
}

module.exports = { uruchom, cykl, kopiaIZakladka, przetworzOd, stan, konto, kontoAktywne, doOdczytu, KLUCZ_POCZTA, _test: { hostPort, pobierzMaile, ustawPrisma: (p) => { _prisma = p; }, reset: () => { wToku = false; bledyZRzedu = 0; proby.clear(); } } };
