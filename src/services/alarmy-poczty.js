'use strict';

/* ALARMY O POCZCIE BEZ SERII „nie działa / działa / nie działa" (3.11.2026).
 *
 * Było: każda skrzynka alarmowała OSOBNO po 2 nieudanych cyklach (~10 min),
 * a jedno udane połączenie kasowało pamięć alarmu. Serwer poczty, który co
 * kilkanaście minut nie odpowiadał przy logowaniu („Timed out while
 * authenticating with server"), dawał co 10–15 min po trzy wiadomości
 * „⚠️ info@ / niko@ / delivery@ NIE pobiera maili" na zmianę z trzema „✅ znów
 * pobiera" — z mylącą radą „sprawdź hasło". Właściciel: „za bardzo spamuje".
 *
 * Teraz o alarmie decyduje jedno miejsce, raz na cykl, dla wszystkich skrzynek:
 *  - AWARIA SERWERA (limit czasu, zerwane połączenie, serwer niedostępny) to
 *    jeden incydent na host: wiadomość dopiero, gdy któraś skrzynka nie
 *    połączyła się ANI RAZU przez PROG_MS (30 min). Krótkie przerwy, które
 *    poller i tak nadrabia sam, nie budzą nikogo;
 *  - incydent trwa, dopóki serwer nie działa STABILNIE przez STABILNIE_MS
 *    (30 min bez błędu) — wtedy jedno „✅" z czasem trwania kłopotów. Serwer
 *    „mrugający" w tym czasie nie wysyła nic;
 *  - kolejny alarm o tym samym serwerze lub skrzynce najwcześniej po
 *    ODSTEP_MS (3 h); awaria trwająca dalej — przypomnienie raz na dobę;
 *  - ZŁE HASŁO jednej skrzynki (serwer odrzucił logowanie): po 2 cyklach, bo
 *    samo nie przejdzie — i tylko tu pada rada o IMAP_ACCOUNTS;
 *  - inny błąd jednej skrzynki: po 30 min, tak jak serwer.
 * Otwarte incydenty leżą w Config `poczta_alarmy`, żeby redeploy w trakcie
 * awarii nie zgubił „✅" ani nie powtórzył „⚠️". */

const MIN = 60 * 1000;
const minutyZEnv = (nazwa, domyslnie) => {
  const n = Number(process.env[nazwa]);
  return (Number.isFinite(n) && n > 0 ? n : domyslnie) * MIN;
};
const PROG_MS = minutyZEnv('POCZTA_ALARM_PO_MIN', 30);
const STABILNIE_MS = minutyZEnv('POCZTA_STABILNIE_MIN', 30);
const ODSTEP_MS = 3 * 60 * MIN;
const PRZYPOMNIENIE_MS = 24 * 60 * MIN;
const PROG_LOGOWANIA = 2;
const KLUCZ = 'poczta_alarmy';

/* Serwer nie odpowiada / połączenie padło. Też „Timed out while
 * authenticating" (serwer nie odpisał na LOGIN w 15 s — to wolny serwer, nie
 * złe hasło) i „Temporary authentication failure" (backend logowania leży). */
function awariaSerwera(blad) {
  // Nasze własne komunikaty bywają bez polskich znaków („polaczenie IMAP
  // zakonczone przed gotowoscia") — 4.11.2026 przez brak `[nń]` szły jako
  // „inny" błąd i obok alarmu o serwerze leciały alarmy o pojedynczych skrzynkach.
  return /przekroczono|timed out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|socket|zamkni[eę]te przed gotowo|zako[nń]czone przed gotowo|\bUNAVAILABLE\b|temporar/i.test(String(blad || ''));
}
const ZLE_LOGOWANIE = /AUTHENTICATIONFAILED|AUTHORIZATIONFAILED|authentication failed|invalid credentials|bad credentials|login failed|LOGIN (failed|denied|incorrect)|incorrect (password|username)|nieprawid[łl]owe (has[łl]o|dane logowania)/i;

/** 'serwer' | 'logowanie' | 'inny' */
function rodzajBledu(blad) {
  if (awariaSerwera(blad)) return 'serwer';
  if (ZLE_LOGOWANIE.test(String(blad || ''))) return 'logowanie';
  return 'inny';
}

