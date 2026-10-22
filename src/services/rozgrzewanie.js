'use strict';

/* MAILE ROZGRZEWAJĄCE (Instantly warmup, 22.10.2026).
 *
 * Część skrzynek Surf Stick rozgrzewa Instantly: wysyła z nich i do nich
 * maile, wymienia je z innymi skrzynkami swojej sieci i sam na nie odpowiada.
 * Każdy taki mail niesie w temacie (zwykle też na końcu treści) znacznik
 * rozgrzewania, np. „4ASVTZE". Dla CRM to nie jest poczta: żadnego zapisu,
 * powiadomienia, zadania, kolejki Bell Outreach ani udziału w statystykach.
 *
 * Znaczniki: env WARMUP_TAGS (lista po przecinku, wielkość liter bez
 * znaczenia), domyślnie 4ASVTZE — zmiana bez zmiany kodu.
 *
 * Na serwerze poczty NIC nie zmieniamy. Poller czyta skrzynki w trybie tylko
 * do odczytu (EXAMINE), więc pobranie treści nie ustawia \Seen; mail
 * rozgrzewający jest pomijany, zanim cokolwiek innego się z nim stanie, a jego
 * UID idzie do przodu razem z resztą. Instantly obsługuje te maile sam.
 *
 * W logu i w diagnostyce wyłącznie LICZBY na cykl — bez adresów i tematów. */

const DOMYSLNE_ZNACZNIKI = '4ASVTZE';
const TAG_ROZGRZEWANIE = 'rozgrzewanie';

let _pamiec = { surowe: Symbol('brak'), lista: [], male: [] };

/* Lista znaczników z WARMUP_TAGS. Pusta albo sama z przecinków → domyślny
 * znacznik (bezpieczniej niż po cichu wyłączyć filtr). Czytana przy każdym
 * wywołaniu, żeby zmiana zmiennej działała bez zmiany kodu. */
function znacznikiRozgrzewania() {
  const surowe = process.env.WARMUP_TAGS;
  if (surowe === _pamiec.surowe) return _pamiec.lista;
  let lista = String(surowe == null ? '' : surowe).split(',').map(s => s.trim()).filter(Boolean);
  if (!lista.length) lista = [DOMYSLNE_ZNACZNIKI];
  _pamiec = { surowe, lista, male: lista.map(z => z.toLowerCase()) };
  return lista;
}

/* Zwraca dopasowany znacznik albo null. Sprawdza temat i treść: tekst,
 * SUROWY HTML (znacznik bywa w ukrytym elemencie) oraz pola pomocnicze,
 * pod którymi różne ścieżki CRM trzymają treść (bodyText, body, bodyHtml,
 * temat w kolejce Bell Outreach). */
function jestRozgrzewaniem(mail) {
  if (!mail) return null;
  znacznikiRozgrzewania();
  const { lista, male } = _pamiec;
  const pola = [mail.subject, mail.temat, mail.text, mail.html, mail.bodyText, mail.body, mail.bodyHtml];
  for (const pole of pola) {
    if (typeof pole !== 'string' || !pole) continue;
    const s = pole.toLowerCase();
    for (let i = 0; i < male.length; i++) if (s.includes(male[i])) return lista[i];
  }
  return null;
}

/* Kryteria IMAP SEARCH wykluczające maile rozgrzewające po TEMACIE (node-imap:
 * prefiks „!" = NOT). Do statystyk z serwera (pokrycie skrzynek). Znacznik
 * wyłącznie w treści pomijamy tu świadomie: SEARCH BODY jest drogi, a
 * Instantly zawsze daje znacznik w temacie. */
function kryteriaBezRozgrzewania() {
  return znacznikiRozgrzewania().map(z => ['!SUBJECT', z]);
}

// ── Liczniki na cykl (tylko liczby) ─────────────────────────────────────────
const stan = {
  start: new Date().toISOString(),
  biezacy: null,   // { cykl, inbox, wyslane, rescan } — trwający cykl pollera
  ostatni: null,   // podsumowanie ostatniego zakończonego cyklu
  pierwszy: null,  // pierwszy cykl od startu procesu (raport po wdrożeniu)
  nowychOdStartu: 0, // INBOX + Wysłane (rescan liczy te same maile ponownie)
};

function zacznijCykl(nr) {
  stan.biezacy = { cykl: nr != null ? nr : null, inbox: 0, wyslane: 0, rescan: 0 };
}

function cyklTrwa() { return !!stan.biezacy; }

/* gdzie: 'inbox' (nowe w INBOX) | 'wyslane' (nowe w Wysłanych) | 'rescan'.
 * Poza cyklem (ręczny rescan) nie liczymy globalnie — wywołujący oddaje
 * liczbę w swoim wyniku i logu. */
function policzPominiety(gdzie) {
  if (gdzie !== 'rescan') stan.nowychOdStartu++;
  if (!stan.biezacy) return;
  stan.biezacy[gdzie] = (stan.biezacy[gdzie] || 0) + 1;
}

