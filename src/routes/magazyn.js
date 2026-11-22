'use strict';
/**
 * magazyn.js — ZEWNĘTRZNY MAGAZYN: zamówienia na spakowanie, stock, kartony.
 *
 * Dwie strony tego samego ekranu:
 *   - właściciel (rola owner): składa zamówienia, przyjmuje stock, zatwierdza,
 *   - magazyn (rola magazyn): widzi zamówienia, oznacza „gotowe" z kartonem.
 * Rola przychodzi w req.crm (nagłówki z frontu, patrz index.js). Endpointy
 * „tylko właściciel" odrzucają magazyn tutaj — bramka we froncie i tak nie
 * puszcza magazynu poza /api/magazyn/*, ale w obrębie tej trasy to JEDYNE
 * miejsce, które rozróżnia strony.
 *
 * Boxy (BOX-STICK-30 itd.) rozbijamy na kolory PRZY ZŁOŻENIU wg składu
 * z katalogu (migawka) — magazyn ma widzieć, co pakuje, a stan per kolor ma
 * z czego zejść. Generic („dowolny kolor") jest tu ZABRONIONY: dla magazynu
 * nie znaczy nic, a stan per kolor nie zejdzie z „dowolnego".
 *
 * Stock = suma ruchów. Wydanie zapisuje się przy „GOTOWE" (towar fizycznie
 * zszedł z półki), anulowanie po GOTOWE robi ruch odwrotny.
 */

const router = require('express').Router();
const asyncHandler = require('../asyncHandler');
const { getActiveCatalog } = require('../services/product-catalog');
const { selfCall } = require('../services/agent-runtime');
const { getOrderLabels } = require('../glob-client');
const { PRODUCT_WEIGHTS } = require('./glob-helpers');
const { pdfZamowienia, trescMaila } = require('../services/magazyn-druk');
const { sprawdzOdbiorce } = require('../services/adres-gk');
const { szacujPaczke, limitCeny, zaDrogo, opisSzacunku, zl } = require('../services/kurier-szacunek');
const { naprawKuriera, rodzajBledu, naruszeniaPoprawki } = require('../services/kurier-naprawa');
const { kiedyPowiadomic, opisTerminu } = require('../services/godziny-magazynu');
const { normalizujTelefon, KIERUNKOWE } = require('../services/telefon');
const crypto = require('crypto');

/* Alarm do właściciela, gdy auto-list nie zamówi kuriera (9.11.2026: #5
 * spakowane o 11:18, błąd widać było tylko w panelu — właściciel trafił na
 * niego przypadkiem). Telegram jak alarmy poczty; błąd wysyłki nie blokuje. */
async function alarmWlasciciela(prisma, tekst) {
  try {
    const { resolveTelegram } = require('../services/telegram-helper');
    const { sendTelegram } = require('../telegram-utils');
    const { token, chatId } = await resolveTelegram(prisma, { scope: 'pl' });
    if (token && chatId) await sendTelegram(token, chatId, tekst);
  } catch (e) { console.error('[magazyn] alarm do właściciela nieudany:', e.message); }
}

const EKSPOZYTOR = { ean: 'EKSPOZYTOR', name: 'Ekspozytor (pusty)' };
const STATUSY = ['NOWE', 'GOTOWE', 'KURIER', 'WYSLANE', 'ANULOWANE'];

const kto = (req) => (req.crm && req.crm.user) || null;
const rola = (req) => (req.crm && req.crm.role) || 'owner';
function tylkoWlasciciel(req, res) {
  if (rola(req) === 'magazyn') { res.status(403).json({ ok: false, error: 'tylko właściciel' }); return false; }
  return true;
}

