'use strict';

/**
 * CRM v2 — pelen sync FV z Contasimple do naszej bazy EsInvoice +
 * EsInvoiceLineItem + EsContractor (jak brakuje).
 *
 * Wzorem ifirma-sync ale prostszy bo Contasimple GET /invoices/issued
 * zwraca pelne dane z pozycjami (listInvoices + getInvoice).
 *
 * Period: Contasimple operuje kwartalami ('2026-1T', '2026-2T', ...).
 * Iterujemy po liscie default (od env CONTASIMPLE_BACKFILL_START_YEAR,
 * default 2026) lub po explicite podanej liscie.
 *
 * Idempotent — kazda EsInvoice ma unique contasimpleId. Skipujemy
 * istniejace (upsert update tylko status/totalPayedAmount).
 *
 * Wolane z POST /api/admin/backfill/es-invoices-from-contasimple.
 */

const cs = require('../contasimple-client');
const { resolveOwnerFromAddress } = require('./owner-derive');
const {
  buildEsLinesFromPreview,
  buildEsLinesFromContasimple,
  resolveEsProductIdByEan,
} = require('./invoice-lines-backfill');

function periodsForYear(year) {
  return [`${year}-1T`, `${year}-2T`, `${year}-3T`, `${year}-4T`];
}

function defaultPeriods() {
  const startYear = parseInt(process.env.CONTASIMPLE_BACKFILL_START_YEAR || '2026', 10);
  const thisYear = new Date().getFullYear();
  const out = [];
  for (let y = startYear; y <= thisYear; y++) out.push(...periodsForYear(y));
  return out;
}

async function listAllForPeriod(period, log) {
  const all = [];
  const pageSize = 100;
  let startIndex = 0;
  for (let i = 0; i < 50; i++) { // hard cap — 5000 FV per period
    const resp = await cs.listInvoices(period, { startIndex, numRows: pageSize });
    const items = (resp && resp.data) || resp || [];
    if (!Array.isArray(items)) {
      log(`  period ${period} page ${i}: unexpected response shape`);
      break;
    }
    all.push(...items);
    if (items.length < pageSize) break;
    startIndex += pageSize;
  }
  return all;
}

// Contasimple zwraca w bodyiu faktury 'targetEntityId' (numeric FK do
// /entities/customers), a nie zagniezdzonego customer-a. Stara wersja
// upsertEsContractor patrzyla wylacznie na full.customer co skutkowalo
// pustym contractorId/Name/Nip na wszystkich faktorach importowanych ze
// starsza wersja kodu. Ten helper rozwiazuje obie formy: nested customer
// jak jest, fallback do targetEntityId (lokalna baza lub GET /entities).
async function resolveCustomerRef(prisma, full, csInvoice, log) {
  let customer = full.customer || csInvoice.customer || null;
  if (customer && customer.id) return customer;

  const targetEntityId = full.targetEntityId || csInvoice.targetEntityId || (customer && customer.id) || null;
  if (!targetEntityId) return customer;

  const local = await prisma.esContractor.findUnique({
    where: { contasimpleId: targetEntityId },
    select: {
      contasimpleId: true, organization: true, firstname: true, lastname: true,
      nif: true, country: true, city: true, province: true, postalCode: true,
      email: true, phone: true, mobile: true, address: true, type: true,
      countryId: true, documentCulture: true, notes: true,
    },
  });
  if (local) {
    return { id: local.contasimpleId, ...local };
  }

  try {
    const r = await cs.getCustomer(targetEntityId);
    return (r && r.data) || r || null;
  } catch (e) {
    log(`  ! resolveCustomerRef(${targetEntityId}): ${e.message}`);
    return null;
  }
}

