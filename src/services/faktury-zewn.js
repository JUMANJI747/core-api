'use strict';

/* FAKTURY NA ZAMÓWIENIE Z ZEWNĄTRZ (26.10.2026).
 *
 * System mailingowy zamawia przez API fakturę za usługę dla POLSKIEJ firmy
 * przy każdym odnowieniu abonamentu. CRM wystawia ją w iFirmie tą samą drogą
 * co resztę faktur (ta sama firma i konto: faktura krajowa, VAT 23%, PLN)
 * i oddaje numer, kwoty i PDF. Maila do klienta wysyła system mailingowy.
 *
 * Bezpieczeństwo (token może wyciec jak zmienne Railway w październiku):
 *  - token Bearer; w Config tylko jego SHA-256 (`faktury_zewn_tokeny`),
 *  - `ref` = klucz idempotencji (ConfirmLock `zewn:<nazwa>:<ref>`): ten sam
 *    ref zawsze daje TĘ SAMĄ fakturę, nigdy drugą,
 *  - limity: kwota netto jednej faktury i liczba faktur na dobę (Config
 *    `faktury_zewn_limity`), przekroczenie → odmowa + alert na Telegram,
 *  - każda wystawiona faktura → wiadomość na Telegram PL. */

const crypto = require('crypto');

const KLUCZ_TOKENY = 'faktury_zewn_tokeny';   // [{ nazwa, hash (sha256 hex), od }]
const KLUCZ_LIMITY = 'faktury_zewn_limity';   // { maxNettoFaktury, maxDziennie }
const LIMITY_DOMYSLNE = { maxNettoFaktury: 10000, maxDziennie: 50 };
const GTU_DOZWOLONE = new Set(['BRAK', ...Array.from({ length: 13 }, (_, i) => `GTU_${String(i + 1).padStart(2, '0')}`)]);
const VAT = 0.23;

const r2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

async function czytajConfig(prisma, klucz, domyslnie) {
  try {
    const r = await prisma.config.findUnique({ where: { key: klucz } });
    return r && r.value ? JSON.parse(r.value) : domyslnie;
  } catch { return domyslnie; }
}

/* Token z nagłówka Authorization: Bearer … → nazwa źródła (np. 'mailing')
 * albo null. Porównanie skrótów w stałym czasie. */
async function zrodloZTokenu(prisma, req) {
  const h = String((req.headers && req.headers.authorization) || '');
  const m = h.match(/^Bearer\s+(\S{20,200})$/i);
  if (!m) return null;
  const hash = Buffer.from(sha256(m[1]), 'hex');
  const tokeny = await czytajConfig(prisma, KLUCZ_TOKENY, []);
  for (const t of Array.isArray(tokeny) ? tokeny : []) {
    if (!t || !t.hash || t.aktywny === false) continue;
    const wzor = Buffer.from(String(t.hash), 'hex');
    if (wzor.length === hash.length && crypto.timingSafeEqual(wzor, hash)) return String(t.nazwa || 'zewn');
  }
  return null;
}

// NIP: 10 cyfr, suma kontrolna (wagi 6,5,7,2,3,4,5,6,7).
function nipPoprawny(nip) {
  if (!/^\d{10}$/.test(nip)) return false;
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const suma = w.reduce((a, x, i) => a + x * Number(nip[i]), 0);
  return suma % 11 === Number(nip[9]);
}