const ORDER_INCLUDE = {
  items: { orderBy: { sort: 'asc' } },
  contractor: { select: { id: true, name: true } },
  // metadane dokumentów — bez `data`, żeby lista nie ciągnęła PDF-ów
  dokumenty: { select: { id: true, filename: true, contentType: true, size: true, opis: true, dodal: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
};

/* Kształt zamówienia dla frontu. Rola `magazyn` to OBCA firma (audyt
 * 14.10.2026): nie dostaje identyfikatorów CRM (kontrahent, mail, FV),
 * e-maila odbiorcy ani loginów właściciela (utworzyl/zatwierdzilKto/dodal —
 * zamiast nich „Surf Stick"). Telefon odbiorcy zostaje — jest na liście. */
function toPublic(o, rola = 'owner') {
  const obcy = rola === 'magazyn';
  const odb = o.odbiorca || {};
  return {
    id: o.id, numer: o.numer, status: o.status,
    contractorId: obcy ? null : o.contractorId, contractorName: obcy ? null : (o.contractor ? o.contractor.name : null),
    odbiorca: obcy ? { ...odb, email: '' } : odb,
    uwagiNasze: o.uwagiNasze, uwagiMagazynu: o.uwagiMagazynu,
    invoiceNumber: obcy ? null : o.invoiceNumber, emailId: obcy ? null : o.emailId,
    karton: o.kartonNazwa || o.dlugoscCm ? {
      nazwa: o.kartonNazwa, dlugoscCm: o.dlugoscCm, szerokoscCm: o.szerokoscCm, wysokoscCm: o.wysokoscCm,
      wagaKg: o.wagaKg != null ? Number(o.wagaKg) : null,
    } : null,
    autoList: !!o.autoList, kurierBlad: o.kurierBlad || null,
    // Automatyczna naprawa auto-listu (18.11.2026): magazyn widzi tylko stan,
    // właściciel także podsumowanie i zmiany, które zrobił model. Stan z
    // poprzedniego pakowania (cofnięte „gotowe") nie jest pokazywany.
    kurierNaprawa: (() => {
      const n = o.kurierNaprawa;
      if (!n || !n.stan) return null;
      const bezKuriera = o.status === 'GOTOWE' && !o.gkNumber && !o.gkHash;
      let stan = null;
      if (n.stan === 'w-toku' && bezKuriera) stan = naprawaTrwa(o) ? 'w-toku' : 'przerwana';
      else if (n.stan === 'nieudana' && bezKuriera) stan = 'nieudana';
      else if (n.stan === 'udana' && ['KURIER', 'WYSLANE'].includes(o.status) && o.zatwierdzilKto === ZATWIERDZIL_NAPRAWA) stan = 'udana';
      if (!stan) return null;
      return obcy ? { stan } : { stan, od: n.od || null, do: n.do || null, model: n.model || null, podsumowanie: n.podsumowanie || null, zmiany: Array.isArray(n.zmiany) ? n.zmiany : [], niepewne: !!n.niepewne };
    })(),
    // Cena kuriera: szacunek pokazany przy składaniu i cena zamówionego listu
    // (10.11.2026). Tylko dla właściciela — magazyn nie widzi naszych kosztów.
    kurierSzacunek: obcy ? null : (o.kurierSzacunek || null),
    kurierCena: obcy || o.kurierCena == null ? null : Number(o.kurierCena),
    // Weryfikacja adresu pod GlobKurier (9.11.2026) — widoczna, zanim magazyn spakuje.
    adresUwagi: !obcy && o.autoList && ['NOWE', 'GOTOWE'].includes(o.status) && odb.name
      ? (() => { const w = sprawdzOdbiorce(odb); return [...w.bledy, ...w.ostrzezenia]; })()
      : [],
    gkHash: o.gkHash, gkNumber: o.gkNumber, carrier: o.carrier,
    utworzyl: obcy && o.utworzyl ? 'Surf Stick' : o.utworzyl, gotoweKto: o.gotoweKto, zatwierdzilKto: obcy && o.zatwierdzilKto ? (/^auto-list/.test(o.zatwierdzilKto) ? 'auto-list' : 'Surf Stick') : o.zatwierdzilKto,
    createdAt: o.createdAt, gotoweAt: o.gotoweAt, zatwierdzonoAt: o.zatwierdzonoAt,
    gkStatus: o.gkStatus || null, gkStatusAt: o.gkStatusAt || null, wyslanoAt: o.wyslanoAt || null, dostarczonoAt: o.dostarczonoAt || null, ostatnieZdarzenie: o.ostatnieZdarzenie || null,
    powiadomionoAt: o.powiadomionoAt || null, powiadomilKto: obcy ? null : (o.powiadomilKto || null), powiadomionoDo: obcy ? null : (o.powiadomionoDo || null),
    // Mail do magazynu zaplanowany na rano (kliknięto poza godzinami pracy) — sprawa właściciela.
    powiadomNa: obcy ? null : (o.powiadomNa || null), powiadomBlad: obcy ? null : (o.powiadomBlad || null),
    items: (o.items || []).map(i => ({
      id: i.id, ean: i.ean, name: i.name, variant: i.variant, symbol: i.symbol || null, qty: i.qty, parentEan: i.parentEan, packaging: i.packaging,
    })),
    // 14.10.2026: toPublic gubił `symbol` pozycji i listę dokumentów — panel
    // pokazywał „brak kodu" przy wszystkim i nie widział wgranej WZ.
    dokumenty: (o.dokumenty || []).map(d => ({
      id: d.id, filename: d.filename, contentType: d.contentType, size: d.size, opis: d.opis || null, dodal: obcy && d.dodal ? 'Surf Stick' : (d.dodal || null), createdAt: d.createdAt,
    })),
  };
}

/* Rozbicie pozycji z formularza na linie zamówienia (migawka składu boxów).
   Wejście: [{ean, qty, packaging?}]. Wyjście: linie + błędy walidacji. */
// Kod magazynowy Bell (np. BfchS) — magazyn po nim identyfikuje towar na półce.
const symbolZ = (p) => (p && p.extras && typeof p.extras === 'object' && p.extras.symbol) ? String(p.extras.symbol) : null;

function rozbijPozycje(items, catalog) {
  const byEan = new Map(catalog.map(p => [p.ean, p]));
  const linie = [];
  const bledy = [];
  let sort = 0;
  for (const it of items) {
    const ean = String(it.ean || '').trim();
    const qty = Number(String(it.qty ?? '').trim());
    if (!ean || !Number.isInteger(qty) || qty <= 0 || qty > 100000) { bledy.push(`pozycja bez EAN albo ze złą ilością (całkowita 1–100000): ${JSON.stringify(it)}`); continue; }
    const p = byEan.get(ean);
    if (!p) { bledy.push(`nieznany produkt ${ean}`); continue; }
    if (/-GENERIC$/i.test(ean)) { bledy.push(`„${p.name}" bez koloru — magazyn musi wiedzieć, co pakuje. Wybierz kolory albo box mix.`); continue; }
    const ex = (p.extras && typeof p.extras === 'object') ? p.extras : {};
    const comp = Array.isArray(ex.composition) ? ex.composition : null;
    if (comp && comp.length) {
      const packaging = it.packaging === 'ekspozytor' ? 'ekspozytor' : 'karton';
      linie.push({ ean, name: p.name, variant: packaging === 'ekspozytor' ? 'ekspozytor zatowarowany' : 'w kartonie', symbol: symbolZ(p), qty, parentEan: null, packaging, sort: sort++ });
      for (const c of comp) {
        const cp = byEan.get(c.ean);
        linie.push({ ean: c.ean, name: cp ? cp.name : p.name, variant: c.variant || (cp && cp.variant) || null, symbol: symbolZ(cp), qty: Number(c.qty) * qty, parentEan: ean, packaging: null, sort: sort++ });
      }
      if (packaging === 'ekspozytor') {
        linie.push({ ean: EKSPOZYTOR.ean, name: EKSPOZYTOR.name, variant: null, qty, parentEan: ean, packaging: null, sort: sort++ });
      }
    } else {
      linie.push({ ean, name: p.name, variant: p.variant || null, symbol: symbolZ(p), qty, parentEan: null, packaging: null, sort: sort++ });
    }
  }
  return { linie, bledy };
}

/* WAGA Z ZAMÓWIENIA. Użytkownik: „wagę liczy z zamówienia" — magazyn nie musi
   ważyć. PRODUCT_WEIGHTS w glob-helpers to kg na 30 sztuk; klasyfikacja po
   słowach w nazwie, tak samo jak przy wycenie z faktury. Ekspozytor pusty:
   0,3 kg (do skorygowania po pierwszym zważeniu). Do tego waga kartonu
   z zapisanego wzorca, jeśli jest. Zaokrąglamy W GÓRĘ do 0,1 kg — lepiej
   zapłacić za 100 g więcej niż dostać dopłatę od kurjera. */
const WAGA_EKSPOZYTORA_KG = 0.3;
function wagaZPozycji(items, wagaKartonuKg) {
  let kg = 0;
  for (const i of items) {
    if (i.packaging) continue; // nagłówek boxa — waga siedzi w liniach dzieci
    if (i.ean === EKSPOZYTOR.ean) { kg += WAGA_EKSPOZYTORA_KG * i.qty; continue; }
    const n = String(i.name || '').toLowerCase();
    let typ = 'stick';
    if (n.includes('mascara') || n.includes('girl')) typ = 'mascara';
    else if (n.includes('gel')) typ = 'gel';
    else if (n.includes('daily')) typ = 'daily';
    else if (n.includes('care') || n.includes('cream')) typ = 'care';
    else if (n.includes('lip')) typ = 'lips';
    kg += ((PRODUCT_WEIGHTS[typ] || 1) / 30) * i.qty;
  }
  kg += Number(wagaKartonuKg) || 0;
  return Math.max(0.1, Math.ceil(kg * 10) / 10);
}

/** Czy odbiorca ma komplet do etykiety. Zwraca listę braków. */
function brakiOdbiorcy(od) {
  const o = od || {};
  const braki = [];
  if (!o.name) braki.push('nazwa');
  if (!o.street) braki.push('ulica');
  if (!o.postCode) braki.push('kod');
  if (!o.city) braki.push('miasto');
  if (!String(o.phone || '').replace(/\D/g, '')) braki.push('telefon');
  return braki;
}

/* AUTO-LIST: wycena + zamówienie kuriera z adresu magazynu (nadawca) na
   adres z zamówienia, najtańsza oferta. Wymiary z kartonu, waga policzona.
   Wołamy własne endpointy przez selfCall (jak agent), żeby nie dublować
   2000 linii logiki wyceny/zamówienia. Nadawca: MAGAZYN_SENDER_SEARCH
   (fragment nazwy nadawcy z książki GK) — bez tego jedziemy domyślnym
   nadawcą i mówimy o tym w kurierBlad? Nie: bez skonfigurowanego nadawcy
   NIE zamawiamy — paczka poszłaby z Galin zamiast z magazynu. */
/* Nadawca zakładki Paczki (14.10.2026): rekord `Sender` magazynu zewnętrznego
 * (Michał Urbaniak, Hłaski 7, 05-410 Józefów, delivery@) wskazany w Config
 * `magazyn_sender_id` — ustawiane z Konsoli API, bez zmiennych Railway.
 * Fallback: env MAGAZYN_SENDER_SEARCH (szukanie po nazwie w książce GK). */
async function nadawcaMagazynu(prisma) {
  try {
    const row = await prisma.config.findUnique({ where: { key: 'magazyn_sender_id' } });
    if (row && row.value) {
      const sender = await prisma.sender.findUnique({ where: { id: String(row.value).trim() } });
      if (sender) return { senderId: sender.id, opis: `${sender.name}, ${sender.city}` };
    }
  } catch (_) { /* brak Config — fallback niżej */ }
  const senderSearch = (process.env.MAGAZYN_SENDER_SEARCH || '').trim();
  if (senderSearch) return { senderSearch, opis: senderSearch };
  throw new Error('brak nadawcy magazynu: ustaw Config magazyn_sender_id (PUT /api/config/magazyn_sender_id) albo env MAGAZYN_SENDER_SEARCH — kurier nie zamówiony');
}

/* Wycena kuriera z adresu magazynu na adres odbiorcy (GK, przez własny
   endpoint — jak agent). Zwraca oferty od najtańszej. Bez chatId, więc nic
   nie idzie na Telegram. */
async function wycenKuriera(prisma, adres, paczka, extra = {}) {
  const nadawca = await nadawcaMagazynu(prisma);
  const q = await selfCall('POST', '/api/glob/quote', {
    ...(nadawca.senderId ? { senderId: nadawca.senderId } : { senderSearch: nadawca.senderSearch }),
    receiverSearch: adres.name,
    deliveryAddress: {
      street: adres.street, houseNumber: adres.houseNumber || null, apartmentNumber: adres.apartmentNumber || null,
      postCode: adres.postCode, city: adres.city, country: adres.country || 'PL', phone: adres.phone || null, email: adres.email || null,
    },
    weight: Number(paczka.wagaKg), length: paczka.dlugoscCm, width: paczka.szerokoscCm, height: paczka.wysokoscCm,
    ...extra,
  });
  if (!q.body || !q.body.ok) throw new Error(`wycena: ${(q.body && (q.body.error || q.body.message)) || `HTTP ${q.status}`}`);
  const offers = q.body.offers || [];
  if (!offers.length) throw new Error('wycena bez ofert');
  return { quoteId: String(q.body.quoteId), offers };
}

/* SZACUNEK CENY KURIERA PRZY SKŁADANIU ZAMÓWIENIA (10.11.2026). Paczka #5 do
   Włoch poszła za 138,94 zł zamiast ~47 zł i nikt tego nie widział, bo auto-list
   wyceniał dopiero po spakowaniu. Teraz wycena idzie już przy składaniu, na
   kartonie, jaki magazyn zwykle bierze (szacujPaczke), a właściciel widzi cenę,
   przewoźnika i liczbę ofert. Wynik trzymamy 30 min w pamięci, żeby „sprawdź
   cenę" w formularzu i samo złożenie zamówienia nie pytały GK dwa razy. */
const _szacunki = new Map(); // klucz → { o: szacunek, t }
async function szacunekKuriera(prisma, adres, linie) {
  const paczka = szacujPaczke(linie, wagaZPozycji(linie, 0));
  const klucz = crypto.createHash('sha1').update(JSON.stringify([adres.street, adres.houseNumber, adres.postCode, adres.city, adres.country, paczka])).digest('hex');
  const teraz = Date.now();
  for (const [k, v] of _szacunki) if (teraz - v.t > 30 * 60 * 1000) _szacunki.delete(k);
  const zapamietany = _szacunki.get(klucz);
  if (zapamietany) return zapamietany.o;
  let wynik;
  try {
    // Limit czasu: selfCall go nie ma, a składanie zamówienia nie może wisieć na GK.
    let budzik;
    const { offers } = await Promise.race([
      wycenKuriera(prisma, adres, paczka),
      new Promise((_, rej) => { budzik = setTimeout(() => rej(new Error('GlobKurier nie odpowiedział w 25 s')), 25000); }),
    ]).finally(() => clearTimeout(budzik));
    const o = offers[0];
    wynik = {
      cena: Number(o.price), waluta: o.currency || 'PLN', przewoznik: o.carrier || null, usluga: o.name || null,
      ofert: offers.length,
      inne: offers.slice(1, 3).map(x => ({ przewoznik: x.carrier || null, usluga: x.name || null, cena: Number(x.price) })),
      paczka, kiedy: new Date().toISOString(),
    };
    _szacunki.set(klucz, { o: wynik, t: teraz });
  } catch (e) {
    // GK nie odpowiada — zamówienie do magazynu i tak można złożyć, ale bez
    // punktu odniesienia dla bezpiecznika ceny. Nie zapamiętujemy błędu.
    wynik = { blad: String(e.message).slice(0, 300), paczka, kiedy: new Date().toISOString() };
  }
  return wynik;
}

/* AUTO-LIST + BEZPIECZNIK CENY: gdy najtańsza oferta przy pakowaniu jest
   wyraźnie droższa niż szacunek pokazany właścicielowi (limitCeny: 1,5× albo
   +25 zł), kuriera NIE zamawiamy — błąd trafia do kurierBlad i na Telegram,
   a właściciel decyduje („Zamów mimo to" = bezLimitu). */
async function zamowKuriera(o, prisma, { bezLimitu = false, productId = null } = {}) {
  // Najpierw nasze sprawdzenie (te same reguły co zamówienie w GK) — czytelny
  // powód zamiast odrzucenia z GK, i bez zbędnego wywołania.
  const spr = sprawdzOdbiorce(o.odbiorca);
  if (spr.bledy.length) throw new Error(`adres nie przejdzie w GlobKurier: ${spr.bledy.join('; ')} — popraw odbiorcę i ponów`);
  const { quoteId, offers } = await wycenKuriera(prisma, spr.adres, kartonZ(o), { invoiceNumber: o.invoiceNumber || undefined });
  // productId = inny przewoźnik wskazany przy naprawie (najtańszy odrzucił albo nie ma terminu).
  const oferta = productId == null ? offers[0] : offers.find(x => String(x.productId) === String(productId));
  if (!oferta) throw new Error(`oferty ${productId} nie ma w aktualnej wycenie — wybierz productId z wycen_kuriera`);
  const cena = oferta.price != null ? Number(oferta.price) : null;
  const szac = o.kurierSzacunek && Number(o.kurierSzacunek.cena);
  // Odniesienie: szacunek pokazany właścicielowi; bez niego przy droższej
  // ofercie — najtańsza z bieżącej wyceny (naprawa nie może kupić dowolnie drogo).
  const odniesienie = szac > 0 ? szac : (oferta !== offers[0] ? Number(offers[0].price) : null);
  if (!bezLimitu && cena != null && odniesienie > 0 && zaDrogo(cena, odniesienie)) {
    const wobec = szac > 0 ? `przy składaniu zamówienia szacunek był ${zl(szac)}` : `najtańsza oferta to ${zl(odniesienie)}`;
    throw new Error(`Cena kuriera za wysoka: ${zl(cena)} (${[oferta.carrier, oferta.name].filter(Boolean).join(' ')}), a ${wobec} (limit ${zl(limitCeny(odniesienie))}). Kurier NIE został zamówiony — sprawdź adres i karton; jeśli cena jest w porządku, kliknij „Zamów mimo to”.`);
  }
  // `niepewne` = nie wiadomo, czy zlecenie powstało (patrz niepewnyBlad): kto
  // ponawia, najpierw sprawdza listę zleceń w GK (swiezeZlecenieGk).
  let r;
  try { r = await selfCall('POST', '/api/glob/order', { quoteId, productId: oferta.productId }); }
  catch (e) { throw Object.assign(new Error(`zamówienie: brak odpowiedzi serwera (${e.message})`), { niepewne: true }); }
  if (!r.body || !r.body.ok) {
    const tresc = (r.body && (r.body.error || r.body.message)) || `HTTP ${r.status}`;
    // Odmowa GK wraca jako HTTP 200 + ok:false (nic nie powstało). Inny status
    // to wyjątek w trakcie zamawiania — np. limit czasu po wysłaniu zlecenia.
    throw Object.assign(new Error(`zamówienie: ${tresc}`), { niepewne: r.status !== 200 || niepewnyBlad(tresc) });
  }
  return { gkHash: r.body.hash || null, gkNumber: r.body.orderNumber || null, carrier: r.body.carrier || oferta.carrier || null, quoteId, cena };
}

/* CZY ZLECENIE JEDNAK POWSTAŁO (18.11.2026). GlobKurier potrafi zawisnąć przy
 * POST /v1/order na 25 s+ (nasz limit czasu) albo oddać 502 — a zlecenie mimo
 * to utworzyć. Człowiek po takim błędzie zajrzy do GK; automat, który ponawia,
 * zamówiłby drugiego kuriera. Dlatego po NIEPEWNYM błędzie każde ponowienie
 * (naprawa i „Ponów auto-list") najpierw szuka na liście GK zlecenia z ostatnich
 * minut dla tego odbiorcy i — jeśli jest — podpina je zamiast zamawiać. */
// Treść błędu z fazy zamawiania (po wycenie): limit czasu, zerwane połączenie,
// 5xx albo odpowiedź bez numeru — zlecenie mogło powstać.
const niepewnyBlad = (tresc) => /timeout|limit czasu|brak odpowiedzi|HTTP 5\d\d|ECONN|ETIMEDOUT|EPIPE|socket|hang up|nie potwierdzi[łl] zam[óo]wienia/i.test(String(tresc || ''));
// To samo dla błędu zapisanego w kurierBlad („zamówienie: …"; błąd wyceny jest bezpieczny).
const niepewnyZapisany = (blad) => /^zamówienie:/i.test(String(blad || '')) && niepewnyBlad(blad);

// „2026-11-18 13:26:15" z GK to czas warszawski — na milisekundy UTC.
function czasGkNaMs(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const jakUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const w = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .format(new Date(jakUtc)).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!w) return jakUtc;
  const przesuniecie = Date.UTC(+w[1], +w[2] - 1, +w[3], +w[4], +w[5], +w[6]) - jakUtc; // +1 h zimą, +2 h latem
  return jakUtc - przesuniecie;
}

const tylkoZnaki = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Zlecenie GK utworzone po `odMs` dla odbiorcy tego zamówienia i niepodpięte
 *  pod inne zamówienie magazynu — albo null. Rzuca, gdy lista GK jest niedostępna
 *  (wtedy NIE wolno zamawiać ponownie w ciemno). `pobierz` do testów. */
async function swiezeZlecenieGk(prisma, o, odMs, pobierz = null) {
  const lista = await (pobierz || (() => require('../glob-client').fetchOrdersPaged(1, 50)))();
  const adres = sprawdzOdbiorce(o.odbiorca).adres;
  const nazwa = tylkoZnaki(adres.name);
  const ulica = tylkoZnaki(`${adres.street}${adres.houseNumber}`);
  const kod = tylkoZnaki(adres.postCode);
  if (!kod || (nazwa.length < 4 && ulica.length < 5)) return null;
  const pasujace = (lista || []).filter((z) => {
    const r = z.receiverAddress || {};
    const n = tylkoZnaki(r.name);
    const kiedy = czasGkNaMs(z.creationDate);
    // Ten sam odbiorca: początek nazwy (GK ucina ją do 30 znaków) albo ta sama
    // ulica z numerem — zawsze z tym samym kodem pocztowym.
    const tenSam = (n.length >= 4 && nazwa.length >= 4 && (nazwa.startsWith(n) || n.startsWith(nazwa)))
      || (ulica.length >= 5 && tylkoZnaki(`${r.street || ''}${r.houseNumber || ''}`) === ulica);
    return tenSam && tylkoZnaki(r.postCode) === kod
      && kiedy != null && kiedy >= odMs - 2 * 60 * 1000
      && !/CANCEL|ANUL/i.test(String(z.status || ''));
  });
  for (const z of pasujace) {
    const numer = z.number ? String(z.number) : null;
    const hash = z.hash ? String(z.hash) : null;
    if (!numer && !hash) continue;
    const zajete = await prisma.warehouseOrder.findFirst({ where: { id: { not: o.id }, OR: [...(numer ? [{ gkNumber: numer }] : []), ...(hash ? [{ gkHash: hash }] : [])] } });
    if (zajete) continue;
    const c = z.carrier;
    const cena = z.pricing && z.pricing.priceGross != null ? Number(z.pricing.priceGross) : null;
    return { gkNumber: numer, gkHash: hash, carrier: (c && typeof c === 'object' ? (c.name || c.brandName) : c) || null, cena: Number.isFinite(cena) ? cena : null };
  }
  return null;
}

/** Karton do wyceny: wybrany przez magazyn, a zanim go wybierze — szacowany. */
function kartonZ(o) {
  if (o.dlugoscCm && o.szerokoscCm && o.wysokoscCm && o.wagaKg != null) return { wagaKg: o.wagaKg, dlugoscCm: o.dlugoscCm, szerokoscCm: o.szerokoscCm, wysokoscCm: o.wysokoscCm };
  return szacujPaczke(o.items || [], wagaZPozycji(o.items || [], 0));
}

/* ---------- AUTOMATYCZNA NAPRAWA AUTO-LISTU (18.11.2026) ----------
 * Po nieudanym auto-liście: brak środków / bezpiecznik ceny / błąd ustawień →
 * od razu Telegram do właściciela; reszta → model (services/kurier-naprawa.js)
 * z narzędziami zdefiniowanymi tutaj. Naprawa biegnie W TLE — „Paczka gotowa"
 * odpowiada magazynowi od razu, a wynik (list albo alarm) przychodzi po
 * 1–2 minutach. Stan w WarehouseOrder.kurierNaprawa. */
const NAPRAWA_NAJDLUZEJ_MS = 10 * 60 * 1000;
const ZATWIERDZIL_NAPRAWA = 'auto-list (naprawa)';
const _naprawyWToku = new Set();
const naprawaWlaczona = () => process.env.KURIER_NAPRAWA !== '0' && !!(process.env.ANTHROPIC_API_KEY || '').trim();
function naprawaTrwa(o) {
  const n = o && o.kurierNaprawa;
  return !!(n && n.stan === 'w-toku' && Date.now() - new Date(n.od || 0).getTime() < NAPRAWA_NAJDLUZEJ_MS);
}
const ktoGdzie = (o) => [(o.odbiorca || {}).name, (o.odbiorca || {}).city].filter(Boolean).join(', ') || 'bez odbiorcy';

function daneDlaModelu(o) {
  const sz = o.kurierSzacunek || null;
  const k = kartonZ(o);
  return {
    numer: o.numer,
    odbiorca: o.odbiorca || {},
    paczka: { dlugoscCm: k.dlugoscCm, szerokoscCm: k.szerokoscCm, wysokoscCm: k.wysokoscCm, wagaKg: Number(k.wagaKg) },
    szacunekCeny: sz && sz.cena != null ? { cena: sz.cena, przewoznik: sz.przewoznik || null, usluga: sz.usluga || null, limit: limitCeny(sz.cena) } : null,
  };
}

const POLA_ODBIORCY = { name: 'nazwa', street: 'ulica', houseNumber: 'numer domu', apartmentNumber: 'lokal', postCode: 'kod pocztowy', city: 'miasto', phone: 'telefon' };
const czystePola = (pola) => Object.fromEntries(Object.entries(pola || {}).filter(([k, v]) => k in POLA_ODBIORCY && typeof v === 'string').map(([k, v]) => [k, v.slice(0, 200)]));

/** Zapis zamówionego (albo odnalezionego) kuriera w zamówieniu magazynu. */
const daneKuriera = (k, ktoZatwierdzil) => ({ status: 'KURIER', gkHash: k.gkHash || null, gkNumber: k.gkNumber || null, carrier: k.carrier || null, ...(k.quoteId ? { quoteId: k.quoteId } : {}), kurierCena: k.cena != null ? k.cena : null, kurierBlad: null, zatwierdzilKto: ktoZatwierdzil, zatwierdzonoAt: new Date() });

/** Narzędzia modelu dla jednego zamówienia. `proba` = { o, zamow } — praca
 *  na kopii w pamięci: nic nie zapisuje i niczego nie zamawia w GlobKurier.
 *  `niepewneOd` (ms) — pierwsza próba auto-listu skończyła się niepewnie
 *  (limit czasu przy zamawianiu): pierwsze `zamow` najpierw sprawdzi listę GK. */
function narzedziaNaprawy(prisma, id, { proba = null, niepewneOd = null } = {}) {
  // `pierwotny` — odbiorca sprzed naprawy: każda poprawka jest porównywana z nim,
  // nie z poprzednią poprawką (seria drobnych zmian nie może odpłynąć od adresu).
  const stan = { niepewneOd: niepewneOd || null, pierwotny: null };
  const wez = async () => {
    const o = proba ? proba.o : await prisma.warehouseOrder.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (o && !stan.pierwotny) stan.pierwotny = { ...(o.odbiorca || {}) };
    return o;
  };
  const stop = (o) => (!o ? 'zamówienia już nie ma'
    : o.status !== 'GOTOWE' ? `zamówienie jest w stanie ${o.status} — kuriera nie zamawiam`
      : (o.gkNumber || o.gkHash) ? 'kurier został w międzyczasie zamówiony' : null);
  const zapisz = async (k) => {
    // Zlecenie w GK JUŻ JEST — błąd zapisu nie może skończyć się drugim zamówieniem
    // (naprawWTle domyka zapis jeszcze raz na podstawie wyniku).
    try { await prisma.warehouseOrder.update({ where: { id }, data: daneKuriera(k, ZATWIERDZIL_NAPRAWA) }); }
    catch (e) { console.error(`[magazyn] naprawa: kurier ${k.gkNumber} zamówiony, zapis nieudany:`, e.message); }
  };
  return {
    stan,
    async sprawdzAdres(pola) {
      const o = await wez();
      const w = sprawdzOdbiorce({ ...(o.odbiorca || {}), ...czystePola(pola) });
      return { adres: w.adres, poprawkiAutomatyczne: w.poprawki, ostrzezenia: w.ostrzezenia, bledy: w.bledy, zmianaTresci: naruszeniaPoprawki(stan.pierwotny, w.adres) };
    },
    async poprawOdbiorce(pola, powod) {
      const o = await wez();
      const s = stop(o);
      if (s) return { ok: false, blad: s };
      const w = sprawdzOdbiorce({ ...(o.odbiorca || {}), ...czystePola(pola) });
      if (w.bledy.length) return { ok: false, blad: `adres po zmianie nie przejdzie: ${w.bledy.join('; ')}` };
      const zle = naruszeniaPoprawki(stan.pierwotny, w.adres);
      if (zle.length) return { ok: false, blad: `to zmiana treści, nie zapisu — odrzucona: ${zle.join('; ')}` };
      const zmiany = Object.keys(POLA_ODBIORCY)
        .filter(k => String((o.odbiorca || {})[k] || '') !== String(w.adres[k] || ''))
        .map(k => ({ pole: POLA_ODBIORCY[k], bylo: String((o.odbiorca || {})[k] || ''), jest: String(w.adres[k] || ''), powod }));
      if (!zmiany.length) return { ok: true, zmiany: [], uwaga: 'nic się nie zmieniło — po czyszczeniu dane są takie same' };
      if (proba) proba.o = { ...proba.o, odbiorca: w.adres };
      else await prisma.warehouseOrder.update({ where: { id }, data: { odbiorca: w.adres } });
      return { ok: true, odbiorca: w.adres, zmiany, ostrzezenia: w.ostrzezenia };
    },
    async wycen() {
      const o = await wez();
      const spr = sprawdzOdbiorce(o.odbiorca);
      if (spr.bledy.length) return { ok: false, blad: `adres nie przejdzie w GlobKurier: ${spr.bledy.join('; ')}` };
      const { offers } = await wycenKuriera(prisma, spr.adres, kartonZ(o));
      const szac = o.kurierSzacunek && Number(o.kurierSzacunek.cena);
      return {
        ok: true,
        oferty: offers.slice(0, 6).map(x => ({ productId: x.productId, przewoznik: x.carrier, usluga: x.name, cena: Number(x.price), najblizszyOdbior: (x.nearestPickup && x.nearestPickup.date) || null })),
        limitCeny: limitCeny(szac > 0 ? szac : Number(offers[0].price)),
        szacunekPrzyZamowieniu: szac > 0 ? szac : null,
      };
    },
    async zamow({ productId }) {
      const o = await wez();
      const s = stop(o);
      if (s) return { ok: false, blad: s };
      if (proba) return proba.zamow(o, productId);
      // Poprzednia próba mogła utworzyć zlecenie mimo błędu — najpierw lista GK.
      if (stan.niepewneOd) {
        let z;
        try { z = await swiezeZlecenieGk(prisma, o, stan.niepewneOd); }
        catch (e) { return { ok: false, blad: `nie zamawiam ponownie: nie da się sprawdzić w GlobKurier, czy poprzednia próba utworzyła zlecenie (${String(e.message).slice(0, 200)}). Zakończ — właściciel sprawdzi listę zleceń.` }; }
        if (z) {
          await zapisz(z);
          stan.niepewneOd = null;
          return { ok: true, gkNumber: z.gkNumber, gkHash: z.gkHash, przewoznik: z.carrier, cena: z.cena, podpiete: true, uwaga: 'Zlecenie powstało już przy poprzedniej próbie (GlobKurier nie odpowiedział na czas) — podpiąłem je, drugiego nie zamawiam.' };
        }
        stan.niepewneOd = null; // nic nie powstało — można zamawiać
      }
      const start = Date.now();
      let k;
      try { k = await zamowKuriera(o, prisma, { productId }); }
      catch (e) {
        if (e.niepewne) stan.niepewneOd = start;
        return { ok: false, blad: String(e.message).slice(0, 500), ...(e.niepewne ? { uwaga: 'Nie wiadomo, czy zlecenie powstało. Następne zamow_kuriera najpierw sprawdzi listę zleceń w GlobKurier i podepnie zlecenie, jeśli jest.' } : {}) };
      }
      await zapisz(k);
      return { ok: true, gkNumber: k.gkNumber, gkHash: k.gkHash, przewoznik: k.carrier, cena: k.cena, quoteId: k.quoteId };
    },
  };
}

/* Atrapa GlobKuriera do PRÓBY: odrzuca to, co odrzuca prawdziwy (znaki spoza
   bezpiecznych w nazwie/ulicy/mieście, telefon spoza kraju), resztę „zamawia"
   na niby. Pozwala sprawdzić model i pętlę na produkcji bez płatnego zlecenia. */
function atrapaGk(bladPoczatkowy) {
  return (o) => {
    const od = o.odbiorca || {};
    const brudne = ['name', 'street', 'city'].filter(k => /[^\p{L}\p{N}\s.\-]/u.test(String(od[k] || '')));
    if (brudne.length) return { ok: false, blad: bladPoczatkowy };
    const tel = normalizujTelefon(od.phone, od.country);
    const dial = KIERUNKOWE[String(od.country || '').toUpperCase()];
    if (!tel || (dial && !tel.startsWith(`+${dial}`))) return { ok: false, blad: `zamówienie: Telefon odbiorcy (${od.phone || 'brak'}) odrzucony przez GK: "To nie jest prawidłowy numer telefonu dla kraju odbiorcy".` };
    return { ok: true, proba: true, gkNumber: 'PROBA-NIC-NIE-ZAMOWIONO', przewoznik: 'próba', cena: null };
  };
}

const tekstBrakuSrodkow = (o, blad) => `🛑 Magazyn #${o.numer} (${ktoGdzie(o)}): paczka spakowana, kurier NIE zamówiony — GlobKurier odrzucił płatność (brak środków na koncie).\n`
  + `Komunikat: ${String(blad).slice(0, 300)}\n`
  + 'Doładuj konto GlobKurier i kliknij „Ponów auto-list” przy zamówieniu w panelu Magazyn.';
const tekstNieudanego = (o, blad, dopisek) => `⚠️ Magazyn #${o.numer} (${ktoGdzie(o)}): paczka spakowana, ale NIE udało się zamówić kuriera.\n`
  + `Błąd: ${String(blad).slice(0, 350)}\n`
  + (dopisek ? `${dopisek}\n` : '')
  + 'Zamów kuriera ręcznie w panelu Magazyn (albo napisz do Claude).';
const UWAGA_NIEPEWNE = 'UWAGA: GlobKurier nie odpowiedział przy zamawianiu — zlecenie mogło powstać. Zajrzyj do listy zleceń w GlobKurier, zanim zamówisz ponownie.';

/** Co wysłać właścicielowi od razu (bez modelu) po nieudanym auto-liście. */
function tekstBezNaprawy(o, blad, rodzaj) {
  if (rodzaj === 'brak-srodkow') return tekstBrakuSrodkow(o, blad);
  return tekstNieudanego(o, blad, rodzaj === 'cena' ? 'Jeśli cena jest w porządku, kliknij „Zamów mimo to” przy zamówieniu.' : null);
}

async function powiadomONaprawie(prisma, o, blad, w, niepewne) {
  if (w.ok) {
    const z = w.zamowiono || {};
    return alarmWlasciciela(prisma, `🔧 Magazyn #${o.numer} (${ktoGdzie(o)}): auto-list się nie udał, kurier zamówiony po automatycznej naprawie.\n`
      + `${w.podsumowanie}\n`
      + `Kurier: ${[z.przewoznik, z.cena != null ? zl(z.cena) : null, z.gkNumber].filter(Boolean).join(', ')}.`);
  }
  if (w.brakSrodkow) return alarmWlasciciela(prisma, tekstBrakuSrodkow(o, w.ostatniBlad || blad));
  return alarmWlasciciela(prisma, tekstNieudanego(o, w.ostatniBlad || blad,
    [`Automatyczna naprawa (${w.model}) nie pomogła: ${w.podsumowanie}`, niepewne ? UWAGA_NIEPEWNE : null].filter(Boolean).join('\n')));
}

/** Naprawa w tle: stan „w-toku" → model → zapis wyniku → Telegram.
 *  `napraw` do testów (domyślnie prawdziwy model). */
async function naprawWTle(prisma, id, blad, { niepewneOd = null, napraw = naprawKuriera } = {}) {
  if (_naprawyWToku.has(id)) return null;
  _naprawyWToku.add(id);
  const od = new Date().toISOString();
  let o = null;
  try {
    o = await prisma.warehouseOrder.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!o) return null;
    if (o.status !== 'GOTOWE' || o.gkNumber || o.gkHash) {
      // Zamówienie zmieniło się, zanim naprawa ruszyła — nie zostawiamy „w toku".
      await prisma.warehouseOrder.update({ where: { id }, data: { kurierNaprawa: { stan: 'pominieta', od, do: od } } });
      return null;
    }
    await prisma.warehouseOrder.update({ where: { id }, data: { kurierNaprawa: { stan: 'w-toku', od } } });
    const narz = narzedziaNaprawy(prisma, id, { niepewneOd });
    const w = await napraw({ zamowienie: daneDlaModelu(o), blad, narzedzia: narz });
    const niepewne = !w.ok && !!narz.stan.niepewneOd;
    console.log(`[magazyn] naprawa auto-listu #${o.numer}: ${w.ok ? 'UDANA' : 'nieudana'} (${w.model}, ${w.zuzycie.wywolan} wywołań, ${w.proby} prób zamówienia, ${Math.round(w.trwaloMs / 1000)} s)`);
    const po = await prisma.warehouseOrder.findUnique({ where: { id }, include: ORDER_INCLUDE });
    const data = {
      kurierNaprawa: {
        stan: w.ok ? 'udana' : 'nieudana', od, do: new Date().toISOString(), model: w.model,
        podsumowanie: w.podsumowanie, zmiany: w.zmiany, proby: w.proby, powodKonca: w.powodKonca || null,
        ...(niepewne ? { niepewne: true } : {}),
        kroki: w.kroki.slice(0, 20), zuzycie: w.zuzycie,
      },
    };
    // Domknięcie, gdy zapis w narzędziu się nie udał, a zlecenie w GK powstało.
    if (w.ok && po && po.status === 'GOTOWE' && (w.zamowiono.gkNumber || w.zamowiono.gkHash)) {
      Object.assign(data, daneKuriera({ gkHash: w.zamowiono.gkHash, gkNumber: w.zamowiono.gkNumber, carrier: w.zamowiono.przewoznik, quoteId: w.zamowiono.quoteId, cena: w.zamowiono.cena }, ZATWIERDZIL_NAPRAWA));
    }
    if (!w.ok && po && po.status === 'GOTOWE') data.kurierBlad = String(w.ostatniBlad || blad).slice(0, 500);
    await prisma.warehouseOrder.update({ where: { id }, data });
    await powiadomONaprawie(prisma, po || o, blad, w, niepewne);
    return w;
  } catch (e) {
    console.error(`[magazyn] naprawa auto-listu ${id} przerwana:`, e.message);
    try { await prisma.warehouseOrder.update({ where: { id }, data: { kurierNaprawa: { stan: 'nieudana', od, do: new Date().toISOString(), podsumowanie: `Naprawa przerwana: ${String(e.message).slice(0, 300)}` } } }); } catch (_) { /* baza leży — alarm niżej i tak pójdzie */ }
    if (o) await alarmWlasciciela(prisma, tekstNieudanego(o, blad, `Automatyczna naprawa przerwana: ${String(e.message).slice(0, 200)}`));
    return null;
  } finally {
    _naprawyWToku.delete(id);
  }
}

