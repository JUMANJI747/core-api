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

const EKSPOZYTOR = { ean: 'EKSPOZYTOR', name: 'Ekspozytor (pusty)' };
const STATUSY = ['NOWE', 'GOTOWE', 'KURIER', 'WYSLANE', 'ANULOWANE'];

const kto = (req) => (req.crm && req.crm.user) || null;
const rola = (req) => (req.crm && req.crm.role) || 'owner';
function tylkoWlasciciel(req, res) {
  if (rola(req) === 'magazyn') { res.status(403).json({ ok: false, error: 'tylko właściciel' }); return false; }
  return true;
}

const ORDER_INCLUDE = { items: { orderBy: { sort: 'asc' } }, contractor: { select: { id: true, name: true } } };

function toPublic(o) {
  return {
    id: o.id, numer: o.numer, status: o.status,
    contractorId: o.contractorId, contractorName: o.contractor ? o.contractor.name : null,
    odbiorca: o.odbiorca || {},
    uwagiNasze: o.uwagiNasze, uwagiMagazynu: o.uwagiMagazynu,
    invoiceNumber: o.invoiceNumber, emailId: o.emailId,
    karton: o.kartonNazwa || o.dlugoscCm ? {
      nazwa: o.kartonNazwa, dlugoscCm: o.dlugoscCm, szerokoscCm: o.szerokoscCm, wysokoscCm: o.wysokoscCm,
      wagaKg: o.wagaKg != null ? Number(o.wagaKg) : null,
    } : null,
    autoList: !!o.autoList, kurierBlad: o.kurierBlad || null,
    gkHash: o.gkHash, gkNumber: o.gkNumber, carrier: o.carrier,
    utworzyl: o.utworzyl, gotoweKto: o.gotoweKto, zatwierdzilKto: o.zatwierdzilKto,
    createdAt: o.createdAt, gotoweAt: o.gotoweAt, zatwierdzonoAt: o.zatwierdzonoAt,
    items: (o.items || []).map(i => ({
      id: i.id, ean: i.ean, name: i.name, variant: i.variant, qty: i.qty, parentEan: i.parentEan, packaging: i.packaging,
    })),
  };
}

/* Rozbicie pozycji z formularza na linie zamówienia (migawka składu boxów).
   Wejście: [{ean, qty, packaging?}]. Wyjście: linie + błędy walidacji. */
