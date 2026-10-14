"use strict";

/* STATUSY ZAMÓWIEŃ MAGAZYNU Z GLOBKURIER (14.10.2026).
 *
 * Zamówienie w zakładce Paczki po zamówieniu kuriera ma status KURIER i bez
 * tego modułu nikt go nie zmieniał — „wysłane" było guzikiem właściciela.
 * Tu robimy to, co zakładka Wysyłki: czytamy status z listy zamówień GK
 * (IN_PROGRESS = czeka na odbiór, IN_TRANSIT = w drodze, DELIVERED,
 * CANCELED, RETURNED_TO_SENDER) i historię trackingu (daty zdarzeń).
 * Paczka, która ruszyła, dostaje WYSLANE z datą pierwszego zdarzenia po
 * odbiorze; doręczona — dostarczonoAt. Front pokazuje „wysłane · 3 dni temu".
 *
 * Wołane: w tle przy GET /magazyn/zamowienia (throttle 10 min), co 30 min
 * z index.js, na żądanie POST /magazyn/zamowienia/odswiez-statusy. */

const { fetchOrdersPaged, findOrderInList, getOrderTracking } = require('../glob-client');
const { extractDeliveredDate } = require('./delivered-backfill');

const RUSZYLA_RE = /in_transit|in_delivery|shipped|picked|ready|delivered|returned|out_for/i; // status listy GK
const DORECZONA_RE = /^delivered$/i;
const ANULOWANA_RE = /cancel/i;
// Zdarzenia trackingu oznaczające fizyczny ruch paczki (nie „zarejestrowano").
const ZDARZENIE_RUCHU_RE = /picked|transit|delivery|delivered|ready|returned|shipped|out_for|sorting|hub|arrived|departed/i;

const parseGk = (s) => { if (!s) return null; const d = new Date(String(s).trim().replace(' ', 'T')); return Number.isFinite(d.getTime()) ? d : null; };
const fmt = (d) => d ? d.toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
const czysteMiejsce = (loc) => { const p = String(loc || '').split(',').map(x => x.trim()).filter(Boolean); return p.length ? p.join(', ') : ''; };

function analizaTrackingu(tracking) {
  const statusy = Array.isArray(tracking && tracking.statuses) ? tracking.statuses.slice() : [];
  if (tracking && tracking.latestStatus) statusy.push(tracking.latestStatus);
  const zDatami = statusy.map(ev => ({ ...ev, d: parseGk(ev.date) })).filter(ev => ev.d);
  zDatami.sort((a, b) => a.d - b.d);
  const ruch = zDatami.filter(ev => ZDARZENIE_RUCHU_RE.test(String(ev.type || '') + ' ' + String(ev.name || '')));
  const ostatnie = zDatami[zDatami.length - 1] || null;
  return {
    pierwszyRuch: ruch.length ? ruch[0].d : null,
    dostarczono: extractDeliveredDate(tracking),
    ostatnie: ostatnie ? `${ostatnie.name || ostatnie.type}${ostatnie.d ? ' · ' + fmt(ostatnie.d) : ''}${czysteMiejsce(ostatnie.location) ? ' · ' + czysteMiejsce(ostatnie.location) : ''}` : null,
  };
}

let ostatnioO = 0;
let wToku = false;

async function odswiezStatusyMagazynu(prisma, { force = false, minOdstepMin = 10 } = {}) {
  if (wToku) return { pominieto: 'w toku' };
  if (!force && Date.now() - ostatnioO < minOdstepMin * 60 * 1000) return { pominieto: 'throttle' };
  if (!process.env.GLOBKURIER_EMAIL || !process.env.GLOBKURIER_PASSWORD) return { pominieto: 'brak GK' };
  wToku = true; ostatnioO = Date.now();
  try {
    const zam = await prisma.warehouseOrder.findMany({
      where: { OR: [{ status: 'KURIER' }, { status: 'WYSLANE', dostarczonoAt: null }], NOT: { AND: [{ gkNumber: null }, { gkHash: null }] } },
      select: { id: true, numer: true, status: true, gkNumber: true, gkHash: true, wyslanoAt: true, dostarczonoAt: true, kurierBlad: true },
    });
    if (!zam.length) return { sprawdzono: 0, zmienione: 0 };
    const lista = await fetchOrdersPaged(3);
    let zmienione = 0;
    for (const o of zam) {
      const gk = (o.gkNumber && findOrderInList(lista, o.gkNumber)) || (o.gkHash && findOrderInList(lista, o.gkHash)) || null;
      if (!gk) continue;
      const st = String(gk.status || gk.statusName || '').toUpperCase();
      const data = { gkStatus: st, gkStatusAt: new Date() };
      if (!o.gkNumber && (gk.number || gk.orderNumber)) data.gkNumber = String(gk.number || gk.orderNumber);
      let tr = null;
      const numer = o.gkNumber || data.gkNumber;
      if (numer && RUSZYLA_RE.test(st)) {
        try { tr = analizaTrackingu(await getOrderTracking(numer)); } catch (e) { console.warn(`[magazyn-statusy] tracking #${o.numer} (${numer}):`, e.message); }
      }
      if (tr && tr.ostatnie) data.ostatnieZdarzenie = tr.ostatnie.slice(0, 200);
      if (RUSZYLA_RE.test(st)) {
        if (o.status === 'KURIER') { data.status = 'WYSLANE'; zmienione++; }
        if (!o.wyslanoAt) data.wyslanoAt = (tr && tr.pierwszyRuch) || new Date();
      }
      if (DORECZONA_RE.test(st) && !o.dostarczonoAt) {
        data.dostarczonoAt = (tr && tr.dostarczono) || (tr && tr.pierwszyRuch) || new Date();
        zmienione++;
      }
      if (ANULOWANA_RE.test(st) && o.status === 'KURIER' && !o.kurierBlad) {
        data.kurierBlad = `Przesyłka ${numer || ''} została anulowana w GlobKurier — zamów kuriera ponownie albo anuluj zamówienie.`;
        zmienione++;
      }
      await prisma.warehouseOrder.update({ where: { id: o.id }, data });
    }
    return { sprawdzono: zam.length, zmienione };
  } finally { wToku = false; }
}

module.exports = { odswiezStatusyMagazynu, analizaTrackingu };