/** Uruchamia naprawę w tle (odpowiedź HTTP nie czeka na model). */
function uruchomNaprawe(prisma, id, blad, opcje) {
  setImmediate(() => { naprawWTle(prisma, id, blad, opcje).catch(err => console.error('[magazyn] naprawa w tle:', err.message)); });
}

/** Po restarcie serwera: naprawy urwane w połowie nie mogą wisieć jako
 *  „w toku" bez słowa — oznaczamy i zgłaszamy właścicielowi. index.js woła to
 *  3 minuty po starcie: wtedy poprzedni proces na pewno już nie żyje, więc
 *  każda naprawa zaczęta przed startem tego procesu jest osierocona. */
async function posprzatajPrzerwaneNaprawy(prisma, { startProcesu = Date.now() - process.uptime() * 1000 } = {}) {
  const wiszace = await prisma.warehouseOrder.findMany({ where: { status: 'GOTOWE', kurierNaprawa: { path: ['stan'], equals: 'w-toku' } }, include: ORDER_INCLUDE });
  let ile = 0;
  for (const o of wiszace) {
    const od = new Date((o.kurierNaprawa || {}).od || 0).getTime();
    if (_naprawyWToku.has(o.id) || od >= startProcesu) continue; // biegnie w tym procesie
    await prisma.warehouseOrder.update({ where: { id: o.id }, data: { kurierNaprawa: { ...(o.kurierNaprawa || {}), stan: 'nieudana', do: new Date().toISOString(), podsumowanie: 'Naprawa przerwana restartem serwera.', niepewne: true } } });
    await alarmWlasciciela(prisma, tekstNieudanego(o, o.kurierBlad || 'kurier niezamówiony', `Automatyczna naprawa została przerwana restartem serwera.\n${UWAGA_NIEPEWNE}`));
    ile++;
  }
  return ile;
}

