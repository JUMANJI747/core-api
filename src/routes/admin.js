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

// POST /api/admin/merge-contractors — zlacz dwoch kontrahentow w jednego.
// primaryId zostaje (zachowuje nazwe), secondaryId jest wchlaniane i kasowane.
// Dane fakturowania (NIP, adres billing) z secondary trafiaja do primary.extras.billingAddress.
// Wszystkie FV, maile, transakcje, deale przepinane na primary.
router.post('/admin/merge-contractors', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { primaryId, secondaryId } = req.body || {};
    if (!primaryId || !secondaryId) return res.status(400).json({ error: 'primaryId + secondaryId required' });
    if (primaryId === secondaryId) return res.status(400).json({ error: 'cannot merge with self' });

    const primary = await prisma.contractor.findUnique({ where: { id: primaryId } });
    const secondary = await prisma.contractor.findUnique({ where: { id: secondaryId } });
    if (!primary) return res.status(404).json({ error: 'primary not found' });
    if (!secondary) return res.status(404).json({ error: 'secondary not found' });

    const report = { invoices: 0, emails: 0, transactions: 0, deals: 0, consignments: 0 };

    // 1. Zachowaj dane fakturowania secondary w primary.extras.billingAddress
    const extras = primary.extras && typeof primary.extras === 'object' ? { ...primary.extras } : {};
    extras.billingAddress = {
      name: secondary.name,
      nip: secondary.nip,
      address: secondary.address,
      city: secondary.city,
      postCode: secondary.postCode || null,
      country: secondary.country,
      source: `merged from ${secondary.id} (${secondary.name})`,
    };
    // Merge aliasów
    extras.aliases = Array.from(new Set([
      ...(extras.aliases || []),
      secondary.name,
      ...(secondary.extras?.aliases || []),
    ]));
    // Adoptuj NIP jesli primary nie ma
    const nipUpdate = (!primary.nip && secondary.nip) ? secondary.nip : primary.nip;
    // Adoptuj email jesli primary nie ma
    const emailUpdate = (!primary.email && secondary.email) ? secondary.email : primary.email;
    const phoneUpdate = (!primary.phone && secondary.phone) ? secondary.phone : primary.phone;
    const countryUpdate = (!primary.country && secondary.country) ? secondary.country : primary.country;

    // 2. Przepnij wszystkie rekordy z secondary na primary
    const invoiceResult = await prisma.invoice.updateMany({ where: { contractorId: secondaryId }, data: { contractorId: primaryId } });
    report.invoices = invoiceResult.count;

    const emailResult = await prisma.email.updateMany({ where: { contractorId: secondaryId }, data: { contractorId: primaryId } });
    report.emails = emailResult.count;

    const txResult = await prisma.transaction.updateMany({ where: { contractorId: secondaryId }, data: { contractorId: primaryId, contractorName: primary.name } });
    report.transactions = txResult.count;

    try {
      const dealResult = await prisma.deal.updateMany({ where: { contractorId: secondaryId }, data: { contractorId: primaryId } });
      report.deals = dealResult.count;
    } catch (_) {}

    try {
      const consResult = await prisma.consignment.updateMany({ where: { contractorId: secondaryId }, data: { contractorId: primaryId } });
      report.consignments = consResult.count;
    } catch (_) {}

    // 3. Update primary z extras + adoptowane pola
    await prisma.contractor.update({
      where: { id: primaryId },
      data: { extras, nip: nipUpdate, email: emailUpdate, phone: phoneUpdate, country: countryUpdate },
    });

    // 4. Kasuj secondary
    await prisma.contractor.delete({ where: { id: secondaryId } });

    res.json({
      ok: true,
      primaryId,
      primaryName: primary.name,
      secondaryId,
      secondaryName: secondary.name,
      billingData: extras.billingAddress,
      ...report,
    });
  } catch (e) {
    console.error('[admin/merge-contractors]', e.message);
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
      const allowed = ['nip', 'email', 'primaryEmail', 'name', 'country', 'address', 'city', 'phone'];
      const data = {};
      for (const k of allowed) { if (updates[k] !== undefined) data[k] = updates[k]; }
      if (Object.keys(data).length) {
        await prisma.contractor.update({ where: { id: contractorId }, data });
        result.updated = data;
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
