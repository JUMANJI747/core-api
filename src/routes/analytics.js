'use strict';

const router = require('express').Router();
const https = require('https');

// ============ HELPER ============

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch (e) { resolve({ status: res.statusCode, body: text }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function callClaudeWithRetry(body, maxRetries = 3) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const resp = await httpsPost('https://api.anthropic.com/v1/messages', {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    }, body);

    const isOverloaded = resp.body && resp.body.error && resp.body.error.type === 'overloaded_error';
    if (isOverloaded && attempt < maxRetries) {
      const waitMs = attempt * 5000;
      console.log('[analytics] Anthropic overloaded, retry', attempt, 'in', waitMs, 'ms');
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    return resp;
  }
}

// ============ SCHEMA DESCRIPTION ============

const SCHEMA_DESCRIPTION = `SCHEMA BAZY DANYCH SurfStickBell:

Table: Invoice
- id (UUID), number (String, np "25/2026"), contractorId (UUID FK),
- ifirmaId (Int), issueDate (DateTime), dueDate (DateTime),
- grossAmount (Decimal(12,2)), currency (String: "EUR"/"PLN"),
- paidAmount (Decimal(12,2)), status (String: "paid"/"unpaid"/"partial"),
- type (String), ifirmaType (String, np "prz_dostawa_ue_towarow" = WDT),
- source (String: "system"/"ifirma_sync"), bankReference (String),
- extras (JSONB: matchedOrder, kontrahentNazwa, ...)
- createdAt, updatedAt

Table: Contractor
- id (UUID), name (String), nip (String unique), type (String: "BUSINESS"/"PERSON"),
- email (String), phone (String), country (String: "PL"/"ES"/"FR"/"PT"/"IT"/"DE"),
- address (String), city (String), tags (String[]),
- source (String: "manual"/"ifirma_sync"/"telegram"),
- extras (JSONB: tradeName, billingAddress{street,city,postCode,country}, locations[])
- createdAt, updatedAt

Table: Email
- id (UUID), fromEmail (String), fromName (String), toEmail (String),
- subject (String), bodyFull (Text), bodyPreview (String),
- direction (String: "INBOUND"/"OUTBOUND"/"DRAFT"),
- inbox (String: "info"/"niko"/"delivery"/"sales"/"office"/"info_eu"/"info_fr"/"michal_fr"),
- messageId (String), inReplyTo (String), references (String),
- tags (String[]), contractorId (UUID FK nullable),
- createdAt

Table: Document
- id (UUID), packageId (UUID FK), type (String: "invoice"/"cmr"/"cost"/"merged_invoices"),
- name (String), filename (String), invoiceNumber (String),
- mimeType (String), size (Int), createdAt

Table: MonthlyPackage
- id (UUID), period (String unique, np "2026-03"), status (String: "building"/"ready"/"sent"),
- sentTo (String), sentAt (DateTime), createdAt, updatedAt

Table: Memory
- id (UUID), chatId (String), role (String: "user"/"assistant"), content (Text), createdAt

RELACJE:
- Invoice.contractorId -> Contractor.id
- Document.packageId -> MonthlyPackage.id
- Email.contractorId -> Contractor.id (nullable)

WAZNE:
- WDT (eksport UE): type zawiera "dostawa_ue" lub ifirmaType zawiera "wdt"
- Faktury krajowe: type zawiera "krajow"
- Obroty = suma grossAmount
- Przeterminowane = "dueDate" < NOW() AND status != 'paid'
- Nazwy tabel w Postgres są quoted: "Invoice", "Contractor", "Email", "Document", "MonthlyPackage", "Memory"
- Nazwy kolumn camelCase też quoted: "grossAmount", "issueDate", "createdAt", "contractorId" itd.`;

// ============ HELPERS ============

function serializeForJson(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'bigint') return Number(obj);
  if (obj instanceof Date) return obj.toISOString();
  if (typeof obj === 'object' && obj.constructor && obj.constructor.name === 'Decimal'
      && typeof obj.toFixed === 'function') {
    return obj.toString();
  }
  if (Array.isArray(obj)) return obj.map(serializeForJson);
  if (typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = serializeForJson(obj[k]);
    return out;
  }
  return obj;
}

