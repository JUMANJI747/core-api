'use strict';

/**
 * CRM v2 Etap 4.5 — backfill historycznych ActivityEvent z istniejacych
 * tabel (Email, Invoice, EsInvoice, Transaction, Contractor).
 *
 * Idempotent: usuwamy ActivityEvent.source='backfill' przed nowym runem.
 * Dry-run wraca counts bez insertu.
 *
 * Mapowanie:
 *   - Email.direction='INBOUND'                            -> mail.received
 *   - Email.direction='OUTBOUND' z extras.appendedToSentAt -> mail.sent
 *   - Email.direction='OUTBOUND' bez extras.appendedToSentAt -> mail.sent_external
 *     (Thunderbird / webmail / inny zewn. klient)
 *   - Email.direction='DRAFT' z tags ['tracking_notify']   -> tracking.notify.draft
 *   - Email.direction='DRAFT' bez                          -> mail.draft.created
 *   - Email.direction='FAILED'                             -> mail.failed
 *   - Invoice                                              -> invoice.created
 *   - EsInvoice                                            -> es_invoice.created
 *   - Transaction z hasShipped + shipmentNumber           -> shipment.created
 *   - Transaction z trackingNumber                         -> tracking.notify.sent
 *   - Contractor                                           -> contractor.created
 */

function tagOrNull(prefix, value) {
  if (!value) return null;
  return `${prefix}:${String(value).toLowerCase()}`;
}