function zakonczCykl() {
  const b = stan.biezacy;
  if (!b) return null;
  const podsumowanie = {
    cykl: b.cykl,
    kiedy: new Date().toISOString(),
    pominieto: b.inbox + b.wyslane + b.rescan,
    inbox: b.inbox,
    wyslane: b.wyslane,
    rescan: b.rescan,
  };
  stan.ostatni = podsumowanie;
  if (!stan.pierwszy) stan.pierwszy = podsumowanie;
  stan.biezacy = null;
  console.log(`[rozgrzewanie] cykl ${b.cykl != null ? b.cykl : '?'}: pominięto ${podsumowanie.pominieto} (INBOX ${b.inbox}, Wysłane ${b.wyslane}, rescan ${b.rescan})`);
  return podsumowanie;
}

function stanRozgrzewania() {
  return {
    znacznikow: znacznikiRozgrzewania().length,
    procesOd: stan.start,
    pierwszyCykl: stan.pierwszy,
    ostatniCykl: stan.ostatni,
    nowychOdStartu: stan.nowychOdStartu,
  };
}

/* Ślad przetworzenia dla /poczta/zdrowie: gdy najnowsza wiadomość na serwerze
 * jest rozgrzewająca, werdykt „gubimy" byłby fałszywy (nie ma jej ani w Email,
 * ani w EmailSkip — i słusznie). Sam znacznik czasu, bez adresów i liczników.
 * Tylko update: wiersz ImapState istnieje, bo poller właśnie zapisał lastUid. */
async function zapiszSlad(prisma, inbox) {
  try { await prisma.imapState.update({ where: { inbox }, data: { rozgrzewanieO: new Date() } }); }
  catch (e) { console.error('[rozgrzewanie] zapis śladu nieudany:', e.message); }
}

/* PUNKT 4: maile rozgrzewające, które już trafiły do CRM (np. zanim to
 * wdrożono, albo po zmianie WARMUP_TAGS) — oznaczamy tagiem `rozgrzewanie`
 * i jako przeczytane (listy i liczniki CRM ten tag pomijają), zamykamy
 * zadania utworzone z tych maili, chowamy ich wpisy w dzienniku aktywności
 * i wycofujemy je z kolejki Bell Outreach. Serwera poczty nie dotykamy.
 * dry: tylko policz. */
async function oznaczIstniejace(prisma, { dry = false } = {}) {
  const znaczniki = znacznikiRozgrzewania();
  const OR = [];
  for (const z of znaczniki) {
    for (const pole of ['subject', 'bodyPreview', 'bodyFull', 'bodyHtml']) {
      OR.push({ [pole]: { contains: z, mode: 'insensitive' } });
    }
  }
  const maile = await prisma.email.findMany({
    where: { OR, NOT: { tags: { has: TAG_ROZGRZEWANIE } } },
    select: { id: true, messageId: true, direction: true },
  });
  const ids = maile.map(m => m.id);
  const messageIds = maile.map(m => m.messageId).filter(Boolean);
  const bellOR = [
    ...(messageIds.length ? [{ messageId: { in: messageIds } }] : []),
    ...znaczniki.map(z => ({ temat: { contains: z, mode: 'insensitive' } })),
  ];
  const bellWhere = { OR: bellOR, status: { in: ['nowy', 'blad'] } };
  const wynik = {
    dry: !!dry,
    maili: ids.length,
    przychodzacych: maile.filter(m => m.direction === 'INBOUND').length,
    wychodzacych: maile.filter(m => m.direction === 'OUTBOUND').length,
    zadan: 0, aktywnosci: 0, bell: 0,
  };
  if (dry) {
    if (ids.length) {
      wynik.zadan = await prisma.task.count({ where: { emailId: { in: ids }, status: 'OPEN' } });
      wynik.aktywnosci = await prisma.activityEvent.count({ where: { emailId: { in: ids }, NOT: { tags: { has: TAG_ROZGRZEWANIE } } } });
    }
    wynik.bell = await prisma.bellOutreachMsg.count({ where: bellWhere });
    return wynik;
  }
  if (ids.length) {
    await prisma.email.updateMany({ where: { id: { in: ids } }, data: { isRead: true, tags: { push: TAG_ROZGRZEWANIE } } });
    wynik.zadan = (await prisma.task.updateMany({ where: { emailId: { in: ids }, status: 'OPEN' }, data: { status: 'DONE', completedAt: new Date() } })).count;
    wynik.aktywnosci = (await prisma.activityEvent.updateMany({ where: { emailId: { in: ids }, NOT: { tags: { has: TAG_ROZGRZEWANIE } } }, data: { tags: { push: TAG_ROZGRZEWANIE } } })).count;
  }
  wynik.bell = (await prisma.bellOutreachMsg.updateMany({ where: bellWhere, data: { status: 'pominiety', powod: 'rozgrzewanie' } })).count;
  if (wynik.maili || wynik.bell) {
    console.log(`[rozgrzewanie] oznaczono istniejące: maili ${wynik.maili} (przych. ${wynik.przychodzacych}, wych. ${wynik.wychodzacych}), zadań ${wynik.zadan}, aktywności ${wynik.aktywnosci}, Bell ${wynik.bell}`);
  }
  return wynik;
}

module.exports = {
  TAG_ROZGRZEWANIE, DOMYSLNE_ZNACZNIKI,
  znacznikiRozgrzewania, jestRozgrzewaniem, kryteriaBezRozgrzewania,
  zacznijCykl, cyklTrwa, policzPominiety, zakonczCykl, stanRozgrzewania,
  zapiszSlad, oznaczIstniejace,
};
