"use strict";

/* BELL OUTREACH — most do systemu zimnego mailingu (20.10.2026).
 *
 * Bell Outreach wysyła z naszych skrzynek zimne maile do sklepów i
 * wypożyczalni (DE/AT/CH/IT/FR), ale tych skrzynek NIE czyta. Czyta je CRM
 * (poller co 5 min) — więc to CRM mówi Bell Outreach, kto odpisał, kto odbił
 * i kto ma autoresponder:
 *
 *   POST {BELL_OUTREACH_URL}/api/surf_stick/odpowiedzi
 *   Authorization: Bearer {BELL_OUTREACH_TOKEN}   (env albo Config bell_outreach_token)
 *
 * Rodzaje: nie_zainteresowany (BLOKUJE całą firmę w Bell — stąd tylko przy
 * krótkiej, jednoznacznej odmowie), wypisz, zainteresowany, odpowiedz,
 * autoresponder, odbicie (+adres_odbity z raportu DSN). Przy wątpliwości
 * ZAWSZE `odpowiedz`.
 *
 * Przepływ: poller → kolejkujZMaila() → wiersz BellOutreachMsg (dedup po
 * Message-ID) → po każdym cyklu wyslijKolejke(): paczki ≤200, timeout 20 s;
 * 200 → wyslany/pominiety wg odpowiedzi; 400 → błąd danych, bez ponowień;
 * 401/404 → alarm, pauza godzinę; 429/5xx/sieć → ponowienia 1/2/4/8 min,
 * potem następny cykl. Treści maila nie wysyłamy. Tokenu nie logujemy nigdy.
 * BELL_OUTREACH_DRY_RUN=1 wypisuje paczkę zamiast ją wysłać.
 *
 * Wzorce prośby o wypis (wykryjWypis) i cięcie cytatu (czescWlasnaMaila)
 * są w inbox-poller.js — poller WSTRZYKUJE je przy wywołaniu, bo require
 * pollera uruchamia polling (startPolling na końcu modułu). Tu są tylko
 * wzorce, których poller nie ma: odmowa, zainteresowanie, autoresponder,
 * odbicie. */

const { fetchWithTimeout } = require('../http');

const RODZAJE = ['nie_zainteresowany', 'wypisz', 'zainteresowany', 'odpowiedz', 'autoresponder', 'odbicie'];
const URL_DOMYSLNY = 'https://bell-mailing-system-production.up.railway.app';
const SCIEZKA = '/api/surf_stick/odpowiedzi';
const MAX_W_PACZCE = 200;
const TIMEOUT_MS = 20000;
const OPOZNIENIA_MIN = [1, 2, 4, 8];
const KLUCZ_TOKENU = 'bell_outreach_token';
const KLUCZ_SKRZYNEK_POZA = 'bell_outreach_skrzynki_poza';

const DOMENA_WLASNA_RE = /@surfstickbell\.(com|fr|es|pl)$/i;
const ODPOWIEDZ_TEMAT_RE = /^\s*(re|aw|antw|antwort|r|sv|odp|wg|fwd?|tr|rif|ref)\s*:/i;

// Odbicie: nadawca-robot albo DSN w temacie/treści.
const NADAWCA_ZWROTKI_RE = /(mailer-?daemon|postmaster|mail-?delivery|delivery-?(system|status)|bounce|returned)/i;
const TEMAT_ZWROTKI_RE = /undeliver|unzustellbar|delivery (status|failure|has failed)|mail delivery failed|failure notice|returned mail|nicht zugestellt|non (recapitabil|consegnat)|non remis|(é|e)chec de (la )?livraison|undelivered|delivery notification/i;
const TRESC_ZWROTKI_RE = /final-recipient:|original-recipient:|x-failed-recipients:|status:\s*5\.\d\.\d|\b55[0-4][ -]5\.\d\.\d|user unknown|unknown user|mailbox (unavailable|not found|does not exist)|recipient address rejected|no such user|address rejected|does not exist/i;

