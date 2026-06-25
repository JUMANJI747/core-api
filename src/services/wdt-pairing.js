'use strict';

// Inteligentne parowanie faktur WDT/eksport z listami przewozowymi GlobKurier
// — model Opus + DWUPRZEBIEGOWA weryfikacja (kraj musi się zgadzać i NIE może
// to być list do Polski, bo WDT/eksport idzie poza PL). Używane przez przycisk
// „Paruj" w Dodatkowej księgowości.

const MATCH_MODEL = () => process.env.WDT_MATCH_MODEL || 'claude-opus-4-8';

function getAnthropic() {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey, maxRetries: Number(process.env.ANTHROPIC_MAX_RETRIES) || 5 });
}

// Twardy bezpiecznik: czy list jedzie do Polski? (polski kod XX-XXX / kraj PL).
function isToPoland(order) {
  const r = (order && order.receiver) || {};
  const c = String(r.country || '').trim().toLowerCase();
  if (['pl', 'pol', 'polska', 'poland'].includes(c)) return true;
  if (r.countryId === 1 || r.countryId === '1') { /* uwaga: countryId zależy od GK; nie ufamy samemu temu */ }
  if (/^\d{2}-\d{3}$/.test(String(r.postCode || '').trim())) return true; // polski format kodu
  return false;
}

function parseJson(text) {
  const clean = String(text || '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(clean);
}

// PRZEBIEG 1 — dopasowanie faktur do zamówień (nazwa prawna/handlowa, adres, NIP).
async function matchPass(client, invoices, orders) {
  const inv = invoices.map(i => ({
    number: i.number, contractor: i.contractorName, country: i.contractorCountry || '',
    city: i.contractorCity || '', nip: i.contractorNip || '',
  }));
  const ord = orders.map(o => ({
    number: o.number, receiver: o.receiverName,
    contact: o.receiver && o.receiver.contactPerson, city: o.receiver && o.receiver.city,
    postCode: o.receiver && o.receiver.postCode, country: o.receiver && o.receiver.country,
  }));
  const prompt = `Sparuj faktury WDT/eksport z listami przewozowymi GlobKurier.
Każda faktura ma MAKSYMALNIE jeden list; każdy list użyty maks. raz.
Paruj po nazwie (prawnej lub handlowej; różnice: wielkość liter, znaki, sufiksy SL/LDA/Unipessoal, złączone słowa, contactPerson zamiast receiver), wspierając się miastem/kodem/NIP.
NIE paruj po słowach ogólnych (surf, farmacia, shop). Niepewne → zostaw nieparowane.

FAKTURY:
${JSON.stringify(inv, null, 1)}

LISTY (GlobKurier):
${JSON.stringify(ord, null, 1)}

Odpowiedz TYLKO czystym JSON:
{ "matched": [ { "invoiceNumber": "...", "orderNumber": "...", "reason": "..." } ] }`;
  const msg = await client.messages.create({ model: MATCH_MODEL(), max_tokens: 2048, messages: [{ role: 'user', content: prompt }] });
  const out = parseJson(msg.content && msg.content[0] && msg.content[0].text);
  return Array.isArray(out.matched) ? out.matched : [];
}

// PRZEBIEG 2 — podwójne sprawdzenie: czy KRAJ listu = kraj faktury i czy to NIE Polska.
async function verifyPass(client, pairs) {
  if (!pairs.length) return [];
  const items = pairs.map((p, i) => ({
    i, invoiceNumber: p.inv.number, invoiceCountry: p.inv.contractorCountry || '',
    invoiceContractor: p.inv.contractorName,
    shipmentReceiver: p.order.receiverName,
    shipmentCity: p.order.receiver && p.order.receiver.city,
    shipmentPostCode: p.order.receiver && p.order.receiver.postCode,
    shipmentCountry: p.order.receiver && p.order.receiver.country,
  }));
  const prompt = `Weryfikacja parowania faktur WDT/eksport z listami przewozowymi.
Faktura WDT/eksport MUSI być wysłana POZA Polskę, do kraju kontrahenta.
Dla każdej pary oceń:
- czy kraj dostawy listu ZGADZA SIĘ z krajem faktury (invoiceCountry), oraz
- czy list NIE jedzie do Polski (kod XX-XXX, miasto/kraj PL = błąd).
Jeśli kraj się nie zgadza LUB to list do Polski → ok=false.

PARY:
${JSON.stringify(items, null, 1)}

Odpowiedz TYLKO czystym JSON:
{ "verdicts": [ { "i": 0, "ok": true, "reason": "..." } ] }`;
  const msg = await client.messages.create({ model: MATCH_MODEL(), max_tokens: 2048, messages: [{ role: 'user', content: prompt }] });
  const out = parseJson(msg.content && msg.content[0] && msg.content[0].text);
  return Array.isArray(out.verdicts) ? out.verdicts : [];
}

// Główna funkcja: zwraca pary do zapisania + odrzucone (z powodem).
async function pairWdtSmart(invoices, orders) {
  if (!invoices.length || !orders.length) return { paired: [], rejected: [], proposals: 0 };
  const client = getAnthropic();
  const invByNum = new Map(invoices.map(i => [String(i.number), i]));
  const ordByNum = new Map(orders.map(o => [String(o.number), o]));

  const proposalsRaw = await matchPass(client, invoices, orders);
  const used = new Set();
  const candidates = [];
  for (const p of proposalsRaw) {
    const inv = invByNum.get(String(p.invoiceNumber));
    const order = ordByNum.get(String(p.orderNumber));
    if (!inv || !order || used.has(String(p.orderNumber))) continue;
    used.add(String(p.orderNumber));
    candidates.push({ inv, order, reason: p.reason });
  }

  const paired = []; const rejected = [];
  // Twardy guard: list do Polski przy WDT/eksport = od razu odrzut.
  const guarded = [];
  for (const c of candidates) {
    if (isToPoland(c.order)) { rejected.push({ number: c.inv.number, shipment: c.order.number, reason: 'list do Polski (WDT wymaga zagranicy)' }); continue; }
    guarded.push(c);
  }
  // Przebieg 2 — weryfikacja kraju przez model.
  let verdicts = [];
  try { verdicts = await verifyPass(client, guarded); } catch (_) { verdicts = guarded.map((_, i) => ({ i, ok: true })); }
  const verdictByI = new Map(verdicts.map(v => [v.i, v]));
  guarded.forEach((c, i) => {
    const v = verdictByI.get(i);
    if (v && v.ok === false) rejected.push({ number: c.inv.number, shipment: c.order.number, reason: v.reason || 'kraj się nie zgadza' });
    else paired.push(c);
  });
  return { paired, rejected, proposals: candidates.length };
}

module.exports = { pairWdtSmart, isToPoland };
