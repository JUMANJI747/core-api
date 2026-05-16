'use strict';

const router = require('express').Router();
const { getToken: getGkToken } = require('../glob-client');
const { runBackfill: runContractorV2Backfill } = require('../services/contractor-v2-backfill');
const { runBackfill: runContractorContactsBackfill } = require('../services/contractor-contacts-backfill');
const { runBackfill: runInvoiceSnapshotsBackfill } = require('../services/invoice-snapshot-backfill');
const { runBackfill: runInvoiceLinesBackfill } = require('../services/invoice-lines-backfill');
const { runBackfill: runActivityBackfill } = require('../services/activity-backfill');
const { runPrune: runActivityPrune } = require('../services/activity-prune');
const https = require('https');

// ============ ADMIN ENDPOINTS ============
// Każdy z tych endpointów jest opakowaniem dla potężnej operacji której
// zwykłe sub-agenty nie powinny mieć dostępu. Dostępne dla Sudo Agenta
// (i bezpośrednio przez API_KEY auth — to ten sam klucz co wszędzie).
//
// Każda destrukcyjna operacja loguje pełny request i caller w Railway →
// trail audytowy.

// Read-only SQL. Tylko SELECT (regex check). Zwraca max 500 wierszy.
router.post('/admin/query', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { sql, params } = req.body || {};
  if (!sql || typeof sql !== 'string') return res.status(400).json({ error: 'sql (string) required' });
  const trimmed = sql.trim().replace(/^\s*--.*$/gm, '').trim();
  // Permissive read-only check: must start with SELECT or WITH (CTE), must not
  // contain destructive keywords as standalone words.
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    return res.status(400).json({ error: 'only SELECT / WITH queries allowed in /admin/query — use /admin/mutate for writes' });
  }
  if (/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/i.test(trimmed)) {
    return res.status(400).json({ error: 'destructive keyword detected — use /admin/mutate for writes' });
  }
  try {
    console.log(`[admin/query] ${trimmed.slice(0, 300)}`);
    const rows = await prisma.$queryRawUnsafe(trimmed, ...(Array.isArray(params) ? params : []));
    const arr = Array.isArray(rows) ? rows : [rows];
    res.json({ ok: true, rowCount: arr.length, rows: arr.slice(0, 500), truncated: arr.length > 500 });
  } catch (e) {
    console.error('[admin/query] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Destructive SQL. INSERT / UPDATE / DELETE / etc. WYMAGA confirm:true.
router.post('/admin/mutate', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { sql, params, confirm } = req.body || {};
  if (!sql || typeof sql !== 'string') return res.status(400).json({ error: 'sql required' });
  if (confirm !== true) return res.status(400).json({ error: 'destructive — pass { "confirm": true } to proceed' });
  try {
    console.warn(`[admin/mutate] ${sql.trim().slice(0, 500)}`);
    const affected = await prisma.$executeRawUnsafe(sql, ...(Array.isArray(params) ? params : []));
    res.json({ ok: true, rowsAffected: affected });
  } catch (e) {
    console.error('[admin/mutate] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Proxy: wywołaj DOWOLNY endpoint naszego backendu (/api/*) tym samym
// kluczem co request. Pozwala Sudo wywołać każdy istniejący endpoint
// nawet jeśli zwykły sub-agent go nie ma w toolach.
router.post('/admin/call-endpoint', async (req, res) => {
  const http = require('http');
  const { method = 'POST', path, body } = req.body || {};
  if (!path || typeof path !== 'string') return res.status(400).json({ error: 'path required (e.g. "/api/transactions")' });
  if (!path.startsWith('/api/')) return res.status(400).json({ error: 'path must start with /api/' });
  const apiKey = (process.env.API_KEY || '').trim();
  const data = body && method !== 'GET' ? JSON.stringify(body) : '';
  let finalPath = path;
  if (method === 'GET' && body && typeof body === 'object') {
    const params = Object.entries(body).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]);
    if (params.length) finalPath = `${path}?${new URLSearchParams(params).toString()}`;
  }
  console.log(`[admin/call-endpoint] ${method} ${finalPath}`);
  const opts = {
    hostname: '127.0.0.1', port: process.env.PORT || 3000, path: finalPath, method,
    headers: {
      'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
  };
  const proxyReq = http.request(opts, (proxyRes) => {
    const chunks = [];
    proxyRes.on('data', c => chunks.push(c));
    proxyRes.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      try { res.json({ ok: proxyRes.statusCode < 400, status: proxyRes.statusCode, body: JSON.parse(text) }); }
      catch (_) { res.json({ ok: proxyRes.statusCode < 400, status: proxyRes.statusCode, body: text }); }
    });
  });
  proxyReq.on('error', e => res.status(500).json({ error: e.message }));
  if (data) proxyReq.write(data);
  proxyReq.end();
});

// Raw GlobKurier API call. Sudo może wywołać każdy endpoint GK którego
// nasz glob-client jeszcze nie ma jako funkcji. Token dorzucany automatycznie.
router.post('/admin/gk-raw', async (req, res) => {
  const { method = 'GET', path, body, headers: extraHeaders } = req.body || {};
  if (!path || typeof path !== 'string') return res.status(400).json({ error: 'path required (e.g. "/v1/order/tracking?orderNumber=GK...")' });
  if (!path.startsWith('/v1/')) return res.status(400).json({ error: 'path must start with /v1/' });
  try {
    const token = await getGkToken();
    const data = body && method !== 'GET' ? JSON.stringify(body) : '';
    const opts = {
      hostname: 'api.globkurier.pl', port: 443, path, method,
      headers: {
        'X-Auth-Token': token,
        'Accept': 'application/json',
        'Accept-Language': 'pl',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(extraHeaders || {}),
      },
    };
    console.log(`[admin/gk-raw] ${method} ${path}`);
    const proxyReq = https.request(opts, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { res.json({ status: proxyRes.statusCode, body: JSON.parse(text) }); }
        catch (_) { res.json({ status: proxyRes.statusCode, body: text }); }
      });
    });
    proxyReq.on('error', e => res.status(500).json({ error: e.message }));
    if (data) proxyReq.write(data);
    proxyReq.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ CRM v2 BACKFILLS ============
// Jednorazowe migracje danych — idempotentne (nadpisuja tylko puste pola).
// Dry-run domyslnie; { "apply": true } zapisuje.

// Etap 1: Contractor extras + flat fields -> aliases/externalIds/primaryEmail.
router.post('/admin/backfill/contractor-v2', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const apply = req.body && req.body.apply === true;
  const verbose = req.body && req.body.verbose === true;
  console.log(`[admin/backfill/contractor-v2] apply=${apply} verbose=${verbose}`);
  try {
    const result = await runContractorV2Backfill(prisma, {
      apply, verbose,
      log: (msg) => console.log(`[backfill] ${msg}`),
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[admin/backfill/contractor-v2] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Etap 1.2 + 1.3: ContractorContact + ContractorAddress backfill z flat
// fields (email/phone/address) + extras.locations[].
router.post('/admin/backfill/contractor-contacts', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const apply = req.body && req.body.apply === true;
  const verbose = req.body && req.body.verbose === true;
  console.log(`[admin/backfill/contractor-contacts] apply=${apply} verbose=${verbose}`);
  try {
    const result = await runContractorContactsBackfill(prisma, {
      apply, verbose,
      log: (msg) => console.log(`[backfill] ${msg}`),
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[admin/backfill/contractor-contacts] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Etap 2.1: Invoice + EsInvoice contractor snapshot (contractorName/Nip/
// Country/City) wypelniony z aktualnego stanu (Es)Contractor. Idempotentny —
// nadpisuje tylko puste pola, wiec reczne korekty z NocoDB przezyja kolejne
// uruchomienie.
router.post('/admin/backfill/invoice-snapshots', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const apply = req.body && req.body.apply === true;
  const verbose = req.body && req.body.verbose === true;
  console.log(`[admin/backfill/invoice-snapshots] apply=${apply} verbose=${verbose}`);
  try {
    const result = await runInvoiceSnapshotsBackfill(prisma, {
      apply, verbose,
      log: (msg) => console.log(`[backfill] ${msg}`),
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[admin/backfill/invoice-snapshots] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Etap 2.2/2.3: InvoiceLineItem + EsInvoiceLineItem backfill z extras.
// PL: extras.pozycje (preferowane, ma cene) -> extras.items (proporcjonalnie
// po qty, vatRate + price inferred). ES: extras.previewLines (preferowane,
// ma EAN) -> extras.lines (Contasimple response shape). Idempotent — FV z
// istniejacymi line itemami pomijane bezwarunkowo.
router.post('/admin/backfill/invoice-lines', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const apply = req.body && req.body.apply === true;
  const verbose = req.body && req.body.verbose === true;
  console.log(`[admin/backfill/invoice-lines] apply=${apply} verbose=${verbose}`);
  try {
    const result = await runInvoiceLinesBackfill(prisma, {
      apply, verbose,
      log: (msg) => console.log(`[backfill] ${msg}`),
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[admin/backfill/invoice-lines] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Etap 4.5: Backfill historycznych ActivityEvent z Email/Invoice/EsInvoice/
// Transaction/Contractor. Idempotent — usuwa source='backfill' przed
// re-runem.
router.post('/admin/backfill/activity', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const apply = req.body && req.body.apply === true;
  console.log(`[admin/backfill/activity] apply=${apply}`);
  try {
    const result = await runActivityBackfill(prisma, {
      apply,
      log: (msg) => console.log(`[activity-backfill] ${msg}`),
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[admin/backfill/activity] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Etap 4.2.2: Retention prune. Bezparametrowo (default dry-run), z apply
// kasuje wg POLICIES. Cron: POST /api/cron/prune-activity (Etap 6.2).
router.post('/admin/activity/prune', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const apply = req.body && req.body.apply === true;
  try {
    const result = await runActivityPrune(prisma, {
      apply,
      log: (msg) => console.log(`[activity-prune] ${msg}`),
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[admin/activity/prune] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============ CRM v2 etap 3.3 — admin manual data ops ============

// POST /api/admin/contractors/merge
//   body { keepId, dropId, confirm: true }
// Przepina wszystkie FK z dropId na keepId, mergeuje contacts/addresses/
// aliases/externalIds, kasuje drop. Idempotent na poziomie unique-keyow
// (contacts dedup, addresses normalize). Wymaga confirm:true.
router.post('/admin/contractors/merge', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { keepId, dropId, confirm } = req.body || {};
  if (!keepId || !dropId) return res.status(400).json({ ok: false, error: 'keepId i dropId wymagane' });
  if (keepId === dropId) return res.status(400).json({ ok: false, error: 'keepId == dropId' });
  if (confirm !== true) return res.status(400).json({ ok: false, error: 'wymaga confirm:true (destruktywne — kasuje dropId)' });

  try {
    const [keep, drop] = await Promise.all([
      prisma.contractor.findUnique({ where: { id: keepId } }),
      prisma.contractor.findUnique({ where: { id: dropId } }),
    ]);
    if (!keep) return res.status(404).json({ ok: false, error: `keep (${keepId}) nie istnieje` });
    if (!drop) return res.status(404).json({ ok: false, error: `drop (${dropId}) nie istnieje` });

    const stats = { aliasesAdded: 0, externalIdsMerged: 0 };

    // 1) Contacts — przepinanie z dedup. Bierzemy istniejace contacts
    //    dropa, dla kazdego probujemy stworzyc na keep z onDup skip
    //    (upsert pasuje bo mamy @@unique[contractorId, type, value]).
    const dropContacts = await prisma.contractorContact.findMany({ where: { contractorId: dropId } });
    let contactsMoved = 0, contactsSkipped = 0;
    for (const ct of dropContacts) {
      try {
        await prisma.contractorContact.upsert({
          where: { contractorId_type_value: { contractorId: keepId, type: ct.type, value: ct.value } },
          update: {}, // istnieje juz na keepId — zostaw oryginal
          create: {
            contractorId: keepId,
            type: ct.type, value: ct.value,
            label: ct.label, personName: ct.personName,
            isPrimary: ct.isPrimary, source: ct.source || 'merge',
            notes: ct.notes, extras: ct.extras || {},
          },
        });
        contactsMoved++;
      } catch (e) {
        console.error('[merge] contact dedup failed:', e.message, ct.id);
        contactsSkipped++;
      }
    }
    // Po przepieciu kasujemy contacts dropa (cascade by je usunal przy
    // delete drop, ale lepiej jawnie zeby uniknac sytuacji "drop ma 5
    // contacts, mergeujemy 3, 2 nie zalapaly do dedup i znikneliby z
    // cascade bez sladu").
    await prisma.contractorContact.deleteMany({ where: { contractorId: dropId } });

    // 2) Addresses — analogicznie ale bez @@unique w schemie. Korzystamy
    //    z normalizacji z contractor-sync-helpers (NFKD + lowercase).
    const { upsertAddress } = require('../services/contractor-sync-helpers');
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

    // 3) Twarde FK — Email/Invoice/InvoiceLineItem/Transaction/Deal/Consignment
    //    leca prosto updateMany bo nie maja unique constraintow z contractorId.
    const [emails, invoices, invoiceLines, transactions, deals, consignments] = await Promise.all([
      prisma.email.updateMany({ where: { contractorId: dropId }, data: { contractorId: keepId } }),
      prisma.invoice.updateMany({ where: { contractorId: dropId }, data: { contractorId: keepId } }),
      prisma.invoiceLineItem.updateMany({ where: { contractorId: dropId }, data: { contractorId: keepId } }),
      prisma.transaction.updateMany({ where: { contractorId: dropId }, data: { contractorId: keepId } }),
      prisma.deal.updateMany({ where: { contractorId: dropId }, data: { contractorId: keepId } }),
      prisma.consignment.updateMany({ where: { contractorId: dropId }, data: { contractorId: keepId } }),
    ]);

    // 4) Aliases — keep.aliases ∪ drop.aliases + drop.name jako alias.
    const aliasesAfter = [...(keep.aliases || [])];
    const lower = new Set(aliasesAfter.map(a => a.toLowerCase()));
    if (keep.name) lower.add(keep.name.toLowerCase());
    function pushIfNovel(a) {
      if (!a) return;
      const s = String(a).trim();
      if (s.length < 2 || s.length > 80) return;
      if (lower.has(s.toLowerCase())) return;
      aliasesAfter.push(s);
      lower.add(s.toLowerCase());
      stats.aliasesAdded++;
    }
    for (const a of (drop.aliases || [])) pushIfNovel(a);
    pushIfNovel(drop.name);

    // 5) externalIds — shallow merge, keep wygrywa konflikt (bo zostaje).
    const keepExt = (keep.externalIds && typeof keep.externalIds === 'object') ? keep.externalIds : {};
    const dropExt = (drop.externalIds && typeof drop.externalIds === 'object') ? drop.externalIds : {};
    const mergedExt = { ...dropExt, ...keepExt };
    for (const k of Object.keys(dropExt)) {
      if (mergedExt[k] === dropExt[k] && keepExt[k] == null) stats.externalIdsMerged++;
    }

    // 6) linkedEsContractorId — jak drop mial, a keep nie → migrate.
    let linkedEsMigrated = false;
    let linkedEsData = {};
    if (drop.linkedEsContractorId && !keep.linkedEsContractorId) {
      linkedEsData = { linkedEsContractorId: drop.linkedEsContractorId };
      linkedEsMigrated = true;
    }

    // 7) Aktualizacja keep + delete drop.
    const updatedKeep = await prisma.contractor.update({
      where: { id: keepId },
      data: {
        aliases: aliasesAfter,
        externalIds: mergedExt,
        ...linkedEsData,
        // Jezeli keep nie ma primaryEmail/preferredLanguage/phone a drop ma → przejmij.
        ...(!keep.primaryEmail && drop.primaryEmail ? { primaryEmail: drop.primaryEmail } : {}),
        ...(!keep.preferredLanguage && drop.preferredLanguage ? { preferredLanguage: drop.preferredLanguage } : {}),
        ...(!keep.phone && drop.phone ? { phone: drop.phone } : {}),
        ...(!keep.email && drop.email ? { email: drop.email } : {}),
        ...(!keep.address && drop.address ? { address: drop.address } : {}),
        ...(!keep.city && drop.city ? { city: drop.city } : {}),
        ...(!keep.country && drop.country ? { country: drop.country } : {}),
      },
    });

    await prisma.contractor.delete({ where: { id: dropId } });

    // 8) AuditLog (security trail). ActivityEvent timeline dorzucimy w
    //    commicie #9 razem z Etapem 4 — wtedy emit contractor.merged.
    await prisma.auditLog.create({
      data: {
        actor: 'admin', action: 'contractor.merge',
        entityType: 'Contractor', entityId: keepId,
        payload: {
          keepId, dropId,
          keepNameBefore: keep.name, dropNameBefore: drop.name,
          fkUpdates: {
            emails: emails.count, invoices: invoices.count, invoiceLines: invoiceLines.count,
            transactions: transactions.count, deals: deals.count, consignments: consignments.count,
          },
          contactsMoved, contactsSkipped, addressesMoved,
          aliasesAdded: stats.aliasesAdded, externalIdsMerged: stats.externalIdsMerged,
          linkedEsMigrated,
        },
      },
    });

    try {
      const { logActivity } = require('../services/activity-log');
      logActivity(prisma, {
        type: 'contractor.merged',
        summary: `Merge ${drop.name} → ${keep.name}`,
        source: 'sudo',
        contractorId: keepId,
        actorType: 'user',
        payload: { keepId, dropId, keepName: keep.name, dropName: drop.name,
          emails: emails.count, invoices: invoices.count, transactions: transactions.count,
          contactsMoved, addressesMoved, aliasesAdded: stats.aliasesAdded, linkedEsMigrated },
      });
    } catch (_) {}

    res.json({
      ok: true, keepId, dropId,
      contractor: { id: updatedKeep.id, name: updatedKeep.name, aliases: updatedKeep.aliases.length, externalIds: Object.keys(updatedKeep.externalIds || {}).length },
      moved: {
        emails: emails.count, invoices: invoices.count, invoiceLines: invoiceLines.count,
        transactions: transactions.count, deals: deals.count, consignments: consignments.count,
        contacts: contactsMoved, addresses: addressesMoved,
      },
      stats: { contactsSkipped, aliasesAdded: stats.aliasesAdded, externalIdsMerged: stats.externalIdsMerged, linkedEsMigrated },
    });
  } catch (e) {
    console.error('[admin/contractors/merge] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/contractors/:id/link-es
//   body { esContractorId, confirm: true }
// Ustawia Contractor.linkedEsContractorId. Sprawdza ze PL nie jest juz
// zlinkowany do innego ES i ze docelowy ES nie ma juz innego PL. Wymaga
// confirm:true bo to materialne polaczenie biznesowe — auto-link po NIP
// w sync hookach to inna sciezka (sekcja 1.5 contractor-sync-helpers).
router.post('/admin/contractors/:id/link-es', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { id } = req.params;
  const { esContractorId, confirm } = req.body || {};
  if (!esContractorId) return res.status(400).json({ ok: false, error: 'esContractorId wymagane' });
  if (confirm !== true) return res.status(400).json({ ok: false, error: 'wymaga confirm:true' });

  try {
    const [pl, es] = await Promise.all([
      prisma.contractor.findUnique({ where: { id } }),
      prisma.esContractor.findUnique({ where: { id: esContractorId } }),
    ]);
    if (!pl) return res.status(404).json({ ok: false, error: `PL contractor ${id} nie istnieje` });
    if (!es) return res.status(404).json({ ok: false, error: `EsContractor ${esContractorId} nie istnieje` });

    if (pl.linkedEsContractorId && pl.linkedEsContractorId !== esContractorId) {
      return res.status(409).json({ ok: false, error: `PL ${id} juz zlinkowany z ES ${pl.linkedEsContractorId}. Najpierw odlinkuj (PUT z esContractorId=null) albo merge.` });
    }
    const otherPl = await prisma.contractor.findFirst({
      where: { linkedEsContractorId: esContractorId, NOT: { id } },
      select: { id: true, name: true },
    });
    if (otherPl) {
      return res.status(409).json({ ok: false, error: `ES ${esContractorId} juz zlinkowany z innym PL ${otherPl.id} (${otherPl.name}). Wybierz inny ES albo unlink tamten.` });
    }

    if (pl.linkedEsContractorId === esContractorId) {
      return res.json({ ok: true, message: 'already linked', linkedEsContractorId: esContractorId });
    }

    await prisma.contractor.update({
      where: { id },
      data: { linkedEsContractorId: esContractorId },
    });

    await prisma.auditLog.create({
      data: {
        actor: 'admin', action: 'contractor.link_es',
        entityType: 'Contractor', entityId: id,
        payload: { plName: pl.name, plNip: pl.nip, esContractorId, esName: es.name, esNif: es.nif },
      },
    });
    try {
      const { logActivity } = require('../services/activity-log');
      logActivity(prisma, {
        type: 'contractor.linked_es',
        summary: `Linked PL ${pl.name} ↔ ES ${es.name}`,
        source: 'sudo',
        contractorId: id,
        actorType: 'user',
        payload: { plName: pl.name, plNip: pl.nip, esContractorId, esName: es.name, esNif: es.nif },
      });
    } catch (_) {}

    res.json({
      ok: true, id, linkedEsContractorId: esContractorId,
      pl: { id: pl.id, name: pl.name, nip: pl.nip },
      es: { id: es.id, name: es.name, nif: es.nif },
    });
  } catch (e) {
    console.error('[admin/contractors/:id/link-es] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/contractors/:id/unlink-es { confirm }
// Symetryczny unlink. Pomocniczy — gdyby auto-link zlapal nie ten zwiazek.
router.post('/admin/contractors/:id/unlink-es', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { id } = req.params;
  const { confirm } = req.body || {};
  if (confirm !== true) return res.status(400).json({ ok: false, error: 'wymaga confirm:true' });
  try {
    const pl = await prisma.contractor.findUnique({ where: { id }, select: { id: true, name: true, linkedEsContractorId: true } });
    if (!pl) return res.status(404).json({ ok: false, error: 'nie istnieje' });
    if (!pl.linkedEsContractorId) return res.json({ ok: true, message: 'not linked' });
    const previousLink = pl.linkedEsContractorId;
    await prisma.contractor.update({ where: { id }, data: { linkedEsContractorId: null } });
    await prisma.auditLog.create({
      data: {
        actor: 'admin', action: 'contractor.unlink_es',
        entityType: 'Contractor', entityId: id,
        payload: { plName: pl.name, previousEsContractorId: previousLink },
      },
    });
    try {
      const { logActivity } = require('../services/activity-log');
      logActivity(prisma, {
        type: 'contractor.unlinked_es',
        summary: `Unlinked PL ${pl.name} from ES ${previousLink}`,
        source: 'sudo',
        contractorId: id,
        actorType: 'user',
        payload: { plName: pl.name, previousEsContractorId: previousLink },
      });
    } catch (_) {}
    res.json({ ok: true, id, previousLink });
  } catch (e) {
    console.error('[admin/contractors/:id/unlink-es] error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