/* ZA MAŁO TOWARU (22.11.2026). Zamówienie #10 poszło do magazynu z 74 żelami
 * przy 72 na stanie i z 74 Daily przy 71 — wyszło dopiero przy ręcznym
 * sprawdzeniu, już po mailu do magazynu. Teraz złożenie zamówienia jest
 * BLOKOWANE, gdy wg CRM towaru nie wystarczy. Dostępne = stan (suma ruchów)
 * minus to, co czeka w innych zamówieniach do spakowania: towar schodzi ze
 * stanu dopiero przy „Paczka gotowa", więc zamówienia NOWE go rezerwują.
 * Ekspozytorów nie liczymy — ich stan nie jest prowadzony (bywa ujemny). */
const krotkaNazwa = (n) => ((String(n || '').match(/^[\p{Lu}\d]+(?:\s+[\p{Lu}\d]+)*(?=\s|$)/u) || [String(n || '')])[0]).trim();
const etykietaTowaru = (x) => `${krotkaNazwa(x.name)}${x.variant && /^\p{L}+$/u.test(x.variant) ? ` ${x.variant}` : ''}${x.symbol ? ` (${x.symbol})` : ''}`;
async function brakiTowaru(prisma, linie) {
  const potrzeba = new Map();
  for (const l of linie) {
    if (l.packaging || l.ean === EKSPOZYTOR.ean) continue;
    const p = potrzeba.get(l.ean) || { ean: l.ean, symbol: null, name: l.name, variant: null, potrzeba: 0 };
    p.potrzeba += l.qty;
    p.symbol = p.symbol || l.symbol || null;
    p.variant = p.variant || l.variant || null;
    potrzeba.set(l.ean, p);
  }
  const eany = [...potrzeba.keys()];
  if (!eany.length) return [];
  const [ruchy, czekajace] = await Promise.all([
    prisma.stockMovement.groupBy({ by: ['ean'], where: { ean: { in: eany } }, _sum: { delta: true } }),
    prisma.warehouseOrderItem.groupBy({ by: ['ean'], where: { ean: { in: eany }, packaging: null, order: { status: 'NOWE' } }, _sum: { qty: true } }),
  ]);
  const stan = new Map(ruchy.map(g => [g.ean, g._sum.delta || 0]));
  const rezerwa = new Map(czekajace.map(g => [g.ean, g._sum.qty || 0]));
  const braki = [];
  for (const p of potrzeba.values()) {
    const naStanie = stan.get(p.ean) || 0;
    const zarezerwowane = rezerwa.get(p.ean) || 0;
    const dostepne = naStanie - zarezerwowane;
    if (dostepne < p.potrzeba) braki.push({ ean: p.ean, symbol: p.symbol, nazwa: etykietaTowaru(p), potrzeba: p.potrzeba, naStanie, zarezerwowane, dostepne, brakuje: p.potrzeba - dostepne });
  }
  return braki;
}
function tekstBrakowTowaru(braki) {
  const linie = braki.map(b => `• ${b.nazwa}: potrzeba ${b.potrzeba}, dostępne ${Math.max(0, b.dostepne)}`
    + (b.zarezerwowane > 0 ? ` (na stanie ${b.naStanie}, a ${b.zarezerwowane} czeka w innych zamówieniach do spakowania)` : '')
    + ` — brakuje ${b.brakuje}`);
  return `Za mało towaru w magazynie — zamówienie NIE zostało złożone.\n${linie.join('\n')}\nZmniejsz ilości albo wpisz przyjęcie towaru (Paczki → Stan w magazynie → Przyjęcie / korekta).`;
}

/** Linie, które realnie schodzą ze stanu: bez nagłówków boxów. */
const linieDoStocku = (items) => items.filter(i => !i.packaging);

// ---------- ZAMÓWIENIA ----------

router.get('/zamowienia', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const status = String(req.query.status || 'aktywne');
  // „Aktywne" = do spakowania / spakowane / u kuriera + WYSŁANE z ostatnich 14 dni
  // (widać „wysłane · 3 dni temu", potem schodzi z listy) — jak zakładka Wysyłki.
  const dni14 = new Date(Date.now() - 14 * 24 * 3600 * 1000);
  const aktywne = { OR: [{ status: { in: ['NOWE', 'GOTOWE', 'KURIER'] } }, { status: 'WYSLANE', OR: [{ wyslanoAt: { gte: dni14 } }, { wyslanoAt: null, updatedAt: { gte: dni14 } }] }] };
  let where = status === 'aktywne' ? aktywne
    : status === 'wszystkie' ? {} : { status: status.toUpperCase() };
  // Magazyn: tylko to, co go dotyczy — nigdy anulowane (nie były jego) ani
  // historia starsza niż 60 dni.
  if (rola(req) === 'magazyn') {
    where = status === 'aktywne'
      ? aktywne
      : { status: { in: ['NOWE', 'GOTOWE', 'KURIER', 'WYSLANE'] }, createdAt: { gte: new Date(Date.now() - 60 * 24 * 3600 * 1000) } };
  }
  // Status z GlobKurier odświeżamy W TLE (throttle 10 min) — lista nie czeka na GK.
  setImmediate(() => require('../services/magazyn-statusy').odswiezStatusyMagazynu(prisma).catch(e => console.error('[magazyn-statusy]', e.message)));
  const rows = await prisma.warehouseOrder.findMany({ where, include: ORDER_INCLUDE, orderBy: { numer: 'desc' }, take: 300 });
  res.json({ ok: true, zamowienia: rows.map(x => toPublic(x, rola(req))), rola: rola(req) });
}));