function nowyStan(zapisany) {
  const z = zapisany && typeof zapisany === 'object' ? zapisany : {};
  const stan = {
    skrzynki: {},                           // tylko w pamięci: inbox → bieżąca seria błędów
    serwery: z.serwery || {},               // host → otwarty incydent serwera
    skrzynkiAlarmy: z.skrzynkiAlarmy || {}, // inbox → otwarty incydent jednej skrzynki
    ostatnie: z.ostatnie || {},             // 'serwer:<host>' / 'skrzynka:<inbox>' → czas ostatniego alarmu
    zmiana: false,
  };
  // Incydent skrzynki otwarty przez błąd, który dziś rozpoznajemy jako awarię
  // serwera (np. sprzed poprawki `zako[nń]czone`), należy do incydentu
  // serwera — zamykamy go po cichu, żeby nie dał osobnego „✅".
  for (const [inbox, inc] of Object.entries(stan.skrzynkiAlarmy)) {
    if (inc && inc.rodzaj !== 'logowanie' && awariaSerwera(inc.blad)) { delete stan.skrzynkiAlarmy[inbox]; stan.zmiana = true; }
  }
  return stan;
}
const doZapisu = (s) => JSON.stringify({ serwery: s.serwery, skrzynkiAlarmy: s.skrzynkiAlarmy, ostatnie: s.ostatnie });

// ---------- teksty ----------
const godz = (ms) => new Date(ms).toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' });
function czas(ms) {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h >= 48) return `${Math.round(h / 24)} dni`;
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
function lista(skrzynki, max = 5) {
  const l = skrzynki.map(i => `${i}@`);
  return l.length <= max ? l.join(', ') : `${l.slice(0, max).join(', ')} i jeszcze ${l.length - max}`;
}

function tekstAwariiSerwera(host, inc, teraz, przypomnienie) {
  return `⚠️ ${przypomnienie ? 'Nadal: p' : 'P'}oczta nie dochodzi do CRM od ${czas(teraz - inc.od)} — serwer poczty ${host} nie odpowiada.\n`
    + `Skrzynki: ${lista(inc.skrzynki)}.\n`
    + (inc.blad ? `Błąd: ${inc.blad}\n` : '')
    + 'To awaria serwera, nie haseł — w CRM nic nie trzeba zmieniać. Maile nie giną: CRM pobierze je sam, gdy serwer wróci. '
    + 'Następna wiadomość dopiero wtedy, gdy serwer będzie działał stabilnie.';
}
function tekstPowrotuSerwera(host, inc) {
  return `✅ Poczta znów dochodzi — serwer ${host} działa stabilnie od ${czas(STABILNIE_MS)}.\n`
    + `Kłopoty trwały ${godz(inc.od)}–${godz(inc.stabilnieOd)} (${czas(inc.stabilnieOd - inc.od)}). Zaległe maile CRM pobiera sam.`;
}
function tekstAwariiSkrzynek(rodzaj, host, pozycje, teraz) {
  const inboxy = pozycje.map(p => p.inbox);
  const jedna = inboxy.length === 1;
  const nadal = pozycje.every(p => p.przypomnienie) ? 'Nadal: ' : '';
  const blad = pozycje.map(p => p.inc.blad).find(Boolean);
  if (rodzaj === 'logowanie') {
    return `⚠️ ${nadal}${jedna ? 'Skrzynka' : 'Skrzynki'} ${lista(inboxy, 10)} ${jedna ? 'nie loguje' : 'nie logują'} się do serwera poczty (${host}).\n`
      + (blad ? `Błąd: ${blad}\n` : '')
      + `Sprawdź hasło w IMAP_ACCOUNTS (Railway → Variables). Do tego czasu poczta z ${jedna ? 'tej skrzynki' : 'tych skrzynek'} nie trafia do CRM.`;
  }
  const od = Math.min(...pozycje.map(p => p.inc.od));
  return `⚠️ ${nadal}${jedna ? 'Skrzynka' : 'Skrzynki'} ${lista(inboxy, 10)} ${jedna ? 'nie pobiera' : 'nie pobierają'} poczty od ${czas(teraz - od)}.\n`
    + (blad ? `Błąd: ${blad}\n` : '')
    + 'Maile leżą na serwerze i zostaną pobrane po naprawie. Szczegóły: GET /poczta/poller';
}
function tekstPowrotuSkrzynek(inboxy) {
  const jedna = inboxy.length === 1;
  return `✅ ${jedna ? 'Skrzynka' : 'Skrzynki'} ${lista(inboxy, 10)} ${jedna ? 'znów pobiera' : 'znów pobierają'} pocztę (od ${czas(STABILNIE_MS)} bez błędu).`;
}

/** Ocena jednego PEŁNEGO cyklu pollera. `obserwacje` = [{inbox, host, ok,
 *  blad?, pominieta?}] dla wszystkich skrzynek z konfiguracji (pominięta =
 *  bezpiecznik odpuścił ją, bo serwer nie odpowiadał). Zmienia `stan`
 *  i zwraca listę wiadomości do wysłania (zwykle pustą). */
