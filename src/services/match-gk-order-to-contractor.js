'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.GK_MATCHER_MODEL || 'claude-haiku-4-5-20251001';

// LLM-based fuzzy match between a contractor (canonical billing data we
// have in DB) and a list of GK shipping orders. Carriers' "delivery
// receiver" names often differ from the billing company name (e.g.
// "Ocean Republik Society S.L" vs "Ocean Republik School", same client),
// so token / regex matching misses these pairs. The LLM looks at every
// available signal — name similarity, country match, city, postal code,
// email, NIP — and picks the most likely match (or none).
//
// Returns: { matched: true, index, reason } or { matched: false, reason }
async function matchGkOrderToContractor(contractor, orders) {
  if (!process.env.ANTHROPIC_API_KEY) return { matched: false, reason: 'no_api_key' };
  if (!contractor || !Array.isArray(orders) || orders.length === 0) {
    return { matched: false, reason: 'empty_input' };
  }

  const SCAN_LIMIT = 30;
  const candidates = orders.slice(0, SCAN_LIMIT).map((o, idx) => {
    const r = o.receiverAddress || o.receiver || {};
    return {
      idx,
      name: r.name || null,
      contactPerson: r.contactPerson || null,
      city: r.city || null,
      postCode: r.postCode || r.zipCode || null,
      country: r.countryCode || r.country || null,
      street: r.street || null,
      email: r.email || null,
      phone: r.phone || null,
      date: o.creationDate || o.created_at || o.createdAt || null,
    };
  });

  const cExtras = (typeof contractor.extras === 'object' && contractor.extras) || {};
  const contractorBlob = {
    name: contractor.name || null,
    aliases: cExtras.aliases || [],
    nip: contractor.nip || null,
    country: contractor.country || null,
    city: contractor.city || null,
    email: contractor.email || null,
    phone: contractor.phone || null,
    nipList: cExtras.nipList || [],
    emailList: cExtras.emailList || [],
    phoneList: cExtras.phoneList || [],
  };

  const prompt = `Mam kontrahenta z mojej bazy i listę zamówień kurierskich (GlobKurier). Wybierz które ZAMÓWIENIE jest TYM SAMYM klientem co kontrahent — pomimo że nazwy mogą się różnić (formal vs informal, branding, skrót, literówka, polski vs hiszpański zapis).

KONTRAHENT (z bazy):
${JSON.stringify(contractorBlob, null, 2)}

ZAMÓWIENIA (kandydaci, najświeższe pierwsze):
${JSON.stringify(candidates, null, 2)}

Sygnały do dopasowania (rosnące wagi):
- email zgodny → bardzo silny
- nip zgodny → bardzo silny
- telefon zgodny → silny
- city + country oba zgodne → średni
- name semantycznie podobne ("Ocean Republik Society" vs "Ocean Republik School" — TEN SAM klient) → silny
- sama country zgodna → słaby (za mało, by sam wystarczył)

Odpowiedz TYLKO czystym JSON-em (bez markdown):
{"matched": true, "index": <numer z idx>, "reason": "krótkie uzasadnienie po polsku"}
albo
{"matched": false, "reason": "krótkie wyjaśnienie czemu żaden nie pasuje"}

ZASADY:
- jeśli niepewny → matched=false
- nie dopasowuj na samej country (PL i PL to za mało)
- preferuj najświeższe zamówienie gdy kilka kandydatów wygląda podobnie`;

  let resp;
  try {
    resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (e) {
    return { matched: false, reason: 'claude_error: ' + e.message };
  }

  const text = (resp.content[0] && resp.content[0].text) || '';
  let parsed;
  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return { matched: false, reason: 'parse_failed', raw: text.slice(0, 200) };
  }

  if (!parsed.matched) return { matched: false, reason: parsed.reason || 'no_match' };
  const idx = Number(parsed.index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) {
    return { matched: false, reason: 'invalid_index_' + parsed.index };
  }
  return { matched: true, index: idx, reason: parsed.reason || '' };
}

module.exports = { matchGkOrderToContractor };