router.get('/zamowienia/:id', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const o = await prisma.warehouseOrder.findUnique({ where: { id: req.params.id }, include: ORDER_INCLUDE });
  if (!o) return res.status(404).json({ ok: false, error: 'brak zamówienia' });
  res.json({ ok: true, zamowienie: toPublic(o, rola(req)) });
}));

router.post('/zamowienia', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const prisma = req.app.locals.prisma;
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return res.status(400).json({ ok: false, error: 'brak pozycji' });
  const od = (b.odbiorca && typeof b.odbiorca === 'object') ? b.odbiorca : {};
  // Odbiorca jest OPCJONALNY (wysyłka niestandardowa: kurier ręcznie, podpięcie
  // numerem). Ale auto-list bez pełnego adresu nie ma sensu — blokujemy tutaj,
  // nie dopiero przy „gotowe", żeby magazyn nie czekał na etykietę.
  const autoList = !!b.autoList;
  /* WERYFIKACJA ADRESU (9.11.2026): przy auto-liście adres musi przejść reguły
   * GlobKuriera JUŻ TERAZ — wcześniej błąd wychodził dopiero przy pakowaniu,
   * gdy kurier miał przyjechać. Poprawki (apostrof, „(LI)", kod, telefon)
   * robimy sami i zapisujemy adres już poprawiony. */
  const podanyAdres = Object.values(od).some(v => String(v || '').trim());
  const weryfikacja = (podanyAdres || autoList) ? sprawdzOdbiorce(od) : null;
  if (autoList && weryfikacja.bledy.length) {
    return res.status(400).json({ ok: false, error: `Adres nie przejdzie w GlobKurier — popraw przed złożeniem: ${weryfikacja.bledy.join('; ')}`, bledy: weryfikacja.bledy, poprawki: weryfikacja.poprawki, ostrzezenia: weryfikacja.ostrzezenia });
  }

  const catalog = await getActiveCatalog(prisma);
  const { linie, bledy } = rozbijPozycje(items, catalog);
  if (bledy.length) return res.status(400).json({ ok: false, error: bledy.join('; ') });
  // Blokada: wg CRM nie ma tyle towaru (stan minus zamówienia czekające na spakowanie).
  const braki = await brakiTowaru(prisma, linie);
  if (braki.length) return res.status(400).json({ ok: false, zaMaloTowaru: true, error: tekstBrakowTowaru(braki), braki });

  let contractorId = b.contractorId ? String(b.contractorId) : null;
  if (contractorId) {
    const c = await prisma.contractor.findUnique({ where: { id: contractorId }, select: { id: true } }).catch(() => null);
    if (!c) contractorId = null;
  }
  // Cena kuriera już teraz (auto-list) — właściciel widzi ją przy składaniu.
  const szacunek = autoList ? await szacunekKuriera(prisma, weryfikacja.adres, linie) : null;
  const o = await prisma.warehouseOrder.create({
    data: {
      contractorId,
      kurierSzacunek: szacunek || undefined,
      odbiorca: weryfikacja ? weryfikacja.adres : {
        name: '', street: '', houseNumber: '', apartmentNumber: '', postCode: '', city: '', country: 'PL', phone: '', email: '',
      },
      autoList,
      uwagiNasze: b.uwagiNasze ? String(b.uwagiNasze).slice(0, 2000) : null,
      invoiceNumber: b.invoiceNumber ? String(b.invoiceNumber).slice(0, 60) : null,
      emailId: b.emailId ? String(b.emailId) : null,
      utworzyl: kto(req),
      items: { create: linie },
    },
    include: ORDER_INCLUDE,
  });
  res.json({
    ok: true, zamowienie: toPublic(o, rola(req)),
    adres: weryfikacja ? { poprawki: weryfikacja.poprawki, ostrzezenia: weryfikacja.ostrzezenia, bledy: weryfikacja.bledy } : null,
    kurier: szacunek ? { szacunek, opis: opisSzacunku(szacunek) } : null,
  });
}));

/* Cena kuriera PRZED złożeniem zamówienia (formularz, Claude): ten sam
   szacunek, który potem zapisze się przy zamówieniu. Nic nie zamawia. */
router.post('/wycena', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const prisma = req.app.locals.prisma;
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return res.status(400).json({ ok: false, error: 'brak pozycji' });
  const w = sprawdzOdbiorce((b.odbiorca && typeof b.odbiorca === 'object') ? b.odbiorca : {});
  if (w.bledy.length) return res.status(400).json({ ok: false, error: `Adres nie przejdzie w GlobKurier: ${w.bledy.join('; ')}`, bledy: w.bledy });
  const { linie, bledy } = rozbijPozycje(items, await getActiveCatalog(prisma));
  if (bledy.length) return res.status(400).json({ ok: false, error: bledy.join('; ') });
  const szacunek = await szacunekKuriera(prisma, w.adres, linie);
  res.json({ ok: !szacunek.blad, szacunek, opis: opisSzacunku(szacunek), adres: { poprawki: w.poprawki, ostrzezenia: w.ostrzezenia } });
}));

/* Sprawdzenie adresu bez składania zamówienia (formularz, Claude). */
router.post('/sprawdz-adres', asyncHandler(async (req, res) => {
  const w = sprawdzOdbiorce((req.body && req.body.odbiorca) || {});
  res.json({ ok: !w.bledy.length, ...w });
}));

// Właściciel: uwagi, anulowanie. Anulowanie po GOTOWE cofa wydanie ze stanu.
router.patch('/zamowienia/:id', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const prisma = req.app.locals.prisma;
  const b = req.body || {};
  const o = await prisma.warehouseOrder.findUnique({ where: { id: req.params.id }, include: ORDER_INCLUDE });
  if (!o) return res.status(404).json({ ok: false, error: 'brak zamówienia' });
  // Naprawa auto-listu może właśnie zamawiać kuriera na ten adres — zmiana
  // odbiorcy albo statusu w tej chwili rozjechałaby zamówienie ze zleceniem.
  if ((b.odbiorca || b.status) && (naprawaTrwa(o) || _naprawyWToku.has(o.id))) return res.status(409).json({ ok: false, error: 'Trwa automatyczne zamawianie kuriera — poczekaj minutę i odśwież.' });
  const data = {};
  if ('uwagiNasze' in b) data.uwagiNasze = b.uwagiNasze ? String(b.uwagiNasze).slice(0, 2000) : null;
  /* POPRAWA ODBIORCY (9.11.2026) — wcześniej „odbiorcy nie da się zmienić po
   * złożeniu" i adres #5 trzeba było poprawiać w bazie. Wolno do chwili
   * zamówienia kuriera (NOWE / GOTOWE); przy auto-liście adres musi przejść
   * weryfikację GlobKuriera. Kuriera ponawia się potem „Ponów auto-list". */
  let weryfikacja = null;
  if (b.odbiorca && typeof b.odbiorca === 'object') {
    if (!['NOWE', 'GOTOWE'].includes(o.status)) return res.status(400).json({ ok: false, error: `odbiorcę można poprawić tylko przed zamówieniem kuriera (jest ${o.status})` });
    weryfikacja = sprawdzOdbiorce({ ...(o.odbiorca || {}), ...b.odbiorca });
    if (o.autoList && weryfikacja.bledy.length) return res.status(400).json({ ok: false, error: `Adres nie przejdzie w GlobKurier: ${weryfikacja.bledy.join('; ')}`, ...weryfikacja });
    data.odbiorca = weryfikacja.adres;
  }
  /* Przejścia statusów (audyt 14.10.2026): ANULOWANE z NOWE/GOTOWE/KURIER
   * (z GOTOWE i KURIER = COFNIECIE na stan; przy KURIER przesyłkę w GlobKurier
   * właściciel odwołuje sam, tu czyścimy jej numer), WYSLANE z KURIER,
   * NOWE z ANULOWANE (z wyzerowaniem kartonu/wagi/błędu kuriera). Zmiana
   * statusu i ruch stanu w JEDNEJ transakcji z warunkiem na stan wejściowy —
   * dwa równoległe kliknięcia nie zrobią dwóch ruchów. */
  let zwrotNaStan = false;
  if (b.status === 'ANULOWANE' && o.status !== 'ANULOWANE') {
    if (o.status === 'WYSLANE') return res.status(400).json({ ok: false, error: 'paczka już wysłana — nie da się anulować' });
    data.status = 'ANULOWANE';
    // Mail do magazynu zaplanowany na rano nie może wyjść o anulowanym zamówieniu.
    if (o.powiadomNa) Object.assign(data, { powiadomNa: null, powiadomNaKto: null, powiadomNaDo: null });
    zwrotNaStan = o.status === 'GOTOWE' || o.status === 'KURIER';
    if (o.status === 'KURIER') Object.assign(data, { gkHash: null, gkNumber: null, carrier: null, quoteId: null, kurierBlad: null });
  }
  if (b.status === 'WYSLANE') {
    if (o.status !== 'KURIER') return res.status(400).json({ ok: false, error: `„wysłane" tylko z „kurier zamówiony" (jest ${o.status})` });
    data.status = 'WYSLANE';
    if (!o.wyslanoAt) data.wyslanoAt = new Date();
  }
  if (b.status === 'NOWE' && o.status === 'ANULOWANE') {
    Object.assign(data, { status: 'NOWE', kartonNazwa: null, dlugoscCm: null, szerokoscCm: null, wysokoscCm: null, wagaKg: null, uwagiMagazynu: null, kurierBlad: null, gotoweAt: null, gotoweKto: null });
  }
  if (!Object.keys(data).length) return res.json({ ok: true, zamowienie: toPublic(o, rola(req)) });
  try {
    await prisma.$transaction(async (tx) => {
      const upd = await tx.warehouseOrder.updateMany({ where: { id: o.id, status: o.status }, data });
      if (upd.count !== 1) throw new Error('STAN_ZMIENIONY');
      if (zwrotNaStan) {
        await tx.stockMovement.createMany({
          data: linieDoStocku(o.items).map(i => ({ ean: i.ean, name: i.name, delta: i.qty, typ: 'COFNIECIE', orderId: o.id, kto: kto(req), uwaga: `anulowano #${o.numer} (było ${o.status})` })),
        });
      }
    });
  } catch (e) {
    if (e.message === 'STAN_ZMIENIONY') return res.status(409).json({ ok: false, error: 'zamówienie w międzyczasie zmieniło stan — odśwież listę' });
    throw e;
  }
  const u = await prisma.warehouseOrder.findUnique({ where: { id: o.id }, include: ORDER_INCLUDE });
  res.json({ ok: true, zamowienie: toPublic(u, rola(req)), ...(weryfikacja ? { adres: { poprawki: weryfikacja.poprawki, ostrzezenia: weryfikacja.ostrzezenia, bledy: weryfikacja.bledy } } : {}) });
}));