/* Walidacja zamówienia faktury. Zwraca { dane } albo { bledy: [...] }. */
function waliduj(body) {
  const b = body || {};
  const bledy = [];
  const ref = String(b.ref || '').trim();
  if (!/^[A-Za-z0-9._:/-]{1,100}$/.test(ref)) bledy.push('ref: wymagany, 1–100 znaków (litery, cyfry, . _ : / -) — ten sam ref = ta sama faktura');
  const k = b.klient || {};
  const nip = String(k.nip || '').replace(/^PL/i, '').replace(/[\s-]/g, '');
  if (!nipPoprawny(nip)) bledy.push('klient.nip: polski NIP, 10 cyfr z poprawną sumą kontrolną');
  const nazwa = String(k.nazwa || '').trim();
  if (nazwa.length < 2 || nazwa.length > 250) bledy.push('klient.nazwa: wymagana (2–250 znaków)');
  const ulica = String(k.ulica || '').trim();
  if (!ulica || ulica.length > 120) bledy.push('klient.ulica: wymagana, z numerem (np. „Górczewska 222/5")');
  const kod = String(k.kod || '').trim();
  if (!/^\d{2}-\d{3}$/.test(kod)) bledy.push('klient.kod: kod pocztowy w formacie 00-000');
  const miasto = String(k.miasto || '').trim();
  if (!miasto || miasto.length > 80) bledy.push('klient.miasto: wymagane');
  const email = String(k.email || '').trim();
  if (email && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email)) bledy.push('klient.email: niepoprawny adres');

  const pozycje = Array.isArray(b.pozycje) ? b.pozycje : [];
  if (!pozycje.length || pozycje.length > 20) bledy.push('pozycje: od 1 do 20 pozycji');
  const tryby = new Set();
  const linie = pozycje.map((p, i) => {
    const n = `pozycje[${i}]`;
    const nazwaP = String((p && p.nazwa) || '').trim();
    if (!nazwaP || nazwaP.length > 250) bledy.push(`${n}.nazwa: wymagana (do 250 znaków)`);
    const ilosc = Number(p && p.ilosc);
    if (!(ilosc > 0 && ilosc <= 10000) || r2(ilosc) !== ilosc) bledy.push(`${n}.ilosc: liczba > 0, najwyżej 2 miejsca po przecinku`);
    const jednostka = String((p && p.jednostka) || 'usł.').trim();
    if (!jednostka || jednostka.length > 10) bledy.push(`${n}.jednostka: do 10 znaków (domyślnie „usł.")`);
    const gtu = String((p && p.gtu) || 'GTU_12').trim().toUpperCase();
    if (!GTU_DOZWOLONE.has(gtu)) bledy.push(`${n}.gtu: BRAK albo GTU_01…GTU_13`);
    const maNetto = p && p.cenaNetto != null && p.cenaNetto !== '';
    const maBrutto = p && p.cenaBrutto != null && p.cenaBrutto !== '';
    if (maNetto === maBrutto) bledy.push(`${n}: podaj DOKŁADNIE jedną cenę — cenaNetto albo cenaBrutto`);
    const cena = Number(maNetto ? p.cenaNetto : p.cenaBrutto);
    if ((maNetto || maBrutto) && (!(cena > 0 && cena <= 1000000) || r2(cena) !== cena)) bledy.push(`${n}: cena > 0, najwyżej 2 miejsca po przecinku`);
    tryby.add(maNetto ? 'netto' : 'brutto');
    return { nazwa: nazwaP, ilosc, jednostka, gtu, cena };
  });
  if (tryby.size > 1) bledy.push('pozycje: wszystkie ceny netto albo wszystkie brutto — nie mieszaj');
  const terminDni = b.terminDni == null ? 7 : Number(b.terminDni);
  if (!(Number.isInteger(terminDni) && terminDni >= 0 && terminDni <= 60)) bledy.push('terminDni: liczba całkowita 0–60 (domyślnie 7)');
  const uwagi = b.uwagi == null ? '' : String(b.uwagi).trim();
  if (uwagi.length > 500) bledy.push('uwagi: do 500 znaków');
  if (bledy.length) return { bledy };

  const trybCen = [...tryby][0];
  let netto, vat, brutto;
  const wartosci = linie.map(l => r2(l.ilosc * l.cena));
  if (trybCen === 'netto') {
    netto = r2(wartosci.reduce((a, x) => a + x, 0)); vat = r2(netto * VAT); brutto = r2(netto + vat);
  } else {
    brutto = r2(wartosci.reduce((a, x) => a + x, 0)); netto = r2(brutto / (1 + VAT)); vat = r2(brutto - netto);
  }
  return {
    dane: {
      ref, klient: { nazwa, nip, ulica, kod, miasto, email: email || null },
      linie, trybCen, terminDni, uwagi: uwagi || null, suma: { netto, vat, brutto, waluta: 'PLN' },
    },
  };
}

