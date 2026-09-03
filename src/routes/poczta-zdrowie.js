'use strict';
/**
 * poczta-zdrowie.js — JEDNO zapytanie, ktore odpowiada na pytanie
 * „czy poczta dziala?" dla WSZYSTKICH skrzynek naraz.
 *
 * Powod powstania: 3.09.2026 michal@ przestal pobierac maile i nikt sie o tym
 * nie dowiedzial — w CRM nie bylo ani maili, ani powiadomien, ani bledu.
 * Nie bylo tez CZYM tego sprawdzic: `/emails/imap-diag` pokazuje foldery na
 * serwerze IMAP, ale nie zestawia ich z tym, co faktycznie mamy w bazie,
 * wiec nie widac najwazniejszej rzeczy — CZY ZOSTAJEMY W TYLE.
 *
 * Kluczowa liczba to `zaleglosc`: ile wiadomosci lezy na serwerze POWYZEJ
 * naszego lastUid. Zero = jestesmy na biezaco. Cokolwiek innego niz zero,
 * utrzymujace sie miedzy cyklami, znaczy, ze poczta stoi — niezaleznie od
 * tego, czy polaczenie zglasza blad.
 *
 * Zwraca WYLACZNIE metadane: liczniki, znaczniki czasu, nazwy folderow,
 * powody odfiltrowania. Zadnej tresci maili, zadnych hasel.
 *
 * Auth: naglowek x-token = PREPROCESS_TOKEN (ten sam tryb co /czytnik/*
 * i /karta-pracy/* — endpoint operacyjny, poza /api).
 */

const prisma = require('../db');
const { getAccounts } = require('../mail-sender');

const MINUTA = 60 * 1000;

/** polaczenie IMAP z twardym limitem czasu — diagnostyka nie moze wisiec */
function polacz(Imap, account, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: account.user, password: account.pass,
      host: account.host, port: account.port,
      tls: true, tlsOptions: { rejectUnauthorized: false },
      connTimeout: timeoutMs, authTimeout: timeoutMs,
    });
    const strazak = setTimeout(() => {
      try { imap.destroy(); } catch (_) {}
      reject(new Error(`timeout ${timeoutMs} ms`));
    }, timeoutMs + 2000);
    imap.once('ready', () => { clearTimeout(strazak); resolve(imap); });
    imap.once('error', e => { clearTimeout(strazak); reject(e); });
    imap.connect();
  });
}

/* Data NAJNOWSZEJ wiadomości leżącej na serwerze. To jest dana, która
 * odróżnia dwie zupełnie różne sytuacje wyglądające tak samo z zewnątrz:
 *   - „nic nie przyszło"  → skrzynka po prostu milczy, nie ma awarii,
 *   - „przyszło, a u nas tego nie ma" → poczta ginie i trzeba działać.
 * Bez tego alert o ciszy nie umie odróżnić spokojnego dnia od awarii.
 * Czytamy po NUMERZE PORZĄDKOWYM (nie po UID), bo najwyższy UID mógł zostać
 * skasowany, a wtedy fetch po nim nie zwróciłby nic. Pobieramy wyłącznie
 * atrybuty (INTERNALDATE) — bez treści, bez nagłówków. */
function dataNajnowszej(imap, box) {
  return new Promise(resolve => {
    const ile = box && box.wiadomosci;
    if (!ile) return resolve(null);
    let data = null;
    let f;
    try { f = imap.seq.fetch(`${ile}:${ile}`, { bodies: '' , struct: false }); }
    catch (e) { return resolve(null); }
    const strazak = setTimeout(() => resolve(data), 10000);
    f.on('message', msg => {
      msg.once('attributes', attrs => { if (attrs && attrs.date) data = attrs.date; });
    });
    f.once('error', () => { clearTimeout(strazak); resolve(null); });
    f.once('end', () => { clearTimeout(strazak); resolve(data); });
  });
}

function statusSkrzynki(imap, nazwa = 'INBOX') {
  return new Promise(resolve => {
    imap.openBox(nazwa, true, (err, box) => {
      if (err) return resolve({ blad: err.message });
      resolve({
        wiadomosci: box.messages.total,
        nieprzeczytane: box.messages.unseen,
        uidValidity: box.uidvalidity,
        uidNext: box.uidnext,
      });
    });
  });
}