// Magazyn (i właściciel): paczka gotowa + karton + uwaga. Wydanie ze stanu.
router.post('/zamowienia/:id/gotowe', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const b = req.body || {};
  const o = await prisma.warehouseOrder.findUnique({ where: { id: req.params.id }, include: ORDER_INCLUDE });
  if (!o) return res.status(404).json({ ok: false, error: 'brak zamówienia' });
  if (o.status !== 'NOWE') return res.status(400).json({ ok: false, error: `zamówienie jest w stanie ${o.status}` });
  const d = parseInt(b.dlugoscCm, 10), s = parseInt(b.szerokoscCm, 10), h = parseInt(b.wysokoscCm, 10);
  if (!(d > 0 && s > 0 && h > 0)) return res.status(400).json({ ok: false, error: 'podaj wymiary kartonu (cm)' });
  // Waga: zważona przez magazyn ma pierwszeństwo; bez niej liczymy z pozycji
  // (+ waga wzorca kartonu, jeśli podano nazwę zapisanego kartonu).
  let w = b.wagaKg != null && b.wagaKg !== '' ? Number(String(b.wagaKg).replace(',', '.')) : null;
  if (!(w > 0)) {
    const wz = b.kartonNazwa ? await prisma.warehouseBox.findFirst({ where: { nazwa: String(b.kartonNazwa), aktywny: true } }).catch(() => null) : null;
    w = wagaZPozycji(o.items, wz ? Number(wz.wagaKg) : 0);
  }
  if (d > 175 || s > 175 || h > 175 || w > 50) return res.status(400).json({ ok: false, error: 'limit kuriera: 175 cm / 50 kg' });

  // Ostrzeżenie (nie blokada) o brakach wg CRM — magazyn widzi, że księgowy
  // stan nie zgadza się z półką, zanim paczka pojedzie.
  const ostrzezenia = [];
  try {
    const linie = linieDoStocku(o.items);
    const grupy = await prisma.stockMovement.groupBy({ by: ['ean'], where: { ean: { in: linie.map(i => i.ean) } }, _sum: { delta: true } });
    const stan = new Map(grupy.map(g => [g.ean, g._sum.delta || 0]));
    for (const i of linie) {
      const ma = stan.get(i.ean) || 0;
      if (ma < i.qty) ostrzezenia.push(`${i.symbol ? i.symbol + ' ' : ''}${i.name}${i.variant ? ' ' + i.variant : ''}: wg CRM na stanie ${ma}, zamówienie ${i.qty}`);
    }
  } catch (e) { console.warn('[magazyn] kontrola stanu nieudana:', e.message); }

  let u;
  try {
    u = await prisma.$transaction(async (tx) => {
      // Najpierw zmiana stanu z WARUNKIEM — drugie kliknięcie (druga karta,
      // ponowione żądanie po timeout) nie zrobi drugiego WYDANIA.
      const upd = await tx.warehouseOrder.updateMany({
        where: { id: o.id, status: 'NOWE' },
        data: {
          status: 'GOTOWE', gotoweAt: new Date(), gotoweKto: kto(req),
          kartonNazwa: b.kartonNazwa ? String(b.kartonNazwa).slice(0, 80) : null,
          dlugoscCm: d, szerokoscCm: s, wysokoscCm: h, wagaKg: w,
          uwagiMagazynu: b.uwagiMagazynu ? String(b.uwagiMagazynu).slice(0, 2000) : null,
        },
      });
      if (upd.count !== 1) throw new Error('STAN_ZMIENIONY');
      await tx.stockMovement.createMany({
        data: linieDoStocku(o.items).map(i => ({ ean: i.ean, name: i.name, delta: -i.qty, typ: 'WYDANIE', orderId: o.id, kto: kto(req), uwaga: `spakowano #${o.numer}` })),
      });
      return tx.warehouseOrder.findUnique({ where: { id: o.id }, include: ORDER_INCLUDE });
    });
  } catch (e) {
    if (e.message === 'STAN_ZMIENIONY') return res.status(409).json({ ok: false, error: 'to zamówienie zostało już spakowane (albo zmieniło stan) — odśwież listę' });
    throw e;
  }

  /* AUTO-LIST. Osobno od transakcji: „gotowe" i zejście ze stanu są faktem
     niezależnie od tego, czy kurier się uda. Błąd kuriera ląduje w kurierBlad
     i jest widoczny obu stronom — zamówienie zostaje GOTOWE, właściciel może
     zamówić ręcznie i podpiąć. */
  let wynik = u;
  // Kurier zamówiony z góry (list podpięty do nowego zamówienia): paczka
  // spakowana = czeka już tylko na kuriera, niczego nie trzeba zamawiać.
  if (!u.autoList && (u.gkNumber || u.gkHash)) {
    wynik = await prisma.warehouseOrder.update({
      where: { id: u.id },
      data: { status: 'KURIER', kurierBlad: null, zatwierdzonoAt: new Date() },
      include: ORDER_INCLUDE,
    });
  }
  if (u.autoList) {
    const startAutoListu = Date.now();
    try {
      const k = await zamowKuriera(u, prisma);
      wynik = await prisma.warehouseOrder.update({ where: { id: u.id }, data: daneKuriera(k, 'auto-list'), include: ORDER_INCLUDE });
    } catch (e) {
      console.error(`[magazyn] auto-list #${u.numer} padł:`, e.message);
      const blad = String(e.message).slice(0, 500);
      const rodzaj = rodzajBledu(blad);
      // Brak środków, bezpiecznik ceny i błędy ustawień: od razu do właściciela.
      // Reszta: model próbuje naprawić i zamówić; Telegram dopiero z wynikiem.
      const naprawiam = rodzaj === 'naprawialny' && naprawaWlaczona();
      wynik = await prisma.warehouseOrder.update({
        where: { id: u.id },
        data: { kurierBlad: blad, ...(naprawiam ? { kurierNaprawa: { stan: 'w-toku', od: new Date().toISOString() } } : {}) },
        include: ORDER_INCLUDE,
      });
      // e.niepewne: GK nie odpowiedział przy zamawianiu — naprawa najpierw
      // sprawdzi, czy zlecenie nie powstało, zanim zamówi ponownie.
      if (naprawiam) uruchomNaprawe(prisma, u.id, blad, { niepewneOd: e.niepewne ? startAutoListu : null });
      else await alarmWlasciciela(prisma, [tekstBezNaprawy(u, blad, rodzaj), e.niepewne ? UWAGA_NIEPEWNE : null].filter(Boolean).join('\n'));
    }
  }
  res.json({ ok: true, zamowienie: toPublic(wynik, rola(req)), ostrzezenia });
}));

// Właściciel podpina wysyłkę zamówioną RĘCZNIE w Wysyłkach (numer GK albo hash).
// Też: ponowna próba auto-listu po naprawieniu przyczyny (body.autoList=true).
router.post('/zamowienia/:id/kurier', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const prisma = req.app.locals.prisma;
  const b = req.body || {};
  const o = await prisma.warehouseOrder.findUnique({ where: { id: req.params.id }, include: ORDER_INCLUDE });
  if (!o) return res.status(404).json({ ok: false, error: 'brak zamówienia' });
  /* LIST PRZEWOZOWY JUŻ JEST (16.11.2026). Super-Pharm: kurier zamówiony
     z wyprzedzeniem pod awizację, list leży w CRM — a system pozwalał go
     podpiąć dopiero PO spakowaniu, więc magazyn pakował bez listu i widział
     „czeka na zamówienie kuriera". Teraz gotowy list podpina się też do
     zamówienia NOWE: magazyn ma go od razu, a „Paczka gotowa" przechodzi
     prosto do „kurier zamówiony". Auto-list nadal tylko po spakowaniu. */
  if (naprawaTrwa(o) || _naprawyWToku.has(o.id)) return res.status(409).json({ ok: false, error: 'Trwa automatyczna naprawa zamówienia kuriera — poczekaj minutę i odśwież, żeby nie zamówić dwóch kurierów.' });
  const przedSpakowaniem = o.status === 'NOWE' && !b.autoList;
  if (o.status !== 'GOTOWE' && !przedSpakowaniem) return res.status(400).json({ ok: false, error: `zamówienie jest w stanie ${o.status} — kuriera zamawia się do spakowanej paczki (gotowy list można podpiąć też do nowego zamówienia)` });
  if (przedSpakowaniem && o.autoList) return res.status(400).json({ ok: false, error: 'to zamówienie ma auto-list — kurier zamówi się sam po spakowaniu; gotowego listu nie podpinamy' });
  let data;
  let podpieteZListy = false;
  if (b.autoList) {
    const braki = brakiOdbiorcy(o.odbiorca);
    if (braki.length) return res.status(400).json({ ok: false, error: `brak danych odbiorcy: ${braki.join(', ')}` });
    try {
      // Poprzednia próba skończyła się niepewnie (GK nie odpowiedział przy
      // zamawianiu)? Zanim zamówimy drugi raz — czy zlecenie nie powstało.
      let k = null;
      if (niepewnyZapisany(o.kurierBlad) || (o.kurierNaprawa && o.kurierNaprawa.niepewne)) {
        const odKiedy = new Date(o.gotoweAt || Date.now() - 24 * 3600 * 1000).getTime();
        try { k = await swiezeZlecenieGk(prisma, o, odKiedy); }
        catch (e) { return res.status(502).json({ ok: false, error: `Poprzednia próba mogła utworzyć zlecenie, a listy zleceń GlobKurier nie da się teraz sprawdzić (${e.message}). Spróbuj za chwilę albo podepnij numer GK ręcznie — nie zamawiam w ciemno drugiego kuriera.` }); }
        if (k) podpieteZListy = true;
      }
      // bezLimitu: właściciel widział cenę wyższą od szacunku i potwierdził.
      if (!k) k = await zamowKuriera(o, prisma, { bezLimitu: b.bezLimitu === true });
      data = daneKuriera(k, kto(req));
    } catch (e) {
      await prisma.warehouseOrder.update({ where: { id: o.id }, data: { kurierBlad: String(e.message).slice(0, 500) } });
      return res.status(502).json({ ok: false, error: e.message });
    }
  } else {
    const gkNumber = b.gkNumber ? String(b.gkNumber).trim() : '';
    let gkHash = b.gkHash ? String(b.gkHash).trim() : '';
    let carrierZnaleziony = null;
    if (!gkNumber && !gkHash) return res.status(400).json({ ok: false, error: 'podaj numer zamówienia GK albo hash' });
    /* 14.10.2026: sam numer GK nie dawał magazynowi listu (etykieta idzie po
     * hashu). Dociągamy hash z ostatnich zamówień GK — jak /send-label. Gdy GK
     * nie odpowie, podpinamy po numerze jak dotąd, a list wgrywa się jako PDF. */
    if (gkNumber && !gkHash) {
      try {
        const { fetchOrdersPaged, findOrderInList } = require('../glob-client');
        const found = findOrderInList(await fetchOrdersPaged(3), gkNumber);
        if (found) {
          gkHash = String(found.hash || found.orderHash || '').trim();
          const c = found.carrier; carrierZnaleziony = (c && typeof c === 'object') ? (c.name || null) : (c || null);
        }
      } catch (e) { console.warn(`[magazyn] hash po numerze ${gkNumber} nieznaleziony:`, e.message); }
    }
    data = { status: 'KURIER', gkHash: gkHash || null, gkNumber: gkNumber || null, carrier: b.carrier ? String(b.carrier).slice(0, 60) : (carrierZnaleziony ? String(carrierZnaleziony).slice(0, 60) : null), kurierBlad: null, zatwierdzilKto: kto(req), zatwierdzonoAt: new Date() };
    // Przed spakowaniem zapisujemy sam list — status zmieni „Paczka gotowa".
    if (przedSpakowaniem) { delete data.status; delete data.zatwierdzonoAt; }
  }
  const u = await prisma.warehouseOrder.update({ where: { id: o.id }, data, include: ORDER_INCLUDE });
  res.json({ ok: true, zamowienie: toPublic(u, rola(req)), ...(podpieteZListy ? { uwaga: `Zlecenie ${u.gkNumber || ''} powstało już przy poprzedniej próbie — podpięte, drugiego kuriera nie zamawiałem.` } : {}) });
}));

/* Ręczne uruchomienie naprawy (właściciel) i PRÓBA.
 * {proba:true, blad?, odbiorca?} — prawdziwy model, ale narzędzia pracują na
 * kopii zamówienia w pamięci i z atrapą GlobKuriera: nic się nie zapisuje i
 * żaden kurier nie jest zamawiany. Do sprawdzenia modelu po wdrożeniu. */
router.post('/zamowienia/:id/napraw-kuriera', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const prisma = req.app.locals.prisma;
  const b = req.body || {};
  const o = await prisma.warehouseOrder.findUnique({ where: { id: req.params.id }, include: ORDER_INCLUDE });
  if (!o) return res.status(404).json({ ok: false, error: 'brak zamówienia' });
  if (b.proba) {
    const kopia = { ...o, status: 'GOTOWE', gkNumber: null, gkHash: null, odbiorca: { ...(o.odbiorca || {}), ...czystePola(b.odbiorca) } };
    const blad = String(b.blad || o.kurierBlad || 'zamówienie: Pole „nazwa” odbiorcy odrzucone przez GK: "Wpisano nieprawidłowy znak proszę o weryfikację np.: . , ” ” % & + ( ) / [] ;!".').slice(0, 500);
    const rodzaj = rodzajBledu(blad);
    // Błąd, którego model nie dostaje: pokazujemy, co poszłoby na Telegram (nic nie wysyłamy).
    if (rodzaj !== 'naprawialny') return res.json({ ok: true, proba: true, rodzajBledu: rodzaj, model: null, telegram: tekstBezNaprawy(kopia, blad, rodzaj) });
    if (!naprawaWlaczona()) return res.status(503).json({ ok: false, error: 'automatyczna naprawa jest wyłączona (brak ANTHROPIC_API_KEY albo KURIER_NAPRAWA=0)' });
    const proba = { o: kopia, zamow: atrapaGk(blad) };
    const w = await naprawKuriera({ zamowienie: daneDlaModelu(kopia), blad, narzedzia: narzedziaNaprawy(prisma, o.id, { proba }) });
    return res.json({ ok: true, proba: true, rodzajBledu: rodzaj, odbiorcaPrzed: kopia.odbiorca, odbiorcaPo: proba.o.odbiorca, wynik: w });
  }
  if (!naprawaWlaczona()) return res.status(503).json({ ok: false, error: 'automatyczna naprawa jest wyłączona (brak ANTHROPIC_API_KEY albo KURIER_NAPRAWA=0)' });
  if (o.status !== 'GOTOWE' || o.gkNumber || o.gkHash) return res.status(400).json({ ok: false, error: `naprawa dotyczy spakowanej paczki bez kuriera (jest ${o.status}${o.gkNumber ? `, kurier ${o.gkNumber}` : ''})` });
  if (naprawaTrwa(o) || _naprawyWToku.has(o.id)) return res.status(409).json({ ok: false, error: 'naprawa już trwa — odśwież za chwilę' });
  const blad = String(o.kurierBlad || 'kurier nie został zamówiony').slice(0, 500);
  const rodzaj = rodzajBledu(blad);
  if (rodzaj !== 'naprawialny') return res.status(400).json({ ok: false, error: rodzaj === 'brak-srodkow' ? 'to brak środków w GlobKurier — doładuj konto i ponów auto-list' : rodzaj === 'cena' ? 'to bezpiecznik ceny — zdecyduj sam („Zamów mimo to”)' : 'to błąd ustawień, nie adresu — naprawa automatyczna tu nie pomoże' });
  const u = await prisma.warehouseOrder.update({ where: { id: o.id }, data: { kurierNaprawa: { stan: 'w-toku', od: new Date().toISOString() } }, include: ORDER_INCLUDE });
  const niepewne = niepewnyZapisany(o.kurierBlad) || !!(o.kurierNaprawa && o.kurierNaprawa.niepewne);
  uruchomNaprawe(prisma, o.id, blad, { niepewneOd: niepewne ? new Date(o.gotoweAt || Date.now() - 24 * 3600 * 1000).getTime() : null });
  res.json({ ok: true, uruchomiono: true, zamowienie: toPublic(u, rola(req)) });
}));

