'use strict';

const router = require('express').Router();
const { getToken: getGkToken } = require('../glob-client');
const { runBackfill: runContractorV2Backfill } = require('../services/contractor-v2-backfill');
const { runBackfill: runContractorContactsBackfill } = require('../services/contractor-contacts-backfill');
const { runBackfill: runInvoiceSnapshotsBackfill } = require('../services/invoice-snapshot-backfill');
const { runBackfill: runInvoiceLinesBackfill } = require('../services/invoice-lines-backfill');
const { runBackfill: runInvoiceLinesFromIfirmaBackfill } = require('../services/invoice-lines-from-ifirma-backfill');
const { runBackfill: runEsInvoicesBackfill } = require('../services/es-invoices-backfill');
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

// Backfill InvoiceLineItem dla FV bez pozycji w bazie (importowanych
// przez ifirma-sync, ktora /listy-faktur nie zwraca Pozycji). Zaciaga
// /fakturakraj/{id}, parsuje, matchuje produkty po EAN (z NazwaPelna)
// -> fuzzy -> LLM Haiku fallback. Rate-limited.
//
// Body:
//   apply (bool, default false)
//   limit (int, default 20)        — ile FV per run (chunkujemy)
//   sleepMs (int, default 1500)    — pauza miedzy fetchami (iFirma rate)
//   verbose (bool, default false)
//
// Response: { processed, errors, totalLinesCreated, matchStats:
//   {directEan, fuzzyMatched, llmCalls, unmatched}, sample, errorsSample }
//
// Workflow: najpierw probe na 1 FV przez /admin/ifirma/probe-details,
// potem ten endpoint z malym limitem (apply:false), zweryfikuj sample +
// matchStats, potem apply:true z wiekszym limitem.
router.post('/admin/backfill/invoice-lines-from-ifirma', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const body = req.body || {};
  const apply = body.apply === true;
  const verbose = body.verbose === true;
  const limit = Number.isFinite(body.limit) ? body.limit : 20;
  const sleepMs = Number.isFinite(body.sleepMs) ? body.sleepMs : 1500;
  console.log(`[admin/backfill/invoice-lines-from-ifirma] apply=${apply} limit=${limit} sleep=${sleepMs}`);
  try {
    const result = await runInvoiceLinesFromIfirmaBackfill(prisma, {
      apply, verbose, limit, sleepMs,
      log: (msg) => console.log(`[ifirma-lines-backfill] ${msg}`),
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[admin/backfill/invoice-lines-from-ifirma] error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Backfill — pelen sync FV z Contasimple do EsInvoice + EsInvoiceLineItem
// + EsContractor (wtorne). Iteruje po kwartalach (default: od env
// CONTASIMPLE_BACKFILL_START_YEAR, dziedziczone obecny rok). Idempotent
// po contasimpleId.
//
// Body:
//   apply (bool, default false)
//   periods (string[]?, np. ['2026-1T','2026-2T']) — gdy pominete, default
//     wg env start year do biezacego.
router.post('/admin/backfill/es-invoices-from-contasimple', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const body = req.body || {};
  const apply = body.apply === true;
  const periods = Array.isArray(body.periods) ? body.periods : null;
  console.log(`[admin/backfill/es-invoices-from-contasimple] apply=${apply} periods=${periods ? periods.join(',') : 'default'}`);
  try {
    const result = await runEsInvoicesBackfill(prisma, {
      apply, periods,
      log: (msg) => console.log(`[es-invoices-backfill] ${msg}`),
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[admin/backfill/es-invoices-from-contasimple] error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Diagnostic — wywoluje iFirma fetchInvoiceDetails(fakturaId, rodzaj) i
// zwraca raw response. Sluzy do sprawdzenia ksztaltu Pozycje[] przed
// napisaniem backfillu ktory zaciagnie pozycje historycznych FV (te z
// pustym extras po imporcie przez ifirma-sync).
router.post('/admin/ifirma/probe-details', async (req, res) => {
  const { fakturaId, rodzaj } = req.body || {};
  if (!fakturaId) return res.status(400).json({ error: 'fakturaId required' });
  try {
    const { fetchInvoiceDetails } = require('../ifirma-client');
    const details = await fetchInvoiceDetails(fakturaId, rodzaj || 'prz_faktura_kraj');
    res.json({ ok: true, fakturaId, rodzaj, details });
  } catch (e) {
    console.error('[admin/ifirma/probe-details] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
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

// POST /api/admin/contractors/dedupe-nip
//   body { confirm: true }  albo  { dryRun: true } (podgląd bez zmian)
// Znajduje kontrahentów o TYM SAMYM (znormalizowanym) NIP i scala ich w jeden
// (keep = najwięcej faktur, potem najstarszy). Kanonizuje NIP keepa. Jednorazowe
// sprzątanie istniejących duplikatów (nowe blokuje już auto-merge w /upsert).
router.post('/admin/contractors/dedupe-nip', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { confirm, dryRun } = req.body || {};
  try {
    const { mergeContractors, normalizeNipKey, stripNipCountryPrefix, sameNip } = require('../services/contractor-merge');
    const all = await prisma.contractor.findMany({
      where: { nip: { not: null } },
      select: { id: true, nip: true, name: true, createdAt: true },
    });
    // Grupuj po kluczu BEZ prefiksu kraju ("29494914J" == "ES29494914J"), ale
    // scalaj tylko pary zgodne wg sameNip (PL123 vs DE123 zostają osobno).
    const groups = new Map();
    for (const c of all) {
      const key = stripNipCountryPrefix(normalizeNipKey(c.nip));
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const dups = [...groups.entries()]
      .map(([key, arr]) => {
        if (arr.length < 2) return null;
        // odfiltruj sprzeczne prefiksy: zostaw tylko rekordy zgodne z pierwszym
        const compatible = arr.filter(c => sameNip(c.nip, arr[0].nip));
        return compatible.length > 1 ? [key, compatible] : null;
      })
      .filter(Boolean);
    if (!dups.length) return res.json({ ok: true, groups: 0, merged: 0, message: 'Brak duplikatów po NIP.' });

    const ids = dups.flatMap(([, arr]) => arr.map(c => c.id));
    const invCounts = await prisma.invoice.groupBy({ by: ['contractorId'], where: { contractorId: { in: ids } }, _count: { _all: true } });
    const invMap = new Map(invCounts.map(r => [r.contractorId, r._count._all]));
    const rank = (a, b) => (invMap.get(b.id) || 0) - (invMap.get(a.id) || 0) || new Date(a.createdAt) - new Date(b.createdAt);

    if (dryRun === true) {
      return res.json({
        ok: true, dryRun: true, groups: dups.length,
        plan: dups.map(([key, arr]) => ({ nip: key, keep: [...arr].sort(rank)[0].name, records: [...arr].sort(rank).map(c => ({ id: c.id, name: c.name, invoices: invMap.get(c.id) || 0 })) })),
      });
    }
    if (confirm !== true) return res.status(400).json({ ok: false, error: 'wymaga confirm:true (destruktywne) albo dryRun:true' });

    let merged = 0;
    const results = [];
    for (const [key, arr] of dups) {
      arr.sort(rank);
      const keep = arr[0];
      for (const drop of arr.slice(1)) {
        try { await mergeContractors(prisma, keep.id, drop.id); merged++; results.push({ nip: key, kept: keep.name, dropped: drop.name }); }
        catch (e) { results.push({ nip: key, kept: keep.name, dropError: `${drop.name}: ${e.message}` }); }
      }
      // Po scaleniu kanonizuj NIP keepa na NAJBOGATSZY wariant grupy (z prefiksem
      // kraju, jeśli ktoryś rekord go miał) — key jest bez prefiksu, nie nadpisuj nim.
      const withPrefix = arr.map(c => normalizeNipKey(c.nip)).find(k => k !== key) || normalizeNipKey(keep.nip) || key;
      try { await prisma.contractor.update({ where: { id: keep.id }, data: { nip: withPrefix } }); } catch (_) { /* noop */ }
    }
    res.json({ ok: true, groups: dups.length, merged, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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

// NAPRAWA: przepnij transakcję (deal cycle) do WŁAŚCIWEGO kontrahenta — tego
// z faktury. Sprząta skutki starego fuzzy-parowania, które potrafiło przypiąć
// cudzą FV/wysyłkę do złego kontrahenta (np. FV 86/2026 Żeglarza na karcie
// Uhainy). body: { invoiceNumber } — transakcje z tą FV dostają kontrahenta
// z rekordu Invoice.
router.post('/admin/transactions/reassign-by-invoice', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const invoiceNumber = String((req.body && req.body.invoiceNumber) || '').trim();
    if (!invoiceNumber) return res.status(400).json({ ok: false, error: 'invoiceNumber required' });
    const inv = await prisma.invoice.findFirst({
      where: { number: invoiceNumber },
      orderBy: { createdAt: 'desc' },
      include: { contractor: { select: { id: true, name: true } } },
    });
    if (!inv) return res.status(404).json({ ok: false, error: `Nie znaleziono faktury ${invoiceNumber}` });
    if (!inv.contractorId) return res.status(400).json({ ok: false, error: `Faktura ${invoiceNumber} nie ma kontrahenta w bazie.` });

    const before = await prisma.transaction.findMany({
      where: { invoiceNumber },
      select: { id: true, contractorId: true, contractorName: true, shipmentNumber: true },
    });
    const r = await prisma.transaction.updateMany({
      where: { invoiceNumber },
      data: { contractorId: inv.contractorId, contractorName: (inv.contractor && inv.contractor.name) || inv.contractorName || null },
    });
    res.json({
      ok: true,
      invoiceNumber,
      correctContractor: { id: inv.contractorId, name: inv.contractor && inv.contractor.name },
      reassigned: r.count,
      before,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/admin/merge-contractors — STARY interfejs (primaryId/secondaryId),
// deleguje do wspólnego services/contractor-merge (ten sam kod co
// /admin/contractors/merge i dedupe-nip: kontakty, adresy, FK, aliasy,
// externalIds, AuditLog). Wcześniej miał własną, słabszą kopię logiki
// (gubiła ContractorContact/ContractorAddress/InvoiceLineItem) — audyt #27.
router.post('/admin/merge-contractors', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { primaryId, secondaryId } = req.body || {};
    if (!primaryId || !secondaryId) return res.status(400).json({ error: 'primaryId + secondaryId required' });
    if (primaryId === secondaryId) return res.status(400).json({ error: 'cannot merge with self' });
    const { mergeContractors } = require('../services/contractor-merge');
    const result = await mergeContractors(prisma, primaryId, secondaryId);
    // Liczniki top-level dla kompatybilności ze starym UI (r.invoices/r.emails/r.transactions).
    res.json({ ok: true, primaryId, secondaryId, ...result.moved, moved: result.moved, stats: result.stats, contractor: result.contractor });
  } catch (e) {
    console.error('[admin/merge-contractors]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/admin/dedupe-contractors — auto-scalanie OCZYWISTYCH duplikatów PL
// kontrahentów: grupuje po ZNORMALIZOWANYM NIP (zdjęty prefiks kraju + format).
// Ten sam NIP = ta sama firma → bezpieczny merge. body: { apply?:bool }.
// apply=false (default) → tylko plan (dry-run). apply=true → scala przez
// /admin/contractors/merge (przenosi FV/maile/kontakty/adresy, kasuje duplikat).
const EU_VAT_PREFIX = /^(FR|ES|DE|PT|IT|NL|BE|PL|GB|IE|AT|SE|DK|FI|CZ|SK|HU|RO|BG|HR|SI|LT|LV|EE|LU|MT|CY|GR|EL)$/;
function normNipForDedup(nip) {
  if (!nip) return '';
  let s = String(nip).toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Zdejmij wiodący 2-literowy kod kraju VAT (np. FR/ES) gdy poprzedza resztę
  // — "FR44123"=="44123", "ESB12"=="B12". Hiszpański NIF "B12.." (litera+cyfra)
  // nie jest ruszany, bo [A-Z]{2} wymaga dwóch LITER.
  const m = s.match(/^([A-Z]{2})(?=[0-9A-Z])/);
  if (m && EU_VAT_PREFIX.test(m[1])) s = s.slice(2);
  return s;
}
function dedupKeepScore(c) {
  return (c.linkedEsContractorId ? 4 : 0)
    + (c.email || c.primaryEmail ? 1 : 0)
    + (c.phone ? 1 : 0)
    + (c.address ? 1 : 0)
    + (c.city ? 1 : 0)
    + ((c.aliases && c.aliases.length) ? 1 : 0);
}
router.post('/admin/dedupe-contractors', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const apply = req.body && (req.body.apply === true || req.body.apply === 'true');
  try {
    const all = await prisma.contractor.findMany({
      select: {
        id: true, name: true, nip: true, email: true, primaryEmail: true, phone: true,
        address: true, city: true, country: true, aliases: true, linkedEsContractorId: true, createdAt: true,
      },
    });
    // Grupuj po znormalizowanym NIP (pomijamy puste).
    const groups = new Map();
    for (const c of all) {
      const key = normNipForDedup(c.nip);
      if (!key || key.length < 5) continue; // za krótki / brak NIP → nie ruszamy (ryzyko fałszywego scalenia)
      if (/^(.)\1+$/.test(key)) continue;   // placeholder typu "0000000000" — NIE scalaj różnych firm
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }

    const plan = [];
    for (const [key, members] of groups) {
      if (members.length < 2) continue;
      // keep = najpełniejszy rekord; remis → najstarszy (stabilna tożsamość/nazwa).
      const sorted = members.slice().sort((a, b) =>
        dedupKeepScore(b) - dedupKeepScore(a) || new Date(a.createdAt) - new Date(b.createdAt));
      const keep = sorted[0];
      const drops = sorted.slice(1);
      plan.push({
        nipNorm: key,
        keep: { id: keep.id, name: keep.name, nip: keep.nip },
        drops: drops.map(d => ({ id: d.id, name: d.name, nip: d.nip })),
      });
    }

    // PROPOZYCJE (NIE auto-scalane): podobni po EMAILU lub TELEFONIE, ale bez
    // wspólnego znormalizowanego NIP — czyli przypadki "nie na 100%". Pokazujemy
    // do ręcznej decyzji (merge robisz świadomie). Email/telefon = mocny sygnał,
    // mało fałszywek; nazwy nie używamy (zbyt szumna). Wykluczamy pary, które i
    // tak złapie auto-merge po NIP.
    const { normalizeEmail, normalizePhone, isOwnEmail } = require('../services/contractor-sync-helpers');
    const sameNipKey = (a, b) => {
      const ka = normNipForDedup(a.nip); const kb = normNipForDedup(b.nip);
      return ka && kb && ka === kb;
    };
    const byKey = new Map(); // "email:x" / "phone:x" -> [contractors]
    for (const c of all) {
      const em = normalizeEmail(c.email) || normalizeEmail(c.primaryEmail);
      if (em && !isOwnEmail(em)) {
        const k = `email:${em}`;
        if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(c);
      }
      const ph = normalizePhone(c.phone);
      if (ph) {
        const k = `phone:${ph}`;
        if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(c);
      }
    }
    const suggestions = [];
    const seenPair = new Set();
    for (const [k, members] of byKey) {
      if (members.length < 2) continue;
      // tylko gdy NIE wszyscy mają ten sam NIP (inaczej auto-merge to ogarnie)
      const distinct = members.filter((m, i) => members.findIndex(x => x.id === m.id) === i);
      if (distinct.length < 2) continue;
      const allSameNip = distinct.every(m => sameNipKey(m, distinct[0]));
      if (allSameNip) continue;
      const [type, value] = k.split(/:(.+)/);
      const pairKey = distinct.map(m => m.id).sort().join('|');
      if (seenPair.has(pairKey)) continue;
      seenPair.add(pairKey);
      suggestions.push({
        reason: type, value,
        members: distinct.map(m => ({ id: m.id, name: m.name, nip: m.nip || null, email: m.email || m.primaryEmail || null, country: m.country || null })),
        hint: 'Niepewne — sprawdź i scal ręcznie: POST /api/admin/contractors/merge {keepId, dropId, confirm:true}',
      });
    }

    if (!apply) {
      const totalDrops = plan.reduce((s, g) => s + g.drops.length, 0);
      return res.json({ ok: true, dryRun: true, groups: plan.length, toMerge: totalDrops, plan, suggestions });
    }

    // APPLY — scal każdą parę keep←drop przez kompletny merge (self-call).
    const { selfCall } = require('../services/agent-runtime');
    let merged = 0;
    const errors = [];
    for (const g of plan) {
      for (const d of g.drops) {
        try {
          const r = await selfCall('POST', '/api/admin/contractors/merge', { keepId: g.keep.id, dropId: d.id, confirm: true });
          if (r.status === 200 && r.body && r.body.ok !== false) merged++;
          else errors.push({ keep: g.keep.id, drop: d.id, status: r.status, error: (r.body && r.body.error) || 'unknown' });
        } catch (e) {
          errors.push({ keep: g.keep.id, drop: d.id, error: e.message });
        }
      }
    }
    res.json({ ok: true, dryRun: false, groups: plan.length, merged, errors, suggestions });
  } catch (e) {
    console.error('[admin/dedupe-contractors]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/admin/contractor-cleanup — batch fix kontrahenta:
// aktualizuj NIP/email/nazwe, linkuj maile, linkuj fakture, ustaw kraj.
// body: { contractorId, updates: { nip?, email?, name?, country?, address?, city? },
//         linkInvoiceNumber?, linkEmails?: boolean }
router.post('/admin/contractor-cleanup', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { contractorId, updates, linkInvoiceNumber, linkEmails } = req.body || {};
    if (!contractorId) return res.status(400).json({ error: 'contractorId required' });

    const contractor = await prisma.contractor.findUnique({ where: { id: contractorId } });
    if (!contractor) return res.status(404).json({ error: 'contractor not found' });

    const result = { updated: {}, linkedInvoice: null, linkedEmails: 0, linkedTransactions: 0 };

    // 1. Update contractor fields
    if (updates && Object.keys(updates).length) {
      const allowed = ['nip', 'email', 'primaryEmail', 'name', 'country', 'address', 'city', 'phone', 'postCode'];
      const data = {};
      for (const k of allowed) { if (updates[k] !== undefined) data[k] = updates[k]; }
      // Zmiana email BEZ jawnego primaryEmail → aktualizuj OBA. Lista i wysyłka
      // trackingu czytają primaryEmail w pierwszej kolejności — po edycji samego
      // email „z wierzchu" dalej wisiał stary adres.
      if (data.email !== undefined && updates.primaryEmail === undefined) {
        data.primaryEmail = data.email ? String(data.email).trim().toLowerCase() : null;
      }
      // Alias kodu pocztowego + auto-wyciąg gdy user wpisał go w adresie/mieście.
      const { extractPostCode } = require('../utils/address');
      if (data.postCode == null && (updates.postalCode || updates.zipCode)) data.postCode = updates.postalCode || updates.zipCode;
      if (!data.postCode && (data.address || updates.address)) {
        const zip = extractPostCode(data.address || updates.address);
        if (zip) data.postCode = zip;
      }
      if (!data.postCode && (data.city || updates.city)) {
        const zip = extractPostCode(data.city || updates.city);
        if (zip) { data.postCode = zip; if (data.city) data.city = String(data.city).replace(zip, '').replace(/[,\s]+/g, ' ').trim(); }
      }
      if (Object.keys(data).length) {
        // Synchronizuj adres do extras.billingAddress — iFirma payload builder
        // czyta stąd jako fallback; trzymamy spójnie z kolumną postCode.
        const eb = (contractor.extras && typeof contractor.extras.billingAddress === 'object' && contractor.extras.billingAddress) || {};
        const billingAddress = {
          street: data.address != null ? data.address : (eb.street || contractor.address || null),
          city: data.city != null ? data.city : (eb.city || contractor.city || null),
          postCode: data.postCode != null ? data.postCode : (eb.postCode || contractor.postCode || null),
          country: data.country != null ? data.country : (eb.country || contractor.country || null),
          source: eb.source || 'edit',
          updatedAt: new Date().toISOString(),
        };
        await prisma.contractor.update({
          where: { id: contractorId },
          data: { ...data, extras: { ...(contractor.extras || {}), billingAddress } },
        });
        result.updated = data;

        // Propaguj poprawione dane (zwłaszcza kod pocztowy) do iFirmy, żeby kolejna
        // FV nie padła „Brak kodu pocztowego". Best-effort, tylko gdy jest NIP.
        const nipNow = data.nip || contractor.nip;
        if (nipNow) {
          setImmediate(async () => {
            try {
              const { upsertContractor: ifirmaUpsertContractor } = require('../ifirma-client');
              await ifirmaUpsertContractor({
                name: data.name || contractor.name,
                nip: nipNow,
                address: billingAddress.street || '',
                city: billingAddress.city || '',
                postCode: billingAddress.postCode || '',
                country: billingAddress.country || 'Polska',
                email: data.email || contractor.email || '',
                phone: data.phone || contractor.phone || '',
              });
              console.log(`[admin/contractor-cleanup] iFirma sync OK: ${nipNow} (postCode=${billingAddress.postCode || '—'})`);
            } catch (e) {
              console.warn(`[admin/contractor-cleanup] iFirma sync failed (non-fatal): ${e.message}`);
            }
          });
        }
      }
    }

    // 2. Link invoice by number
    if (linkInvoiceNumber) {
      const inv = await prisma.invoice.findFirst({ where: { number: { contains: linkInvoiceNumber } } });
      if (inv) {
        await prisma.invoice.update({ where: { id: inv.id }, data: { contractorId } });
        // Update Transaction too
        const tx = await prisma.transaction.findFirst({ where: { invoiceId: inv.id } });
        if (tx) {
          await prisma.transaction.update({
            where: { id: tx.id },
            data: { contractorId, contractorName: updates?.name || contractor.name },
          });
          result.linkedTransactions++;
        }
        result.linkedInvoice = inv.number;
      }
    }

    // 3. Link unlinked emails by contractor email
    if (linkEmails) {
      const email = updates?.email || contractor.email;
      if (email) {
        const { count } = await prisma.email.updateMany({
          where: { contractorId: null, OR: [
            { fromEmail: { equals: email, mode: 'insensitive' } },
            { toEmail: { equals: email, mode: 'insensitive' } },
          ]},
          data: { contractorId },
        });
        result.linkedEmails = count;
      }
    }

    // 4. Link orphan Transactions by contractorName
    const name = updates?.name || contractor.name;
    if (name) {
      const words = name.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
      if (words.length) {
        const orphanTxs = await prisma.transaction.findMany({
          where: { contractorId: null, contractorName: { not: null } },
          select: { id: true, contractorName: true },
        });
        for (const tx of orphanTxs) {
          const txName = (tx.contractorName || '').toLowerCase();
          if (words.some(w => txName.includes(w))) {
            await prisma.transaction.update({ where: { id: tx.id }, data: { contractorId, contractorName: name } });
            result.linkedTransactions++;
          }
        }
      }
    }

    res.json({ ok: true, contractorId, ...result });
  } catch (e) {
    console.error('[admin/contractor-cleanup]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/admin/contractors/split — ROZKLEJENIE błędnie scalonych kontrahentów.
// Przenosi wskazane FV (po numerach) + ich transakcje + maile (po adresach/
// domenach) ze źródłowego kontrahenta na docelowego (istniejącego po id albo
// nowego z podanych danych). Usuwa przenoszone adresy z kontaktów/kolumn źródła.
// body: {
//   fromContractorId: string,
//   invoiceNumbers: ["169/2026", ...],
//   to: { contractorId } ALBO { name, nip?, email?, phone?, country?, city?, address?, postCode? },
//   moveEmails?: ["adres@x.gr"], moveDomains?: ["kymasurf.gr"],
//   dryRun: true (default) | confirm: true
// }
router.post('/admin/contractors/split', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { fromContractorId, invoiceNumbers = [], to = {}, moveEmails = [], moveDomains = [], confirm } = req.body || {};
    const dryRun = !confirm;
    if (!fromContractorId) return res.status(400).json({ ok: false, error: 'fromContractorId required' });
    if (!Array.isArray(invoiceNumbers)) return res.status(400).json({ ok: false, error: 'invoiceNumbers must be an array' });

    const from = await prisma.contractor.findUnique({ where: { id: fromContractorId } });
    if (!from) return res.status(404).json({ ok: false, error: 'source contractor not found' });

    // Target: istniejący po id, istniejący po NIP, albo (przy confirm) nowy.
    let target = null;
    let targetPlan = null;
    if (to.contractorId) {
      target = await prisma.contractor.findUnique({ where: { id: to.contractorId } });
      if (!target) return res.status(404).json({ ok: false, error: 'target contractor not found' });
    } else if (to.name) {
      if (to.nip) target = await prisma.contractor.findUnique({ where: { nip: String(to.nip).trim() } });
      if (!target) {
        targetPlan = {
          name: String(to.name).trim(),
          nip: to.nip ? String(to.nip).trim() : null,
          email: to.email ? String(to.email).trim() : null,
          primaryEmail: to.email ? String(to.email).trim().toLowerCase() : null,
          phone: to.phone || null,
          country: to.country || from.country || null,
          city: to.city || null,
          address: to.address || null,
          postCode: to.postCode || null,
          type: 'BUSINESS',
        };
        if (!dryRun) target = await prisma.contractor.create({ data: targetPlan });
      }
    } else {
      return res.status(400).json({ ok: false, error: 'to.contractorId or to.name required' });
    }

    // FV do przeniesienia — TYLKO z konta źródłowego, dokładne numery.
    const invoices = await prisma.invoice.findMany({
      where: { contractorId: from.id, number: { in: invoiceNumbers.map(String) } },
      select: { id: true, number: true, issueDate: true, grossAmount: true, currency: true },
    });
    const notFound = invoiceNumbers.filter(n => !invoices.some(i => i.number === String(n)));

    // Maile do przepięcia: po pełnym adresie i/lub domenie (fromEmail/toEmail).
    const emailOr = [];
    for (const a of moveEmails) {
      emailOr.push({ fromEmail: { equals: String(a).trim(), mode: 'insensitive' } });
      emailOr.push({ toEmail: { equals: String(a).trim(), mode: 'insensitive' } });
    }
    for (const d of moveDomains) {
      const dom = '@' + String(d).trim().replace(/^@/, '');
      emailOr.push({ fromEmail: { endsWith: dom, mode: 'insensitive' } });
      emailOr.push({ toEmail: { endsWith: dom, mode: 'insensitive' } });
    }
    const emailWhere = emailOr.length ? { contractorId: from.id, OR: emailOr } : null;
    const emailsCount = emailWhere ? await prisma.email.count({ where: emailWhere }) : 0;

    const invIds = invoices.map(i => i.id);
    const txWhere = invIds.length
      ? { OR: [{ invoiceId: { in: invIds } }, { invoiceNumber: { in: invoices.map(i => i.number) } }] }
      : null;
    const txCount = txWhere ? await prisma.transaction.count({ where: txWhere }) : 0;

    if (dryRun) {
      return res.json({
        ok: true, dryRun: true,
        from: { id: from.id, name: from.name, nip: from.nip },
        target: target ? { id: target.id, name: target.name, nip: target.nip } : { CREATE: targetPlan },
        wouldMove: {
          invoices: invoices.map(i => `${i.number} (${i.grossAmount} ${i.currency}, ${i.issueDate ? String(i.issueDate).slice(0, 10) : '—'})`),
          invoiceNumbersNotFoundOnSource: notFound,
          transactions: txCount,
          emails: emailsCount,
          emailAddressesRemovedFromSource: moveEmails,
        },
        note: 'To jest podgląd. Wykonanie: to samo body z {"confirm":true}.',
      });
    }

    // ===== WYKONANIE =====
    const moved = { invoices: 0, transactions: 0, emails: 0 };
    if (invIds.length) {
      const r = await prisma.invoice.updateMany({
        where: { id: { in: invIds } },
        data: { contractorId: target.id, contractorName: target.name },
      });
      moved.invoices = r.count;
    }
    if (txWhere) {
      const r = await prisma.transaction.updateMany({
        where: txWhere,
        data: { contractorId: target.id, contractorName: target.name },
      });
      moved.transactions = r.count;
    }
    if (emailWhere) {
      const r = await prisma.email.updateMany({ where: emailWhere, data: { contractorId: target.id } });
      moved.emails = r.count;
    }
    // Przenoszone adresy: precz z kontaktów i kolumn ŹRÓDŁA, na cel gdy pusty.
    for (const a of moveEmails) {
      const val = String(a).trim();
      await prisma.contractorContact.deleteMany({
        where: { contractorId: from.id, type: 'email', value: { equals: val, mode: 'insensitive' } },
      });
      const fresh = await prisma.contractor.findUnique({ where: { id: from.id }, select: { email: true, primaryEmail: true } });
      const data = {};
      if (fresh.primaryEmail && fresh.primaryEmail.trim().toLowerCase() === val.toLowerCase()) data.primaryEmail = null;
      if (fresh.email && fresh.email.trim().toLowerCase() === val.toLowerCase()) data.email = null;
      if (Object.keys(data).length) await prisma.contractor.update({ where: { id: from.id }, data });
      if (!target.primaryEmail && !target.email) {
        await prisma.contractor.update({ where: { id: target.id }, data: { email: val, primaryEmail: val.toLowerCase() } });
        target = await prisma.contractor.findUnique({ where: { id: target.id } });
      }
    }
    // Domeny firmowe: przenieś z extras.domains źródła na cel.
    if (moveDomains.length) {
      const doms = moveDomains.map(d => String(d).trim().replace(/^@/, '').toLowerCase());
      const srcEx = { ...(from.extras || {}) };
      if (Array.isArray(srcEx.domains)) {
        srcEx.domains = srcEx.domains.filter(d => !doms.includes(String(d).toLowerCase()));
        await prisma.contractor.update({ where: { id: from.id }, data: { extras: srcEx } });
      }
      const tgtFresh = await prisma.contractor.findUnique({ where: { id: target.id } });
      const tgtEx = { ...(tgtFresh.extras || {}) };
      tgtEx.domains = Array.from(new Set([...(Array.isArray(tgtEx.domains) ? tgtEx.domains : []), ...doms]));
      await prisma.contractor.update({ where: { id: target.id }, data: { extras: tgtEx } });
    }
    console.log(`[admin/contractors/split] ${from.name} → ${target.name}: FV=${moved.invoices}, tx=${moved.transactions}, maile=${moved.emails}`);
    res.json({
      ok: true, dryRun: false,
      from: { id: from.id, name: from.name },
      target: { id: target.id, name: target.name, nip: target.nip, email: target.primaryEmail || target.email },
      moved,
      invoiceNumbersNotFoundOnSource: notFound,
    });
  } catch (e) {
    console.error('[admin/contractors/split]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/admin/vies-check — sprawdz NIP w VIES (pomijajac cache)
router.post('/admin/vies-check', async (req, res) => {
  const { vatNumber: raw } = req.body || {};
  if (!raw) return res.status(400).json({ error: 'vatNumber required (e.g. FR47922156443)' });
  const vatNumber = raw.trim().replace(/[\s-]/g, '').toUpperCase();
  const countryCode = vatNumber.slice(0, 2);
  const number = vatNumber.slice(2);
  try {
    const { verifyVat } = require('../vies');
    const v = await verifyVat(countryCode, number);
    res.json({ ok: true, vatNumber, countryCode, status: v.status, valid: v.valid, name: v.name, address: v.address, userError: v.userError });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