async function upsertEsContractor(prisma, customerRef, log) {
  // customerRef z listInvoices wraca jako embedded {id, organization, nif,
  // ...} albo czasem tylko {id}. getInvoice tez ma customer. Najpierw
  // probujemy znalezc po contasimpleId.
  if (!customerRef || !customerRef.id) return null;
  const existing = await prisma.esContractor.findUnique({
    where: { contasimpleId: customerRef.id },
    select: { id: true },
  });
  if (existing) return existing.id;

  // Pelne dane z getCustomer jak nie mamy.
  try {
    const full = await cs.getCustomer(customerRef.id);
    const c = (full && full.data) || full;
    if (!c) return null;
    const name = c.organization || [c.firstname, c.lastname].filter(Boolean).join(' ').trim() || 'Unknown';
    // Auto-przypisanie owner przy CREATE — Fuerte ZIP/miasto -> rogacz, reszta -> nikodem.
    const ownerAuto = resolveOwnerFromAddress({ postalCode: c.postalCode, city: c.city, province: c.province });
    const created = await prisma.esContractor.create({
      data: {
        contasimpleId: c.id,
        type: c.type || 'Issuer',
        organization: c.organization || null,
        firstname: c.firstname || null,
        lastname: c.lastname || null,
        name,
        nif: c.nif || null,
        email: c.email || null,
        phone: c.phone || null,
        mobile: c.mobile || null,
        address: c.address || null,
        city: c.city || null,
        province: c.province || null,
        country: c.country || null,
        countryId: c.countryId || null,
        postalCode: c.postalCode || null,
        documentCulture: c.documentCulture || null,
        notes: c.notes || null,
        owner: ownerAuto,
        extras: {
          customField1: c.customField1 || null,
          customField2: c.customField2 || null,
          discountPercentage: c.discountPercentage || 0,
        },
      },
    });
    log(`  + EsContractor ${created.id} (${name}, NIF=${c.nif || '-'}, owner=${ownerAuto})`);
    return created.id;
  } catch (e) {
    log(`  ! upsertEsContractor(${customerRef.id}) failed: ${e.message}`);
    return null;
  }
}

async function persistInvoice(prisma, period, csInvoice, opts) {
  const { apply, log } = opts;
  const existing = await prisma.esInvoice.findUnique({
    where: { contasimpleId: csInvoice.id },
    select: { id: true, status: true, totalPayedAmount: true },
  });
  if (existing) {
    // Update status + payments jak sie zmienily.
    if (apply) {
      const updates = {};
      if (csInvoice.status && csInvoice.status !== existing.status) updates.status = csInvoice.status;
      if (csInvoice.totalPayedAmount != null && Number(csInvoice.totalPayedAmount) !== Number(existing.totalPayedAmount || 0)) {
        updates.totalPayedAmount = csInvoice.totalPayedAmount;
      }
      if (Object.keys(updates).length) {
        await prisma.esInvoice.update({ where: { id: existing.id }, data: updates });
      }
    }
    return { id: existing.id, action: 'update', linesCreated: 0 };
  }

  // Nowa FV — potrzebujemy pelnych pozycji. Lista zwraca tylko summary,
  // pozycje sa w GET /invoices/issued/{id}.
  let full;
  try {
    const r = await cs.getInvoice(period, csInvoice.id);
    full = (r && r.data) || r;
  } catch (e) {
    log(`  ! getInvoice(${period}, ${csInvoice.id}) failed: ${e.message}`);
    return { id: null, action: 'error', error: e.message };
  }

  const customer = await resolveCustomerRef(prisma, full, csInvoice, log);
  const contractorId = await upsertEsContractor(prisma, customer, log);

  // Snapshot kontrahenta na FV (Etap 2.1) — z customer payload.
  const snapshotName = customer ? (customer.organization || [customer.firstname, customer.lastname].filter(Boolean).join(' ').trim() || null) : null;
  const snapshotNip = customer ? (customer.nif || null) : null;
  const snapshotCountry = customer ? (customer.country || null) : null;
  const snapshotCity = customer ? (customer.city || null) : null;

  if (!apply) {
    return { id: null, action: 'would-create', number: full.number, lineCount: (full.lines || []).length };
  }

  const created = await prisma.esInvoice.create({
    data: {
      contasimpleId: full.id,
      contractorId,
      period,
      number: full.number || null,
      status: full.status || 'Pending',
      invoiceDate: full.invoiceDate ? new Date(full.invoiceDate) : new Date(),
      expirationDate: full.expirationDate ? new Date(full.expirationDate) : null,
      totalAmount: full.totalAmount || 0,
      totalTaxableAmount: full.totalTaxableAmount || 0,
      totalVatAmount: full.totalVatAmount || 0,
      totalPayedAmount: full.totalPayedAmount || 0,
      currency: full.currency || 'EUR',
      uiCulture: full.uiCulture || null,
      numberingFormatId: full.numberingFormatId || null,
      operationType: full.operationType || null,
      contractorName: snapshotName,
      contractorNip: snapshotNip,
      contractorCountry: snapshotCountry,
      contractorCity: snapshotCity,
      source: 'contasimple-backfill',
      extras: {
        lines: full.lines || [],
        payments: full.payments || [],
        targetEntityId: full.targetEntityId || null,
        backfilledAt: new Date().toISOString(),
      },
    },
  });

  // EsInvoiceLineItem — buildEsLinesFromContasimple z helpera.
  let linesCreated = 0;
  const csLines = Array.isArray(full.lines) ? full.lines : [];
  if (csLines.length) {
    const stub = { currency: created.currency, invoiceDate: created.invoiceDate };
    const built = buildEsLinesFromContasimple(stub, csLines);
    const productCache = new Map();
    const records = [];
    for (const l of built) {
      const productId = await resolveEsProductIdByEan(prisma, l.ean, productCache);
      records.push({
        esInvoiceId: created.id,
        productId,
        ean: l.ean,
        name: l.name,
        unit: l.unit,
        qty: l.qty,
        unitPriceNetto: l.unitPriceNetto,
        vatRate: l.vatRate,
        vatAmount: l.vatAmount,
        totalNetto: l.totalNetto,
        totalGross: l.totalGross,
        currency: created.currency || 'EUR',
        contractorId: created.contractorId,
        contractorCountry: created.contractorCountry,
        invoiceDate: created.invoiceDate,
        contasimpleLineId: null,
        position: l.position,
        extras: { ...l.extras, source: 'contasimple-backfill' },
      });
    }
    if (records.length) {
      const r = await prisma.esInvoiceLineItem.createMany({ data: records });
      linesCreated = r.count;
    }
  }
  return { id: created.id, action: 'create', number: created.number, linesCreated };
}

