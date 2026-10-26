'use strict';

/* STRAŻNIK — wykrywanie obcych ruchów (24.10.2026, po incydencie Railway
 * 20–22.10.2026, gdy wyciekły zmienne środowiskowe części klientów).
 *
 * Właściciel wymienił klucz Anthropic, pozostałe sekrety (klucz API CRM,
 * PREPROCESS_TOKEN, hasła skrzynek, iFirma, GlobKurier, tokeny botów…)
 * zostały i trzeba WIEDZIEĆ, gdyby ktoś ich użył. Strażnik pilnuje śladów,
 * których obcy nie uniknie:
 *
 *  1. Wywołania tras z sekretem (klucz API, PREPROCESS_TOKEN, sekret webhooka
 *     bota) spoza panelu: NOWA sieć → alert z nazwą użytego sekretu (i z
 *     oznaczeniem podglądu linku, gdy wołał robot podglądów — np. iPhone
 *     z linkiem w notatce); > PROG_WYWOLAN na godzinę z jednego adresu →
 *     alert. Panel CRM wysyła x-crm-user (z sesji), webhook bota przychodzi
 *     z adresów Telegrama.
 *  2. Webhook bota wywołany POPRAWNYM sekretem spoza adresów Telegrama =
 *     ktoś podrabia wiadomości do bota (bot ma moce CRM i AI) → alert od razu.
 *  3. Połączenie z bazą z adresu innego niż nasz backend (dwa przeglądy
 *     z rzędu — nakładanie się kontenerów przy wdrożeniu trwa chwilę) → alert.
 *  4. Webhook bota przestawiony na obcy adres albo zdjęty (ktoś ma token
 *     bota i przechwytuje wiadomości) → alert.
 *  5. Zamówienia GlobKurier, których nie złożył CRM → alert.
 *  6. Faktury iFirma / Contasimple, których nie wystawił CRM → alert.
 *  7. Skrzynki: wysyłka spoza CRM ze skrzynki, która od 30 dni nic nie
 *     wysyłała, albo > PROG_WYSYLEK na godzinę; fala zwrotów (≥ PROG_ZWROTOW
 *     na godzinę) — znak, że ktoś wysyła z naszego konta → alert.
 *
 * Alerty: Telegram (bot PL), każdy temat raz (pamięć w Config). Bez treści
 * maili i bez sekretów; adresy IP i ścieżki tak — po to jest ten moduł. */

const KLUCZ_ZNANE = 'straznik_znane_adresy';   // { siec: { od, ostatnio, ua, n, sciezki, adresy } }
const KLUCZ_ZGLOSZONE = 'straznik_zgloszone';  // { klucz: ISO } — temat już zgłoszony
const KLUCZ_START = 'straznik_start';          // ISO — od kiedy strażnik patrzy (GK, faktury)

const PROG_WYWOLAN = 300;   // na godzinę z jednego adresu spoza panelu
const PROG_WYSYLEK = 10;    // wysyłek spoza CRM na godzinę z jednej skrzynki (dziś max 3)
const PROG_ZWROTOW = 5;     // zwrotów na godzinę na skrzynkę (dziś 0)
const TELEGRAM_ZAKRESY = ['149.154.160.0/20', '91.108.4.0/22'];

// ── pomocnicze ──────────────────────────────────────────────────────────────
/* Adres wołającego. Pierwszy wpis X-Forwarded-For może wpisać SAM wołający
 * (podszycie pod Telegram albo pod znany adres) — dlatego bierzemy to, co
 * dopisała brama Railway: X-Real-IP, a bez niego OSTATNI wpis XFF. */
function adresKlienta(req) {
  const h = req.headers || {};
  const realIp = String(h['x-real-ip'] || '').trim();
  const xff = String(h['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  const ip = realIp || xff[xff.length - 1] || (req.socket && req.socket.remoteAddress) || '';
  return ip.replace(/^::ffff:/, '');
}

function ipv4WZakresie(ip, cidr) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const [baza, bity] = cidr.split('/');
  const liczba = s => s.split('.').reduce((a, x) => ((a << 8) + Number(x)) >>> 0, 0);
  const maska = Number(bity) === 0 ? 0 : (~0 << (32 - Number(bity))) >>> 0;
  return (liczba(ip) & maska) === (liczba(baza) & maska);
}
const zTelegrama = ip => TELEGRAM_ZAKRESY.some(z => ipv4WZakresie(ip, z));

// /api/contractors/7f3a…/x → /api/contractors/:id/x (identyfikatory i numery won)
function sciezkaOgolna(p) {
  return String(p || '').split('?')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d[\w.-]*/g, '/:n')
    .slice(0, 120);
}

