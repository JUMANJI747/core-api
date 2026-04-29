'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ADDRESS_EXTRACTOR_MODEL || 'claude-haiku-4-5-20251001';

// Pull a delivery address out of the most recent inbound emails from a
// contractor. Goal: when the user types "wyślij paczkę do X" and we have
// no saved location for X, search their email signatures / body text for
// a real delivery address and persist it.
//
// Returns: { found: true, address: { street, houseNumber, city, postCode, country, contactPerson, phone, source: 'email <id>' } }
//       or { found: false, reason }
async function findAddressInContractorEmails(prisma, contractorId, opts = {}) {
  if (!process.env.ANTHROPIC_API_KEY) return { found: false, reason: 'no_api_key' };
  if (!contractorId) return { found: false, reason: 'no_contractor_id' };

  const limit = opts.limit || 10;
  const emails = await prisma.email.findMany({
    where: { contractorId, direction: 'INBOUND' },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, fromEmail: true, fromName: true, subject: true, bodyFull: true, bodyPreview: true, createdAt: true },
  });

  if (!emails.length) return { found: false, reason: 'no_inbound_emails' };

  // Trim each body to keep prompt small (signatures and addresses live
  // near the bottom; first ~400 chars rarely contain them, but we keep
  // some lead-in). 4000 chars per email is enough for a typical signature.
  const blocks = emails.map((e, i) => {
    const body = (e.bodyFull || e.bodyPreview || '').slice(0, 4000);
    return `--- Email ${i + 1} (id=${e.id}, from=${e.fromName || ''} <${e.fromEmail}>, ${e.createdAt.toISOString().slice(0, 10)}) ---\nSubject: ${e.subject || '(no subject)'}\n\n${body}`;
  }).join('\n\n');

  const prompt = `Przeszukaj poniższe maile od kontrahenta i znajdź adres DOSTAWY (nie billing/rozliczeniowy — adres pod który należy wysłać paczkę). Adres typowo jest w stopce maila, w treści po słowach typu "ship to", "delivery", "dostawa", "wysyłka", "send to", albo w podpisie/wizytówce.

Odpowiedz TYLKO czystym JSON-em w formacie:
{"found": true, "street": "...", "houseNumber": "...", "city": "...", "postCode": "...", "country": "ES", "contactPerson": "...", "phone": "...", "sourceEmailId": "uuid maila z którego wzięto adres"}
albo
{"found": false, "reason": "krótkie wyjaśnienie"}

ZASADY:
- country jako kod ISO-2 (PL, ES, DE, FR, ...)
- houseNumber osobno od street (np. street="Avenida Leopoldo Calvo Sotelo", houseNumber="5")
- jeśli kilka różnych adresów w mailach → wybierz NAJNOWSZY (z maila z najświeższą datą)
- jeśli niepewny → {"found": false, ...}
- nie zmyślaj, nie zgaduj — tylko jeśli adres jest jasno widoczny

MAILE:
${blocks}`;

  let resp;
  try {
    resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (e) {
    return { found: false, reason: 'claude_error: ' + e.message };
  }

  const text = (resp.content[0] && resp.content[0].text) || '';
  let parsed;
  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return { found: false, reason: 'parse_failed', raw: text };
  }

  if (!parsed.found) return { found: false, reason: parsed.reason || 'not_found_in_emails' };

  return {
    found: true,
    address: {
      street: parsed.street || null,
      houseNumber: parsed.houseNumber || null,
      city: parsed.city || null,
      postCode: parsed.postCode || null,
      country: parsed.country || null,
      contactPerson: parsed.contactPerson || null,
      phone: parsed.phone || null,
      email: null,
      source: parsed.sourceEmailId ? `email ${parsed.sourceEmailId}` : 'email',
      addedAt: new Date().toISOString(),
    },
  };
}

// Persist a found address to contractor.extras.locations[] (idempotent on
// street+city+postCode), so future quotes don't repeat the email scan.
async function saveAddressToContractorLocations(prisma, contractorId, address) {
  const c = await prisma.contractor.findUnique({ where: { id: contractorId } });
  if (!c) return false;
  const extras = (typeof c.extras === 'object' && c.extras) || {};
  const locations = Array.isArray(extras.locations) ? [...extras.locations] : [];
  const norm = (s) => (s || '').toString().toLowerCase().trim();
  const dup = locations.find(l =>
    norm(l.street) === norm(address.street) &&
    norm(l.city) === norm(address.city) &&
    norm(l.postCode) === norm(address.postCode)
  );
  if (dup) return false;
  locations.push(address);
  await prisma.contractor.update({
    where: { id: contractorId },
    data: { extras: { ...extras, locations } },
  });
  return true;
}

module.exports = { findAddressInContractorEmails, saveAddressToContractorLocations };
