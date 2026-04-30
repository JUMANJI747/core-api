'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.SHIPMENT_MATCHER_MODEL || 'claude-haiku-4-5-20251001';

// Fuzzy match GlobKurier orders against a free-form user query.
// Used when the deterministic search (substring / collapsed / tokens)
// returns zero — typical case is a voice transcription artifact:
// "Holaola" → "Olaola", "Ocean Republik" → "Okean Republic".
//
// Returns: { matched: true, indices: [n, n, ...], reason } or
//          { matched: false, reason }
async function matchShipmentsByQuery(query, orders, opts = {}) {
  if (!process.env.ANTHROPIC_API_KEY) return { matched: false, reason: 'no_api_key' };
  if (!query || !Array.isArray(orders) || orders.length === 0) {
    return { matched: false, reason: 'empty_input' };
  }

  const SCAN_LIMIT = opts.scanLimit || 150;
  const MAX_HITS = opts.maxHits || 5;
  const candidates = orders.slice(0, SCAN_LIMIT).map((o, idx) => {
    const r = o.receiverAddress || o.receiver || {};
    const c = o.carrier || {};
    return {
      idx,
      number: o.number || o.orderNumber || null,
      name: r.name || null,
      contactPerson: r.contactPerson || null,
      city: r.city || null,
      country: r.countryCode || r.country || null,
      tracking: o.trackingNumber || o.tracking || null,
      carrier: typeof c === 'object' ? (c.name || null) : c,
      date: o.creationDate || o.created_at || o.createdAt || null,
    };
  });

  const prompt = `User pyta o paczkę kurierską — w wiadomości może być literówka, niepoprawna transkrypcja głosowa, skrót, branding albo inna kolejność słów. Wybierz które ZAMÓWIENIA z poniższej listy najprawdopodobniej dotyczą tego, o co pyta.

USER PYTA: "${query}"

ZAMÓWIENIA:
${JSON.stringify(candidates, null, 2)}

Sygnały do dopasowania:
- nazwa odbiorcy semantycznie podobna ("Okean Republik" → "Ocean Republik School")
- contactPerson lub fragment nazwy
- numer GK / tracking number jeśli user podał liczby
- miasto + kraj jeśli user podał lokalizację
- partial match z literówką ("holaola" → "Hola Ola")

Odpowiedz TYLKO czystym JSON-em (bez markdown):
{"matched": true, "indices": [<idx>, <idx>, ...], "reason": "krótkie uzasadnienie po polsku"}
albo
{"matched": false, "reason": "krótkie wyjaśnienie czemu żaden nie pasuje"}

ZASADY:
- max ${MAX_HITS} wyników, najpewniejsze pierwsze
- jeśli niepewny → matched=false (lepiej powiedzieć "brak" niż zgadnąć)
- tylko realne semantyczne dopasowania — pojedyncza zgodna litera nie wystarczy
- preferuj najnowsze gdy kilka pasuje równie dobrze`;

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
  const indices = Array.isArray(parsed.indices) ? parsed.indices.filter(i => Number.isInteger(i) && i >= 0 && i < candidates.length) : [];
  if (indices.length === 0) return { matched: false, reason: 'invalid_indices' };
  return { matched: true, indices: indices.slice(0, MAX_HITS), reason: parsed.reason || '' };
}

module.exports = { matchShipmentsByQuery };