function ocenCykl(stan, obserwacje, teraz) {
  const wiadomosci = [];

  // 1. Bieżąca seria błędów każdej skrzynki.
  for (const o of obserwacje) {
    const s = stan.skrzynki[o.inbox] || (stan.skrzynki[o.inbox] = { seria: 0 });
    s.host = o.host;
    if (o.ok) { s.seria = 0; s.bladOd = null; s.rodzaj = null; continue; }
    const rodzaj = o.pominieta ? 'serwer' : rodzajBledu(o.blad);
    s.seria = s.rodzaj === rodzaj ? s.seria + 1 : 1;
    s.rodzaj = rodzaj;
    if (!s.bladOd) s.bladOd = teraz;
    s.bladO = teraz;
    if (o.blad) s.blad = String(o.blad).slice(0, 200);
  }

  // 2. Awarie serwera: jeden incydent na host.
  for (const host of new Set(obserwacje.map(o => o.host))) {
    const padniete = obserwacje
      .filter(o => o.host === host && !o.ok && stan.skrzynki[o.inbox].rodzaj === 'serwer')
      .map(o => o.inbox);
    const blad = padniete.map(i => stan.skrzynki[i].blad).find(Boolean);
    const inc = stan.serwery[host];
    if (inc) {
      if (padniete.length) {
        for (const i of padniete) if (!inc.skrzynki.includes(i)) inc.skrzynki.push(i);
        if (blad) inc.blad = blad;
        if (inc.stabilnieOd) { inc.stabilnieOd = null; stan.zmiana = true; }
        if (teraz - inc.alarmO >= PRZYPOMNIENIE_MS) {
          inc.alarmO = teraz;
          stan.ostatnie[`serwer:${host}`] = teraz;
          stan.zmiana = true;
          wiadomosci.push(tekstAwariiSerwera(host, inc, teraz, true));
        }
      } else {
        if (!inc.stabilnieOd) { inc.stabilnieOd = teraz; stan.zmiana = true; }
        if (teraz - inc.stabilnieOd >= STABILNIE_MS) {
          wiadomosci.push(tekstPowrotuSerwera(host, inc));
          delete stan.serwery[host];
          stan.zmiana = true;
        }
      }
      continue;
    }
    const dlugo = padniete.filter(i => teraz - stan.skrzynki[i].bladOd >= PROG_MS);
    if (!dlugo.length) continue;
    if (teraz - (stan.ostatnie[`serwer:${host}`] || 0) < ODSTEP_MS) continue;
    const nowy = { od: Math.min(...dlugo.map(i => stan.skrzynki[i].bladOd)), alarmO: teraz, stabilnieOd: null, skrzynki: [...padniete], blad: blad || null };
    stan.serwery[host] = nowy;
    stan.ostatnie[`serwer:${host}`] = teraz;
    stan.zmiana = true;
    wiadomosci.push(tekstAwariiSerwera(host, nowy, teraz, false));
  }

  // 3. Pojedyncze skrzynki: złe hasło (po 2 cyklach) i błędy nierozpoznane (po 30 min).
  const alarmy = new Map(); // `${rodzaj}|${host}` → [{inbox, inc, przypomnienie}]
  const powroty = [];
  const dodajAlarm = (rodzaj, host, poz) => {
    const k = `${rodzaj}|${host}`;
    if (!alarmy.has(k)) alarmy.set(k, []);
    alarmy.get(k).push(poz);
  };
  for (const o of obserwacje) {
    const s = stan.skrzynki[o.inbox];
    const inc = stan.skrzynkiAlarmy[o.inbox];
    if (inc) {
      if (o.ok) {
        if (!inc.stabilnieOd) { inc.stabilnieOd = teraz; stan.zmiana = true; }
        if (teraz - inc.stabilnieOd >= STABILNIE_MS) {
          powroty.push(o.inbox);
          delete stan.skrzynkiAlarmy[o.inbox];
          stan.zmiana = true;
        }
        continue;
      }
      if (inc.stabilnieOd) { inc.stabilnieOd = null; stan.zmiana = true; }
      if (s.rodzaj === inc.rodzaj) {
        if (s.blad) inc.blad = s.blad;
        if (teraz - inc.alarmO >= PRZYPOMNIENIE_MS) {
          inc.alarmO = teraz;
          stan.zmiana = true;
          dodajAlarm(inc.rodzaj, o.host, { inbox: o.inbox, inc, przypomnienie: true });
        }
      }
      continue;
    }
    if (o.ok || s.rodzaj === 'serwer') continue;
    // Gdy serwer tej skrzynki właśnie leży (otwarty incydent albo awaria
    // serwera w tym cyklu), nieznany błąd to najpewniej ta sama awaria
    // w innym przebraniu — mówi o niej jedna wiadomość o serwerze.
    if (s.rodzaj === 'inny' && (stan.serwery[o.host] || obserwacje.some(x => x.host === o.host && !x.ok && stan.skrzynki[x.inbox].rodzaj === 'serwer'))) continue;
    const pora = s.rodzaj === 'logowanie' ? s.seria >= PROG_LOGOWANIA : teraz - s.bladOd >= PROG_MS;
    if (!pora) continue;
    if (teraz - (stan.ostatnie[`skrzynka:${o.inbox}`] || 0) < ODSTEP_MS) continue;
    const nowy = { rodzaj: s.rodzaj, host: o.host, od: s.bladOd, alarmO: teraz, stabilnieOd: null, blad: s.blad || null };
    stan.skrzynkiAlarmy[o.inbox] = nowy;
    stan.ostatnie[`skrzynka:${o.inbox}`] = teraz;
    stan.zmiana = true;
    dodajAlarm(nowy.rodzaj, o.host, { inbox: o.inbox, inc: nowy });
  }
  for (const [k, pozycje] of alarmy) {
    const [rodzaj, host] = k.split('|');
    wiadomosci.push(tekstAwariiSkrzynek(rodzaj, host, pozycje, teraz));
  }
  if (powroty.length) wiadomosci.push(tekstPowrotuSkrzynek(powroty));

  // 4. Sprzątanie: incydenty skrzynek i hostów, których nie ma już w konfiguracji.
  const inboxy = new Set(obserwacje.map(o => o.inbox));
  const hosty = new Set(obserwacje.map(o => o.host));
  for (const h of Object.keys(stan.serwery)) if (!hosty.has(h)) { delete stan.serwery[h]; stan.zmiana = true; }
  for (const i of Object.keys(stan.skrzynkiAlarmy)) if (!inboxy.has(i)) { delete stan.skrzynkiAlarmy[i]; stan.zmiana = true; }
  for (const [k, t] of Object.entries(stan.ostatnie)) if (teraz - t > ODSTEP_MS) delete stan.ostatnie[k];

  return wiadomosci;
}

