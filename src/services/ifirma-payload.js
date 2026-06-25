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

  const street = contractor.address
    || (billingAddr && billingAddr.street)
    || billing.street
    || cExtras.street
    || '';

  const city = contractor.city
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

  const country = contractor.country
    || (billingAddr && billingAddr.country)
    || billing.country
    || '';

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
