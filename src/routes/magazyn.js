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
    gkHash: o.gkHash, gkNumber: o.gkNumber, carrier: o.carrier,
    utworzyl: obcy && o.utworzyl ? 'Surf Stick' : o.utworzyl, gotoweKto: o.gotoweKto, zatwierdzilKto: obcy && o.zatwierdzilKto && o.zatwierdzilKto !== 'auto-list' ? 'Surf Stick' : o.zatwierdzilKto,
    createdAt: o.createdAt, gotoweAt: o.gotoweAt, zatwierdzonoAt: o.zatwierdzonoAt,
    gkStatus: o.gkStatus || null, gkStatusAt: o.gkStatusAt || null, wyslanoAt: o.wyslanoAt || null, dostarczonoAt: o.dostarczonoAt || null, ostatnieZdarzenie: o.ostatnieZdarzenie || null,
    powiadomionoAt: o.powiadomionoAt || null, powiadomilKto: obcy ? null : (o.powiadomilKto || null), powiadomionoDo: obcy ? null : (o.powiadomionoDo || null),
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

async function zamowKuriera(o, prisma) {
  const nadawca = await nadawcaMagazynu(prisma);
  const od = o.odbiorca || {};
  const q = await selfCall('POST', '/api/glob/quote', {
    ...(nadawca.senderId ? { senderId: nadawca.senderId } : { senderSearch: nadawca.senderSearch }),
    receiverSearch: od.name,
    deliveryAddress: {
      street: od.street, houseNumber: od.houseNumber || null, apartmentNumber: od.apartmentNumber || null,
      postCode: od.postCode, city: od.city, country: od.country || 'PL', phone: od.phone || null, email: od.email || null,
    },
    weight: Number(o.wagaKg), length: o.dlugoscCm, width: o.szerokoscCm, height: o.wysokoscCm,
    invoiceNumber: o.invoiceNumber || undefined,
  });
  if (!q.body || !q.body.ok) throw new Error(`wycena: ${(q.body && (q.body.error || q.body.message)) || `HTTP ${q.status}`}`);
  const oferta = (q.body.offers || [])[0];
  if (!oferta) throw new Error('wycena bez ofert');
  const r = await selfCall('POST', '/api/glob/order', { quoteId: q.body.quoteId, productId: oferta.productId });
  if (!r.body || !r.body.ok) throw new Error(`zamówienie: ${(r.body && (r.body.error || r.body.message)) || `HTTP ${r.status}`}`);
  return { gkHash: r.body.hash || null, gkNumber: r.body.orderNumber || null, carrier: r.body.carrier || oferta.carrier || null, quoteId: String(q.body.quoteId), cena: oferta.price != null ? Number(oferta.price) : null };
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
  if (autoList) {
    const braki = brakiOdbiorcy(od);
    if (braki.length) return res.status(400).json({ ok: false, error: `auto-list wymaga pełnego odbiorcy — brakuje: ${braki.join(', ')}` });
  }

  const catalog = await getActiveCatalog(prisma);
  const { linie, bledy } = rozbijPozycje(items, catalog);
  if (bledy.length) return res.status(400).json({ ok: false, error: bledy.join('; ') });

  let contractorId = b.contractorId ? String(b.contractorId) : null;
  if (contractorId) {
    const c = await prisma.contractor.findUnique({ where: { id: contractorId }, select: { id: true } }).catch(() => null);
    if (!c) contractorId = null;
  }
  const o = await prisma.warehouseOrder.create({
    data: {
      contractorId,
      odbiorca: {
        name: od.name || '', street: od.street || '', houseNumber: od.houseNumber || '', apartmentNumber: od.apartmentNumber || '',
        postCode: od.postCode || '', city: od.city || '', country: od.country || 'PL', phone: od.phone || '', email: od.email || '',
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
  res.json({ ok: true, zamowienie: toPublic(o, rola(req)) });
}));

// Właściciel: uwagi, anulowanie. Anulowanie po GOTOWE cofa wydanie ze stanu.
router.patch('/zamowienia/:id', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const prisma = req.app.locals.prisma;
  const b = req.body || {};
  const o = await prisma.warehouseOrder.findUnique({ where: { id: req.params.id }, include: ORDER_INCLUDE });
  if (!o) return res.status(404).json({ ok: false, error: 'brak zamówienia' });
  const data = {};
  if ('uwagiNasze' in b) data.uwagiNasze = b.uwagiNasze ? String(b.uwagiNasze).slice(0, 2000) : null;
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
  res.json({ ok: true, zamowienie: toPublic(u, rola(req)) });
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
  if (u.autoList) {
    try {
      const k = await zamowKuriera(u, prisma);
      wynik = await prisma.warehouseOrder.update({
        where: { id: u.id },
        data: { status: 'KURIER', gkHash: k.gkHash, gkNumber: k.gkNumber, carrier: k.carrier, quoteId: k.quoteId, kurierBlad: null, zatwierdzilKto: 'auto-list', zatwierdzonoAt: new Date() },
        include: ORDER_INCLUDE,
      });
    } catch (e) {
      console.error(`[magazyn] auto-list #${u.numer} padł:`, e.message);
      wynik = await prisma.warehouseOrder.update({ where: { id: u.id }, data: { kurierBlad: String(e.message).slice(0, 500) }, include: ORDER_INCLUDE });
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
  if (o.status !== 'GOTOWE') return res.status(400).json({ ok: false, error: `zamówienie jest w stanie ${o.status} — kurier podpina się do spakowanej paczki` });
  let data;
  if (b.autoList) {
    const braki = brakiOdbiorcy(o.odbiorca);
    if (braki.length) return res.status(400).json({ ok: false, error: `brak danych odbiorcy: ${braki.join(', ')}` });
    try {
      const k = await zamowKuriera(o, prisma);
      data = { status: 'KURIER', gkHash: k.gkHash, gkNumber: k.gkNumber, carrier: k.carrier, quoteId: k.quoteId, kurierBlad: null, zatwierdzilKto: kto(req), zatwierdzonoAt: new Date() };
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
  }
  const u = await prisma.warehouseOrder.update({ where: { id: o.id }, data, include: ORDER_INCLUDE });
  res.json({ ok: true, zamowienie: toPublic(u, rola(req)) });
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
router.post('/zamowienia/:id/powiadom', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const prisma = req.app.locals.prisma;
  const b = req.body || {};
  const o = await prisma.warehouseOrder.findUnique({ where: { id: req.params.id }, include: ORDER_INCLUDE });
  if (!o) return res.status(404).json({ ok: false, error: 'brak zamówienia' });
  if (o.status === 'ANULOWANE') return res.status(400).json({ ok: false, error: `zamówienie #${o.numer} jest anulowane — nie powiadamiam magazynu` });
  const doKogo = b.do ? String(b.do).trim() : MAGAZYN_MAIL_DO();
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(doKogo)) return res.status(400).json({ ok: false, error: `zły adres e-mail: ${doKogo}` });
  if (o.powiadomionoAt && !b.ponownie && !b.podglad) {
    const kiedy = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'short', timeStyle: 'short' }).format(o.powiadomionoAt);
    return res.status(409).json({ ok: false, juzPowiadomiono: true, powiadomionoAt: o.powiadomionoAt, error: `Magazyn powiadomiony już ${kiedy} (${o.powiadomionoDo || 'magazyn'}). Wyślij ponownie tylko, jeśli trzeba.` });
  }
  const z = toPublic(o, 'magazyn');
  const { subject, text, html } = trescMaila(z);
  const zalaczniki = [{ filename: `zamowienie-${o.numer}.pdf`, content: await pdfZamowienia(z), contentType: 'application/pdf' }];
  const docs = await prisma.warehouseOrderDoc.findMany({ where: { orderId: o.id }, orderBy: { createdAt: 'asc' }, select: { filename: true, contentType: true, data: true } });
  for (const d of docs) zalaczniki.push({ filename: d.filename, content: Buffer.from(d.data), contentType: d.contentType || 'application/pdf' });
  const opisZal = zalaczniki.map(a => ({ filename: a.filename, size: a.content.length }));
  const od = MAGAZYN_MAIL_OD();
  if (b.podglad) return res.json({ ok: true, podglad: true, od, do: doKogo, temat: subject, tresc: text, zalaczniki: opisZal });
  try {
    await require('../mail-sender').sendMail({ from: od, to: doKogo, subject, body: text, html, attachments: zalaczniki });
  } catch (e) {
    console.error(`[magazyn] powiadomienie #${o.numer} nieudane:`, e.message);
    return res.status(502).json({ ok: false, error: `Mail do magazynu nie wyszedł: ${e.message}` });
  }
  const u = await prisma.warehouseOrder.update({ where: { id: o.id }, data: { powiadomionoAt: new Date(), powiadomilKto: kto(req), powiadomionoDo: doKogo }, include: ORDER_INCLUDE });
  console.log(`[magazyn] powiadomiono magazyn o #${o.numer} (${zalaczniki.length} zał.)`);
  res.json({ ok: true, zamowienie: toPublic(u, rola(req)), wyslano: { od, do: doKogo, zalaczniki: opisZal } });
}));

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