async function runBackfill(prisma, opts = {}) {
  const apply = !!opts.apply;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  if (apply) {
    const del = await prisma.activityEvent.deleteMany({ where: { source: 'backfill' } });
    log(`deleted ${del.count} previous backfill events (re-run safety)`);
  }

  const result = {
    apply,
    mail: { received: 0, sent: 0, sent_external: 0, draft_created: 0, tracking_draft: 0, failed: 0 },
    invoice: { pl: 0, es: 0 },
    shipment: 0, tracking_sent: 0,
    contractor: 0,
  };
  const batch = [];

  function push(rec) {
    batch.push({ ...rec, source: 'backfill', tags: rec.tags || [], payload: rec.payload || {} });
  }
  async function flush() {
    if (!apply || batch.length === 0) return;
    const chunk = batch.splice(0, 500);
    await prisma.activityEvent.createMany({ data: chunk });
  }

  // 1) Emails
  const emails = await prisma.email.findMany({
    select: { id: true, direction: true, inbox: true, fromEmail: true, toEmail: true, subject: true, contractorId: true, tags: true, extras: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const e of emails) {
    const extras = (e.extras && typeof e.extras === 'object') ? e.extras : {};
    const isTracking = Array.isArray(e.tags) && e.tags.includes('tracking_notify');
    let type, summary, actorType = 'system', actorId = null;
    if (e.direction === 'INBOUND') {
      type = 'mail.received';
      summary = `Mail z ${e.fromEmail}: ${e.subject || '(brak tematu)'}`;
      result.mail.received++;
    } else if (e.direction === 'OUTBOUND') {
      if (extras.appendedToSentAt || extras.source === 'our-send') {
        type = 'mail.sent'; result.mail.sent++;
      } else {
        type = 'mail.sent_external'; actorType = 'user'; actorId = 'thunderbird';
        result.mail.sent_external++;
      }
      summary = `Mail wyslany: ${e.subject || '(brak)'} → ${e.toEmail}`;
    } else if (e.direction === 'DRAFT') {
      type = isTracking ? 'tracking.notify.draft' : 'mail.draft.created';
      summary = `Draft ${isTracking ? 'tracking' : 'mail'}: ${e.subject || '(brak)'} → ${e.toEmail}`;
      isTracking ? result.mail.tracking_draft++ : result.mail.draft_created++;
    } else if (e.direction === 'FAILED') {
      type = 'mail.failed'; result.mail.failed++;
      summary = `Mail FAILED: ${e.subject || '(brak)'} → ${e.toEmail}`;
    } else {
      continue;
    }
    push({
      type, summary, contractorId: e.contractorId, emailId: e.id,
      actorType, actorId, createdAt: e.createdAt,
      payload: { subject: e.subject, fromEmail: e.fromEmail, toEmail: e.toEmail, inbox: e.inbox },
      tags: [tagOrNull('inbox', e.inbox)].filter(Boolean),
    });
    if (batch.length >= 500) await flush();
  }
  await flush();
  log(`emails: ${result.mail.received}+${result.mail.sent}+${result.mail.sent_external}+${result.mail.draft_created}+${result.mail.tracking_draft}+${result.mail.failed}`);

  // 2) Invoices PL
  const invs = await prisma.invoice.findMany({
    select: { id: true, number: true, contractorId: true, contractorName: true, contractorNip: true, contractorCountry: true, grossAmount: true, currency: true, type: true, ifirmaId: true, issueDate: true },
    orderBy: { issueDate: 'asc' },
  });
  for (const inv of invs) {
    push({
      type: 'invoice.created',
      summary: `FV ${inv.number} ${inv.contractorName || ''} (${inv.grossAmount} ${inv.currency})`,
      contractorId: inv.contractorId, invoiceId: inv.id,
      actorType: 'system', createdAt: inv.issueDate,
      payload: { number: inv.number, ifirmaId: inv.ifirmaId, grossAmount: String(inv.grossAmount), currency: inv.currency, type: inv.type, contractorName: inv.contractorName, contractorNip: inv.contractorNip },
      tags: [tagOrNull('country', inv.contractorCountry), tagOrNull('currency', inv.currency)].filter(Boolean),
    });
    result.invoice.pl++;
    if (batch.length >= 500) await flush();
  }
  await flush();
  log(`invoices PL: ${result.invoice.pl}`);

  // 3) Invoices ES
  const esInvs = await prisma.esInvoice.findMany({
    select: { id: true, number: true, contractorId: true, contractorName: true, contractorNip: true, contractorCountry: true, totalAmount: true, currency: true, contasimpleId: true, invoiceDate: true },
    orderBy: { invoiceDate: 'asc' },
  });
  for (const inv of esInvs) {
    push({
      type: 'es_invoice.created',
      summary: `FV ES ${inv.number || inv.contasimpleId} ${inv.contractorName || ''} (${inv.totalAmount} ${inv.currency})`,
      contractorId: inv.contractorId, esInvoiceId: inv.id,
      actorType: 'system', createdAt: inv.invoiceDate,
      payload: { number: inv.number, contasimpleId: inv.contasimpleId, totalAmount: String(inv.totalAmount), currency: inv.currency, contractorName: inv.contractorName, contractorNip: inv.contractorNip },
      tags: [tagOrNull('country', inv.contractorCountry), tagOrNull('currency', inv.currency)].filter(Boolean),
    });
    result.invoice.es++;
    if (batch.length >= 500) await flush();
  }
  await flush();
  log(`invoices ES: ${result.invoice.es}`);

  // 4) Transactions z shipment / tracking
  const txs = await prisma.transaction.findMany({
    where: { OR: [{ hasShipped: true }, { trackingNumber: { not: null } }] },
    select: { id: true, contractorId: true, contractorName: true, shipmentNumber: true, trackingNumber: true, occurredAt: true, hasShipped: true, hasDelivered: true, amount: true, currency: true },
    orderBy: { occurredAt: 'asc' },
  });
  for (const t of txs) {
    if (t.shipmentNumber && t.hasShipped) {
      push({
        type: 'shipment.created',
        summary: `Paczka GK${t.shipmentNumber} → ${t.contractorName || ''}`,
        contractorId: t.contractorId, transactionId: t.id, shipmentNumber: t.shipmentNumber,
        actorType: 'system', createdAt: t.occurredAt,
        payload: { shipmentNumber: t.shipmentNumber, trackingNumber: t.trackingNumber, amount: t.amount ? String(t.amount) : null, currency: t.currency },
      });
      result.shipment++;
    }
    if (t.trackingNumber) {
      push({
        type: 'tracking.notify.sent',
        summary: `Tracking ${t.trackingNumber} (backfill, brak emaila)`,
        contractorId: t.contractorId, transactionId: t.id, trackingNumber: t.trackingNumber,
        actorType: 'system', createdAt: t.occurredAt,
        payload: { trackingNumber: t.trackingNumber, shipmentNumber: t.shipmentNumber },
      });
      result.tracking_sent++;
    }
    if (batch.length >= 500) await flush();
  }
  await flush();
  log(`shipments: ${result.shipment} / tracking sent: ${result.tracking_sent}`);

  // 5) Contractors
  const cons = await prisma.contractor.findMany({
    select: { id: true, name: true, nip: true, country: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const c of cons) {
    push({
      type: 'contractor.created',
      summary: `Kontrahent: ${c.name} ${c.nip ? `(${c.nip})` : ''}`,
      contractorId: c.id,
      actorType: 'system', createdAt: c.createdAt,
      payload: { name: c.name, nip: c.nip, country: c.country },
      tags: [tagOrNull('country', c.country)].filter(Boolean),
    });
    result.contractor++;
    if (batch.length >= 500) await flush();
  }
  await flush();
  log(`contractors: ${result.contractor}`);

  return result;
}

module.exports = { runBackfill };
