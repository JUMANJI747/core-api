'use strict';

/**
 * CRM v2 Etap 1.5 — wspolne sync hooks dla ifirma-sync / contasimple-sync /
 * gk createOrder / email classifier. Upsert ContractorContact +
 * ContractorAddress idempotentnie z normalizacja.
 *
 * Importowane przez:
 *   - src/services/ifirma-sync.js (po Contractor.create lub przy update)
 *   - src/routes/contasimple.js   (sync-customers + auto-link PL<->ES)
 *   - src/routes/glob-quote.js    (po udanym createOrder)
 *   - src/inbox-poller.js / email classifier (pierwszy kontakt z nowego maila)
 */

function normalizeEmail(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  return s.includes('@') ? s : null;
}

function normalizePhone(v) {
  if (!v) return null;
  const s = String(v).replace(/[\s\-().]/g, '').trim();
  return s.length >= 6 ? s : null;
}

// Nasze wlasne adresy (delivery@/info@/nikodem@ surfstickbell.com) NIE sa
// kontaktami kontrahenta. Trafialy tu z domyslnych nadawcow przy zamowieniu
// kuriera (DEFAULT_RECEIVER_EMAIL) i zasmiecaly kafelek Kontakty oraz
// doklejaly NASZE maile do kontrahenta w widoku 360 (pula matchowania bierze
// kontakty). Domena konfigurowalna przez OWN_EMAIL_DOMAINS (CSV).
const OWN_EMAIL_DOMAINS = (process.env.OWN_EMAIL_DOMAINS || 'surfstickbell.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function isOwnEmail(value) {
  if (!value) return false;
  const at = String(value).toLowerCase().lastIndexOf('@');
  if (at < 0) return false;
  return OWN_EMAIL_DOMAINS.includes(String(value).toLowerCase().slice(at + 1));
}

// Upsert pojedynczego kontaktu. @@unique([contractorId, type, value])
// w schemie zalatwia dedup — pierwsza wartosc z danego typu+value zostaje.
// Aktualizujemy tylko meta-pola (label/personName/source) bo value jest
// kluczem, nie zmieniamy go w place.
async function upsertContact(prisma, contractorId, contact) {
  if (!contractorId || !contact || !contact.type || !contact.value) return null;
  const value = contact.type === 'email'
    ? normalizeEmail(contact.value)
    : (['phone', 'mobile', 'fax', 'whatsapp'].includes(contact.type) ? normalizePhone(contact.value) : String(contact.value).trim());
  if (!value) return null;
  // Nigdy nie zapisuj naszego wlasnego maila jako kontaktu kontrahenta.
  if (contact.type === 'email' && isOwnEmail(value)) return null;

  try {
    return await prisma.contractorContact.upsert({
      where: { contractorId_type_value: { contractorId, type: contact.type, value } },
      update: {
        // tylko domknij brakujace meta — nie nadpisuj jak juz ustawione,
        // bo NocoDB / wczesniejsze zrodlo moglo ladniej oznaczyc.
        ...(contact.label ? { label: contact.label } : {}),
        ...(contact.personName ? { personName: contact.personName } : {}),
      },
      create: {
        contractorId,
        type: contact.type,
        value,
        label: contact.label || null,
        personName: contact.personName || null,
        isPrimary: !!contact.isPrimary,
        source: contact.source || 'sync',
        notes: contact.notes || null,
        extras: contact.extras || {},
      },
    });
  } catch (e) {
    console.error('[contractor-sync] upsertContact failed:', e.message, contact);
    return null;
  }
}

// ContractorAddress nie ma @@unique — robimy soft-dedup po znormalizowanym
// (type + street + city + postCode). Dopasowanie ignoruje case, bialy
// znak, znaki diakrytyczne (z polskimi/hiszpanskimi accents).
function normAddrKey(addr) {
  const norm = (s) => (s == null ? '' : String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim());
  return [addr.type || 'other', norm(addr.street), norm(addr.city), norm(addr.postalCode)].join('|');
}