/* Sieć adresu: IPv4 → /24, IPv6 → /64. Znane są SIECI, nie pojedyncze adresy —
 * wołający z puli adresów (bramka Claude, n8n w chmurze) zmienia adres w
 * obrębie jednej sieci i bez tego każdy nowy adres z puli dawałby alert. */
function siecAdresu(ip) {
  const s = String(ip || '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return s.split('.').slice(0, 3).join('.') + '.0/24';
  if (s.includes(':')) {
    const czesci = s.split('::')[0].split(':').filter(Boolean);
    return czesci.slice(0, 4).join(':') + '::/64';
  }
  return s || '?';
}

/* Znane sieci z Config. Wpisy pierwszej wersji strażnika (24.10, klucz =
 * pojedynczy adres) scalamy w sieci, żeby po wdrożeniu nie wróciły alerty
 * o adresach już zgłoszonych. */
async function czytajZnane(prisma) {
  const znane = await czytajJson(prisma, KLUCZ_ZNANE, {});
  for (const k of Object.keys(znane)) {
    if (k.includes('/')) continue;
    const siec = siecAdresu(k);
    const z = znane[k];
    delete znane[k];
    const cel = znane[siec] || { od: z.od, ostatnio: z.ostatnio, n: 0, ua: z.ua, sciezki: z.sciezki, adresy: [] };
    cel.n = (cel.n || 0) + (z.n || 0);
    if (String(z.ostatnio || '') > String(cel.ostatnio || '')) cel.ostatnio = z.ostatnio;
    if (String(z.od || '') < String(cel.od || '')) cel.od = z.od;
    cel.adresy = [...new Set([...(cel.adresy || []), k])].slice(-10);
    znane[siec] = cel;
  }
  return znane;
}

const lokalnieWarszawa = (d) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(d).replace('T', ' ');

async function czytajJson(prisma, klucz, domyslnie) {
  try {
    const r = await prisma.config.findUnique({ where: { key: klucz } });
    return r && r.value ? JSON.parse(r.value) : domyslnie;
  } catch { return domyslnie; }
}
async function zapiszJson(prisma, klucz, wartosc) {
  const value = JSON.stringify(wartosc);
  await prisma.config.upsert({ where: { key: klucz }, update: { value }, create: { key: klucz, value } });
}

// ── 1–2. rejestr wywołań (middleware) ───────────────────────────────────────
const okno = { od: Date.now(), adresy: new Map(), panel: 0 };
const ostatnieWyniki = { czesty: null, godzinny: null };

/* Która trasa jest chroniona sekretem i którym. 'api' = klucz API (po auth,
 * także mapa z ?key=), 'token' = PREPROCESS_TOKEN, 'sekret-bota' = sekret
 * webhooka w linku (?secret=, diagnostyka i przełączanie bota z przeglądarki),
 * 'tg' = webhook bota (POST od Telegrama). Trasy publiczne → null. */
const SEKRETY = {
  api: 'klucz API CRM (Railway API_KEY + Vercel CORE_API_KEY)',
  token: 'PREPROCESS_TOKEN (Railway + n8n)',
  'sekret-bota': 'sekret webhooka bota (napisz do Claude — wymieni go)',
  faktury: 'token faktur systemu mailingowego (napisz do Claude — wymieni go)',
};
const TRASY_PUBLICZNE = /^\/czytnik\/(zdrowie|norma)$/;
function rodzajTrasy(req) {
  // originalUrl, nie path: wewnątrz podroutera Express skraca req.url/path.
  const p = String(req.originalUrl || req.url || '').split('?')[0];
  if (p.startsWith('/api/')) return 'api';
  if (req.method === 'POST' && /^\/telegram\/webhook\/[^/]+$/.test(p)) return 'tg';
  if (/^\/telegram\/webhook\/[^/]+(\/ustaw|\/zdejmij)?$/.test(p)) return 'sekret-bota';
  if (p === '/telegram/diag') return 'token';
  if (/^\/zewn\/faktury(\/|$)/.test(p)) return 'faktury';
  if (TRASY_PUBLICZNE.test(p)) return null;
  if (/^\/(czytnik|karty-pracy|karta-pracy|poczta)(\/|$)/.test(p)) return 'token';
  if (/^\/preprocess-scan(\/|$)/.test(p)) return 'token';
  if (p === '/map-data' && /[?&]key=/.test(String(req.originalUrl || ''))) return 'api';
  return null;
}

/* Roboty podglądu linków: link z sekretem wklejony do Wiadomości, Notatek,
 * komunikatora albo udostępniony — urządzenie samo go otwiera, żeby zrobić
 * miniaturę. Apple podpisuje się na KAŻDYM urządzeniu (także iPhonie) jako
 * stary Safari na Macu „10_11_1" i dokleja facebookexternalhit/Twitterbot. */
function podgladLinku(ua) {
  const s = String(ua || '');
  if (/Mac OS X 10_11_1\) AppleWebKit\/601\.2\.4/.test(s)) return 'podgląd linku z urządzenia Apple (iPhone/iPad/Mac)';
  if (/facebookexternalhit|Facebot|Twitterbot|WhatsApp|TelegramBot|Slackbot|Discordbot|LinkedInBot|SkypeUriPreview|Viber/i.test(s)) return 'podgląd linku w komunikatorze';
  return null;
}

