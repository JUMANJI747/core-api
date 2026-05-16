'use strict';

/**
 * CRM v2 Etap 4.2.2 — retention prune.
 *
 * Polityki (z planu):
 *   - agent.recent_activity_pulled / sync.imap.poll* — 30 dni (debug)
 *   - agent.run_* — 90 dni
 *   - telegram.* — 90 dni
 *   - admin.* — forever (security trail)
 *   - mail.* / invoice.* / es_invoice.* / shipment.* / contractor.* /
 *     sync.<system>.{started,finished,failed} — forever (biznes)
 *   - api.error / api.slow_request — 14 dni
 *
 * Wolane z POST /api/cron/prune-activity. Idempotent — kasujemy w
 * batchach deleteMany WHERE createdAt < threshold AND type IN (...).
 */

function ago(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

const POLICIES = [
  { days: 14, types: ['api.error', 'api.slow_request'], label: 'observability_14d' },
  { days: 30, types: ['agent.recent_activity_pulled', 'sync.imap.poll', 'sync.imap.poll_sent'], label: 'debug_30d' },
  { days: 90, types: ['agent.run_started', 'agent.run_finished', 'agent.run_failed', 'telegram.in', 'telegram.out', 'telegram.file_sent'], label: 'agent_telegram_90d' },
];

async function runPrune(prisma, opts = {}) {
  const apply = !!opts.apply;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const results = [];
  for (const policy of POLICIES) {
    const threshold = ago(policy.days);
    const where = { createdAt: { lt: threshold }, type: { in: policy.types } };
    if (apply) {
      const r = await prisma.activityEvent.deleteMany({ where });
      log(`pruned ${r.count} ${policy.label}`);
      results.push({ ...policy, threshold, deleted: r.count });
    } else {
      const count = await prisma.activityEvent.count({ where });
      log(`would prune ${count} ${policy.label}`);
      results.push({ ...policy, threshold, wouldDelete: count });
    }
  }
  return { apply, policies: results };
}

module.exports = { runPrune, POLICIES };