async function upsertAddress(prisma, contractorId, addr) {
  if (!contractorId || !addr || !addr.type) return null;
  // Wymagamy zeby cokolwiek bylo wpisane — same type='delivery' bez ulicy
  // nie jest adresem.
  const hasContent = addr.street || addr.city || addr.postalCode || addr.fullAddress;
  if (!hasContent) return null;

  try {
    const wantedKey = normAddrKey(addr);
    const existing = await prisma.contractorAddress.findMany({
      where: { contractorId, type: addr.type },
      select: { id: true, street: true, city: true, postalCode: true, country: true },
    });
    const match = existing.find(e => normAddrKey({ type: addr.type, ...e }) === wantedKey);
    if (match) {
      // mamy juz taki adres — tylko domknij brakujace pola (country/lat/lng/
      // recipientName) nie tracac wartosci ktore ktos recznie wpisal.
      const data = {};
      if (addr.recipientName && !match.recipientName) data.recipientName = addr.recipientName;
      if (addr.country && !match.country) data.country = addr.country;
      if (addr.lat != null && !match.lat) data.lat = addr.lat;
      if (addr.lng != null && !match.lng) data.lng = addr.lng;
      if (Object.keys(data).length) {
        return await prisma.contractorAddress.update({ where: { id: match.id }, data });
      }
      return match;
    }
    return await prisma.contractorAddress.create({
      data: {
        contractorId,
        type: addr.type,
        label: addr.label || null,
        isPrimary: !!addr.isPrimary,
        recipientName: addr.recipientName || null,
        street: addr.street || null,
        houseNumber: addr.houseNumber || null,
        postalCode: addr.postalCode || null,
        city: addr.city || null,
        region: addr.region || null,
        country: addr.country || null,
        countryName: addr.countryName || null,
        fullAddress: addr.fullAddress || null,
        lat: addr.lat != null ? Number(addr.lat) : null,
        lng: addr.lng != null ? Number(addr.lng) : null,
        geocodingStatus: addr.geocodingStatus || null,
        source: addr.source || 'sync',
        extras: addr.extras || {},
      },
    });
  } catch (e) {
    console.error('[contractor-sync] upsertAddress failed:', e.message, addr);
    return null;
  }
}

// Auto-link PL <-> ES gdy znajdziemy NIF (po normalizacji prefixu kraju)
// pasujacy do Contractor.nip. Idempotent — jezeli linkedEsContractorId
// juz wskazuje, nie ruszamy.
async function tryAutoLinkEs(prisma, esContractor) {
  if (!esContractor || !esContractor.id || !esContractor.nif) return false;
  const cleanNif = String(esContractor.nif).replace(/[\s\-.]/g, '').toUpperCase();
  // Spr po dokladnym NIP-ie i bez prefixu kraju (czesto Contasimple ma "ES12345"
  // a iFirma "12345").
  const candidates = await prisma.contractor.findMany({
    where: {
      OR: [
        { nip: cleanNif },
        { nip: cleanNif.replace(/^[A-Z]{2}/, '') },
      ],
    },
    select: { id: true, nip: true, linkedEsContractorId: true },
  });
  if (candidates.length !== 1) return false; // ambiguous lub brak — link tylko 1-1
  const c = candidates[0];
  if (c.linkedEsContractorId && c.linkedEsContractorId !== esContractor.id) {
    console.warn(`[contractor-sync] PL ${c.id} already linked to ES ${c.linkedEsContractorId}, skipping link to ${esContractor.id}`);
    return false;
  }
  if (c.linkedEsContractorId === esContractor.id) return true; // juz
  try {
    await prisma.contractor.update({
      where: { id: c.id },
      data: { linkedEsContractorId: esContractor.id },
    });
    console.log(`[contractor-sync] auto-linked PL ${c.id} (nip=${c.nip}) <-> ES ${esContractor.id} (nif=${esContractor.nif})`);
    return true;
  } catch (e) {
    console.error('[contractor-sync] auto-link failed:', e.message);
    return false;
  }
}

// Append alias do Contractor.aliases jezeli nowy. Sanity: 2-80 znakow,
// nie URL, nie email. Idempotent po lowercase comparison.
async function appendAlias(prisma, contractorId, newAlias, source = 'sync') {
  if (!contractorId || !newAlias) return false;
  const a = String(newAlias).trim();
  if (a.length < 2 || a.length > 80) return false;
  if (/^https?:\/\//i.test(a)) return false;
  if (/@/.test(a) && /\./.test(a)) return false; // probably email

  try {
    const c = await prisma.contractor.findUnique({
      where: { id: contractorId },
      select: { name: true, aliases: true },
    });
    if (!c) return false;
    const lower = a.toLowerCase();
    if (c.name && c.name.toLowerCase() === lower) return false; // ta sama nazwa
    if ((c.aliases || []).some(x => x.toLowerCase() === lower)) return false;
    await prisma.contractor.update({
      where: { id: contractorId },
      data: { aliases: { push: a } },
    });
    console.log(`[contractor-sync] alias added "${a}" -> contractor ${contractorId} (source=${source})`);
    return true;
  } catch (e) {
    console.error('[contractor-sync] appendAlias failed:', e.message);
    return false;
  }
}

module.exports = {
  upsertContact,
  upsertAddress,
  tryAutoLinkEs,
  appendAlias,
  normalizeEmail,
  normalizePhone,
  isOwnEmail,
};