// Etykieta dla OBU stron — ale tylko przez zamówienie, do którego należy.
// /api/glob/labels/:hash serwuje etykietę każdej paczki po samym hashu i jest
// poza zasięgiem roli magazyn; tu hash bierze się z bazy, nie z URL.
router.get('/zamowienia/:id/etykieta', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const o = await prisma.warehouseOrder.findUnique({ where: { id: req.params.id } });
  if (!o) return res.status(404).json({ ok: false, error: 'brak zamówienia' });
  if (!o.gkHash) return res.status(404).json({ ok: false, error: 'to zamówienie nie ma jeszcze listu przewozowego' });
  const result = await getOrderLabels(o.gkHash, 'A4');
  if (result.status !== 200) return res.status(502).json({ ok: false, error: `GK nie oddał etykiety (HTTP ${result.status})` });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="list-${o.numer}.pdf"`);
  res.send(result.body);
}));

/* DRUK ZAMÓWIENIA (26.10.2026): PDF z tabelą pozycji do odhaczania — guzik
 * „Drukuj zamówienie" na zwiniętym zamówieniu, obie role. Treść jak w panelu
 * magazynu (toPublic 'magazyn'), więc i właściciel drukuje to, co widzi
 * magazyn. */
router.get('/zamowienia/:id/pdf', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const o = await prisma.warehouseOrder.findUnique({ where: { id: req.params.id }, include: ORDER_INCLUDE });
  if (!o) return res.status(404).json({ ok: false, error: 'brak zamówienia' });
  const pdf = await pdfZamowienia(toPublic(o, 'magazyn'));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="zamowienie-${o.numer}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(pdf);
}));

/* POWIADOM MAGAZYN (26.10.2026): mail z naszej skrzynki delivery@ do magazynu
 * (domyślnie m.urbaniak@bell.com.pl) — „nowe zamówienie", treść zamówienia,
 * w załączniku PDF zamówienia do wydruku i dokumenty do paczki. Tylko
 * właściciel. Drugi raz tylko świadomie ({ponownie:true}) — inaczej 409 z datą
 * pierwszej wysyłki. {podglad:true} = temat, treść i załączniki BEZ wysyłki. */
const MAGAZYN_MAIL_OD = () => (process.env.MAGAZYN_MAIL_OD || 'delivery@surfstickbell.com').trim();
const MAGAZYN_MAIL_DO = () => (process.env.MAGAZYN_MAIL_DO || 'm.urbaniak@bell.com.pl').trim();
/** Temat, treść i załączniki maila do magazynu dla zamówienia `o`. */
async function trescPowiadomienia(prisma, o) {
  const z = toPublic(o, 'magazyn');
  // Gotowy list przewozowy (kurier zamówiony z góry) idzie w mailu razem
  // z zamówieniem — magazyn drukuje wszystko z jednej wiadomości.
  let list = null;
  if (o.gkHash) {
    try {
      const r = await getOrderLabels(o.gkHash, 'A4');
      if (r.status === 200 && r.body && r.body.length) list = { filename: `list-przewozowy-${o.gkNumber || o.numer}.pdf`, content: r.body, contentType: 'application/pdf' };
    } catch (e) { console.warn(`[magazyn] list do maila #${o.numer} niedostępny:`, e.message); }
  }
  z.listWZalaczniku = !!list;
  const { subject, text, html } = trescMaila(z);
  const zalaczniki = [{ filename: `zamowienie-${o.numer}.pdf`, content: await pdfZamowienia(z), contentType: 'application/pdf' }];
  if (list) zalaczniki.push(list);
  const docs = await prisma.warehouseOrderDoc.findMany({ where: { orderId: o.id }, orderBy: { createdAt: 'asc' }, select: { filename: true, contentType: true, data: true } });
  for (const d of docs) zalaczniki.push({ filename: d.filename, content: Buffer.from(d.data), contentType: d.contentType || 'application/pdf' });
  return { od: MAGAZYN_MAIL_OD(), subject, text, html, zalaczniki, opisZal: zalaczniki.map(a => ({ filename: a.filename, size: a.content.length })) };
}

/** Wysyła mail do magazynu i zapisuje kiedy/kto/dokąd (kasuje też plan, jeśli był).
 *  Rzuca, gdy mail nie wyjdzie — wtedy w bazie nic się nie zmienia. */
async function wyslijPowiadomienie(prisma, o, { doKogo, kto: ktoWyslal }) {
  const m = await trescPowiadomienia(prisma, o);
  await require('../mail-sender').sendMail({ from: m.od, to: doKogo, subject: m.subject, body: m.text, html: m.html, attachments: m.zalaczniki });
  const u = await prisma.warehouseOrder.update({
    where: { id: o.id },
    data: { powiadomionoAt: new Date(), powiadomilKto: ktoWyslal, powiadomionoDo: doKogo, powiadomNa: null, powiadomNaKto: null, powiadomNaDo: null, powiadomProby: 0, powiadomBlad: null },
    include: ORDER_INCLUDE,
  });
  console.log(`[magazyn] powiadomiono magazyn o #${o.numer} (${m.zalaczniki.length} zał.)`);
  return { zamowienie: u, od: m.od, opisZal: m.opisZal };
}

// Zegar do podmiany w testach (reguła godzin zależy od pory dnia i dnia tygodnia).
let _zegar = () => new Date();

/* POZA GODZINAMI PRACY MAGAZYNU (22.11.2026): kliknięcie w weekend, po 16:00
 * albo przed 8:00 nie wysyła maila — zapisuje plan (`powiadomNa`), a cykl
 * `wyslijZaplanowanePowiadomienia` wysyła go o 8:00 najbliższego dnia roboczego
 * z treścią aktualną w chwili wysyłki. {teraz:true} wysyła od razu (świadoma
 * decyzja właściciela), {anulujPlan:true} kasuje plan. */
router.post('/zamowienia/:id/powiadom', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const prisma = req.app.locals.prisma;
  const b = req.body || {};
  const o = await prisma.warehouseOrder.findUnique({ where: { id: req.params.id }, include: ORDER_INCLUDE });
  if (!o) return res.status(404).json({ ok: false, error: 'brak zamówienia' });
  if (b.anulujPlan) {
    if (!o.powiadomNa) return res.status(400).json({ ok: false, error: 'dla tego zamówienia nie ma zaplanowanego maila do magazynu' });
    const u = await prisma.warehouseOrder.update({ where: { id: o.id }, data: { powiadomNa: null, powiadomNaKto: null, powiadomNaDo: null }, include: ORDER_INCLUDE });
    return res.json({ ok: true, planAnulowany: true, zamowienie: toPublic(u, rola(req)) });
  }
  if (o.status === 'ANULOWANE') return res.status(400).json({ ok: false, error: `zamówienie #${o.numer} jest anulowane — nie powiadamiam magazynu` });
  const doKogo = b.do ? String(b.do).trim() : MAGAZYN_MAIL_DO();
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(doKogo)) return res.status(400).json({ ok: false, error: `zły adres e-mail: ${doKogo}` });
  if (o.powiadomionoAt && !b.ponownie && !b.podglad) {
    const kiedy = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'short', timeStyle: 'short' }).format(o.powiadomionoAt);
    return res.status(409).json({ ok: false, juzPowiadomiono: true, powiadomionoAt: o.powiadomionoAt, error: `Magazyn powiadomiony już ${kiedy} (${o.powiadomionoDo || 'magazyn'}). Wyślij ponownie tylko, jeśli trzeba.` });
  }
  const termin = b.teraz === true ? { odRazu: true } : kiedyPowiadomic(_zegar());
  if (b.podglad) {
    const m = await trescPowiadomienia(prisma, o);
    return res.json({ ok: true, podglad: true, od: m.od, do: doKogo, temat: m.subject, tresc: m.text, zalaczniki: m.opisZal, wysylka: termin.odRazu ? 'od razu' : termin.opis });
  }
  if (!termin.odRazu) {
    const u = await prisma.warehouseOrder.update({
      where: { id: o.id },
      data: { powiadomNa: termin.kiedy, powiadomNaKto: kto(req), powiadomNaDo: doKogo, powiadomProby: 0, powiadomBlad: null },
      include: ORDER_INCLUDE,
    });
    console.log(`[magazyn] powiadomienie o #${o.numer} zaplanowane na ${termin.kiedy.toISOString()} (${termin.powod})`);
    return res.json({
      ok: true, zaplanowano: true, kiedy: termin.kiedy, opis: termin.opis, powod: termin.powod, do: doKogo, zamowienie: toPublic(u, rola(req)),
      komunikat: `Magazyn dostanie maila ${termin.opis} — teraz jest poza godzinami pracy magazynu (${termin.powod}).`,
    });
  }
  let w;
  try { w = await wyslijPowiadomienie(prisma, o, { doKogo, kto: kto(req) }); }
  catch (e) {
    console.error(`[magazyn] powiadomienie #${o.numer} nieudane:`, e.message);
    return res.status(502).json({ ok: false, error: `Mail do magazynu nie wyszedł: ${e.message}` });
  }
  res.json({ ok: true, zamowienie: toPublic(w.zamowienie, rola(req)), wyslano: { od: w.od, do: doKogo, zalaczniki: w.opisZal } });
}));

/** Cykl (index.js, co minutę): wysyła maile do magazynu zaplanowane na teraz
 *  lub wcześniej. Każde zamówienie jest najpierw „zajmowane" warunkowym zapisem,
 *  żeby dwa przebiegi nie wysłały tego samego maila. Błąd wysyłki → ponowienie
 *  za 5 minut, po trzech próbach alarm do właściciela. */
const POWIADOM_PROBY = 3;
async function wyslijZaplanowanePowiadomienia(prisma, teraz = _zegar()) {
  const lista = await prisma.warehouseOrder.findMany({ where: { powiadomNa: { lte: teraz } }, include: ORDER_INCLUDE, orderBy: { powiadomNa: 'asc' }, take: 20 });
  let wyslane = 0;
  for (const o of lista) {
    const zajete = await prisma.warehouseOrder.updateMany({ where: { id: o.id, powiadomNa: o.powiadomNa }, data: { powiadomNa: null } });
    if (zajete.count !== 1) continue; // wziął to inny przebieg albo plan zmieniono
    // Zamówienie anulowane albo już wysłane do klienta — „nowe zamówienie" nie ma sensu.
    if (!['NOWE', 'GOTOWE', 'KURIER'].includes(o.status)) {
      await prisma.warehouseOrder.update({ where: { id: o.id }, data: { powiadomNaKto: null, powiadomNaDo: null } });
      console.log(`[magazyn] zaplanowane powiadomienie o #${o.numer} pominięte (status ${o.status})`);
      continue;
    }
    const doKogo = o.powiadomNaDo || MAGAZYN_MAIL_DO();
    try {
      await wyslijPowiadomienie(prisma, o, { doKogo, kto: o.powiadomNaKto || 'plan' });
      wyslane++;
    } catch (e) {
      const proby = (o.powiadomProby || 0) + 1;
      const blad = String(e.message).slice(0, 300);
      console.error(`[magazyn] zaplanowane powiadomienie o #${o.numer} nieudane (próba ${proby}/${POWIADOM_PROBY}):`, blad);
      if (proby >= POWIADOM_PROBY) {
        await prisma.warehouseOrder.update({ where: { id: o.id }, data: { powiadomProby: proby, powiadomBlad: blad, powiadomNaKto: null, powiadomNaDo: null } });
        await alarmWlasciciela(prisma, `✉️ Magazyn #${o.numer} (${ktoGdzie(o)}): zaplanowany mail do magazynu NIE wyszedł (${proby} próby).\nBłąd: ${blad}\nKliknij „Powiadom magazyn” przy zamówieniu jeszcze raz.`);
      } else {
        await prisma.warehouseOrder.update({ where: { id: o.id }, data: { powiadomNa: new Date(teraz.getTime() + 5 * 60 * 1000), powiadomProby: proby, powiadomBlad: blad } });
      }
    }
  }
  return wyslane;
}