// Autoresponder: nagłówek Auto-Submitted: auto-replied, temat albo początek treści.
const AUTORESPONDER_TEMAT_RE = /abwesenheit|abwesend|out of (the )?office|automatische antwort|automatic reply|auto-?reply|autoreply|autorisposta|r(é|e)ponse automatique|risposta automatica|fuori (sede|ufficio)|absence du bureau|je suis absent|nicht im (b(ü|u)ro|haus)|\bim urlaub\b|\bin vacanz|\ben cong(é|e)\b|on (annual )?leave|\booo\b|automatyczna odpowied/i;
const AUTORESPONDER_TRESC_RE = /abwesenheitsnotiz|out of (the )?office|automatische antwort|automatic reply|this is an automated|r(é|e)ponse automatique|risposta automatica|messaggio automatico|bin bis zum .{3,30} (nicht|abwesend)|bin ab dem .{3,30} wieder/i;

// Odmowa: krótka, jednoznaczna. Nasz mail kończy się prośbą o krótką odpowiedź,
// gdy temat nie jest relewantny — „Nein danke" / „Kein Bedarf" to odmowa.
const ODMOWA_RE = /\bkein(e|en)?\s+(interesse|bedarf)\b|nicht\s+(relevant|interessiert|von\s+interesse)|\bnein,?\s+danke\b|\bdanke,?\s+nein\b|\bno,?\s+thank(s|\s+you)\b|\bnot\s+(interested|relevant|for us)\b|\bno\s+(interest|need|thanks)\b|non\s+(siamo|sono|è)\s+(di\s+(nostro\s+)?)?interess|non\s+(ci\s+)?interessa|nessun\s+interesse|pas\s+int(é|e)ress(é|e)|pas\s+d'?int(é|e)r(ê|e)t|sans\s+int(é|e)r(ê|e)t|\bnon\s+merci\b|no\s+(estamos|estoy)\s+interesad|no\s+nos\s+interesa|sin\s+inter(é|e)s|nie\s+jeste(ś|s)my\s+zainteresowan|brak\s+zainteresowania|nie,?\s+dzi(ę|e)kuj|geen\s+interesse|niet\s+ge(ï|i)nteresseerd/i;
const MAX_DLUGOSC_ODMOWY = 400;

// Zainteresowanie: katalog, ceny, próbki, oferta, rozmowa, zamówienie.
const ZAINTERESOWANIE_RE = /katalog|catalog|preisliste|price\s*list|prezzi|listino|tarif|\bpreise?\b|\bprices?\b|\bprix\b|muster|sample|(é|e)chantillon|campion|angebot|offerta|\boffre\b|\bbestell|\border\b|ordin(e|are|azione)|\bcommande|interessiert|interessat[io]|intéressée?s?\b|interested|\btermin\b|\bcall\b|anrufen|r(ü|u)ckruf|meeting|gespr(ä|a)ch|\bappel|telefon|zusenden|schicken sie|send (us|me)|envoyez|inviat(e|emi)|h(ä|a)tten? (wir )?gerne|w(ü|u)rden? (wir )?gerne/i;