async function limity(prisma) {
  const l = await czytajConfig(prisma, KLUCZ_LIMITY, {});
  return { ...LIMITY_DOMYSLNE, ...(l && typeof l === 'object' ? l : {}) };
}

async function powiadom(prisma, tekst) {
  try {
    const { resolveTelegram } = require('./telegram-helper');
    const { sendTelegram } = require('../telegram-utils');
    const { token, chatId } = await resolveTelegram(prisma, { scope: 'pl' });
    if (token && chatId) await sendTelegram(token, chatId, tekst);
  } catch (e) { console.error('[faktury-zewn] telegram:', e.message); }
}

const zl = (x) => `${Number(x).toFixed(2).replace('.', ',')} zł`;

/* Kontrahent w CRM: po NIP. Nowy → z danymi z zamówienia i tagiem źródła.
 * Istniejący → dopisujemy tylko puste pola i tag (nie nadpisujemy danych,
 * które ktoś poprawiał w CRM). Na fakturę idą dane Z ZAMÓWIENIA. */
async function kontrahentCrm(prisma, k, zrodlo) {
  const tag = zrodlo;
  // NIP bywa zapisany z prefiksem albo kreskami — szukamy wszystkich postaci,
  // żeby nie założyć drugiej karty tej samej firmy.
  const zKreskami = `${k.nip.slice(0, 3)}-${k.nip.slice(3, 6)}-${k.nip.slice(6, 8)}-${k.nip.slice(8)}`;
  const istn = await prisma.contractor.findFirst({ where: { nip: { in: [k.nip, `PL${k.nip}`, zKreskami] } } });
  if (!istn) {
    return prisma.contractor.create({
      data: { name: k.nazwa, nip: k.nip, address: k.ulica, postCode: k.kod, city: k.miasto, country: 'PL', email: k.email, tags: [tag], source: `${zrodlo}-api` },
    });
  }
  const data = {};
  if (!istn.address) data.address = k.ulica;
  if (!istn.postCode) data.postCode = k.kod;
  if (!istn.city) data.city = k.miasto;
  if (!istn.email && k.email) data.email = k.email;
  if (!(istn.tags || []).includes(tag)) data.tags = [...(istn.tags || []), tag];
  return Object.keys(data).length ? prisma.contractor.update({ where: { id: istn.id }, data }) : istn;
}

/* Numer faktury: iFirma często oddaje sam FakturaId — wtedy szukamy na
 * dzisiejszej liście (jak invoice-confirm). */
async function ustalNumer(odp, ifirma) {
  const raw = odp.ifirmaRaw;
  const ifirmaId = odp.ifirmaId || (raw && raw.response && raw.response.Wynik && raw.response.Wynik.FakturaId) || (raw && raw.response && raw.response.Identyfikator) || null;
  let numer = odp.invoiceNumber || (raw && raw.response && raw.response.Wynik && (raw.response.Wynik.PelnyNumer || raw.response.Wynik.Numer)) || null;
  for (let proba = 1; !numer && ifirmaId && proba <= 3; proba++) {
    try {
      if (proba > 1) await new Promise(r => setTimeout(r, 1500));
      const dzis = new Date().toISOString().slice(0, 10);
      const lista = await ifirma.fetchInvoices({ dataOd: dzis, dataDo: dzis });
      const f = (lista || []).find(x => String(x.FakturaId) === String(ifirmaId));
      if (f) numer = f.PelnyNumer || f.Numer || null;
    } catch (e) { console.error(`[faktury-zewn] numer, próba ${proba}:`, e.message); }
  }
  return { ifirmaId, numer: numer || 'UNKNOWN' };
}