/* Wołane z res.on('finish'). Liczymy tylko wywołania, które PRZESZŁY
 * (status < 400) — złe klucze to szum skanerów internetu. deps.wyslij —
 * natychmiastowy alert (podrobiony webhook bota). */
function zarejestruj(req, res, deps = {}) {
  try {
    const rodzaj = rodzajTrasy(req);
    if (!rodzaj) return;
    const status = res && res.statusCode;
    if (!(status < 400)) return;
    const ip = adresKlienta(req);
    if (rodzaj === 'tg') {
      if (ip && !zTelegrama(ip)) {
        const tekst = `🛡️ Strażnik: webhook bota wywołany POPRAWNYM sekretem spoza adresów Telegrama.\nAdres: ${ip}\nŚcieżka: ${String(req.originalUrl || '').split('?')[0]}\nKtoś może podszywać się pod Twoje wiadomości do bota (bot ma dostęp do CRM i AI). Wymień sekret webhooka i tokeny botów.`;
        (deps.wyslij || wyslijAlert)(tekst, `tg-podrobka:${ip}`).catch(() => {});
      }
      return;
    }
    const zPanelu = rodzaj === 'api' && !!(req.headers && (req.headers['x-crm-user'] || req.headers['x-crm-role']));
    if (zPanelu) { okno.panel++; return; }
    const wpis = okno.adresy.get(ip) || { n: 0, ua: new Set(), sciezki: new Map(), rodzaje: new Set() };
    wpis.n++;
    wpis.ua.add(String((req.headers && req.headers['user-agent']) || '-').slice(0, 200));
    const s = sciezkaOgolna(req.originalUrl || req.path);
    wpis.sciezki.set(s, (wpis.sciezki.get(s) || 0) + 1);
    wpis.rodzaje.add(rodzaj);
    okno.adresy.set(ip, wpis);
  } catch (e) {
    console.error('[straznik] rejestr:', e.message);
  }
}

function middleware(deps = {}) {
  return (req, res, next) => {
    res.on('finish', () => zarejestruj(req, res, deps));
    next();
  };
}

// ── wysyłka alertów (Telegram PL), raz na temat ─────────────────────────────
let _prisma = null;
async function wyslijAlert(tekst, klucz) {
  const prisma = _prisma || require('../db');
  if (klucz) {
    const zgl = await czytajJson(prisma, KLUCZ_ZGLOSZONE, {});
    if (zgl[klucz]) return false;
    zgl[klucz] = new Date().toISOString();
    // Sprzątanie: tematy starsze niż 30 dni wracają do obiegu.
    const granica = Date.now() - 30 * 24 * 3600 * 1000;
    for (const k of Object.keys(zgl)) if (new Date(zgl[k]).getTime() < granica) delete zgl[k];
    await zapiszJson(prisma, KLUCZ_ZGLOSZONE, zgl);
  }
  console.warn(`[straznik] ALERT: ${tekst.split('\n')[0]}`);
  try {
    const { resolveTelegram } = require('./telegram-helper');
    const { sendTelegram } = require('../telegram-utils');
    const { token, chatId } = await resolveTelegram(prisma, { scope: 'pl' });
    if (token && chatId) await sendTelegram(token, chatId, tekst);
  } catch (e) { console.error('[straznik] wysyłka alertu:', e.message); }
  return true;
}