// Prosty zapasowy wycinek własnej treści (bez cytatu) — gdy poller nie wstrzyknął swojego.
function wytnijCytat(bodyText) {
  const body = String(bodyText || '');
  const cut = body.search(/(^|\n)\s*(>|von:|from:|de:|da:|od:|-{3,}\s*(original|urspr(ü|u)ngliche|mensaje original|message d'origine|wiadomość oryginalna)|am\s.{3,60}\sschrieb|on\s.{3,80}\swrote|le\s.{3,80}\sa\s(é|e)crit|il\s.{3,80}\sha\sscritto|el\s.{3,80}\sescribi|w\sdniu\s.{3,80}\snapisa)/i);
  return (cut >= 0 ? body.slice(0, cut) : body).slice(0, 1200);
}

function wyciagnijAdresOdbity(m) {
  const body = String(m.bodyText || '');
  const wzorce = [
    /final-recipient:\s*(rfc822;)?\s*<?([^\s<>;]+@[^\s<>;]+)/i,
    /original-recipient:\s*(rfc822;)?\s*<?([^\s<>;]+@[^\s<>;]+)/i,
    /x-failed-recipients:\s*<?([^\s<>;,]+@[^\s<>;,]+)/i,
  ];
  for (const re of wzorce) {
    const h = body.match(re);
    if (h) return (h[2] || h[1]).toLowerCase().replace(/[.,;:)]+$/, '');
  }
  const nadawca = String(m.fromEmail || '').toLowerCase();
  const kandydaci = (`${m.subject || ''}\n${body}`.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map(a => a.toLowerCase());
  return kandydaci.find(a => !DOMENA_WLASNA_RE.test(a) && !NADAWCA_ZWROTKI_RE.test(a) && a !== nadawca) || null;
}

/* Klasyfikacja do rodzaju Bell Outreach. Wejście: pola maila jak w pollerze
 * (fromEmail, toEmail, subject, bodyText, inReplyTo, references, autoSubmitted,
 * listUnsubscribe, direction) + to, co CRM już wie: category (ocena modelu),
 * wypis (trafienie wykryjWypis). opcje.wykryjWypis / opcje.czescWlasnaMaila —
 * wstrzyknięte z pollera. Zwraca { rodzaj, adresOdbity, regula } albo null
 * (nie wysyłać: newsletter, nasz mail, nie-odpowiedź). */
function rodzajBellOutreach(m, opcje = {}) {
  if (!m) return null;
  if (m.direction && m.direction !== 'INBOUND') return null;
  const od = String(m.fromEmail || '').toLowerCase();
  if (!od || DOMENA_WLASNA_RE.test(od)) return null;
  const temat = String(m.subject || '');
  const bodyText = String(m.bodyText || '');
  const autoSubmitted = String(m.autoSubmitted || '').toLowerCase();

  if (NADAWCA_ZWROTKI_RE.test(od) || TEMAT_ZWROTKI_RE.test(temat) || TRESC_ZWROTKI_RE.test(bodyText.slice(0, 2500))) {
    return { rodzaj: 'odbicie', adresOdbity: wyciagnijAdresOdbity(m), regula: 'zwrotka' };
  }
  if (m.listUnsubscribe && !m.inReplyTo) return null; // masówka / newsletter

  const wlasna = (opcje.czescWlasnaMaila ? opcje.czescWlasnaMaila(m) : wytnijCytat(bodyText)).trim();
  if (autoSubmitted.includes('auto-replied') || AUTORESPONDER_TEMAT_RE.test(temat) || AUTORESPONDER_TRESC_RE.test(wlasna.slice(0, 300)) || m.category === 'AUTO_REPLY') {
    return { rodzaj: 'autoresponder', adresOdbity: null, regula: autoSubmitted.includes('auto-replied') ? 'auto-submitted' : 'temat/treść autorespondera' };
  }

  const jestOdpowiedzia = !!m.inReplyTo || !!m.references || ODPOWIEDZ_TEMAT_RE.test(temat);
  const krotka = wlasna.length > 0 && wlasna.length <= MAX_DLUGOSC_ODMOWY;
  const odmowa = ODMOWA_RE.exec(wlasna);
  // Zainteresowanie liczymy po wycięciu odmowy — „pas intéressés" czy
  // „non siamo interessati" zawierają słowo zainteresowania, ale nim nie są.
  const zainteresowanie = ZAINTERESOWANIE_RE.exec(wlasna.replace(new RegExp(ODMOWA_RE.source, 'gi'), ' '));
  const wypis = typeof m.wypis === 'string' && m.wypis ? m.wypis : (opcje.wykryjWypis ? opcje.wykryjWypis(m) : null);

  if (odmowa && krotka && !wlasna.includes('?') && !zainteresowanie) {
    return { rodzaj: 'nie_zainteresowany', adresOdbity: null, regula: `odmowa:${odmowa[0].slice(0, 40)}` };
  }
  if (wypis) return { rodzaj: 'wypisz', adresOdbity: null, regula: `wypis:${String(wypis).slice(0, 60)}` };
  if (!jestOdpowiedzia && !(krotka && odmowa)) return null; // nie-odpowiedź: Bell i tak jej nie dopasuje
  if (zainteresowanie && !odmowa) {
    return { rodzaj: 'zainteresowany', adresOdbity: null, regula: `zainteresowanie:${zainteresowanie[0].slice(0, 40)}` };
  }
  return { rodzaj: 'odpowiedz', adresOdbity: null, regula: odmowa ? 'odmowa niejednoznaczna → odpowiedz' : 'odpowiedź' };
}

// Nasz adres skrzynki: konto IMAP (account.user) → To z własnej domeny → nazwa skrzynki.
function adresSkrzynki({ kontoAdres, toEmail, inbox }) {
  if (kontoAdres && String(kontoAdres).includes('@')) return String(kontoAdres).toLowerCase();
  const to = String(toEmail || '').toLowerCase();
  if (to && DOMENA_WLASNA_RE.test(to)) return to;
  return `${inbox || 'info'}@surfstickbell.com`;
}

function dataMaila(d) {
  const x = d instanceof Date ? d : (d ? new Date(d) : null);
  return x && !isNaN(x.getTime()) ? x : new Date();
}

/* Kolejkuje mail z pollera. opcje: inbox, kontoAdres, emailId, category, wypis,
 * zrodlo, tylko (lista rodzajów, które interesują — np. przy mailach
 * odrzuconych filtrem tylko odbicie/autoresponder), wykryjWypis, czescWlasnaMaila. */
async function kolejkujZMaila(prisma, mail, o = {}) {
  if (!mail || !mail.messageId) return null;
  const wynik = rodzajBellOutreach({ direction: 'INBOUND', ...mail, category: o.category, wypis: o.wypis }, { wykryjWypis: o.wykryjWypis, czescWlasnaMaila: o.czescWlasnaMaila });
  if (!wynik) return null;
  if (Array.isArray(o.tylko) && !o.tylko.includes(wynik.rodzaj)) return null;
  const rekord = {
    messageId: String(mail.messageId).slice(0, 500),
    skrzynka: adresSkrzynki({ kontoAdres: o.kontoAdres, toEmail: mail.toEmail, inbox: o.inbox }),
    od: String(mail.fromEmail).toLowerCase().slice(0, 320),
    inReplyTo: mail.inReplyTo ? String(mail.inReplyTo).slice(0, 500) : null,
    references: mail.references ? (Array.isArray(mail.references) ? mail.references.join(' ') : String(mail.references)).slice(0, 2000) : null,
    temat: mail.subject ? String(mail.subject).slice(0, 300) : null,
    data: dataMaila(mail.date),
    rodzaj: wynik.rodzaj,
    adresOdbity: wynik.adresOdbity || null,
    regula: wynik.regula ? String(wynik.regula).slice(0, 120) : null,
    emailId: o.emailId || null,
    zrodlo: o.zrodlo || 'email',
  };
  try {
    await prisma.bellOutreachMsg.create({ data: rekord });
    console.log(`[bell-outreach] kolejka +1 ${rekord.rodzaj} (${rekord.regula}) ${rekord.messageId}`);
    return rekord;
  } catch (e) {
    if (e && e.code === 'P2002') return null; // już w kolejce
    console.error('[bell-outreach] kolejkowanie nieudane:', e.message);
    return null;
  }
}

function budujPaczke(rows) {
  return {
    zrodlo: 'crm',
    wiadomosci: rows.slice(0, MAX_W_PACZCE).map(r => {
      const w = { skrzynka: r.skrzynka, od: r.od, message_id: r.messageId, rodzaj: r.rodzaj, data: dataMaila(r.data).toISOString() };
      if (r.inReplyTo) w.in_reply_to = r.inReplyTo;
      if (r.references) w.references = r.references;
      if (r.temat) w.temat = r.temat;
      if (r.rodzaj === 'odbicie' && r.adresOdbity) w.adres_odbity = r.adresOdbity;
      return w;
    }),
  };
}

function konfiguracja() {
  return {
    url: String(process.env.BELL_OUTREACH_URL || URL_DOMYSLNY).replace(/\/+$/, ''),
    dryRun: /^(1|true|tak|yes)$/i.test(String(process.env.BELL_OUTREACH_DRY_RUN || '')),
  };
}

async function pobierzToken(prisma) {
  const env = String(process.env.BELL_OUTREACH_TOKEN || '').trim();
  if (env) return env;
  try {
    const cfg = prisma && prisma.config ? await prisma.config.findUnique({ where: { key: KLUCZ_TOKENU } }) : null;
    return cfg && cfg.value ? String(cfg.value).trim() : null;
  } catch { return null; }
}

async function skrzynkiPozaKampania(prisma) {
  try {
    const cfg = prisma && prisma.config ? await prisma.config.findUnique({ where: { key: KLUCZ_SKRZYNEK_POZA } }) : null;
    const lista = cfg && cfg.value ? JSON.parse(cfg.value) : [];
    return Array.isArray(lista) ? lista : [];
  } catch { return []; }
}

async function zapamietajSkrzynkePoza(prisma, skrzynka) {
  try {
    const lista = await skrzynkiPozaKampania(prisma);
    if (lista.includes(skrzynka)) return;
    lista.push(skrzynka);
    await prisma.config.upsert({ where: { key: KLUCZ_SKRZYNEK_POZA }, update: { value: JSON.stringify(lista) }, create: { key: KLUCZ_SKRZYNEK_POZA, value: JSON.stringify(lista) } });
    console.log(`[bell-outreach] skrzynka ${skrzynka} spoza kampanii — nie wysyłam z niej więcej`);
  } catch (e) { console.error('[bell-outreach] zapis skrzynek poza kampanią:', e.message); }
}

// Stan ponowień (w pamięci — po redeployu zaczynamy od zera, kolejka jest w bazie).
const stan = { nieudane: 0, nastepnaProbaO: 0, ostatni: null, alarmO: 0, brakTokenuO: 0 };
let planuj = (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; };
function ustawPlanowanie(fn) { planuj = fn; }
function zerujStan() { stan.nieudane = 0; stan.nastepnaProbaO = 0; stan.ostatni = null; stan.alarmO = 0; stan.brakTokenuO = 0; }

async function alarm(prisma, tekst) {
  if (Date.now() - stan.alarmO < 60 * 60 * 1000) return;
  stan.alarmO = Date.now();
  console.error(`[bell-outreach] ALARM: ${tekst}`);
  try {
    const { resolveTelegram } = require('./telegram-helper');
    const { sendTelegram } = require('../telegram-utils');
    const { token, chatId } = await resolveTelegram(prisma, { scope: 'pl' });
    if (token && chatId) await sendTelegram(token, chatId, `⚠️ Bell Outreach: ${tekst}`);
  } catch (e) { console.error('[bell-outreach] alarm Telegram nieudany:', e.message); }
}

function zaplanujPonowienie(prisma, powod, teraz) {
  const idx = stan.nieudane;
  stan.nieudane++;
  stan.ostatni = { kiedy: new Date(teraz).toISOString(), wynik: `ponowienie: ${powod}` };
  if (idx < OPOZNIENIA_MIN.length) {
    const ms = OPOZNIENIA_MIN[idx] * 60 * 1000;
    stan.nastepnaProbaO = teraz + ms;
    console.warn(`[bell-outreach] ${powod} — ponowię za ${OPOZNIENIA_MIN[idx]} min (próba ${stan.nieudane}/${OPOZNIENIA_MIN.length})`);
    planuj(() => wyslijKolejke(prisma, { force: true }).catch(e => console.error('[bell-outreach] ponowienie:', e.message)), ms);
    return { ponowienie: true, za_min: OPOZNIENIA_MIN[idx], powod };
  }
  stan.nieudane = 0;
  stan.nastepnaProbaO = 0;
  console.error(`[bell-outreach] ${powod} — wyczerpane ponowienia, spróbuję w następnym cyklu`);
  return { ponowienie: false, powod };
}

/* Wysyła oczekujące wiersze (status nowy) jedną paczką. opcje: force (ignoruj
 * odstęp ponowienia), dryRun (true/false; domyślnie z env), fetchImpl, now. */
async function wyslijKolejke(prisma, o = {}) {
  const teraz = typeof o.now === 'function' ? o.now() : Date.now();
  if (!o.force && teraz < stan.nastepnaProbaO) return { pominieto: 'czekam na ponowienie', za_s: Math.round((stan.nastepnaProbaO - teraz) / 1000) };
  const cfg = konfiguracja();
  const dry = o.dryRun != null ? !!o.dryRun : cfg.dryRun;
  const poza = await skrzynkiPozaKampania(prisma);
  const rows = await prisma.bellOutreachMsg.findMany({
    where: { status: 'nowy', ...(poza.length ? { skrzynka: { notIn: poza } } : {}) },
    orderBy: { createdAt: 'asc' }, take: MAX_W_PACZCE,
  });
  if (!rows.length) return { wyslano: 0 };
  const paczka = budujPaczke(rows);
  if (dry) {
    console.log(`[bell-outreach] TRYB PRÓBNY — paczka ${rows.length} wiad. do ${cfg.url}${SCIEZKA} (nie wysyłam):\n${JSON.stringify(paczka, null, 1)}`);
    return { dryRun: true, ile: rows.length, paczka };
  }
  const token = await pobierzToken(prisma);
  if (!token) {
    // Bez tokenu kolejka po prostu czeka — log raz na godzinę, bez Telegrama
    // (to stan „jeszcze nie skonfigurowane", nie awaria).
    if (Date.now() - stan.brakTokenuO > 60 * 60 * 1000) {
      stan.brakTokenuO = Date.now();
      console.warn(`[bell-outreach] brak tokenu (BELL_OUTREACH_TOKEN w Railway albo Config ${KLUCZ_TOKENU}) — ${rows.length} wiadomości czeka w kolejce`);
    }
    return { pominieto: 'brak tokenu', czeka: rows.length };
  }
  let res;
  try {
    res = await (o.fetchImpl || fetchWithTimeout)(cfg.url + SCIEZKA, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(paczka),
    }, TIMEOUT_MS);
  } catch (e) {
    return zaplanujPonowienie(prisma, `sieć: ${String(e && e.message || e).slice(0, 120)}`, teraz);
  }
  const status = res.status;
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  const idsMsg = rows.map(r => r.messageId);

  if (status === 200 && body && body.ok !== false) {
    const pominiete = Array.isArray(body.pominiete) ? body.pominiete : [];
    const pominieteIds = new Set();
    for (const p of pominiete) {
      const mid = p && p.message_id ? String(p.message_id) : (p && Number.isInteger(p.nr) && rows[p.nr - 1] ? rows[p.nr - 1].messageId : null);
      if (!mid) continue;
      pominieteIds.add(mid);
      const powod = String(p.powod || 'pominięte').slice(0, 300);
      await prisma.bellOutreachMsg.updateMany({ where: { messageId: mid }, data: { status: 'pominiety', powod, proby: { increment: 1 } } });
      if (/spoza tej kampanii/i.test(powod)) {
        const r = rows.find(x => x.messageId === mid);
        if (r) await zapamietajSkrzynkePoza(prisma, r.skrzynka);
      }
    }
    const wyslane = idsMsg.filter(id => !pominieteIds.has(id));
    if (wyslane.length) await prisma.bellOutreachMsg.updateMany({ where: { messageId: { in: wyslane } }, data: { status: 'wyslany', wyslanoAt: new Date(teraz), powod: null, proby: { increment: 1 } } });
    stan.nieudane = 0; stan.nastepnaProbaO = 0;
    const cl = body.czarna_lista || {};
    stan.ostatni = { kiedy: new Date(teraz).toISOString(), wynik: `200: przyjete=${body.przyjete} juz_byly=${body.juz_byly} dopasowane=${body.dopasowane} czarna_lista=${cl.adresy || 0}/${cl.domeny || 0} pominiete=${pominiete.length}` };
    console.log(`[bell-outreach] ${stan.ostatni.wynik}; wysłane=${wyslane.length} ids=${JSON.stringify(wyslane.slice(0, 20))}${pominiete.length ? ' pominięte=' + JSON.stringify(pominiete.slice(0, 10).map(p => ({ message_id: p.message_id, powod: p.powod }))) : ''}`);
    return { wyslano: wyslane.length, pominiete: pominiete.length, odpowiedz: body };
  }
  if (status === 400) {
    const powod = `HTTP 400: ${JSON.stringify(body || '').slice(0, 300)}`;
    await prisma.bellOutreachMsg.updateMany({ where: { messageId: { in: idsMsg } }, data: { status: 'blad', powod, proby: { increment: 1 } } });
    stan.ostatni = { kiedy: new Date(teraz).toISOString(), wynik: powod };
    await alarm(prisma, `Bell Outreach odrzucił paczkę (400 — błąd danych po naszej stronie, ${rows.length} wiad. oznaczone jako błąd): ${JSON.stringify(body || '').slice(0, 200)}`);
    return { blad: 400, ile: rows.length };
  }
  if (status === 401 || status === 404) {
    stan.nastepnaProbaO = teraz + 60 * 60 * 1000;
    stan.ostatni = { kiedy: new Date(teraz).toISOString(), wynik: `HTTP ${status}` };
    await alarm(prisma, status === 401 ? 'zły token (401) — sprawdź BELL_OUTREACH_TOKEN; kolejka czeka' : 'zła ścieżka (404) — sprawdź BELL_OUTREACH_URL; kolejka czeka');
    return { blad: status, czeka: rows.length };
  }
  return zaplanujPonowienie(prisma, `HTTP ${status}`, teraz);
}

/* Jednorazowe objęcie historii: maile INBOUND z ostatnich `dni` (Email) oraz
 * odbicia i autorespondery wyrzucone filtrem (EmailSkip — bez tematu i bez
 * adresu odbitego, bo treści tam nie ma). Nic nie wysyła — tylko kolejkuje. */
async function backfill(prisma, o = {}) {
  const dni = Math.max(1, Math.min(365, parseInt(o.dni, 10) || 30));
  const od = new Date(Date.now() - dni * 24 * 3600 * 1000);
  const konta = o.kontaAdresy || {};
  const wynik = { dni, przejrzane: 0, dodane: 0, juzByly: 0, rodzaje: {}, czarnaLista: [] };
  const maile = await prisma.email.findMany({
    where: { direction: 'INBOUND', createdAt: { gte: od }, messageId: { not: null } },
    select: { id: true, inbox: true, fromEmail: true, toEmail: true, subject: true, bodyFull: true, messageId: true, inReplyTo: true, references: true, tags: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const skipy = await prisma.emailSkip.findMany({
    where: { createdAt: { gte: od }, fromEmail: { not: null }, OR: [
      { reason: { startsWith: 'bounce:' } }, { reason: { contains: 'auto-submitted=auto-replied' } },
      { reason: { contains: 'nadawca-zawiera-mailer' } }, { reason: { contains: 'nadawca-zawiera-daemon' } },
      { reason: { contains: 'nadawca-zawiera-postmaster' } }, { reason: { contains: 'nadawca-zawiera-bounce' } },
    ] },
    orderBy: { createdAt: 'asc' },
  });
  const ids = [...maile.map(m => m.messageId), ...skipy.map(s => s.messageId)];
  const juz = new Set((await prisma.bellOutreachMsg.findMany({ where: { messageId: { in: ids } }, select: { messageId: true } })).map(x => x.messageId));
  for (const m of maile) {
    wynik.przejrzane++;
    if (juz.has(m.messageId)) { wynik.juzByly++; continue; }
    const r = await kolejkujZMaila(prisma, {
      fromEmail: m.fromEmail, toEmail: m.toEmail, subject: m.subject, bodyText: m.bodyFull || '', messageId: m.messageId,
      inReplyTo: m.inReplyTo, references: m.references, date: m.createdAt,
    }, {
      inbox: m.inbox, kontoAdres: konta[m.inbox], emailId: m.id, category: Array.isArray(m.tags) ? m.tags[0] : undefined,
      wypis: Array.isArray(m.tags) && m.tags.includes('wypis') ? 'tag:wypis' : undefined, zrodlo: 'backfill',
      wykryjWypis: o.wykryjWypis, czescWlasnaMaila: o.czescWlasnaMaila,
    });
    if (r) {
      wynik.dodane++; wynik.rodzaje[r.rodzaj] = (wynik.rodzaje[r.rodzaj] || 0) + 1;
      if (r.rodzaj === 'nie_zainteresowany' || r.rodzaj === 'wypisz') wynik.czarnaLista.push({ rodzaj: r.rodzaj, od: r.od, temat: r.temat, regula: r.regula, messageId: r.messageId });
    }
  }
  for (const s of skipy) {
    wynik.przejrzane++;
    if (juz.has(s.messageId)) { wynik.juzByly++; continue; }
    const rodzaj = /auto-replied/.test(s.reason) ? 'autoresponder' : 'odbicie';
    try {
      await prisma.bellOutreachMsg.create({ data: {
        messageId: s.messageId, skrzynka: adresSkrzynki({ kontoAdres: konta[s.inbox], inbox: s.inbox }), od: String(s.fromEmail).toLowerCase(),
        data: s.createdAt, rodzaj, regula: `filtr:${s.reason}`.slice(0, 120), zrodlo: 'backfill-filtr',
      } });
      wynik.dodane++; wynik.rodzaje[rodzaj] = (wynik.rodzaje[rodzaj] || 0) + 1;
    } catch (e) { if (!(e && e.code === 'P2002')) console.error('[bell-outreach] backfill EmailSkip:', e.message); }
  }
  console.log(`[bell-outreach] backfill ${dni} dni: przejrzane=${wynik.przejrzane} dodane=${wynik.dodane} juz=${wynik.juzByly} rodzaje=${JSON.stringify(wynik.rodzaje)}`);
  return wynik;
}

async function statusKolejki(prisma) {
  const grupy = await prisma.bellOutreachMsg.groupBy({ by: ['status', 'rodzaj'], _count: { _all: true } });
  const wg = {};
  for (const g of grupy) { wg[g.status] = wg[g.status] || {}; wg[g.status][g.rodzaj] = g._count._all; }
  const cfg = konfiguracja();
  return {
    url: cfg.url + SCIEZKA, tokenUstawiony: !!(await pobierzToken(prisma)), dryRun: cfg.dryRun,
    skrzynkiPozaKampania: await skrzynkiPozaKampania(prisma),
    ponowienia: { nieudane: stan.nieudane, nastepnaProbaO: stan.nastepnaProbaO ? new Date(stan.nastepnaProbaO).toISOString() : null },
    ostatniaWysylka: stan.ostatni, kolejka: wg,
  };
}

module.exports = {
  RODZAJE, rodzajBellOutreach, wyciagnijAdresOdbity, adresSkrzynki, kolejkujZMaila, budujPaczke,
  wyslijKolejke, backfill, statusKolejki, konfiguracja, pobierzToken, ustawPlanowanie, zerujStan,
  _stan: stan, KLUCZ_TOKENU, KLUCZ_SKRZYNEK_POZA, SCIEZKA,
};