function rozbijPozycje(items, catalog) {
  const byEan = new Map(catalog.map(p => [p.ean, p]));
  const linie = [];
  const bledy = [];
  let sort = 0;
  for (const it of items) {
    const ean = String(it.ean || '').trim();
    const qty = parseInt(it.qty, 10);
    if (!ean || !(qty > 0)) { bledy.push(`pozycja bez EAN albo ilości: ${JSON.stringify(it)}`); continue; }
    const p = byEan.get(ean);
    if (!p) { bledy.push(`nieznany produkt ${ean}`); continue; }
    if (/-GENERIC$/i.test(ean)) { bledy.push(`„${p.name}" bez koloru — magazyn musi wiedzieć, co pakuje. Wybierz kolory albo box mix.`); continue; }
    const ex = (p.extras && typeof p.extras === 'object') ? p.extras : {};
    const comp = Array.isArray(ex.composition) ? ex.composition : null;
    if (comp && comp.length) {
      const packaging = it.packaging === 'ekspozytor' ? 'ekspozytor' : 'karton';
      linie.push({ ean, name: p.name, variant: packaging === 'ekspozytor' ? 'ekspozytor zatowarowany' : 'w kartonie', qty, parentEan: null, packaging, sort: sort++ });
      for (const c of comp) {
        const cp = byEan.get(c.ean);
        linie.push({ ean: c.ean, name: cp ? cp.name : p.name, variant: c.variant || (cp && cp.variant) || null, qty: Number(c.qty) * qty, parentEan: ean, packaging: null, sort: sort++ });
      }
      if (packaging === 'ekspozytor') {
        linie.push({ ean: EKSPOZYTOR.ean, name: EKSPOZYTOR.name, variant: null, qty, parentEan: ean, packaging: null, sort: sort++ });
      }
    } else {
      linie.push({ ean, name: p.name, variant: p.variant || null, qty, parentEan: null, packaging: null, sort: sort++ });
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
  return braki;
}

/* AUTO-LIST: wycena + zamówienie kuriera z adresu magazynu (nadawca) na
   adres z zamówienia, najtańsza oferta. Wymiary z kartonu, waga policzona.
   Wołamy własne endpointy przez selfCall (jak agent), żeby nie dublować
   2000 linii logiki wyceny/zamówienia. Nadawca: MAGAZYN_SENDER_SEARCH
   (fragment nazwy nadawcy z książki GK) — bez tego jedziemy domyślnym
   nadawcą i mówimy o tym w kurierBlad? Nie: bez skonfigurowanego nadawcy
   NIE zamawiamy — paczka poszłaby z Galin zamiast z magazynu. */
async function zamowKuriera(o) {
  const senderSearch = (process.env.MAGAZYN_SENDER_SEARCH || '').trim();
  if (!senderSearch) throw new Error('brak MAGAZYN_SENDER_SEARCH (nazwa nadawcy-magazynu w książce GK) — kurier nie zamówiony');
  const od = o.odbiorca || {};
  const q = await selfCall('POST', '/api/glob/quote', {
    senderSearch,
    receiverSearch: od.name,
    deliveryAddress: {
      street: od.street, houseNumber: od.houseNumber || null, apartmentNumber: od.apartmentNumber || null,
      postCode: od.postCode, city: od.city, country: od.country || 'PL', phone: od.phone || null, email: od.email || null,
    },
    weight: Number(o.wagaKg), length: o.dlugoscCm, width: o.szerokoscCm, height: o.wysokoscCm,
    invoiceNumber: o.invoiceNumber || undefined,
  });
  if (!q.body || !q.body.ok) throw new Error(`wycena: ${(q.body && q.body.error) || `HTTP ${q.status}`}`);
  const oferta = (q.body.offers || [])[0];
  if (!oferta) throw new Error('wycena bez ofert');
  const r = await selfCall('POST', '/api/glob/order', { quoteId: q.body.quoteId, productId: oferta.productId });
  if (!r.body || !r.body.ok) throw new Error(`zamówienie: ${(r.body && r.body.error) || `HTTP ${r.status}`}`);
  return { gkHash: r.body.hash || null, gkNumber: r.body.orderNumber || null, carrier: r.body.carrier || oferta.carrier || null, quoteId: String(q.body.quoteId) };
}

/** Linie, które realnie schodzą ze stanu: bez nagłówków boxów. */
const linieDoStocku = (items) => items.filter(i => !i.packaging);

// ---------- ZAMÓWIENIA ----------

router.get('/zamowienia', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const status = String(req.query.status || 'aktywne');
  const where = status === 'aktywne' ? { status: { in: ['NOWE', 'GOTOWE', 'KURIER'] } }
    : status === 'wszystkie' ? {} : { status: status.toUpperCase() };
  const rows = await prisma.warehouseOrder.findMany({ where, include: ORDER_INCLUDE, orderBy: { numer: 'desc' }, take: 300 });
  res.json({ ok: true, zamowienia: rows.map(toPublic), rola: rola(req) });
}));