// ── przegląd godzinny: adresy, GlobKurier, faktury, skrzynki ────────────────
async function przegladAdresow(prisma, deps) {
  const wyslij = deps.wyslij || wyslijAlert;
  const znane = await czytajZnane(prisma);
  // Stan sprzed tej godziny: kilka adresów jednej nowej sieci to wszystkie „nowe".
  const znaneWczesniej = new Set(Object.keys(znane));
  const teraz = new Date().toISOString();
  const nowe = [];
  const duzo = [];
  const noweSieci = new Set();
  for (const [ip, w] of okno.adresy.entries()) {
    const siec = siecAdresu(ip);
    const sciezki = [...w.sciezki.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, n]) => `${s} ×${n}`);
    if (!znaneWczesniej.has(siec)) { nowe.push({ ip, siec, n: w.n, ua: [...w.ua].slice(0, 2), rodzaje: [...(w.rodzaje || [])], sciezki }); noweSieci.add(siec); }
    if (w.n > PROG_WYWOLAN) duzo.push({ ip, n: w.n, sciezki });
    const stary = znane[siec] || { od: teraz, n: 0, adresy: [] };
    znane[siec] = { od: stary.od, ostatnio: teraz, n: (stary.n || 0) + w.n, ua: [...w.ua][0] || stary.ua || '-', sciezki: sciezki.slice(0, 3), adresy: [...new Set([...(stary.adresy || []), ip])].slice(-10) };
  }
  // Sieci nieużywane od 90 dni zapominamy — wrócą jako „nowe".
  const granica = Date.now() - 90 * 24 * 3600 * 1000;
  for (const k of Object.keys(znane)) if (new Date(znane[k].ostatnio || znane[k].od).getTime() < granica) delete znane[k];
  const wynik = { nowe: nowe.map(x => x.ip), noweSieci: [...noweSieci], duzo: duzo.map(x => x.ip), panel: okno.panel };
  // Tryb próbny (ręczny podgląd): niczego nie zapisujemy i nie zerujemy okna —
  // inaczej podgląd „zaliczyłby" nowy adres jako znany bez alertu. Treść
  // alertów i tak idzie do wywołującego (deps.wyslij zbiera).
  if (!deps.dry) {
    await zapiszJson(prisma, KLUCZ_ZNANE, znane);
    okno.adresy = new Map(); okno.panel = 0; okno.od = Date.now();
  }
  if (nowe.length) {
    const uzyte = new Set();
    const linie = nowe.map(x => {
      x.rodzaje.forEach(r => uzyte.add(r));
      const podglad = x.ua.map(podgladLinku).find(Boolean);
      const ua = x.ua.map(u => u.length > 70 ? `${u.slice(0, 70)}…` : u).join(' | ');
      return `• ${x.ip} (sieć ${x.siec}) — ${x.n} wywołań, ${ua}\n   ${x.sciezki.join(', ')}\n   użyty sekret: ${x.rodzaje.map(r => (SEKRETY[r] || r).split(' (')[0]).join(', ')}` +
        (podglad ? `\n   ↳ ${podglad}: ktoś otworzył, wkleił albo udostępnił link z sekretem — sprawdź, czy nie Ty albo ktoś z zespołu` : '');
    }).join('\n');
    const doWymiany = [...uzyte].map(r => SEKRETY[r]).filter(Boolean);
    await wyslij(`🛡️ Strażnik: NOWY adres używa sekretu CRM (poza panelem):\n${linie}\n\nJeśli to nie Ty, nie n8n i nie praca z Claude w tej godzinie — wymień: ${doWymiany.join('; ') || 'klucz API CRM'}.`, null);
  }
  for (const x of duzo) {
    await wyslij(`🛡️ Strażnik: ${x.n} wywołań w godzinę z adresu ${x.ip} (próg ${PROG_WYWOLAN}).\nNajczęściej: ${x.sciezki.join(', ')}\nTo może być zużywanie naszego AI albo wyciąganie danych.`, `duzo:${x.ip}:${teraz.slice(0, 10)}`);
  }
  return wynik;
}