async function pdfFaktury(ifirma, numer, ifirmaId) {
  try {
    const buf = await ifirma.fetchInvoicePdf(numer, 'krajowa', ifirmaId);
    return buf && buf.length ? buf : null;
  } catch (e) {
    console.error('[faktury-zewn] PDF:', e.message);
    return null;
  }
}

function wynikFaktury(inv, pdf) {
  const ex = (inv.extras && typeof inv.extras === 'object') ? inv.extras : {};
  return {
    numer: inv.number, ifirmaId: inv.ifirmaId || null,
    dataWystawienia: inv.issueDate ? new Date(inv.issueDate).toISOString().slice(0, 10) : null,
    terminPlatnosci: inv.dueDate ? new Date(inv.dueDate).toISOString().slice(0, 10) : null,
    netto: ex.suma ? ex.suma.netto : null, vat: ex.suma ? ex.suma.vat : null, brutto: Number(inv.grossAmount), waluta: inv.currency || 'PLN',
    status: inv.status, zaplacono: Number(inv.paidAmount || 0), ksefNumer: inv.ksefNumber || null,
    pdf: pdf ? { nazwa: `faktura_${String(inv.number).replace(/\//g, '_')}.pdf`, base64: pdf.toString('base64') } : null,
  };
}

/* Wystawienie. Zwraca { status, json } do odesłania. */
async function wystaw(prisma, zrodlo, body, deps = {}) {
  const ifirma = deps.ifirma || require('../ifirma-client');
  const lock = require('./confirm-lock');
  const { dane, bledy } = waliduj(body);
  if (bledy) return { status: 400, json: { ok: false, error: 'Niepoprawne zamówienie faktury', bledy } };
  const klucz = `zewn:${zrodlo}:${dane.ref}`;

  // Ten sam ref już wystawiony → ta sama faktura (bez limitów i bez iFirmy).
  const wczesniej = await prisma.confirmLock.findUnique({ where: { key: klucz } }).catch(() => null);
  if (wczesniej && wczesniej.invoiceId) {
    const inv = await prisma.invoice.findUnique({ where: { id: wczesniej.invoiceId } });
    if (inv) return { status: 200, json: { ok: true, duplikat: true, ref: dane.ref, ...wynikFaktury(inv, await pdfFaktury(ifirma, inv.number, inv.ifirmaId)) } };
  }

  if (body && body.proba === true) {
    return { status: 200, json: { ok: true, proba: true, ref: dane.ref, klient: dane.klient, pozycje: dane.linie, trybCen: dane.trybCen, suma: dane.suma, terminDni: dane.terminDni, info: 'Tryb próbny — nic nie wystawiono.' } };
  }

  const lim = await limity(prisma);
  if (dane.suma.netto > lim.maxNettoFaktury) {
    await powiadom(prisma, `🧾 System ${zrodlo}: ODRZUCONO fakturę na ${zl(dane.suma.netto)} netto dla ${dane.klient.nazwa} (limit ${zl(lim.maxNettoFaktury)}). Jeśli to w porządku — wystaw ręcznie albo podnieś limit.`);
    return { status: 422, json: { ok: false, error: `Kwota netto ${dane.suma.netto} PLN ponad limit ${lim.maxNettoFaktury} PLN — faktura nie została wystawiona, właściciel dostał powiadomienie.` } };
  }
  const odPolnocy = new Date(); odPolnocy.setHours(0, 0, 0, 0);
  const dzis = await prisma.invoice.count({ where: { source: `${zrodlo}-api`, createdAt: { gte: odPolnocy } } });
  if (dzis >= lim.maxDziennie) {
    await powiadom(prisma, `🧾 System ${zrodlo}: dzienny limit faktur (${lim.maxDziennie}) wyczerpany — kolejne odrzucane do jutra. Jeśli to nie Ty, zablokuj token.`);
    return { status: 429, json: { ok: false, error: `Dzienny limit ${lim.maxDziennie} faktur wyczerpany — spróbuj jutro.` } };
  }

  const claim = await lock.claimConfirm(prisma, klucz);
  if (claim.state === 'in_progress') return { status: 409, json: { ok: false, error: 'Faktura z tym ref jest właśnie wystawiana — zapytaj ponownie za chwilę (GET z tym samym ref).' } };
  if (claim.state === 'done') {
    const inv = claim.invoiceId ? await prisma.invoice.findUnique({ where: { id: claim.invoiceId } }) : null;
    if (inv) return { status: 200, json: { ok: true, duplikat: true, ref: dane.ref, ...wynikFaktury(inv, await pdfFaktury(ifirma, inv.number, inv.ifirmaId)) } };
    return { status: 409, json: { ok: false, error: 'Faktura z tym ref została wystawiona, ale nie ma jej jeszcze w CRM — sprawdź później (GET z tym ref).' } };
  }

  let utworzona = false;
  try {
    const kontrahent = await kontrahentCrm(prisma, dane.klient, zrodlo);
    let ifirmaIdKontrahenta = null;
    try {
      const { buildIfirmaContractorPayload } = require('./ifirma-payload');
      ifirmaIdKontrahenta = (await buildIfirmaContractorPayload(prisma, kontrahent)).ifirmaId || null;
    } catch (_) { /* bez identyfikatora iFirma dopasuje po NIP */ }
    const payload = { name: dane.klient.nazwa, nip: dane.klient.nip, address: dane.klient.ulica, postCode: dane.klient.kod, city: dane.klient.miasto, country: 'PL', email: dane.klient.email, ifirmaId: ifirmaIdKontrahenta };
    try { await ifirma.upsertContractor(payload); } catch (e) { console.warn('[faktury-zewn] upsertContractor (niekrytyczne):', e.message); }

    const pozycje = dane.linie.map(l => ({
      nazwa: l.nazwa, nazwaPelna: l.nazwa, ilosc: l.ilosc, jednostka: l.jednostka, gtu: l.gtu,
      ...(dane.trybCen === 'netto' ? { cenaNetto: l.cena } : { cena: l.cena }),
    }));
    const odp = await ifirma.createInvoice({ kontrahent: payload, pozycje, rodzaj: 'krajowa', waluta: 'PLN', priceMode: dane.trybCen, paymentDays: dane.terminDni, uwagi: dane.uwagi });
    utworzona = true;
    const { ifirmaId, numer } = await ustalNumer(odp, ifirma);

    const inv = await prisma.invoice.create({
      data: {
        contractorId: kontrahent.id, ifirmaId, number: numer,
        issueDate: new Date(), dueDate: new Date(Date.now() + dane.terminDni * 24 * 3600 * 1000),
        grossAmount: dane.suma.brutto, currency: 'PLN', paidAmount: 0, status: 'unpaid', type: 'krajowa',
        source: `${zrodlo}-api`,
        contractorName: dane.klient.nazwa, contractorNip: dane.klient.nip, contractorCountry: 'PL', contractorCity: dane.klient.miasto,
        extras: {
          zrodlo, ref: dane.ref, suma: dane.suma, trybCen: dane.trybCen,
          items: dane.linie.map(l => ({ name: l.nazwa, qty: l.ilosc, unit: l.jednostka, ean: null, priceNetto: dane.trybCen === 'netto' ? l.cena : r2(l.cena / (1 + VAT)) })),
        },
      },
    });
    await lock.completeConfirm(prisma, klucz, numer, inv.id);

    try {
      const { logActivity } = require('./activity-log');
      logActivity(prisma, {
        type: 'invoice.created', summary: `FV ${numer} (system ${zrodlo}) dla ${dane.klient.nazwa} (${dane.suma.brutto} PLN)`,
        source: 'ifirma', contractorId: kontrahent.id, invoiceId: inv.id, actorType: 'system', actorId: `${zrodlo}-api`,
        payload: { number: numer, ifirmaId, grossAmount: String(dane.suma.brutto), currency: 'PLN', type: 'krajowa', ref: dane.ref, lineCount: dane.linie.length },
        tags: ['country:pl', 'currency:pln', `zrodlo:${zrodlo}`],
      });
    } catch (_) { /* dziennik nieobowiązkowy */ }

    const pdf = await pdfFaktury(ifirma, numer, ifirmaId);
    await powiadom(prisma, `🧾 System ${zrodlo} zamówił fakturę: ${numer}\n${dane.klient.nazwa} (NIP ${dane.klient.nip})\n${zl(dane.suma.netto)} netto · ${zl(dane.suma.brutto)} brutto · termin ${dane.terminDni} dni\n${dane.linie.map(l => `• ${l.nazwa} × ${l.ilosc}`).join('\n')}`);
    return { status: 200, json: { ok: true, duplikat: false, ref: dane.ref, ...wynikFaktury(inv, pdf), pdfDostepny: !!pdf } };
  } catch (e) {
    if (utworzona) {
      // Faktura POWSTAŁA w iFirmie — nie zwalniamy klucza (ponowienie zrobiłoby drugą).
      await lock.completeConfirm(prisma, klucz, 'ISSUED', null).catch(() => {});
      await powiadom(prisma, `⚠️ System ${zrodlo}: faktura dla ${dane.klient.nazwa} powstała w iFirmie, ale nie zapisała się w CRM (${e.message}). Sprawdź iFirmę — ref ${dane.ref}.`);
      return { status: 500, json: { ok: false, error: 'Faktura powstała w iFirmie, ale CRM jej nie zapisał — właściciel sprawdzi. NIE ponawiaj z nowym ref.', ref: dane.ref } };
    }
    await lock.releaseConfirm(prisma, klucz);
    console.error('[faktury-zewn] wystawienie nieudane:', e.message);
    return { status: 502, json: { ok: false, error: `iFirma nie wystawiła faktury: ${String(e.message).slice(0, 300)}. Można ponowić z tym samym ref.` } };
  }
}

