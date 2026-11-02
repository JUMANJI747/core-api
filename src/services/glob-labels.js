'use strict';

/* KOPIE LISTÓW PRZEWOZOWYCH GK (2.11.2026). Po anulowaniu przesyłki
 * GlobKurier oddaje już tylko 404 — tak przepadł list do OHANA SURF
 * (GK261023416637), a kopii nie było nigdzie. List jest dowodem wysyłki
 * (WDT, paczka JPK), więc każdy PDF, który raz dostaniemy z GK, zostaje
 * w bazie (`GlobLabel`) i od tej pory serwujemy go stąd — GK pytamy tylko,
 * gdy kopii nie ma.
 *
 * `getOrderLabels(hash, format, opts)` ma sygnaturę i wynik ({status, body})
 * jak w glob-client, więc wszystkie miejsca pobierające listy (panel,
 * Telegram, magazyn, paczka JPK, numer z etykiety) korzystają bez innych
 * zmian. Kopia powstaje:
 *  1. przy każdym udanym pobraniu z GK,
 *  2. zaraz po zamówieniu kuriera — w tle, z ponowieniami, bo GK wystawia
 *     list z opóźnieniem (`zabezpieczPoZamowieniu`),
 *  3. przed anulowaniem przesyłki (/glob/delete-order),
 *  4. przeglądem zaległych — zamówienia GK z ostatnich dni bez kopii, co 6 h
 *     z index.js i POST /glob/labels/zabezpiecz (`zabezpieczZalegle`).
 * Błąd bazy nigdy nie psuje pobierania — wtedy działa jak dawniej, prosto z GK. */

const db = () => require('../db');
const gkDomyslny = () => require('../glob-client');

const czyPdf = (buf) => !!buf && buf.length > 100 && Buffer.from(buf.subarray(0, 5)).toString('latin1') === '%PDF-';

// Format idzie do URL-a GK i do klucza kopii — tylko bezpieczne znaki.
const formatListu = (f) => {
  const s = String(f || 'A4').trim();
  return /^[A-Za-z0-9_-]{1,12}$/.test(s) ? s : 'A4';
};

async function znajdzKopie(prisma, hash, format) {
  try {
    return await prisma.globLabel.findUnique({ where: { hash_format: { hash, format } } });
  } catch (e) {
    console.error('[glob-labels] odczyt kopii nieudany:', e.message);
    return null;
  }
}

async function zapiszKopie(prisma, { hash, format, body, orderNumber, zrodlo }) {
  const data = Buffer.from(body);
  const numer = orderNumber ? { orderNumber: String(orderNumber) } : {};
  try {
    await prisma.globLabel.upsert({
      where: { hash_format: { hash, format } },
      create: { hash, format, data, size: data.length, zrodlo: zrodlo || 'pobranie', ...numer },
      update: { data, size: data.length, ...numer },
    });
    return true;
  } catch (e) {
    console.error('[glob-labels] zapis kopii nieudany:', e.message);
    return false;
  }
}

const zKopii = (k) => ({ status: 200, body: Buffer.from(k.data), zBazy: true, orderNumber: k.orderNumber || null });

/* opts: odswiez (najpierw GK, kopia tylko gdy GK zawiedzie), orderNumber
 * i zrodlo (opis kopii), prisma i gk (podstawiane w testach). */
async function getOrderLabels(hash, format = 'A4', opts = {}) {
  const prisma = opts.prisma || db();
  const gk = opts.gk || gkDomyslny();
  const h = String(hash || '').trim();
  const fmt = formatListu(format);

  if (h && !opts.odswiez) {
    const kopia = await znajdzKopie(prisma, h, fmt);
    if (kopia) return zKopii(kopia);
  }

  let wynik;
  try {
    wynik = await gk.getOrderLabels(h, fmt);
  } catch (e) {
    const kopia = h && opts.odswiez ? await znajdzKopie(prisma, h, fmt) : null;
    if (kopia) return zKopii(kopia);
    throw e;
  }

  if (h && wynik && wynik.status === 200 && czyPdf(wynik.body)) {
    await zapiszKopie(prisma, { hash: h, format: fmt, body: wynik.body, orderNumber: opts.orderNumber, zrodlo: opts.zrodlo });
    return { ...wynik, zBazy: false, orderNumber: opts.orderNumber || null };
  }
  if (h && opts.odswiez) {
    const kopia = await znajdzKopie(prisma, h, fmt);
    if (kopia) return zKopii(kopia);
  }
  return wynik;
}

/* Zaraz po zamówieniu: GK wystawia list z kilkusekundowym (czasem dłuższym)
 * opóźnieniem, więc kilka prób w tle. Nie blokuje odpowiedzi — zwraca
 * Promise<boolean> (czy kopia jest), który nigdy nie odrzuca. Gdy wszystkie
 * próby zawiodą (albo proces zrestartuje się w trakcie), list złapie
 * przegląd zaległych. */
const OPOZNIENIA_PO_ZAMOWIENIU = [5e3, 30e3, 2 * 60e3, 10 * 60e3, 30 * 60e3];