async function przegladGK(prisma, deps, start) {
  const wyslij = deps.wyslij || wyslijAlert;
  const pobierz = deps.zamowieniaGK || (async () => require('../glob-client').fetchOrdersPaged(1));
  const startLokalnie = lokalnieWarszawa(new Date(start));
  const zamowienia = (await pobierz()) || [];
  const zCrm = new Set();
  try {
    const zdarzenia = await prisma.activityEvent.findMany({ where: { type: 'shipment.created', shipmentNumber: { not: null }, createdAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) } }, select: { shipmentNumber: true } });
    for (const z of zdarzenia) zCrm.add(String(z.shipmentNumber).replace(/^GK(GK)/, 'GK'));
    const magazyn = await prisma.warehouseOrder.findMany({ where: { gkNumber: { not: null } }, select: { gkNumber: true } });
    for (const m of magazyn) zCrm.add(String(m.gkNumber));
  } catch (e) { console.error('[straznik] GK — lista z CRM:', e.message); }
  const obce = zamowienia.filter(o => {
    const nr = String(o.number || o.orderNumber || '');
    return nr && String(o.creationDate || '') >= startLokalnie && !zCrm.has(nr);
  });
  for (const o of obce) {
    const nr = String(o.number || o.orderNumber);
    const odb = o.receiverAddress || o.receiver || {};
    const cena = o.priceGross != null ? o.priceGross : (o.price && (o.price.gross || o.price.brutto));
    await wyslij(`🛡️ Strażnik: zamówienie GlobKurier, którego NIE złożył CRM.\n${nr} — ${o.creationDate || '?'}, ${o.status || ''}${cena != null ? `, ${cena} zł` : ''}\nOdbiorca: ${odb.name || odb.companyName || '?'}${odb.city ? `, ${odb.city}` : ''}\nJeśli to nie Ty z panelu GlobKurier — zmień hasło do GK i anuluj zamówienie.`, `gk:${nr}`);
  }
  return { sprawdzone: zamowienia.length, obce: obce.map(o => String(o.number || o.orderNumber)) };
}

async function przegladFaktur(prisma, deps, start) {
  const wyslij = deps.wyslij || wyslijAlert;
  const od = new Date(start);
  const blokady = await prisma.confirmLock.findMany({ where: { invoiceNumber: { not: null } }, select: { invoiceNumber: true } });
  const zCrm = new Set(blokady.map(b => String(b.invoiceNumber)));
  const pl = await prisma.invoice.findMany({ where: { createdAt: { gte: od } }, select: { number: true, contractorName: true, grossAmount: true, currency: true } });
  const es = await prisma.esInvoice.findMany({ where: { createdAt: { gte: od } }, select: { number: true, contractorName: true, totalAmount: true } });
  const obce = [
    ...pl.map(f => ({ nr: f.number, kto: f.contractorName, kwota: `${f.grossAmount} ${f.currency || 'PLN'}`, gdzie: 'iFirma' })),
    ...es.map(f => ({ nr: f.number, kto: f.contractorName, kwota: `${f.totalAmount} EUR`, gdzie: 'Contasimple' })),
  ].filter(f => f.nr && !zCrm.has(String(f.nr)));
  for (const f of obce) {
    await wyslij(`🛡️ Strażnik: faktura w ${f.gdzie}, której NIE wystawił CRM.\n${f.nr} — ${f.kto || '?'}, ${f.kwota}\nJeśli to nie Ty ani księgowa — sprawdź ją od razu (zmiana numeru konta, obcy odbiorca).`, `fv:${f.gdzie}:${f.nr}`);
  }
  return { nowych: pl.length + es.length, obce: obce.map(f => f.nr) };
}