async function runBackfill(prisma, opts = {}) {
  const apply = !!opts.apply;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const periods = (Array.isArray(opts.periods) && opts.periods.length) ? opts.periods : defaultPeriods();

  if (!cs.isConfigured()) {
    throw new Error('CONTASIMPLE_API_KEY not configured');
  }

  log(`backfill es-invoices apply=${apply} periods=${periods.join(',')}`);

  const summary = {
    apply, periods,
    perPeriod: [], totalFetched: 0, totalCreated: 0, totalUpdated: 0,
    totalLinesCreated: 0, errors: [],
  };

  for (const period of periods) {
    log(`period ${period}: listing...`);
    let invoices = [];
    try {
      invoices = await listAllForPeriod(period, log);
    } catch (e) {
      log(`! period ${period} list failed: ${e.message}`);
      summary.errors.push({ period, error: e.message });
      summary.perPeriod.push({ period, fetched: 0, created: 0, updated: 0, linesCreated: 0, error: e.message });
      continue;
    }
    log(`period ${period}: ${invoices.length} FV`);
    summary.totalFetched += invoices.length;

    let created = 0, updated = 0, linesCreated = 0;
    for (const inv of invoices) {
      try {
        const r = await persistInvoice(prisma, period, inv, { apply, log });
        if (r.action === 'create') { created++; linesCreated += r.linesCreated || 0; }
        else if (r.action === 'update') updated++;
        else if (r.action === 'would-create') created++;
        else if (r.action === 'error') summary.errors.push({ period, id: inv.id, number: inv.number, error: r.error });
      } catch (e) {
        log(`! persist ${inv.id} (${inv.number}) failed: ${e.message}`);
        summary.errors.push({ period, id: inv.id, number: inv.number, error: e.message });
      }
    }
    summary.perPeriod.push({ period, fetched: invoices.length, created, updated, linesCreated });
    summary.totalCreated += created;
    summary.totalUpdated += updated;
    summary.totalLinesCreated += linesCreated;
  }

  return summary;
}

module.exports = { runBackfill, defaultPeriods };
