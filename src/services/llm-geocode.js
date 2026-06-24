'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: Number(process.env.ANTHROPIC_MAX_RETRIES) || 5 });
const MODEL = process.env.LLM_GEOCODE_MODEL || 'claude-haiku-4-5-20251001';

const SYSTEM = `You normalise messy invoice addresses to a clean form a geocoder can find.
Return STRICT JSON: { "city": "...", "country": "...", "postalCode": "...", "confidence": 0..1 }.
- city: just the locality name (no postal code, no province, no comma)
- country: full English name (e.g. "Spain", "Poland", "Germany")
- postalCode: digits/letters only or empty string
- confidence: 0..1, how confident you are this is correctly parsed
Examples:
  Input: "Calle Las Bajas 73, 35119 Pozo Izquierdo, Las Palmas"
  Output: { "city": "Pozo Izquierdo", "country": "Spain", "postalCode": "35119", "confidence": 0.95 }
  Input: "ul. Mariacka 17/4 80-833 Gdańsk"
  Output: { "city": "Gdańsk", "country": "Poland", "postalCode": "80-833", "confidence": 0.95 }
  Input: "junk text no real address"
  Output: { "city": "", "country": "", "postalCode": "", "confidence": 0 }
Return ONLY the JSON, no prose.`;

async function normalizeAddress(rawText) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!rawText || typeof rawText !== 'string') return null;
  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 256,
      system: SYSTEM,
      messages: [{ role: 'user', content: rawText.slice(0, 500) }],
    });
    const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.city || !parsed.country) return null;
    return parsed;
  } catch (e) {
    console.error('[llm-geocode] failed:', e.message);
    return null;
  }
}

module.exports = { normalizeAddress };