// ============ ENDPOINT ============

router.post('/analytics', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'question required' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

    const sqlPrompt = `${SCHEMA_DESCRIPTION}

Pytanie użytkownika: ${question}

Wygeneruj TYLKO zapytanie SQL (PostgreSQL) które odpowiada na to pytanie.
- TYLKO SELECT — nigdy DELETE/UPDATE/INSERT/DROP/ALTER
- Nazwy tabel w cudzysłowach: "Invoice", "Contractor", "Email" etc.
- LIMIT 100 domyślnie
- Jeśli pytanie dotyczy obrotów/sum — użyj SUM("grossAmount"), GROUP BY
- Jeśli pytanie dotyczy kontrahenta po nazwie — użyj ILIKE '%nazwa%'
- Jeśli pytanie dotyczy okresu — filtruj po "issueDate"
- Daty w formacie: '2026-03-01'

Odpowiedz TYLKO czystym SQL bez markdown, bez komentarzy, bez wyjaśnień.`;

    const sqlResp = await callClaudeWithRetry({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: sqlPrompt }],
    });

    if (sqlResp.status !== 200) {
      return res.status(500).json({ error: 'Claude SQL generation failed', details: sqlResp.body });
    }

    const sql = (sqlResp.body.content[0].text || '').replace(/```sql\n?/g, '').replace(/```\n?/g, '').trim();

    const forbidden = /\b(DELETE|DROP|UPDATE|INSERT|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|EXEC|VACUUM|ANALYZE|COPY|LOAD|LISTEN|NOTIFY|LOCK|RESET|CALL|DO|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|pg_terminate_backend|pg_sleep|pg_read_file|pg_ls_dir|pg_advisory_lock)\b/i;
    if (forbidden.test(sql)) {
      return res.status(400).json({ ok: false, error: 'Only SELECT queries allowed', sql });
    }
    if (!/^\s*SELECT|^\s*WITH/i.test(sql)) {
      return res.status(400).json({ ok: false, error: 'Query must start with SELECT or WITH', sql });
    }

    let results;
    try {
      results = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 10000');
        return await tx.$queryRawUnsafe(sql);
      });
    } catch (err) {
      return res.status(400).json({ ok: false, error: 'SQL error: ' + err.message, sql });
    }

    const safeResults = serializeForJson(results);
    console.log(`[analytics] Question: ${question} | SQL: ${sql.replace(/\s+/g, ' ').slice(0, 200)} | Rows: ${safeResults.length}`);

    let summary = null;
    if (safeResults.length > 0) {
      try {
        const summaryResp = await callClaudeWithRetry({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: `Pytanie: ${question}\n\nWyniki SQL:\n${JSON.stringify(safeResults.slice(0, 50), null, 2)}\n\nOdpowiedz krótko po polsku na pytanie użytkownika na podstawie tych danych. Podaj konkretne liczby, nazwy, kwoty. Jeśli są sumy — podaj w odpowiedniej walucie.`,
          }],
        });
        if (summaryResp.status === 200) {
          summary = summaryResp.body.content[0].text || null;
        }
      } catch (err) {
        console.error('[analytics] Summary failed:', err.message);
      }
    } else {
      summary = 'Brak wyników dla tego pytania.';
    }

    const lastSyncedInvoice = await prisma.invoice.findFirst({
      where: { source: 'ifirma_sync' },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    });
    const lastSync = lastSyncedInvoice && lastSyncedInvoice.updatedAt;
    const syncAgeHours = lastSync ? Math.round((Date.now() - new Date(lastSync).getTime()) / (1000 * 60 * 60)) : null;
    const syncWarning = (syncAgeHours !== null && syncAgeHours > 24)
      ? `Dane mogą być nieaktualne — ostatni sync ${syncAgeHours}h temu. Powiedz "zsynchronizuj" żeby zaktualizować.`
      : null;

    res.json({
      ok: true,
      question,
      sql,
      results: safeResults.slice(0, 100),
      summary,
      rowCount: safeResults.length,
      lastSync: lastSync ? lastSync.toISOString() : null,
      syncAgeHours,
      syncWarning,
    });
  } catch (e) {
    console.error('[analytics] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ CRM v2 BI ENDPOINTS ============

function parseRange(req) {
  const now = new Date();
  let from = req.query.from ? new Date(req.query.from) : null;
  let to = req.query.to ? new Date(req.query.to) : null;
  const year = req.query.year ? parseInt(req.query.year, 10) : null;
  if (year && !from && !to) {
    from = new Date(Date.UTC(year, 0, 1));
    to = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
  }
  if (!from) from = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  if (!to) to = now;
  if (req.query.to && req.query.to.length === 10) {
    to.setUTCHours(23, 59, 59, 999);
  }
  return { from, to };
}

function parseGranularity(req) {
  const g = (req.query.granularity || 'month').toLowerCase();
  if (!['day', 'week', 'month', 'quarter', 'year'].includes(g)) return 'month';
  return g;
}

function parseIfirmaOnly(req) {
  const v = req.query.plIfirmaOnly;
  return v === '1' || v === 'true' || v === 'yes';
}

router.get('/analytics/private-label-revenue', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { from, to } = parseRange(req);
    const granularity = parseGranularity(req);

    const pl = await prisma.$queryRaw`
      SELECT
        'pl'::text                                                      AS source,
        c.id                                                            AS "contractorId",
        c.name                                                          AS contractor_name,
        c.country                                                       AS contractor_country,
        c.nip                                                           AS contractor_nip,
        to_char(date_trunc(${granularity}, i."issueDate"), 'YYYY-MM-DD') AS period,
        i.currency,
        SUM(i."grossAmount")::text                                      AS total,
        COUNT(*)::int                                                   AS invoice_count
      FROM "Invoice" i
      JOIN "Contractor" c ON c.id = i."contractorId"
      WHERE i."issueDate" BETWEEN ${from} AND ${to}
        AND c.tags @> ARRAY['private-label']
      GROUP BY 2, 3, 4, 5, 6, 7
      ORDER BY period DESC, total DESC
    `;

    const es = await prisma.$queryRaw`
      SELECT
        'es'::text                                                       AS source,
        c.id                                                             AS "contractorId",
        c.name                                                           AS contractor_name,
        c.country                                                        AS contractor_country,
        c.nip                                                            AS contractor_nip,
        to_char(date_trunc(${granularity}, ei."invoiceDate"), 'YYYY-MM-DD') AS period,
        ei.currency,
        SUM(ei."totalAmount")::text                                      AS total,
        COUNT(*)::int                                                    AS invoice_count
      FROM "EsInvoice" ei
      JOIN "EsContractor" ec ON ec.id = ei."contractorId"
      JOIN "Contractor" c ON c."linkedEsContractorId" = ec.id
      WHERE ei."invoiceDate" BETWEEN ${from} AND ${to}
        AND c.tags @> ARRAY['private-label']
      GROUP BY 2, 3, 4, 5, 6, 7
      ORDER BY period DESC, total DESC
    `;

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      granularity,
      buckets: serializeForJson([...pl, ...es]),
    });
  } catch (e) {
    console.error('[analytics/private-label-revenue] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/analytics/revenue
//   ?country=DE&from=2026-01-01&to=2026-12-31&granularity=month&currency=EUR&source=pl|es
//   &plIfirmaOnly=1  -> filter PL by ifirmaId IS NOT NULL (only iFirma-synced/pushed)
router.get('/analytics/revenue', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { from, to } = parseRange(req);
    const granularity = parseGranularity(req);
    const country = req.query.country ? String(req.query.country).toUpperCase() : null;
    const currency = req.query.currency ? String(req.query.currency).toUpperCase() : null;
    const source = req.query.source ? String(req.query.source).toLowerCase() : null;
    const plIfirmaOnly = parseIfirmaOnly(req);
    // requireItems=1 -> licz tylko faktury Z POZYCJAMI. Faktury bez pozycji
    // (zaliczkowe rozliczeniowe, prywatne "grafiki 3D" itp. — nie nasza marka)
    // wypadaja z obrotu, zeby kwota i sztuki liczyly sie z tego samego.
    const requireItems = req.query.requireItems === '1' || req.query.requireItems === 'true';

    const wantPl = !source || source === 'pl';
    const wantEs = !source || source === 'es';

    const trunc = granularity;
    const queries = [];
    if (wantPl) {
      queries.push(prisma.$queryRaw`
        SELECT
          'pl'::text                                                   AS source,
          to_char(date_trunc(${trunc}, "issueDate"), 'YYYY-MM-DD')      AS period,
          currency,
          SUM("grossAmount")::text                                      AS amount,
          COUNT(*)::int                                                 AS invoice_count
        FROM "Invoice"
        WHERE "issueDate" BETWEEN ${from} AND ${to}
          AND (${country}::text IS NULL OR UPPER("contractorCountry") = ${country})
          AND (${currency}::text IS NULL OR UPPER(currency) = ${currency})
          AND (${plIfirmaOnly}::boolean = false OR "ifirmaId" IS NOT NULL)
          AND (${requireItems}::boolean = false OR EXISTS (SELECT 1 FROM "InvoiceLineItem" li WHERE li."invoiceId" = "Invoice".id))
        GROUP BY 2, 3
        ORDER BY period, currency
      `);
    }
    if (wantEs) {
      queries.push(prisma.$queryRaw`
        SELECT
          'es'::text                                                   AS source,
          to_char(date_trunc(${trunc}, "invoiceDate"), 'YYYY-MM-DD')    AS period,
          currency,
          SUM("totalAmount")::text                                      AS amount,
          COUNT(*)::int                                                 AS invoice_count
        FROM "EsInvoice"
        WHERE "invoiceDate" BETWEEN ${from} AND ${to}
          AND (${country}::text IS NULL OR UPPER("contractorCountry") = ${country})
          AND (${currency}::text IS NULL OR UPPER(currency) = ${currency})
          AND (${requireItems}::boolean = false OR EXISTS (SELECT 1 FROM "EsInvoiceLineItem" eli WHERE eli."esInvoiceId" = "EsInvoice".id))
        GROUP BY 2, 3
        ORDER BY period, currency
      `);
    }

    const results = await Promise.all(queries);
    const buckets = serializeForJson(results.flat());

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      granularity,
      country,
      currency,
      source,
      plIfirmaOnly,
      buckets,
    });
  } catch (e) {
    console.error('[analytics/revenue] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/analytics/qty-sold
//   ?from=&to=&granularity=month&country=&source=pl|es&plIfirmaOnly=1
// Zwraca ilosc sztuk sprzedanych (SUM lineItem.qty) per (period, source).
// PL leci z InvoiceLineItem, ES z EsInvoiceLineItem. Z plIfirmaOnly=1
// dla PL filtrujemy po Invoice.ifirmaId IS NOT NULL (zeby zgadzalo sie
// z iFirma).
router.get('/analytics/qty-sold', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { from, to } = parseRange(req);
    const granularity = parseGranularity(req);
    const country = req.query.country ? String(req.query.country).toUpperCase() : null;
    const source = req.query.source ? String(req.query.source).toLowerCase() : null;
    const plIfirmaOnly = parseIfirmaOnly(req);

    const wantPl = !source || source === 'pl';
    const wantEs = !source || source === 'es';

    const queries = [];
    if (wantPl) {
      queries.push(prisma.$queryRaw`
        SELECT
          'pl'::text                                                          AS source,
          to_char(date_trunc(${granularity}, li."issueDate"), 'YYYY-MM-DD')   AS period,
          SUM(li.qty)::text                                                   AS qty,
          COUNT(DISTINCT li."invoiceId")::int                                 AS invoice_count
        FROM "InvoiceLineItem" li
        JOIN "Invoice" i ON i.id = li."invoiceId"
        WHERE li."issueDate" BETWEEN ${from} AND ${to}
          AND (${country}::text IS NULL OR UPPER(li."contractorCountry") = ${country})
          AND (${plIfirmaOnly}::boolean = false OR i."ifirmaId" IS NOT NULL)
        GROUP BY 2
        ORDER BY period
      `);
    }
    if (wantEs) {
      queries.push(prisma.$queryRaw`
        SELECT
          'es'::text                                                          AS source,
          to_char(date_trunc(${granularity}, "invoiceDate"), 'YYYY-MM-DD')    AS period,
          SUM(qty)::text                                                      AS qty,
          COUNT(DISTINCT "esInvoiceId")::int                                  AS invoice_count
        FROM "EsInvoiceLineItem"
        WHERE "invoiceDate" BETWEEN ${from} AND ${to}
          AND (${country}::text IS NULL OR UPPER("contractorCountry") = ${country})
        GROUP BY 2
        ORDER BY period
      `);
    }

    const results = await Promise.all(queries);
    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      granularity,
      country,
      source,
      plIfirmaOnly,
      buckets: serializeForJson(results.flat()),
    });
  } catch (e) {
    console.error('[analytics/qty-sold] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/analytics/top-customers', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { from, to } = parseRange(req);
    const country = req.query.country ? String(req.query.country).toUpperCase() : null;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
    const source = req.query.source ? String(req.query.source).toLowerCase() : null;
    const wantPl = !source || source === 'pl';
    const wantEs = !source || source === 'es';

    const queries = [];
    if (wantPl) {
      queries.push(prisma.$queryRaw`
        SELECT
          'pl'::text                       AS source,
          "contractorId",
          MAX("contractorName")            AS contractor_name,
          MAX("contractorCountry")         AS contractor_country,
          currency,
          SUM("grossAmount")::text         AS total_revenue,
          COUNT(*)::int                    AS invoice_count,
          MAX("issueDate")                 AS last_invoice_at
        FROM "Invoice"
        WHERE "issueDate" BETWEEN ${from} AND ${to}
          AND "contractorId" IS NOT NULL
          AND (${country}::text IS NULL OR UPPER("contractorCountry") = ${country})
        GROUP BY "contractorId", currency
        ORDER BY SUM("grossAmount") DESC
        LIMIT ${limit}
      `);
    }
    if (wantEs) {
      queries.push(prisma.$queryRaw`
        SELECT
          'es'::text                       AS source,
          "contractorId",
          MAX("contractorName")            AS contractor_name,
          MAX("contractorCountry")         AS contractor_country,
          currency,
          SUM("totalAmount")::text         AS total_revenue,
          COUNT(*)::int                    AS invoice_count,
          MAX("invoiceDate")               AS last_invoice_at
        FROM "EsInvoice"
        WHERE "invoiceDate" BETWEEN ${from} AND ${to}
          AND "contractorId" IS NOT NULL
          AND (${country}::text IS NULL OR UPPER("contractorCountry") = ${country})
        GROUP BY "contractorId", currency
        ORDER BY SUM("totalAmount") DESC
        LIMIT ${limit}
      `);
    }

    const results = await Promise.all(queries);
    const customers = serializeForJson(results.flat());

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      country,
      limit,
      source,
      customers,
    });
  } catch (e) {
    console.error('[analytics/top-customers] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/analytics/products-sold', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { from, to } = parseRange(req);
    const ean = req.query.ean ? String(req.query.ean) : null;
    const country = req.query.country ? String(req.query.country).toUpperCase() : null;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const source = req.query.source ? String(req.query.source).toLowerCase() : null;
    const wantPl = !source || source === 'pl';
    const wantEs = !source || source === 'es';

    if (ean) {
      const granularity = parseGranularity(req);
      const queries = [];
      if (wantPl) {
        queries.push(prisma.$queryRaw`
          SELECT
            'pl'::text                                                      AS source,
            to_char(date_trunc(${granularity}, "issueDate"), 'YYYY-MM-DD')  AS period,
            currency,
            SUM(qty)::text                                                  AS qty,
            SUM("totalNetto")::text                                         AS revenue_netto,
            SUM("totalGross")::text                                         AS revenue_gross,
            COUNT(*)::int                                                   AS line_count
          FROM "InvoiceLineItem"
          WHERE ean = ${ean}
            AND "issueDate" BETWEEN ${from} AND ${to}
            AND (${country}::text IS NULL OR UPPER("contractorCountry") = ${country})
          GROUP BY 2, 3
          ORDER BY period, currency
        `);
      }
      if (wantEs) {
        queries.push(prisma.$queryRaw`
          SELECT
            'es'::text                                                      AS source,
            to_char(date_trunc(${granularity}, "invoiceDate"), 'YYYY-MM-DD') AS period,
            currency,
            SUM(qty)::text                                                  AS qty,
            SUM("totalNetto")::text                                         AS revenue_netto,
            SUM("totalGross")::text                                         AS revenue_gross,
            COUNT(*)::int                                                   AS line_count
          FROM "EsInvoiceLineItem"
          WHERE ean = ${ean}
            AND "invoiceDate" BETWEEN ${from} AND ${to}
            AND (${country}::text IS NULL OR UPPER("contractorCountry") = ${country})
          GROUP BY 2, 3
          ORDER BY period, currency
        `);
      }
      const results = await Promise.all(queries);
      let productName = null;
      const prod = await prisma.product.findUnique({ where: { ean }, select: { name: true } }).catch(() => null);
      if (prod) productName = prod.name;
      if (!productName) {
        const esProd = await prisma.esProduct.findUnique({ where: { ean }, select: { name: true } }).catch(() => null);
        if (esProd) productName = esProd.name;
      }

      return res.json({
        ean,
        name: productName,
        from: from.toISOString(),
        to: to.toISOString(),
        granularity,
        country,
        source,
        buckets: serializeForJson(results.flat()),
      });
    }

    const queries = [];
    if (wantPl) {
      queries.push(prisma.$queryRaw`
        SELECT
          'pl'::text                              AS source,
          COALESCE(ean, lower(name))              AS ean,
          MAX(name)                               AS name,
          currency,
          SUM(qty)::text                          AS qty,
          SUM("totalNetto")::text                 AS revenue_netto,
          SUM("totalGross")::text                 AS revenue_gross,
          COUNT(DISTINCT "invoiceId")::int        AS invoice_count
        FROM "InvoiceLineItem"
        WHERE "issueDate" BETWEEN ${from} AND ${to}
          AND (ean IS NOT NULL OR name IS NOT NULL)
          AND (${country}::text IS NULL OR UPPER("contractorCountry") = ${country})
        GROUP BY COALESCE(ean, lower(name)), currency
        ORDER BY SUM(qty) DESC
        LIMIT ${limit}
      `);
    }
    if (wantEs) {
      queries.push(prisma.$queryRaw`
        SELECT
          'es'::text                              AS source,
          COALESCE(ean, lower(name))              AS ean,
          MAX(name)                               AS name,
          currency,
          SUM(qty)::text                          AS qty,
          SUM("totalNetto")::text                 AS revenue_netto,
          SUM("totalGross")::text                 AS revenue_gross,
          COUNT(DISTINCT "esInvoiceId")::int      AS invoice_count
        FROM "EsInvoiceLineItem"
        WHERE "invoiceDate" BETWEEN ${from} AND ${to}
          AND (ean IS NOT NULL OR name IS NOT NULL)
          AND (${country}::text IS NULL OR UPPER("contractorCountry") = ${country})
        GROUP BY COALESCE(ean, lower(name)), currency
        ORDER BY SUM(qty) DESC
        LIMIT ${limit}
      `);
    }

    const results = await Promise.all(queries);
    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      country,
      limit,
      source,
      products: serializeForJson(results.flat()),
    });
  } catch (e) {
    console.error('[analytics/products-sold] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


module.exports = router;
