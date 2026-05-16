'use strict';

// CRM v2 Etap 4.6 + 4.8 — GET /api/activity z filtrami, wildcardami,
// tagami, ILIKE searchem i facetami. Idziemy po denormalizowanych
// indexach z ActivityEvent (type/source/createdAt + tags GIN). Read-only,
// bez transakcji.

const router = require('express').Router();

function parseList(s) {
  if (!s) return [];
  return String(s).split(',').map(x => x.trim()).filter(Boolean);
}

router.get('/activity', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const where = {};

    if (req.query.contractorId) where.contractorId = String(req.query.contractorId);
    if (req.query.emailId) where.emailId = String(req.query.emailId);
    if (req.query.invoiceId) where.invoiceId = String(req.query.invoiceId);
    if (req.query.transactionId) where.transactionId = String(req.query.transactionId);
    if (req.query.shipmentNumber) where.shipmentNumber = String(req.query.shipmentNumber);

    // type — pojedynczy (wildcard '.*' = startsWith), albo types — comma list.
    const types = parseList(req.query.types);
    const type = req.query.type ? String(req.query.type) : null;
    function typeClause(t) {
      return t.endsWith('.*')
        ? { type: { startsWith: t.slice(0, -1) } } // 'mail.*' → startsWith 'mail.'
        : { type: t };
    }
    if (types.length) {
      where.OR = types.map(typeClause);
    } else if (type) {
      Object.assign(where, typeClause(type));
    }

    // tags — AND po liscie, tagsAny — OR.
    const tagsAnd = parseList(req.query.tags);
    if (tagsAnd.length) where.tags = { hasEvery: tagsAnd.map(t => t.toLowerCase()) };
    const tagsAny = parseList(req.query.tagsAny);
    if (tagsAny.length) where.tags = { ...(where.tags || {}), hasSome: tagsAny.map(t => t.toLowerCase()) };

    if (req.query.source) where.source = String(req.query.source);
    if (req.query.actorType) where.actorType = String(req.query.actorType);
    if (req.query.actorId) where.actorId = String(req.query.actorId);

    if (req.query.q) where.searchText = { contains: String(req.query.q), mode: 'insensitive' };

    if (req.query.since || req.query.until) {
      where.createdAt = {};
      if (req.query.since) where.createdAt.gte = new Date(req.query.since);
      if (req.query.until) where.createdAt.lte = new Date(req.query.until);
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const order = req.query.order === 'asc' ? 'asc' : 'desc';
    const withFacets = req.query.facets === '1' || req.query.facets === 'true';

    const tasks = [
      prisma.activityEvent.findMany({
        where,
        orderBy: { createdAt: order },
        take: limit,
        skip: offset,
      }),
      prisma.activityEvent.count({ where }),
    ];
    if (withFacets) {
      tasks.push(prisma.activityEvent.groupBy({
        by: ['type'], where, _count: { _all: true },
        orderBy: { _count: { type: 'desc' } },
        take: 30,
      }));
      tasks.push(prisma.activityEvent.groupBy({
        by: ['source'], where, _count: { _all: true },
        orderBy: { _count: { source: 'desc' } },
        take: 20,
      }));
    }

    const results = await Promise.all(tasks);
    const items = results[0];
    const total = results[1];
    const facets = withFacets ? {
      type: Object.fromEntries(results[2].map(r => [r.type, r._count._all])),
      source: Object.fromEntries(results[3].map(r => [r.source, r._count._all])),
    } : undefined;

    res.json({ items, total, limit, offset, ...(facets ? { facets } : {}) });
  } catch (e) {
    console.error('[/api/activity] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