async function przegladSkrzynek(prisma, deps) {
  const wyslij = deps.wyslij || wyslijAlert;
  const godzinaTemu = new Date(Date.now() - 3600 * 1000);
  const miesiacTemu = new Date(Date.now() - 31 * 24 * 3600 * 1000);
  const dzis = new Date().toISOString().slice(0, 10);
  const wysylki = await prisma.$queryRawUnsafe(
    `SELECT coalesce(payload->>'inbox', '?') AS inbox, count(*)::int AS n FROM "ActivityEvent" WHERE type = 'mail.sent_external' AND "createdAt" >= $1 GROUP BY 1`, godzinaTemu);
  const alerty = [];
  for (const w of wysylki) {
    const n = Number(w.n);
    if (n > PROG_WYSYLEK) {
      alerty.push(w.inbox);
      await wyslij(`🛡️ Strażnik: skrzynka ${w.inbox}@ wysłała ${n} maili w godzinę spoza CRM (zwykle najwyżej 3).\nJeśli to nie Ty — zmień hasło tej skrzynki w seohost.`, `wysylki:${w.inbox}:${dzis}`);
      continue;
    }
    const wczesniej = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "ActivityEvent" WHERE type = 'mail.sent_external' AND payload->>'inbox' = $1 AND "createdAt" >= $2 AND "createdAt" < $3`, w.inbox, miesiacTemu, godzinaTemu);
    if (Number((wczesniej[0] || {}).n || 0) === 0) {
      alerty.push(w.inbox);
      await wyslij(`🛡️ Strażnik: skrzynka ${w.inbox}@ wysłała maila spoza CRM, a przez 30 dni nie wysłała żadnego.\nJeśli to nie Ty — zmień hasło tej skrzynki w seohost i sprawdź folder Wysłane.`, `uspiona:${w.inbox}:${dzis}`);
    }
  }
  const zwroty = await prisma.$queryRawUnsafe(
    `SELECT coalesce(inbox, '?') AS inbox, count(*)::int AS n FROM "EmailSkip" WHERE (reason LIKE 'bounce:%' OR reason ILIKE '%mailer%' OR reason ILIKE '%daemon%' OR reason ILIKE '%postmaster%') AND "createdAt" >= $1 GROUP BY 1`, godzinaTemu);
  for (const z of zwroty) {
    const n = Number(z.n);
    if (n >= PROG_ZWROTOW) {
      alerty.push(`${z.inbox}:zwroty`);
      await wyslij(`🛡️ Strażnik: ${n} zwrotów w godzinę na ${z.inbox}@ (zwykle zero).\nKtoś mógł wysyłać maile z tej skrzynki — zmień jej hasło w seohost.`, `zwroty:${z.inbox}:${dzis}`);
    }
  }
  return { alerty };
}

async function przegladGodzinny(prisma, deps = {}) {
  _prisma = prisma;
  let start = await czytajJson(prisma, KLUCZ_START, null);
  if (!start) { start = new Date().toISOString(); if (!deps.dry) await zapiszJson(prisma, KLUCZ_START, start); }
  const wynik = { kiedy: new Date().toISOString() };
  for (const [nazwa, fn] of [['adresy', () => przegladAdresow(prisma, deps)], ['gk', () => przegladGK(prisma, deps, start)], ['faktury', () => przegladFaktur(prisma, deps, start)], ['skrzynki', () => przegladSkrzynek(prisma, deps)]]) {
    try { wynik[nazwa] = await fn(); } catch (e) { wynik[nazwa] = { blad: e.message }; console.error(`[straznik] ${nazwa}:`, e.message); }
  }
  ostatnieWyniki.godzinny = wynik;
  return wynik;
}

// ── przegląd częsty (15 min): baza, webhooki bota ───────────────────────────
let _podejrzaneBaza = new Set();
async function przegladBazy(prisma, deps) {
  const wyslij = deps.wyslij || wyslijAlert;
  // Każdy adres inny niż nasz własny (inet_client_addr() tego połączenia =
  // nasz kontener) to obcy klient bazy. Alert dopiero przy drugim przeglądzie
  // z rzędu — przy wdrożeniu stary i nowy kontener nakładają się na chwilę.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT host(client_addr) AS ip, usename, application_name FROM pg_stat_activity WHERE client_addr IS NOT NULL AND client_addr <> inet_client_addr()`);
  const teraz = new Set(rows.map(r => r.ip));
  const potwierdzone = rows.filter(r => _podejrzaneBaza.has(r.ip));
  if (!deps.dry) _podejrzaneBaza = teraz;
  for (const r of potwierdzone) {
    await wyslij(`🛡️ Strażnik: OBCE połączenie z bazą danych CRM.\nAdres: ${r.ip}, użytkownik: ${r.usename}${r.application_name ? `, aplikacja: ${r.application_name}` : ''}\nJeśli to nie Twoja usługa — wyłącz publiczny dostęp do bazy w Railway i wymień hasło bazy.`, `baza:${r.ip}:${new Date().toISOString().slice(0, 10)}`);
  }
  return { obcych: rows.length, zgloszone: potwierdzone.map(r => r.ip) };
}

function oczekiwanyHost() {
  const baza = (process.env.PUBLIC_BASE_URL || '').trim() || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
  try { return baza ? new URL(baza).host : null; } catch { return null; }
}

