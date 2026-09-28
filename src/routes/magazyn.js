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
  if (!od.name && !b.contractorId) return res.status(400).json({ ok: false, error: 'brak odbiorcy' });

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
  const w = b.wagaKg != null && b.wagaKg !== '' ? Number(String(b.wagaKg).replace(',', '.')) : null;
  if (!(d > 0 && s > 0 && h > 0)) return res.status(400).json({ ok: false, error: 'podaj wymiary kartonu (cm)' });
  if (!(w > 0)) return res.status(400).json({ ok: false, error: 'podaj wagę paczki (kg)' });
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
  res.json({ ok: true, zamowienie: toPublic(u) });
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