router.get('/zamowienia/:id', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const o = await prisma.warehouseOrder.findUnique({ where: { id: req.params.id }, include: ORDER_INCLUDE });
  if (!o) return res.status(404).json({ ok: false, error: 'brak zamówienia' });
  res.json({ ok: true, zamowienie: toPublic(o) });
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
  res.json({ ok: true, zamowienie: toPublic(o) });
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
  if (b.status === 'ANULOWANE' && o.status !== 'ANULOWANE') {
    if (o.status === 'KURIER' || o.status === 'WYSLANE') return res.status(400).json({ ok: false, error: 'kurier już zamówiony — anuluj najpierw przesyłkę' });
    data.status = 'ANULOWANE';
    if (o.status === 'GOTOWE') {
      await prisma.stockMovement.createMany({
        data: linieDoStocku(o.items).map(i => ({ ean: i.ean, name: i.name, delta: i.qty, typ: 'COFNIECIE', orderId: o.id, kto: kto(req), uwaga: `anulowano #${o.numer}` })),
      });
    }
  }
  if (b.status === 'NOWE' && o.status === 'ANULOWANE') data.status = 'NOWE';
  const u = await prisma.warehouseOrder.update({ where: { id: o.id }, data, include: ORDER_INCLUDE });
  res.json({ ok: true, zamowienie: toPublic(u) });
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

  const u = await prisma.$transaction(async (tx) => {
    await tx.stockMovement.createMany({
      data: linieDoStocku(o.items).map(i => ({ ean: i.ean, name: i.name, delta: -i.qty, typ: 'WYDANIE', orderId: o.id, kto: kto(req), uwaga: `spakowano #${o.numer}` })),
    });
    return tx.warehouseOrder.update({
      where: { id: o.id },
      data: {
        status: 'GOTOWE', gotoweAt: new Date(), gotoweKto: kto(req),
        kartonNazwa: b.kartonNazwa ? String(b.kartonNazwa).slice(0, 80) : null,
        dlugoscCm: d, szerokoscCm: s, wysokoscCm: h, wagaKg: w,
        uwagiMagazynu: b.uwagiMagazynu ? String(b.uwagiMagazynu).slice(0, 2000) : null,
      },
      include: ORDER_INCLUDE,
    });
  });

  /* AUTO-LIST. Osobno od transakcji: „gotowe" i zejście ze stanu są faktem
     niezależnie od tego, czy kurier się uda. Błąd kuriera ląduje w kurierBlad
     i jest widoczny obu stronom — zamówienie zostaje GOTOWE, właściciel może
     zamówić ręcznie i podpiąć. */
  let wynik = u;
  if (u.autoList) {
    try {
      const k = await zamowKuriera(u);
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
  res.json({ ok: true, zamowienie: toPublic(wynik) });
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
      const k = await zamowKuriera(o);
      data = { status: 'KURIER', gkHash: k.gkHash, gkNumber: k.gkNumber, carrier: k.carrier, quoteId: k.quoteId, kurierBlad: null, zatwierdzilKto: kto(req), zatwierdzonoAt: new Date() };
    } catch (e) {
      await prisma.warehouseOrder.update({ where: { id: o.id }, data: { kurierBlad: String(e.message).slice(0, 500) } });
      return res.status(502).json({ ok: false, error: e.message });
    }
  } else {
    const gkNumber = b.gkNumber ? String(b.gkNumber).trim() : '';
    const gkHash = b.gkHash ? String(b.gkHash).trim() : '';
    if (!gkNumber && !gkHash) return res.status(400).json({ ok: false, error: 'podaj numer zamówienia GK albo hash' });
    data = { status: 'KURIER', gkHash: gkHash || null, gkNumber: gkNumber || null, carrier: b.carrier ? String(b.carrier).slice(0, 60) : null, kurierBlad: null, zatwierdzilKto: kto(req), zatwierdzonoAt: new Date() };
  }
  const u = await prisma.warehouseOrder.update({ where: { id: o.id }, data, include: ORDER_INCLUDE });
  res.json({ ok: true, zamowienie: toPublic(u) });
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

// Właściciel cofa „gotowe" (np. magazyn się pomylił) — ruch odwrotny.
router.post('/zamowienia/:id/cofnij-gotowe', asyncHandler(async (req, res) => {
  if (!tylkoWlasciciel(req, res)) return;
  const prisma = req.app.locals.prisma;
  const o = await prisma.warehouseOrder.findUnique({ where: { id: req.params.id }, include: ORDER_INCLUDE });
  if (!o) return res.status(404).json({ ok: false, error: 'brak zamówienia' });
  if (o.status !== 'GOTOWE') return res.status(400).json({ ok: false, error: `zamówienie jest w stanie ${o.status}` });
  const u = await prisma.$transaction(async (tx) => {
    await tx.stockMovement.createMany({
      data: linieDoStocku(o.items).map(i => ({ ean: i.ean, name: i.name, delta: i.qty, typ: 'COFNIECIE', orderId: o.id, kto: kto(req), uwaga: `cofnięto gotowe #${o.numer}` })),
    });
    return tx.warehouseOrder.update({ where: { id: o.id }, data: { status: 'NOWE', gotoweAt: null, gotoweKto: null }, include: ORDER_INCLUDE });
  });
  res.json({ ok: true, zamowienie: toPublic(u) });
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
      ilosc: g._sum.delta || 0,
    };
  }).sort((a, b) => (a.name + (a.variant || '')).localeCompare(b.name + (b.variant || ''), 'pl'));
  res.json({ ok: true, stan, ruchy: ostatnie.map(m => ({ id: m.id, ean: m.ean, name: m.name, delta: m.delta, typ: m.typ, orderId: m.orderId, uwaga: m.uwaga, kto: m.kto, createdAt: m.createdAt })) });
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
    const qty = parseInt(it.qty, 10);
    if (!ean || !Number.isFinite(qty) || qty === 0) continue;
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