// ---------- stan procesu (z zapisem otwartych incydentów w Config) ----------
let _stan = null;

async function stanZBazy(prisma) {
  if (_stan) return _stan;
  let zapisany = null;
  try {
    const r = await prisma.config.findUnique({ where: { key: KLUCZ } });
    if (r && r.value) zapisany = JSON.parse(r.value);
  } catch (e) {
    console.error('[alarmy-poczty] odczyt stanu:', e.message);
  }
  _stan = nowyStan(zapisany);
  return _stan;
}

/** Po każdym pełnym cyklu pollera: ocena + zapis zmian + wysyłka wiadomości. */
async function poCyklu(prisma, obserwacje, wyslij, teraz = Date.now()) {
  if (!Array.isArray(obserwacje) || !obserwacje.length) return [];
  const stan = await stanZBazy(prisma);
  const wiadomosci = ocenCykl(stan, obserwacje, teraz);
  if (stan.zmiana) {
    stan.zmiana = false;
    const value = doZapisu(stan);
    await prisma.config.upsert({ where: { key: KLUCZ }, update: { value }, create: { key: KLUCZ, value } })
      .catch(e => console.error('[alarmy-poczty] zapis stanu:', e.message));
  }
  for (const w of wiadomosci) await wyslij(w);
  return wiadomosci;
}

/** Kiedy skrzynka ostatnio NIE połączyła się (ms, 0 = nie było błędu w tym
 *  procesie). Kanarek nie alarmuje, dopóki skrzynka niedawno miała awarię —
 *  testowy mail czeka wtedy na serwerze i dojdzie po powrocie połączenia. */
function ostatniBladSkrzynki(inbox) {
  const s = _stan && _stan.skrzynki[inbox];
  return (s && s.bladO) || 0;
}

/** Do GET /poczta/poller: otwarte incydenty. */
function podglad() {
  if (!_stan) return { serwery: {}, skrzynki: {} };
  return { serwery: _stan.serwery, skrzynki: _stan.skrzynkiAlarmy };
}

module.exports = {
  awariaSerwera, rodzajBledu, poCyklu, ostatniBladSkrzynki, podglad,
  PROG_MS, STABILNIE_MS, ODSTEP_MS,
  _test: { nowyStan, ocenCykl, czas, reset: () => { _stan = null; } },
};
