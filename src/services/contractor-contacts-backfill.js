'use strict';

/**
 * CRM v2 Etap 1.2 + 1.3 — backfill ContractorContact + ContractorAddress
 * z istniejacych pol Contractor (email, phone, address, lat/lng) oraz
 * z extras.locations[].
 *
 * Idempotentny:
 *   - ContractorContact ma @@unique([contractorId, type, value]) — duplikaty
 *     odbije baza, my je labkujemy jako skip.
 *   - ContractorAddress soft-dedup w aplikacji: norm(type+street+city+postCode).
 *
 * Co tworzy per Contractor:
 *   email      -> ContractorContact(type='email', isPrimary=true, source='backfill')
 *   phone      -> ContractorContact(type='phone', isPrimary=true, source='backfill')
 *   address/city/country/lat/lng -> ContractorAddress(type='billing', isPrimary=true)
 *   extras.locations[i] -> ContractorAddress(type='delivery', isPrimary=i===0)
 *     plus jesli loc.phone/email -> ContractorContact z label='delivery'
 */

function normEmail(v) {
  if (!v || typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if (!t.includes('@')) return null;
  return t;
}

function normPhone(v) {
  if (!v || typeof v !== 'string') return null;
  const t = v.replace(/[\s\-()]/g, '').trim();
  if (t.length < 4) return null;
  return t;
}

function normAddressKey(addr) {
  const n = (s) => (s || '').toString().toLowerCase().trim();
  return `${n(addr.type)}|${n(addr.street)}|${n(addr.city)}|${n(addr.postalCode)}`;
}

async function runBackfill(prisma, opts = {}) {
  const apply = !!opts.apply;
  const verbose = !!opts.verbose;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  const all = await prisma.contractor.findMany({
    select: {
      id: true, name: true, email: true, phone: true,
      address: true, city: true, country: true, lat: true, lng: true,
      geocodedAt: true, geocodingStatus: true,
      extras: true,
      contacts: { select: { type: true, value: true } },
      addresses: { select: { type: true, street: true, city: true, postalCode: true } },
    },
  });

  log(`scanning ${all.length} contractors (apply=${apply})`);

  const sample = [];
  let contactsCreated = 0;
  let contactsSkipped = 0;
  let addressesCreated = 0;
  let addressesSkipped = 0;
  let touchedContractors = 0;

  for (const c of all) {
    const existingContactKeys = new Set(
      (c.contacts || []).map((x) => `${x.type}|${x.value}`)
    );
    const existingAddressKeys = new Set(
      (c.addresses || []).map((x) => normAddressKey(x))
    );

    const newContacts = [];
    const newAddresses = [];

    // 1) primary email
    const email = normEmail(c.email);
    if (email && !existingContactKeys.has(`email|${email}`)) {
      newContacts.push({
        contractorId: c.id, type: 'email', value: email,
        isPrimary: true, source: 'backfill', label: 'primary',
      });
      existingContactKeys.add(`email|${email}`);
    }

    // 2) primary phone
    const phone = normPhone(c.phone);
    if (phone && !existingContactKeys.has(`phone|${phone}`)) {
      newContacts.push({
        contractorId: c.id, type: 'phone', value: phone,
        isPrimary: true, source: 'backfill', label: 'primary',
      });
      existingContactKeys.add(`phone|${phone}`);
    }

    // 3) billing address: preferuj extras.billingAddress (bogatsze — ma
    //    street/city/postCode), fall back do flat Contractor.* . Tworzymy
    //    TYLKO gdy street albo city jest niepuste — sam country/lat/lng
    //    bez ulicy daje pusty rekord ktorego potem nie da sie z niczym
    //    matchowac.
    const extrasBilling = (c.extras && typeof c.extras === 'object' && c.extras.billingAddress && typeof c.extras.billingAddress === 'object')
      ? c.extras.billingAddress : {};
    const street = extrasBilling.street || c.address || null;
    const city = extrasBilling.city || c.city || null;
    const postalCode = extrasBilling.postCode || extrasBilling.postalCode || null;
    // ISO-2 z flat (jak '/^[A-Z]{2}$/') wygrywa; w przeciwnym razie z billing
    // (czesto "Polska" / "Hiszpania" — display value).
    const flatCountry = c.country || null;
    const country = (flatCountry && /^[A-Z]{2}$/.test(flatCountry)) ? flatCountry : (extrasBilling.country || flatCountry);
    if (street || city) {
      const addr = {
        contractorId: c.id, type: 'billing', isPrimary: true,
        street, city, postalCode, country,
        lat: c.lat || null,
        lng: c.lng || null,
        geocodedAt: c.geocodedAt || null,
        geocodingStatus: c.geocodingStatus || null,
        source: extrasBilling.source || 'backfill',
      };
      const key = normAddressKey(addr);
      if (!existingAddressKeys.has(key)) {
        newAddresses.push(addr);
        existingAddressKeys.add(key);
      }
    }

    // 4) extras.locations[] -> delivery addresses + (opcjonalnie) contacts
    const locations = Array.isArray(c.extras && c.extras.locations) ? c.extras.locations : [];
    locations.forEach((loc, idx) => {
      if (!loc || typeof loc !== 'object') return;
      const addr = {
        contractorId: c.id, type: 'delivery',
        isPrimary: idx === 0,
        recipientName: loc.contactPerson || null,
        street: loc.street || null,
        houseNumber: loc.houseNumber || null,
        postalCode: loc.postCode || null,
        city: loc.city || null,
        country: loc.country || null,
        source: loc.source || 'extras.locations',
      };
      const key = normAddressKey(addr);
      if (!existingAddressKeys.has(key)) {
        newAddresses.push(addr);
        existingAddressKeys.add(key);
      }

      const locEmail = normEmail(loc.email);
      if (locEmail && !existingContactKeys.has(`email|${locEmail}`)) {
        newContacts.push({
          contractorId: c.id, type: 'email', value: locEmail,
          isPrimary: false, source: loc.source || 'extras.locations', label: 'delivery',
          personName: loc.contactPerson || null,
        });
        existingContactKeys.add(`email|${locEmail}`);
      }
      const locPhone = normPhone(loc.phone);
      if (locPhone && !existingContactKeys.has(`phone|${locPhone}`)) {
        newContacts.push({
          contractorId: c.id, type: 'phone', value: locPhone,
          isPrimary: false, source: loc.source || 'extras.locations', label: 'delivery',
          personName: loc.contactPerson || null,
        });
        existingContactKeys.add(`phone|${locPhone}`);
      }
    });

    if (newContacts.length === 0 && newAddresses.length === 0) continue;
    touchedContractors++;

    if (verbose) log(`  ${c.id}  ${c.name}  -> ${newContacts.length} contacts, ${newAddresses.length} addresses`);
    if (sample.length < 10) sample.push({
      id: c.id, name: c.name,
      newContacts: newContacts.map(x => ({ type: x.type, value: x.value, label: x.label })),
      newAddresses: newAddresses.map(x => ({ type: x.type, city: x.city, street: x.street })),
    });

    if (apply) {
      // Bulk create wewnatrz contractora — bedzie ich od 1 do max 10ish
      // per kontrahent. createMany skipDuplicates pelni dodatkowy safety net
      // dla constraintu @@unique na ContractorContact.
      if (newContacts.length) {
        const r = await prisma.contractorContact.createMany({ data: newContacts, skipDuplicates: true });
        contactsCreated += r.count;
        contactsSkipped += newContacts.length - r.count;
      }
      if (newAddresses.length) {
        // ContractorAddress nie ma DB unique — dla niej skipDuplicates nic nie da,
        // ale soft-dedup juz zrobilismy wyzej.
        const r = await prisma.contractorAddress.createMany({ data: newAddresses });
        addressesCreated += r.count;
      }
    } else {
      contactsCreated += newContacts.length;
      addressesCreated += newAddresses.length;
    }
  }

  return {
    apply, scanned: all.length, touchedContractors,
    contactsCreated, contactsSkipped,
    addressesCreated, addressesSkipped,
    sample,
  };
}

module.exports = { runBackfill };
