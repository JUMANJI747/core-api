'use strict';

// Scala kontrahenta `dropId` w `keepId`: przepina kontakty/adresy/FK
// (Email/Invoice/InvoiceLineItem/Transaction/Deal/Consignment), łączy aliasy/
// externalIds/linkedEs, uzupełnia braki na keep, kasuje drop, pisze AuditLog.
// Wyciągnięte z routes/admin.js, żeby używać też przy auto-merge w upsercie i
// przy dedupe po NIP. Zwraca statystyki. Rzuca przy błędzie/nieistniejących id.
async function mergeContractors(prisma, keepId, dropId) {
  if (!keepId || !dropId) throw new Error('keepId i dropId wymagane');
  if (keepId === dropId) throw new Error('keepId == dropId');

  const [keep, drop] = await Promise.all([
    prisma.contractor.findUnique({ where: { id: keepId } }),
    prisma.contractor.findUnique({ where: { id: dropId } }),
  ]);
  if (!keep) throw new Error(`keep (${keepId}) nie istnieje`);
  if (!drop) throw new Error(`drop (${dropId}) nie istnieje`);

  const stats = { aliasesAdded: 0, externalIdsMerged: 0 };

  // 1) Contacts — przepięcie z dedup po @@unique[contractorId,type,value].
  const dropContacts = await prisma.contractorContact.findMany({ where: { contractorId: dropId } });
  let contactsMoved = 0, contactsSkipped = 0;
  for (const ct of dropContacts) {
    try {
      await prisma.contractorContact.upsert({
        where: { contractorId_type_value: { contractorId: keepId, type: ct.type, value: ct.value } },
        update: {},
        create: {
          contractorId: keepId, type: ct.type, value: ct.value,
          label: ct.label, personName: ct.personName, isPrimary: ct.isPrimary,
          source: ct.source || 'merge', notes: ct.notes, extras: ct.extras || {},
        },
      });
      contactsMoved++;
    } catch (e) {
      console.error('[merge] contact dedup failed:', e.message, ct.id);
      contactsSkipped++;
    }
  }
  await prisma.contractorContact.deleteMany({ where: { contractorId: dropId } });

  // 2) Addresses — normalizacja przez contractor-sync-helpers.
  const { upsertAddress } = require('./contractor-sync-helpers');
  const dropAddresses = await prisma.contractorAddress.findMany({ where: { contractorId: dropId } });
  let addressesMoved = 0;
  for (const a of dropAddresses) {
    const result = await upsertAddress(prisma, keepId, {
      type: a.type, label: a.label, isPrimary: a.isPrimary,
      recipientName: a.recipientName, street: a.street, houseNumber: a.houseNumber,
      postalCode: a.postalCode, city: a.city, region: a.region,
      country: a.country, countryName: a.countryName, fullAddress: a.fullAddress,
      lat: a.lat, lng: a.lng, geocodingStatus: a.geocodingStatus,
      source: a.source || 'merge', extras: a.extras || {},
    });
    if (result) addressesMoved++;
  }
  await prisma.contractorAddress.deleteMany({ where: { contractorId: dropId } });

  // 3) Twarde FK.
  const [emails, invoices, invoiceLines, transactions, deals, consignments] = await Promise.all([
    prisma.email.updateMany({ where: { contractorId: dropId }, data: { contractorId: keepId } }),
    prisma.invoice.updateMany({ where: { contractorId: dropId }, data: { contractorId: keepId } }),
    prisma.invoiceLineItem.updateMany({ where: { contractorId: dropId }, data: { contractorId: keepId } }),
    prisma.transaction.updateMany({ where: { contractorId: dropId }, data: { contractorId: keepId } }),
    prisma.deal.updateMany({ where: { contractorId: dropId }, data: { contractorId: keepId } }),
    prisma.consignment.updateMany({ where: { contractorId: dropId }, data: { contractorId: keepId } }),
  ]);

  // 4) Aliases — keep.aliases ∪ drop.aliases + drop.name.
  const aliasesAfter = [...(keep.aliases || [])];
  const lower = new Set(aliasesAfter.map(a => a.toLowerCase()));
  if (keep.name) lower.add(keep.name.toLowerCase());
  const pushIfNovel = (a) => {
    if (!a) return;
    const s = String(a).trim();
    if (s.length < 2 || s.length > 80) return;
    if (lower.has(s.toLowerCase())) return;
    aliasesAfter.push(s); lower.add(s.toLowerCase()); stats.aliasesAdded++;
  };
  for (const a of (drop.aliases || [])) pushIfNovel(a);
  pushIfNovel(drop.name);

  // 5) externalIds — shallow merge, keep wygrywa.
  const keepExt = (keep.externalIds && typeof keep.externalIds === 'object') ? keep.externalIds : {};
  const dropExt = (drop.externalIds && typeof drop.externalIds === 'object') ? drop.externalIds : {};
  const mergedExt = { ...dropExt, ...keepExt };
  for (const k of Object.keys(dropExt)) {
    if (mergedExt[k] === dropExt[k] && keepExt[k] == null) stats.externalIdsMerged++;
  }

  // 6) linkedEsContractorId — migruj jeśli keep nie ma.
  let linkedEsMigrated = false;
  let linkedEsData = {};
  if (drop.linkedEsContractorId && !keep.linkedEsContractorId) {
    linkedEsData = { linkedEsContractorId: drop.linkedEsContractorId };
    linkedEsMigrated = true;
  }

  // 7) Update keep (uzupełnij braki) + delete drop.
  const updatedKeep = await prisma.contractor.update({
    where: { id: keepId },
    data: {
      aliases: aliasesAfter,
      externalIds: mergedExt,
      ...linkedEsData,
      ...(!keep.nip && drop.nip ? { nip: drop.nip } : {}),
      ...(!keep.primaryEmail && drop.primaryEmail ? { primaryEmail: drop.primaryEmail } : {}),
      ...(!keep.preferredLanguage && drop.preferredLanguage ? { preferredLanguage: drop.preferredLanguage } : {}),
      ...(!keep.phone && drop.phone ? { phone: drop.phone } : {}),
      ...(!keep.email && drop.email ? { email: drop.email } : {}),
      ...(!keep.address && drop.address ? { address: drop.address } : {}),
      ...(!keep.city && drop.city ? { city: drop.city } : {}),
      ...(!keep.postCode && drop.postCode ? { postCode: drop.postCode } : {}),
      ...(!keep.country && drop.country ? { country: drop.country } : {}),
    },
  });

  await prisma.contractor.delete({ where: { id: dropId } });

  // 8) AuditLog + activity.
  try {
    await prisma.auditLog.create({
      data: {
        actor: 'system', action: 'contractor.merge',
        entityType: 'Contractor', entityId: keepId,
        payload: {
          keepId, dropId, keepNameBefore: keep.name, dropNameBefore: drop.name,
          fkUpdates: { emails: emails.count, invoices: invoices.count, invoiceLines: invoiceLines.count, transactions: transactions.count, deals: deals.count, consignments: consignments.count },
          contactsMoved, contactsSkipped, addressesMoved,
          aliasesAdded: stats.aliasesAdded, externalIdsMerged: stats.externalIdsMerged, linkedEsMigrated,
        },
      },
    });
  } catch (e) { console.error('[merge] auditLog failed:', e.message); }
  try {
    const { logActivity } = require('./activity-log');
    logActivity(prisma, {
      type: 'contractor.merged', summary: `Merge ${drop.name} → ${keep.name}`, source: 'system',
      contractorId: keepId, actorType: 'system',
      payload: { keepId, dropId, keepName: keep.name, dropName: drop.name },
    });
  } catch (_) { /* best-effort */ }

  return {
    keepId, dropId,
    contractor: { id: updatedKeep.id, name: updatedKeep.name, aliases: (updatedKeep.aliases || []).length },
    moved: {
      emails: emails.count, invoices: invoices.count, invoiceLines: invoiceLines.count,
      transactions: transactions.count, deals: deals.count, consignments: consignments.count,
      contacts: contactsMoved, addresses: addressesMoved,
    },
    stats: { contactsSkipped, aliasesAdded: stats.aliasesAdded, externalIdsMerged: stats.externalIdsMerged, linkedEsMigrated },
  };
}

// Normalizacja NIP do klucza dedup: bez spacji/kropek/myślników/slashy, wielkie
// litery. NIE zdejmujemy prefiksu kraju (PL/DE…) — inne kraje mają litery w NIP.
// "634-29-75-162" i "634 29 75 162" → "6342975162".
function normalizeNipKey(nip) {
  if (!nip) return '';
  return String(nip).replace(/[\s.\-/]/g, '').toUpperCase();
}

module.exports = { mergeContractors, normalizeNipKey };