async function przegladWebhookow(prisma, deps) {
  const wyslij = deps.wyslij || wyslijAlert;
  const info = deps.webhookInfo || (async (scope) => {
    const { resolveToken } = require('./telegram-helper');
    const { tgApi } = require('../telegram-utils');
    const { token } = await resolveToken(prisma, scope);
    if (!token) return null;
    const r = await tgApi(token, 'getWebhookInfo', {});
    return r && r.result ? r.result : null;
  });
  const host = oczekiwanyHost();
  const wynik = {};
  for (const scope of ['pl', 'kanary']) {
    const w = await info(scope);
    if (!w) { wynik[scope] = 'brak tokenu / brak odpowiedzi'; continue; }
    const url = String(w.url || '');
    let zly = null;
    if (!url) zly = 'webhook ZDJĘTY — ktoś może czytać wiadomości do bota przez getUpdates';
    else if (!url.includes(`/telegram/webhook/${scope}`)) zly = `webhook wskazuje na obcą ścieżkę: ${url}`;
    else if (host) { try { if (new URL(url).host !== host) zly = `webhook wskazuje na obcy adres: ${url}`; } catch { zly = `nieprawidłowy adres webhooka: ${url}`; } }
    wynik[scope] = zly || 'ok';
    if (zly) {
      const blok = new Date(Math.floor(Date.now() / (6 * 3600 * 1000)) * 6 * 3600 * 1000).toISOString();
      await wyslij(`🛡️ Strażnik: bot ${scope.toUpperCase()} — ${zly}.\nKtoś ma token bota. Unieważnij go w BotFather (/revoke) i daj znać — podepnę bota na nowo.`, `webhook:${scope}:${blok}`);
    }
  }
  return wynik;
}

async function przegladCzesty(prisma, deps = {}) {
  _prisma = prisma;
  const wynik = { kiedy: new Date().toISOString() };
  for (const [nazwa, fn] of [['baza', () => przegladBazy(prisma, deps)], ['webhooki', () => przegladWebhookow(prisma, deps)]]) {
    try { wynik[nazwa] = await fn(); } catch (e) { wynik[nazwa] = { blad: e.message }; console.error(`[straznik] ${nazwa}:`, e.message); }
  }
  ostatnieWyniki.czesty = wynik;
  return wynik;
}

// ── start i podgląd ─────────────────────────────────────────────────────────
function uruchom(prisma) {
  _prisma = prisma;
  const czesty = () => przegladCzesty(prisma).catch(e => console.error('[straznik] przegląd częsty:', e.message));
  const godzinny = () => przegladGodzinny(prisma).catch(e => console.error('[straznik] przegląd godzinny:', e.message));
  setTimeout(czesty, 2 * 60 * 1000).unref();
  setInterval(czesty, 15 * 60 * 1000).unref();
  setTimeout(godzinny, 5 * 60 * 1000).unref();
  setInterval(godzinny, 60 * 60 * 1000).unref();
  console.log('[straznik] uruchomiony: baza i webhooki co 15 min, adresy / GK / faktury / skrzynki co godzinę');
}

async function stan(prisma) {
  const znane = await czytajZnane(prisma);
  return {
    oknoOd: new Date(okno.od).toISOString(),
    wywolaniaZPanelu: okno.panel,
    adresyWTejGodzinie: [...okno.adresy.entries()].map(([ip, w]) => ({ ip, siec: siecAdresu(ip), n: w.n, nowy: !znane[siecAdresu(ip)], rodzaje: [...w.rodzaje], ua: [...w.ua].slice(0, 2), sciezki: [...w.sciezki.entries()].slice(0, 5) })),
    znaneSieci: Object.entries(znane).map(([siec, z]) => ({ siec, ...z })),
    start: await czytajJson(prisma, KLUCZ_START, null),
    ostatnieWyniki,
  };
}

module.exports = {
  middleware, zarejestruj, przegladGodzinny, przegladCzesty, uruchom, stan,
  alert: (tekst, klucz) => wyslijAlert(tekst, klucz),
  _test: { okno, adresKlienta, siecAdresu, podgladLinku, ipv4WZakresie, zTelegrama, sciezkaOgolna, rodzajTrasy, lokalnieWarszawa, reset: () => { okno.adresy = new Map(); okno.panel = 0; _podejrzaneBaza = new Set(); } },
  PROG_WYWOLAN, PROG_WYSYLEK, PROG_ZWROTOW,
};