/* DOKUMENTY DO PACZKI (14.10.2026). Super-Pharm (i nie tylko) wymaga WZ/FV
 * w kartonie, a pakuje magazyn zewnętrzny — więc nasz PDF musi być przy
 * zamówieniu, a magazyn ma go wydrukować. Upload: tylko właściciel, base64 w
 * JSON (konwencja repo), PDF albo obraz, do 8 MB. Odczyt: obie role (magazyn
 * widzi tylko dokumenty przy zamówieniu, które i tak ma na liście). */
const DOC_MAX_B = 8 * 1024 * 1024;
const DOC_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
router.post('/zamowienia/:id/dokumenty', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const prisma = req.app.locals.prisma;
  const o = await prisma.warehouseOrder.findUnique({ where: { id: req.params.id }, select: { id: true, numer: true } });
  if (!o) return res.status(404).json({ ok: false, error: 'brak zamówienia' });
  const b = req.body || {};
  const b64 = String(b.dataBase64 || b.data || '').replace(/^data:[^;]+;base64,/, '');
  if (!b64) return res.status(400).json({ ok: false, error: 'brak pliku (dataBase64)' });
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch (_) { return res.status(400).json({ ok: false, error: 'zły base64' }); }
  if (!buf.length) return res.status(400).json({ ok: false, error: 'pusty plik' });
  if (buf.length > DOC_MAX_B) return res.status(413).json({ ok: false, error: `plik za duży (${Math.round(buf.length / 1024 / 1024)} MB, max 8 MB)` });
  const filename = String(b.filename || 'dokument.pdf').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
  let contentType = String(b.contentType || '').toLowerCase();
  if (!DOC_TYPES.includes(contentType)) contentType = /\.png$/i.test(filename) ? 'image/png' : /\.jpe?g$/i.test(filename) ? 'image/jpeg' : 'application/pdf';
  if (contentType === 'application/pdf' && buf.slice(0, 5).toString() !== '%PDF-') return res.status(400).json({ ok: false, error: 'to nie jest PDF' });
  if (contentType === 'image/png' && buf.slice(0, 4).toString('hex') !== '89504e47') return res.status(400).json({ ok: false, error: 'to nie jest PNG' });
  if (contentType === 'image/jpeg' && buf.slice(0, 3).toString('hex') !== 'ffd8ff') return res.status(400).json({ ok: false, error: 'to nie jest JPEG' });
  if ((await prisma.warehouseOrderDoc.count({ where: { orderId: o.id } })) >= 10) return res.status(400).json({ ok: false, error: 'max 10 dokumentów przy zamówieniu' });
  await prisma.warehouseOrderDoc.create({ data: { orderId: o.id, filename, contentType, size: buf.length, data: buf, opis: b.opis ? String(b.opis).slice(0, 120) : null, dodal: kto(req) } });
  const u = await prisma.warehouseOrder.findUnique({ where: { id: o.id }, include: ORDER_INCLUDE });
  res.json({ ok: true, zamowienie: toPublic(u, rola(req)) });
}));

router.get('/zamowienia/:id/dokumenty/:docId', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const d = await prisma.warehouseOrderDoc.findFirst({ where: { id: req.params.docId, orderId: req.params.id } });
  if (!d) return res.status(404).json({ ok: false, error: 'brak dokumentu' });
  res.setHeader('Content-Type', d.contentType || 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(d.filename)}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(Buffer.from(d.data));
}));

router.delete('/zamowienia/:id/dokumenty/:docId', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const prisma = req.app.locals.prisma;
  const r = await prisma.warehouseOrderDoc.deleteMany({ where: { id: req.params.docId, orderId: req.params.id } });
  if (!r.count) return res.status(404).json({ ok: false, error: 'brak dokumentu' });
  const u = await prisma.warehouseOrder.findUnique({ where: { id: req.params.id }, include: ORDER_INCLUDE });
  res.json({ ok: true, zamowienie: toPublic(u, rola(req)) });
}));

// Właściciel: odśwież statusy z GlobKurier od razu (bez czekania na cykl 30 min).
router.post('/zamowienia/odswiez-statusy', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const { odswiezStatusyMagazynu } = require('../services/magazyn-statusy');
  const r = await odswiezStatusyMagazynu(req.app.locals.prisma, { force: true });
  res.json({ ok: true, ...r });
}));

// Właściciel cofa „gotowe" (np. magazyn się pomylił) — ruch odwrotny.
router.post('/zamowienia/:id/cofnij-gotowe', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const prisma = req.app.locals.prisma;
  const o = await prisma.warehouseOrder.findUnique({ where: { id: req.params.id }, include: ORDER_INCLUDE });
  if (!o) return res.status(404).json({ ok: false, error: 'brak zamówienia' });
  if (o.status !== 'GOTOWE') return res.status(400).json({ ok: false, error: `zamówienie jest w stanie ${o.status}` });
  // Naprawa może właśnie zamawiać kuriera — cofnięcie w tej chwili zostawiłoby zlecenie bez paczki.
  if (naprawaTrwa(o) || _naprawyWToku.has(o.id)) return res.status(409).json({ ok: false, error: 'Trwa automatyczne zamawianie kuriera — poczekaj minutę i odśwież.' });
  let u;
  try {
    u = await prisma.$transaction(async (tx) => {
      const upd = await tx.warehouseOrder.updateMany({
        where: { id: o.id, status: 'GOTOWE' },
        data: { status: 'NOWE', gotoweAt: null, gotoweKto: null, kartonNazwa: null, dlugoscCm: null, szerokoscCm: null, wysokoscCm: null, wagaKg: null, uwagiMagazynu: null, kurierBlad: null },
      });
      if (upd.count !== 1) throw new Error('STAN_ZMIENIONY');
      await tx.stockMovement.createMany({
        data: linieDoStocku(o.items).map(i => ({ ean: i.ean, name: i.name, delta: i.qty, typ: 'COFNIECIE', orderId: o.id, kto: kto(req), uwaga: `cofnięto gotowe #${o.numer}` })),
      });
      return tx.warehouseOrder.findUnique({ where: { id: o.id }, include: ORDER_INCLUDE });
    });
  } catch (e) {
    if (e.message === 'STAN_ZMIENIONY') return res.status(409).json({ ok: false, error: 'zamówienie w międzyczasie zmieniło stan — odśwież listę' });
    throw e;
  }
  res.json({ ok: true, zamowienie: toPublic(u, rola(req)) });
}));

// ---------- STOCK ----------

router.get('/stan', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const [grupy, catalog] = await Promise.all([
    prisma.stockMovement.groupBy({ by: ['ean'], _sum: { delta: true } }),
    getActiveCatalog(prisma),
  ]);
  const byEan = new Map(catalog.map(p => [p.ean, p]));
  const nazwy = new Map();
  const ostatnie = await prisma.stockMovement.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  for (const m of ostatnie) if (!nazwy.has(m.ean)) nazwy.set(m.ean, m.name);
  const stan = grupy.map(g => {
    const p = byEan.get(g.ean);
    return {
      ean: g.ean,
      name: p ? p.name : (g.ean === EKSPOZYTOR.ean ? EKSPOZYTOR.name : (nazwy.get(g.ean) || g.ean)),
      variant: p ? p.variant : null,
      symbol: symbolZ(p),
      ilosc: g._sum.delta || 0,
    };
  }).sort((a, b) => (a.name + (a.variant || '')).localeCompare(b.name + (b.variant || ''), 'pl'));
  // Magazyn widzi stan (po kodach szuka towaru na półce), ale nie historię
  // ruchów — w niej są loginy i uwagi właściciela (14.10.2026).
  const ruchy = rola(req) === 'magazyn' ? [] : ostatnie.map(m => ({ id: m.id, ean: m.ean, name: m.name, delta: m.delta, typ: m.typ, orderId: m.orderId, uwaga: m.uwaga, kto: m.kto, createdAt: m.createdAt }));
  res.json({ ok: true, stan, ruchy });
}));

// Właściciel: przyjęcie / korekta. items: [{ean, qty}] (qty może być ujemne przy korekcie).
router.post('/stan/ruch', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const prisma = req.app.locals.prisma;
  const b = req.body || {};
  const typ = b.typ === 'KOREKTA' ? 'KOREKTA' : 'PRZYJECIE';
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return res.status(400).json({ ok: false, error: 'brak pozycji' });
  const catalog = await getActiveCatalog(prisma);
  const byEan = new Map(catalog.map(p => [p.ean, p]));
  const data = [];
  for (const it of items) {
    const ean = String(it.ean || '').trim();
    const qty = Number(String(it.qty ?? '').trim());
    if (!ean || !Number.isInteger(qty) || qty === 0 || Math.abs(qty) > 100000) return res.status(400).json({ ok: false, error: `zła ilość przy ${ean || '(brak EAN)'} — liczba całkowita, nie zero` });
    if (typ === 'PRZYJECIE' && qty < 0) return res.status(400).json({ ok: false, error: 'przyjęcie nie może być ujemne — użyj korekty' });
    const p = byEan.get(ean);
    const name = p ? [p.name, p.variant].filter(Boolean).join(' ') : (ean === EKSPOZYTOR.ean ? EKSPOZYTOR.name : null);
    if (!name) return res.status(400).json({ ok: false, error: `nieznany produkt ${ean}` });
    if (p && Array.isArray(p.extras && p.extras.composition)) return res.status(400).json({ ok: false, error: `${p.name}: stock przyjmuj po kolorach, nie boxami` });
    data.push({ ean, name, delta: qty, typ, kto: kto(req), uwaga: b.uwaga ? String(b.uwaga).slice(0, 500) : null });
  }
  if (!data.length) return res.status(400).json({ ok: false, error: 'brak poprawnych pozycji' });
  await prisma.stockMovement.createMany({ data });
  res.json({ ok: true, dodano: data.length });
}));

// ---------- KARTONY ----------

router.get('/kartony', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const rows = await prisma.warehouseBox.findMany({ where: { aktywny: true }, orderBy: { createdAt: 'asc' } });
  res.json({ ok: true, kartony: rows.map(k => ({ id: k.id, nazwa: k.nazwa, dlugoscCm: k.dlugoscCm, szerokoscCm: k.szerokoscCm, wysokoscCm: k.wysokoscCm, wagaKg: Number(k.wagaKg) })) });
}));

// Magazyn i właściciel mogą dodać karton „na przyszłość".
router.post('/kartony', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const b = req.body || {};
  const d = parseInt(b.dlugoscCm, 10), s = parseInt(b.szerokoscCm, 10), h = parseInt(b.wysokoscCm, 10);
  const w = Number(String(b.wagaKg ?? '').replace(',', '.'));
  if (!(d > 0 && s > 0 && h > 0)) return res.status(400).json({ ok: false, error: 'podaj wymiary (cm)' });
  const nazwa = String(b.nazwa || `${d}×${s}×${h}`).slice(0, 80);
  const k = await prisma.warehouseBox.create({ data: { nazwa, dlugoscCm: d, szerokoscCm: s, wysokoscCm: h, wagaKg: Number.isFinite(w) && w > 0 ? w : 0 } });
  res.json({ ok: true, karton: { id: k.id, nazwa: k.nazwa, dlugoscCm: k.dlugoscCm, szerokoscCm: k.szerokoscCm, wysokoscCm: k.wysokoscCm, wagaKg: Number(k.wagaKg) } });
}));

router.delete('/kartony/:id', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return; // magazyn może dodawać kartony, usuwać tylko my
  const prisma = req.app.locals.prisma;
  await prisma.warehouseBox.update({ where: { id: req.params.id }, data: { aktywny: false } });
  res.json({ ok: true });
}));

// Katalog dla formularza właściciela (bez cen — ten sam obiekt trafia do widoku).
router.get('/katalog', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const catalog = await getActiveCatalog(req.app.locals.prisma);
  res.json({ ok: true, produkty: catalog.map(p => ({ ean: p.ean, name: p.name, variant: p.variant, category: p.category, extras: p.extras })) });
}));

module.exports = router;
module.exports.posprzatajPrzerwaneNaprawy = posprzatajPrzerwaneNaprawy;
module.exports.wyslijZaplanowanePowiadomienia = wyslijZaplanowanePowiadomienia;
module.exports._test = { naprawWTle, narzedziaNaprawy, swiezeZlecenieGk, czasGkNaMs, niepewnyBlad, niepewnyZapisany, atrapaGk, _naprawyWToku, brakiTowaru, tekstBrakowTowaru, etykietaTowaru, ustawZegar: (f) => { _zegar = f || (() => new Date()); } };