function zabezpieczPoZamowieniu(hash, opts = {}) {
  const opoznienia = opts.opoznienia || OPOZNIENIA_PO_ZAMOWIENIU;
  const opis = opts.orderNumber || String(hash || '').slice(0, 12);
  return new Promise((resolve) => {
    if (!hash) return resolve(false);
    let proba = 0;
    const sprobuj = async () => {
      try {
        const r = await getOrderLabels(hash, 'A4', { ...opts, zrodlo: 'zamowienie' });
        if (r && r.status === 200 && czyPdf(r.body)) {
          console.log(`[glob-labels] kopia listu ${opis} jest w bazie${r.zBazy ? '' : ' (pobrana z GK)'}`);
          return resolve(true);
        }
      } catch (e) {
        console.warn(`[glob-labels] list ${opis}, próba ${proba + 1}: ${e.message}`);
      }
      proba++;
      if (proba < opoznienia.length) return zaplanuj();
      console.warn(`[glob-labels] list ${opis}: GK nie oddał go po ${opoznienia.length} próbach — złapie go przegląd zaległych`);
      resolve(false);
    };
    const zaplanuj = () => {
      const t = setTimeout(sprobuj, opoznienia[proba]);
      if (t && t.unref) t.unref();
    };
    zaplanuj();
  });
}

/* PRZEGLĄD ZALEGŁYCH: zamówienia GK z ostatnich `dni` bez kopii w bazie —
 * zamówione z panelu GK, nieudane próby po zamówieniu, okno restartu.
 * GK oddaje zamówienia od najnowszych, więc strony po 100 do pierwszej,
 * która sięga przed okno. Hash, którego GK nie oddał MAX_PROB razy (np.
 * anulowany — 404), przegląd pomija do restartu procesu, żeby nie pytać
 * o niego co 6 h. `budzetMs` trzyma wywołanie z panelu w limicie proxy;
 * czego nie zdążył, liczy w `pozostalo`. */
const MAX_PROB = 3;
const nieudane = new Map(); // hash → liczba nieudanych prób przeglądu
let przegladTrwa = false;

function listaZOdpowiedzi(dane) {
  let lista = dane;
  if (Array.isArray(lista) && lista.length === 1 && lista[0] && Array.isArray(lista[0].results)) lista = lista[0].results;
  else if (!Array.isArray(lista)) lista = (lista && (lista.results || lista.items || lista.data)) || [];
  return Array.isArray(lista) ? lista : [];
}

function dataZamowienia(o) {
  const s = o && (o.creationDate || o.created_at || o.createdAt);
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T'));
  return isNaN(d) ? null : d;
}

async function zabezpieczZalegle(opts = {}) {
  const { dni = 14, limit = 60, budzetMs = 4 * 60e3, maxStron = 10, przerwaMs = 300 } = opts;
  if (przegladTrwa) return { ok: false, error: 'przegląd kopii listów już trwa' };
  przegladTrwa = true;
  const prisma = opts.prisma || db();
  const gk = opts.gk || gkDomyslny();
  const start = Date.now();
  const odKiedy = new Date(start - dni * 24 * 3600e3);
  const wynik = { ok: true, dni, zamowien: 0, maKopie: 0, zapisane: 0, nieudane: [], pominiete: 0, pozostalo: 0 };
  try {
    const zamowienia = [];
    for (let s = 0; s < maxStron; s++) {
      const lista = listaZOdpowiedzi(await gk.getOrders({ limit: 100, offset: s * 100 }));
      let przedOknem = false;
      for (const o of lista) {
        const d = dataZamowienia(o);
        if (d && d < odKiedy) { przedOknem = true; continue; }
        const hash = o.hash || o.orderHash;
        if (hash) zamowienia.push({ hash: String(hash), numer: o.number || o.orderNumber || null, status: o.status || o.statusName || null });
      }
      if (przedOknem || lista.length < 100) break;
    }
    wynik.zamowien = zamowienia.length;
    if (!zamowienia.length) return wynik;

    const kopie = await prisma.globLabel.findMany({
      where: { hash: { in: zamowienia.map(z => z.hash) }, format: 'A4' },
      select: { hash: true },
    });
    const zKopia = new Set(kopie.map(k => k.hash));

    let proby = 0;
    for (const z of zamowienia) {
      if (zKopia.has(z.hash)) { wynik.maKopie++; continue; }
      if ((nieudane.get(z.hash) || 0) >= MAX_PROB) { wynik.pominiete++; continue; }
      if (proby >= limit || Date.now() - start > budzetMs) { wynik.pozostalo++; continue; }
      proby++;
      try {
        const r = await getOrderLabels(z.hash, 'A4', { prisma, gk, zrodlo: 'przeglad', orderNumber: z.numer });
        if (r && r.status === 200 && czyPdf(r.body)) {
          wynik.zapisane++;
          nieudane.delete(z.hash);
        } else {
          nieudane.set(z.hash, (nieudane.get(z.hash) || 0) + 1);
          wynik.nieudane.push({ numer: z.numer, status: z.status, http: r ? r.status : null });
        }
      } catch (e) {
        nieudane.set(z.hash, (nieudane.get(z.hash) || 0) + 1);
        wynik.nieudane.push({ numer: z.numer, status: z.status, error: e.message });
      }
      if (przerwaMs) await new Promise(r => setTimeout(r, przerwaMs));
    }
    return wynik;
  } finally {
    przegladTrwa = false;
  }
}

module.exports = {
  getOrderLabels,
  zabezpieczPoZamowieniu,
  zabezpieczZalegle,
  czyPdf,
  _nieudane: nieudane,
};
