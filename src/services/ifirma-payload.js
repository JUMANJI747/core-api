'use strict';

const { extractPostCode } = require('../utils/address');

// Buduje payload do ifirma-client.upsertContractor + createInvoice Kontrahent
// na podstawie lokalnego Contractor + ContractorAddress (billing) + extras.
//
// Wczesniej te bloki byly duplikowane w 3 miejscach:
//   - invoices.js: invoice-confirm-latest (przy upsert + createInvoice payload)
//   - invoices.js: invoice-confirm (przy upsert + createInvoice payload)
//   - invoices.js: POST /api/ifirma/contractors/sync/:id (manual force-push)
// Helper centralizuje fallback chain:
//
//   1. Strukturalne: ContractorAddress.postalCode (CRM v2 normalized table,
//      wpisywane przez POST /:id/delivery-address lub backfill).
//   2. Legacy: extras.billingAddress.postCode (extras canonical billing).
//   3. Ad-hoc: extras.{postCode, zipCode, postalCode} (rozne wersje agenta).
//   4. Regex z address blob jako last resort — agent wrzuca caly adres
//      jako jeden string i nie rozbija na components.
//
// Zwraca: { name, nip, address, city, postCode, country, email, phone, ifirmaId }
async function buildIfirmaContractorPayload(prisma, contractor) {
  if (!contractor) throw new Error('buildIfirmaContractorPayload: contractor required');

  const cExtras = contractor.extras || {};
  const cExternalIds = contractor.externalIds || {};
  const billing = (cExtras.billingAddress && typeof cExtras.billingAddress === 'object')
    ? cExtras.billingAddress : {};

  // ContractorAddress (CRM v2) — primary billing, najnowsze updatedAt first.
  const billingAddr = await prisma.contractorAddress.findFirst({
    where: { contractorId: contractor.id, type: 'billing' },
    orderBy: [{ isPrimary: 'desc' }, { updatedAt: 'desc' }],
  }).catch(() => null);

  let street = contractor.address
    || (billingAddr && billingAddr.street)
    || billing.street
    || cExtras.street
    || '';

  let city = contractor.city
    || (billingAddr && billingAddr.city)
    || billing.city
    || cExtras.city
    || '';

  let postCode = contractor.postCode
    || (billingAddr && billingAddr.postalCode)
    || billing.postCode
    || cExtras.postCode
    || cExtras.zipCode
    || cExtras.postalCode
    || '';
  if (!postCode) {
    const blob = [street, city, contractor.address].filter(Boolean).join(' ');
    postCode = extractPostCode(blob) || '';
  }
  // Kod z adresu DOSTAWY / extras.locations — częsty przypadek (Uhaina):
  // billing bez kodu, ale delivery ma pełny adres z kodem (zwykle ten sam
  // budynek). Lepszy kod z dostawy niż odrzucona FV.
  if (!postCode) {
    try {
      const anyAddr = await prisma.contractorAddress.findFirst({
        where: { contractorId: contractor.id, postalCode: { not: null } },
        orderBy: [{ isPrimary: 'desc' }, { updatedAt: 'desc' }],
        select: { postalCode: true, city: true, street: true },
      });
      if (anyAddr && anyAddr.postalCode) {
        postCode = anyAddr.postalCode;
        city = city || anyAddr.city || '';
        street = street || anyAddr.street || '';
        console.log(`[ifirma-payload] kod pocztowy z adresu dostawy dla ${contractor.name}: ${postCode}`);
      }
    } catch (_) { /* nieistotne */ }
  }
  if (!postCode && Array.isArray(cExtras.locations)) {
    const loc = cExtras.locations.find(l => l && l.postCode);
    if (loc) {
      postCode = loc.postCode;
      city = city || loc.city || '';
      street = street || loc.street || '';
      console.log(`[ifirma-payload] kod pocztowy z extras.locations dla ${contractor.name}: ${postCode}`);
    }
  }

  let country = contractor.country
    || (billingAddr && billingAddr.country)
    || billing.country
    || '';

  // ODZYSKIWANIE danych adresowych, gdy TEGO rekordu brakuje (np. duplikat
  // „Surf Point" bez kodu, a pełne dane są na „Surfpoint Sp. z o.o."). Firma
  // była już fakturowana → kod jest albo na duplikacie po tym samym NIP
  // (lokalnie), albo w iFirmie (po NIP). Dociągamy, zamiast od razu wywalać
  // „Brak kodu pocztowego".
  if ((!postCode || !city || !street) && contractor.nip) {
    // 1) Lokalny duplikat po NIP
    try {
      const siblings = await prisma.contractor.findMany({
        where: { nip: contractor.nip, NOT: { id: contractor.id } },
        select: { address: true, city: true, postCode: true, country: true, extras: true },
      });
      for (const s of siblings) {
        const sBa = (s.extras && s.extras.billingAddress && typeof s.extras.billingAddress === 'object') ? s.extras.billingAddress : {};
        postCode = postCode || s.postCode || sBa.postCode || '';
        city = city || s.city || sBa.city || '';
        street = street || s.address || sBa.street || '';
        country = country || s.country || sBa.country || '';
        if (postCode && city && street) break;
      }
    } catch (e) { console.warn('[ifirma-payload] recovery (duplikat NIP) nieudane:', e.message); }
    // 2) iFirma po NIP (firma była fakturowana → ma tam pełny adres)
    if (!postCode) {
      try {
        const ifc = require('../ifirma-client');
        const remote = await ifc.findContractorInList(contractor.nip);
        if (remote) {
          postCode = postCode || remote.KodPocztowy || '';
          city = city || remote.Miejscowosc || '';
          street = street || remote.Ulica || '';
        }
      } catch (e) { console.warn('[ifirma-payload] recovery (iFirma po NIP) nieudane:', e.message); }
    }
    // 3) Szczegóły OSTATNIEJ faktury tego kontrahenta w iFirmie — detail FV
    //    zawiera PEŁNY blok Kontrahent (KodPocztowy/Ulica/NumerDomu/
    //    Miejscowosc/Kraj). Kluczowe dla kontrahentów z importu historii
    //    (sync-history): lista FV nie ma adresów, a lista kontrahentów w
    //    iFirmie bywa niedopasowywalna po NIP z literami (np. IE 9667773J).
    if (!postCode && contractor.id) {
      try {
        const histInv = await prisma.invoice.findFirst({
          where: { contractorId: contractor.id, ifirmaId: { not: null } },
          orderBy: { issueDate: 'desc' },
          select: { ifirmaId: true, ifirmaType: true, type: true },
        });
        if (histInv) {
          const { fetchInvoiceDetails } = require('../ifirma-client');
          const det = await fetchInvoiceDetails(histInv.ifirmaId, histInv.ifirmaType || histInv.type);
          const k = det && det.Kontrahent;
          if (k) {
            postCode = postCode || k.KodPocztowy || '';
            city = city || k.Miejscowosc || '';
            street = street || [k.Ulica, k.NumerDomu].filter(Boolean).join(' ') || '';
            country = country || k.Kraj || '';
            if (postCode) console.log(`[ifirma-payload] adres odzyskany z detali FV ${histInv.ifirmaId} dla ${contractor.name}`);
          }
        }
      } catch (e) { console.warn('[ifirma-payload] recovery (detal FV) nieudane:', e.message); }
    }
    if (postCode) console.log(`[ifirma-payload] odzyskano adres dla NIP ${contractor.nip} (${contractor.name}): kod=${postCode} miasto=${city}`);

    // UTRWAL odzyskany adres na kontrahencie (best-effort) — karta przestaje
    // świecić „Adresy: Brak" i następne wystawienie nie musi znów pytać iFirmy.
    if (postCode && contractor.id && !contractor.postCode) {
      try {
        const { normalizeIso } = require('./country-helper');
        await prisma.contractor.update({
          where: { id: contractor.id },
          data: {
            postCode,
            ...(city && !contractor.city ? { city } : {}),
            ...(street && !contractor.address ? { address: street } : {}),
            ...(country && !contractor.country ? { country: normalizeIso(country) || country } : {}),
          },
        });
        console.log(`[ifirma-payload] odzyskany adres utrwalony na kontrahencie ${contractor.name}`);
      } catch (e) { console.warn('[ifirma-payload] utrwalenie adresu nieudane:', e.message); }
    }
  }

  // Gdy kraju brak w danych, a kontrahent jest ewidentnie zagraniczny — dobierz
  // z prefiksu NIP UE (np. DK...) lub sufiksu formy prawnej (ApS → Dania).
  // Potrzebne, by FV krajowa dla zagranicznego klienta (np. duński w PLN) miała
  // poprawny Kraj i iFirma nie odrzuciła kodu pocztowego jako polskiego.
  if (!country) {
    try {
      const { nipPrefixToCountry, legalFormToCountry } = require('./country-helper');
      country = nipPrefixToCountry(contractor.nip) || legalFormToCountry(contractor.name) || '';
      if (country) console.log(`[ifirma-payload] kraj dobrany z sygnału (NIP/forma prawna) dla ${contractor.name}: ${country}`);
    } catch (_) { /* nieistotne */ }
  }

  const ifirmaId = cExternalIds.ifirmaIdentifier
    || cExtras.ifirmaId
    || null;

  return {
    name: contractor.name,
    nip: contractor.nip,
    address: street,
    city,
    postCode,
    country,
    email: contractor.primaryEmail || contractor.email || '',
    phone: contractor.phone || '',
    ifirmaId,
  };
}

module.exports = { buildIfirmaContractorPayload };
