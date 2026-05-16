'use strict';

/**
 * CRM v2 Etap 4.3 — helper do emitowania ActivityEvent.
 *
 * Fire-and-forget przez setImmediate — NIE blokuje hot path.
 * Walidacja type po VALID_TYPES (skip + warn jak nieznany).
 * Env gating per-kategoria (ACTIVITY_LOG_<DOMAIN>) — domyslnie wszystko ON
 * w produkcji prócz `api.*` (default OFF, dużo szumu).
 * Truncate payload >10KB — meta zostaje, content tagowany [truncated Nb].
 * searchText denorm: summary + payload.{subject,contractorName,toEmail,
 *   fromEmail,invoiceNumber,number,shipmentNumber,trackingNumber} — do ILIKE.
 */

// Lista zamknieta typow. Kazdy hot path emituje tylko z tej listy. Nowy
// typ → tu dorzucic, w innym razie helper waliduje i pomija.
const VALID_TYPES = new Set([
  // mail
  'mail.received', 'mail.sent', 'mail.sent_external', 'mail.draft.created',
  'mail.failed', 'mail.bounce', 'mail.classified',
  // invoice PL (iFirma)
  'invoice.created', 'invoice.sent', 'invoice.pdf_to_telegram',
  'invoice.paid', 'invoice.overdue', 'invoice.canceled',
  'invoice.pdf_downloaded', 'invoice.reminder_sent',
  // invoice ES (Contasimple — rename do cn_* w commicie #17)
  'es_invoice.created', 'es_invoice.sent', 'es_invoice.pdf_to_telegram',
  'es_invoice.paid', 'es_invoice.canceled', 'es_invoice.pdf_downloaded',
  // shipment (GK)
  'shipment.quote_requested', 'shipment.quote_built', 'shipment.created',
  'shipment.canceled', 'shipment.label_printed', 'shipment.delivered',
  'shipment.stale',
  // tracking
  'tracking.checked', 'tracking.notify.draft', 'tracking.notify.sent',
  'sync.tracking.poll_batch',
  // contractor
  'contractor.created', 'contractor.updated', 'contractor.merged',
  'contractor.linked_es', 'contractor.unlinked_es', 'contractor.geocoded',
  'contractor.geocode_failed', 'contractor.alias_added',
  // product
  'product.created', 'product.updated',
  // mailing campaigns
  'mailing.sent', 'mailing.bounced', 'mailing.unsubscribed', 'mailing.replied',
  // sync runs
  'sync.ifirma.started', 'sync.ifirma.finished', 'sync.ifirma.failed',
  'sync.contasimple.started', 'sync.contasimple.finished', 'sync.contasimple.failed',
  'sync.gk_receivers.started', 'sync.gk_receivers.finished', 'sync.gk_receivers.failed',
  'sync.sheets.pushed', 'sync.sheets.failed',
  'sync.imap.poll', 'sync.imap.poll_sent',
  'sync.activity_pruned',
  // agent run-level (NIE per tool-call)
  'agent.run_started', 'agent.run_finished', 'agent.run_failed',
  'agent.confirmation_resolved', 'agent.recent_activity_pulled',
  // admin/sudo
  'admin.mutate', 'admin.api_call', 'admin.gk_raw',
  // telegram pointer-only
  'telegram.in', 'telegram.out', 'telegram.file_sent',
  // observability (gated default OFF)
  'api.error', 'api.slow_request',
]);

const CATEGORY_GATES = {
  mail: 'ACTIVITY_LOG_MAIL',
  invoice: 'ACTIVITY_LOG_INVOICE',
  es_invoice: 'ACTIVITY_LOG_INVOICE',
  shipment: 'ACTIVITY_LOG_SHIPMENT',
  tracking: 'ACTIVITY_LOG_TRACKING',
  contractor: 'ACTIVITY_LOG_CONTRACTOR',
  product: 'ACTIVITY_LOG_PRODUCT',
  mailing: 'ACTIVITY_LOG_MAILING',
  sync: 'ACTIVITY_LOG_SYNC',
  agent: 'ACTIVITY_LOG_AGENT_CALLS',
  admin: 'ACTIVITY_LOG_ADMIN',
  telegram: 'ACTIVITY_LOG_TELEGRAM',
  api: 'ACTIVITY_LOG_OBSERVABILITY',
};

function isCategoryEnabled(type) {
  const cat = String(type).split('.')[0];
  const envKey = CATEGORY_GATES[cat];
  if (!envKey) return true;
  // Default: api.* OFF, reszta ON.
  const def = cat === 'api' ? '0' : '1';
  return (process.env[envKey] || def) === '1';
}

function buildSearchText(summary, payload) {
  const parts = [summary || ''];
  const p = (payload && typeof payload === 'object') ? payload : {};
  const keys = ['subject', 'contractorName', 'toEmail', 'fromEmail',
    'invoiceNumber', 'number', 'shipmentNumber', 'trackingNumber',
    'name', 'carrier'];
  for (const k of keys) {
    if (p[k] && typeof p[k] === 'string') parts.push(p[k]);
  }
  return parts.filter(Boolean).join(' ').slice(0, 1000);
}

const MAX_PAYLOAD_BYTES = 10 * 1024;

function truncatePayload(payload) {
  if (!payload || typeof payload !== 'object') return { payload: {}, meta: null };
  const str = JSON.stringify(payload);
  if (str.length <= MAX_PAYLOAD_BYTES) return { payload, meta: null };
  // Trzymamy scalar top-level keys, complex stuff stagujemy jako "[truncated]".
  const out = {};
  for (const k of Object.keys(payload)) {
    const v = payload[k];
    if (v == null || typeof v !== 'object') out[k] = v;
    else out[k] = `[truncated ${JSON.stringify(v).length}b]`;
  }
  return {
    payload: out,
    meta: { truncated: true, originalSize: str.length },
  };
}

function logActivity(prisma, evt) {
  if (!prisma || !evt || !evt.type) return;
  if (!VALID_TYPES.has(evt.type)) {
    console.warn('[activity-log] unknown type, skipping:', evt.type);
    return;
  }
  if (!isCategoryEnabled(evt.type)) return;

  setImmediate(async () => {
    try {
      const { payload, meta } = truncatePayload(evt.payload);
      const finalPayload = meta ? { ...payload, _meta: meta } : payload;
      const searchText = buildSearchText(evt.summary, finalPayload);
      await prisma.activityEvent.create({
        data: {
          type: evt.type,
          summary: (evt.summary || evt.type).slice(0, 1000),
          source: evt.source || 'system',
          contractorId: evt.contractorId || null,
          emailId: evt.emailId || null,
          invoiceId: evt.invoiceId || null,
          esInvoiceId: evt.esInvoiceId || null,
          transactionId: evt.transactionId || null,
          shipmentNumber: evt.shipmentNumber || null,
          trackingNumber: evt.trackingNumber || null,
          actorType: evt.actorType || 'system',
          actorId: evt.actorId || null,
          payload: finalPayload,
          tags: Array.isArray(evt.tags) ? evt.tags.filter(t => typeof t === 'string').map(t => t.toLowerCase()) : [],
          searchText,
        },
      });
    } catch (e) {
      console.warn('[activity-log] insert failed:', e.message, evt.type);
    }
  });
}

module.exports = { logActivity, VALID_TYPES, CATEGORY_GATES, buildSearchText };