const minutTemu = d => (d ? Math.round((Date.now() - new Date(d).getTime()) / MINUTA) : null);

/**
 * @param {object} opcje.progCiszyMin  po ilu minutach bez maila uznajemy skrzynke
 *   za podejrzanie cicha (domyslnie 24 h — ponizej tego cisza bywa normalna)
 */
async function zbadajSkrzynke(Imap, account, opcje = {}) {
  const progCiszyMin = Number(opcje.progCiszyMin) || 24 * 60;
  const inbox = account.inbox;
  const wynik = {
    inbox,
    uzytkownik: account.user,
    host: account.host,
    stan: null,           // ok | cisza | zaleglosc | awaria | nieznany
    powody: [],
  };

  // 1) co wiemy z bazy
  try {
    const st = await prisma.imapState.findUnique({ where: { inbox } });
    wynik.lastUid = st ? st.lastUid : null;
    wynik.uidValidity = st ? st.uidValidity : null;
    wynik.ostatniUdanyCykl = st && st.lastOkAt ? st.lastOkAt.toISOString() : null;
    wynik.ostatniUdanyCyklMinTemu = st ? minutTemu(st.lastOkAt) : null;
  } catch (e) {
    wynik.powody.push(`odczyt ImapState nieudany: ${e.message}`);
  }

  // 2) co mamy w bazie maili
  try {
    const doba = new Date(Date.now() - 24 * 60 * MINUTA);
    const tydzien = new Date(Date.now() - 7 * 24 * 60 * MINUTA);
    const [ostatni, wDobie, wTygodniu] = await Promise.all([
      prisma.email.findFirst({
        where: { inbox, direction: 'INBOUND' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      prisma.email.count({ where: { inbox, direction: 'INBOUND', createdAt: { gte: doba } } }),
      prisma.email.count({ where: { inbox, direction: 'INBOUND', createdAt: { gte: tydzien } } }),
    ]);
    wynik.ostatniMail = ostatni ? ostatni.createdAt.toISOString() : null;
    wynik.ostatniMailMinTemu = ostatni ? minutTemu(ostatni.createdAt) : null;
    wynik.maliDoba = wDobie;
    wynik.maliTydzien = wTygodniu;
  } catch (e) {
    wynik.powody.push(`zliczenie maili nieudane: ${e.message}`);
  }

  // 3) co odfiltrowalismy — bo „brak maili" i „maile wyrzucone przez filtr"
  //    wygladaja z zewnatrz identycznie, a to zupelnie inne awarie
  try {
    const doba = new Date(Date.now() - 24 * 60 * MINUTA);
    const odfiltrowane = await prisma.emailSkip.findMany({
      where: { inbox, createdAt: { gte: doba } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { reason: true, fromEmail: true, createdAt: true },
    });
    wynik.odfiltrowaneDoba = odfiltrowane.length;
    wynik.odfiltrowanePowody = odfiltrowane.map(o => ({
      powod: o.reason,
      // sam nadawca to dana osobowa — do diagnostyki wystarczy domena
      domena: (o.fromEmail || '').split('@')[1] || null,
      kiedy: o.createdAt.toISOString(),
    }));
  } catch (e) {
    wynik.powody.push(`odczyt EmailSkip nieudany: ${e.message}`);
  }

  // 3b) KANAREK — aktywny test drożności. To jedyny dowód, że poczta na tej
  //     skrzynce naprawdę dochodzi; cisza nie dowodzi niczego.
  try {
    const k = await prisma.kanarekPoczty.findFirst({
      where: { inbox }, orderBy: { wyslanoO: 'desc' },
    });
    if (k) {
      wynik.kanarek = {
        nadawca: k.nadawca,
        wyslano: k.wyslanoO.toISOString(),
        wyslanoMinTemu: minutTemu(k.wyslanoO),
        potwierdzony: !!k.potwierdzonoO,
        dolecialWSekundach: k.potwierdzonoO
          ? Math.round((new Date(k.potwierdzonoO) - new Date(k.wyslanoO)) / 1000) : null,
        bladWysylki: k.bladWysylki || null,
        zaalarmowano: k.zaalarmowanoO ? k.zaalarmowanoO.toISOString() : null,
      };
    } else {
      wynik.kanarek = { brak: 'jeszcze nie wysłano ani jednego testu' };
    }
  } catch (e) {
    wynik.kanarek = { blad: e.message };
  }

  // 4) co widac na serwerze IMAP NA ZYWO
  let imap = null;
  try {
    imap = await polacz(Imap, account);
    const box = await statusSkrzynki(imap, 'INBOX');
    wynik.serwer = box;
    if (box && !box.blad) {
      const najnowsza = await dataNajnowszej(imap, box);
      wynik.ostatniaNaSerwerze = najnowsza ? new Date(najnowsza).toISOString() : null;
      wynik.ostatniaNaSerwerzeMinTemu = najnowsza ? minutTemu(najnowsza) : null;
    }
    if (box && !box.blad && box.uidNext != null && wynik.lastUid != null) {
      /* uidNext to numer, ktory dostanie NASTEPNA wiadomosc, wiec najwyzszy
         istniejacy UID to uidNext-1. Roznica ponad nasz lastUid to dokladnie
         to, czego nie pobralismy. */
      wynik.zaleglosc = Math.max(0, (box.uidNext - 1) - wynik.lastUid);
    }
    if (box && !box.blad && wynik.uidValidity != null && box.uidValidity !== wynik.uidValidity) {
      wynik.powody.push(`UIDVALIDITY zmienione: mamy ${wynik.uidValidity}, serwer ${box.uidValidity} — skrzynka zresetowana u dostawcy`);
    }
  } catch (e) {
    wynik.serwer = { blad: e.message };
    wynik.powody.push(`polaczenie IMAP nieudane: ${e.message}`);
  } finally {
    try { if (imap) imap.end(); } catch (_) {}
  }

  // 5) werdykt
  if (wynik.serwer && wynik.serwer.blad) {
    wynik.stan = 'awaria';
  } else if (wynik.kanarek && wynik.kanarek.bladWysylki) {
    wynik.stan = 'awaria';
    wynik.powody.push(`nie udało się wysłać testowego maila: ${wynik.kanarek.bladWysylki}`);
  } else if (wynik.kanarek && wynik.kanarek.potwierdzony === false
      && wynik.kanarek.wyslanoMinTemu != null && wynik.kanarek.wyslanoMinTemu > 30) {
    wynik.stan = 'awaria';
    wynik.powody.push(`testowy mail wysłany ${wynik.kanarek.wyslanoMinTemu} min temu NIE DOTARŁ`);
  } else if (wynik.zaleglosc > 0) {
    wynik.stan = 'zaleglosc';
    wynik.powody.push(`na serwerze jest ${wynik.zaleglosc} wiadomosci powyzej naszego lastUid=${wynik.lastUid}`);
  } else if (wynik.ostatniaNaSerwerzeMinTemu != null && wynik.ostatniMailMinTemu != null
      && wynik.ostatniMailMinTemu - wynik.ostatniaNaSerwerzeMinTemu > 60) {
    /* Na serwerze leży wiadomość NOWSZA niż cokolwiek, co mamy w bazie
       (z godzinnym marginesem na opóźnienie cyklu). Zaległość po UID może
       przy tym wynosić zero — np. gdy poczta trafia do innego folderu albo
       gdy mail został pobrany i porzucony po drodze. */
    wynik.stan = 'gubimy';
    wynik.powody.push(
      `najnowsza wiadomość na serwerze jest sprzed ${Math.round(wynik.ostatniaNaSerwerzeMinTemu / 60)} h, `
      + `a najnowsza u nas sprzed ${Math.round(wynik.ostatniMailMinTemu / 60)} h`);
  } else if (wynik.ostatniUdanyCyklMinTemu != null && wynik.ostatniUdanyCyklMinTemu > 20) {
    wynik.stan = 'awaria';
    wynik.powody.push(`ostatni udany cykl ${wynik.ostatniUdanyCyklMinTemu} min temu (poller chodzi co 5 min)`);
  } else if (wynik.ostatniMailMinTemu == null || wynik.ostatniMailMinTemu > progCiszyMin) {
    wynik.stan = 'cisza';
    wynik.powody.push(wynik.ostatniMail
      ? `ostatni mail ${Math.round(wynik.ostatniMailMinTemu / 60)} h temu`
      : 'w bazie nie ma ani jednego maila przychodzacego z tej skrzynki');
    if (wynik.ostatniaNaSerwerzeMinTemu != null) {
      wynik.powody.push(`na serwerze też nic nowszego (najnowsza sprzed ${Math.round(wynik.ostatniaNaSerwerzeMinTemu / 60)} h) — nikt po prostu nie napisał`);
    }
  } else {
    wynik.stan = 'ok';
  }
  return wynik;
}

function router(express, token) {
  const r = express.Router();

  r.use('/poczta', (req, res, next) => {
    if (!token) return next();
    const podany = String(req.headers['x-token'] || '').trim();
    if (podany !== token) return res.status(401).json({ error: 'Unauthorized' });
    next();
  });

  /**
   * GET /poczta/zdrowie[?inbox=michal][&progCiszyMin=1440]
   * Stan WSZYSTKICH skrzynek: baza + serwer IMAP + zaleglosc + werdykt.
   */
  r.get('/poczta/zdrowie', async (req, res) => {
    let Imap;
    try { Imap = require('imap'); }
    catch (e) { return res.status(500).json({ error: 'brak modulu imap: ' + e.message }); }

    const konta = getAccounts();
    if (!konta.length) {
      return res.json({
        ok: false,
        stan: 'awaria',
        blad: 'IMAP_ACCOUNTS jest puste albo ma zly JSON — poller nie odpytuje ZADNEJ skrzynki',
        skrzynki: [],
      });
    }
    const filtr = req.query.inbox ? String(req.query.inbox) : null;
    const wybrane = filtr ? konta.filter(a => a.inbox === filtr) : konta;
    if (!wybrane.length) {
      return res.status(400).json({
        error: `nie ma skrzynki inbox=${filtr}`,
        dostepne: konta.map(a => a.inbox),
      });
    }

    const skrzynki = [];
    for (const konto of wybrane) {
      skrzynki.push(await zbadajSkrzynke(Imap, konto, { progCiszyMin: req.query.progCiszyMin }));
    }
    /* ZDROWIE KANALU POWIADOMIEN. Uzytkownik zglosil brak powiadomien jako
     * OSOBNY objaw obok braku maili — i slusznie, bo to niezalezna awaria:
     * mail moze byc w CRM, a Telegram moze go nie dostarczyc. Zablokowany bot
     * odpowiada HTTP 403, co dotad bylo brane za sukces. Stan czytamy tutaj,
     * bo ten endpoint jako jedyny nie zalezy od Telegrama. */
    let powiadomienia = null;
    try {
      const { stanKanalu } = require('../telegram-utils');
      powiadomienia = {
        wyslane: stanKanalu.wyslane,
        bledy: stanKanalu.bledy,
        ostatniSukces: stanKanalu.ostatniSukcesO,
        ostatniBlad: stanKanalu.ostatniBlad,
        ostatniBladO: stanKanalu.ostatniBladO,
        // liczniki sa od startu procesu — po redeployu zaczynaja od zera
        uwaga: 'liczniki od ostatniego startu procesu',
      };
    } catch (e) { powiadomienia = { blad: e.message }; }

    const zle = skrzynki.filter(s => s.stan !== 'ok');
    res.json({
      ok: zle.length === 0 && !(powiadomienia && powiadomienia.bledy > 0),
      sprawdzono: new Date().toISOString(),
      powiadomienia,
      podsumowanie: {
        skrzynek: skrzynki.length,
        ok: skrzynki.filter(s => s.stan === 'ok').length,
        zaleglosc: skrzynki.filter(s => s.stan === 'zaleglosc').length,
        awaria: skrzynki.filter(s => s.stan === 'awaria').length,
        gubimy: skrzynki.filter(s => s.stan === 'gubimy').length,
        cisza: skrzynki.filter(s => s.stan === 'cisza').length,
      },
      skrzynki,
    });
  });

  return r;
}

module.exports = { router, zbadajSkrzynke };