/* Stan faktury po ref: numer, kwoty, zapłata, numer KSeF, opcjonalnie PDF. */
async function stan(prisma, zrodlo, ref, { zPdf = false } = {}, deps = {}) {
  const ifirma = deps.ifirma || require('../ifirma-client');
  const r = String(ref || '').trim();
  if (!r) return { status: 400, json: { ok: false, error: 'podaj ref' } };
  const l = await prisma.confirmLock.findUnique({ where: { key: `zewn:${zrodlo}:${r}` } }).catch(() => null);
  if (!l) return { status: 404, json: { ok: false, error: 'brak faktury z tym ref' } };
  if (!l.invoiceId) return { status: 202, json: { ok: true, ref: r, wTrakcie: true, info: 'faktura jest wystawiana albo czeka na zapis w CRM' } };
  const inv = await prisma.invoice.findUnique({ where: { id: l.invoiceId } });
  if (!inv) return { status: 404, json: { ok: false, error: 'faktura zniknęła z CRM' } };
  return { status: 200, json: { ok: true, ref: r, ...wynikFaktury(inv, zPdf ? await pdfFaktury(ifirma, inv.number, inv.ifirmaId) : null) } };
}

module.exports = { zrodloZTokenu, waliduj, wystaw, stan, nipPoprawny, sha256, KLUCZ_TOKENY, KLUCZ_LIMITY, LIMITY_DOMYSLNE };
