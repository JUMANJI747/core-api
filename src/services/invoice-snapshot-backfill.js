'use strict';

/**
 * CRM v2 Etap 2.1 — backfill denormalized contractor snapshot na FV.
 *
 * Wypelnia Invoice.contractorName/Nip/Country/City + EsInvoice.contractorName/
 * Nip/Country/City z aktualnego stanu powiazanego (Es)Contractor. Dla FV bez
 * contractorId zostawia pola null (analytics nie da rady i tak — i nie ma na
 * to lekarstwa bez nowych danych).
 *
 * Idempotentne — nadpisuje tylko gdy snapshot pusty. Ponowne uruchomienie
 * NIE zmieni FV ktora juz dostala snapshot (np. wpis manualny w NocoDB).
 * Flaga apply:true zapisuje; bez niej dry-run + sample.
 *
 * Wolane z POST /api/admin/backfill/invoice-snapshots.
 */

async function backfillPlInvoices(prisma, { apply, verbose, log }) {
  // Tylko FV ktore maja kogokolwiek po stronie kontrahenta i ktorym chociaz
  // jedno pole snapshotu jeszcze nie zostalo wypelnione.
  const rows = await prisma.invoice.findMany({
    where: {
      contractorId: { not: null },
      OR: [
        { contractorName: null },
        { contractorNip: null },
        { contractorCountry: null },
        { contractorCity: null },
      ],
    },
    select: {
      id: true, number: true, contractorId: true,
      contractorName: true, contractorNip: true,
      contractorCountry: true, contractorCity: true,
      contractor: { select: { name: true, nip: true, country: true, city: true } },
    },
  });

  let touched = 0;
  const sample = [];
  for (const inv of rows) {
    if (!inv.contractor) continue; // FK orphan — pomijamy
    const data = {};
    if (!inv.contractorName && inv.contractor.name) data.contractorName = inv.contractor.name;
    if (!inv.contractorNip && inv.contractor.nip) data.contractorNip = inv.contractor.nip;
    if (!inv.contractorCountry && inv.contractor.country) data.contractorCountry = inv.contractor.country;
    if (!inv.contractorCity && inv.contractor.city) data.contractorCity = inv.contractor.city;
    if (Object.keys(data).length === 0) continue;

    touched++;
    if (verbose) log(`  pl ${inv.number || inv.id} -> ${JSON.stringify(data)}`);
    if (sample.length < 10) sample.push({ id: inv.id, number: inv.number, changes: data });
    if (apply) await prisma.invoice.update({ where: { id: inv.id }, data });
  }

  return { scanned: rows.length, touched, sample };
}

async function backfillEsInvoices(prisma, { apply, verbose, log }) {
  const rows = await prisma.esInvoice.findMany({
    where: {
      contractorId: { not: null },
      OR: [
        { contractorName: null },
        { contractorNip: null },
        { contractorCountry: null },
        { contractorCity: null },
      ],
    },
    select: {
      id: true, number: true, contractorId: true,
      contractorName: true, contractorNip: true,
      contractorCountry: true, contractorCity: true,
      contractor: { select: { name: true, nif: true, country: true, city: true } },
    },
  });

  let touched = 0;
  const sample = [];
  for (const inv of rows) {
    if (!inv.contractor) continue;
    const data = {};
    if (!inv.contractorName && inv.contractor.name) data.contractorName = inv.contractor.name;
    if (!inv.contractorNip && inv.contractor.nif) data.contractorNip = inv.contractor.nif;
    if (!inv.contractorCountry && inv.contractor.country) data.contractorCountry = inv.contractor.country;
    if (!inv.contractorCity && inv.contractor.city) data.contractorCity = inv.contractor.city;
    if (Object.keys(data).length === 0) continue;

    touched++;
    if (verbose) log(`  es ${inv.number || inv.id} -> ${JSON.stringify(data)}`);
    if (sample.length < 10) sample.push({ id: inv.id, number: inv.number, changes: data });
    if (apply) await prisma.esInvoice.update({ where: { id: inv.id }, data });
  }

  return { scanned: rows.length, touched, sample };
}

async function runBackfill(prisma, opts = {}) {
  const apply = !!opts.apply;
  const verbose = !!opts.verbose;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  log(`backfill invoice snapshots (apply=${apply})`);
  const pl = await backfillPlInvoices(prisma, { apply, verbose, log });
  const es = await backfillEsInvoices(prisma, { apply, verbose, log });

  return {
    apply,
    pl: { scanned: pl.scanned, touched: pl.touched, sample: pl.sample },
    es: { scanned: es.scanned, touched: es.touched, sample: es.sample },
  };
}

module.exports = { runBackfill };
