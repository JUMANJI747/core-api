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
- Invoice.contractorId → Contractor.id
- Document.packageId → MonthlyPackage.id
- Email.contractorId → Contractor.id (nullable)

WAŻNE:
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

    // 1. Generate SQL with Claude
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

    // 2. Validate — only SELECT allowed (regex blacklist; DB-level READ ONLY below catches the rest)
    const forbidden = /\b(DELETE|DROP|UPDATE|INSERT|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|EXEC|VACUUM|ANALYZE|COPY|LOAD|LISTEN|NOTIFY|LOCK|RESET|CALL|DO|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|pg_terminate_backend|pg_sleep|pg_read_file|pg_ls_dir|pg_advisory_lock)\b/i;
    if (forbidden.test(sql)) {
      return res.status(400).json({ ok: false, error: 'Only SELECT queries allowed', sql });
    }
    if (!/^\s*SELECT|^\s*WITH/i.test(sql)) {
      return res.status(400).json({ ok: false, error: 'Query must start with SELECT or WITH', sql });
    }

    // 3. Execute inside a READ ONLY transaction with statement timeout.
    // Defense in depth: if the regex above misses something destructive,
    // Postgres rejects writes at the DB layer ("cannot execute X in a read-only transaction").
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

    // 4. Summarize results with Claude
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

    // Check last iFirma sync
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

module.exports = router;
