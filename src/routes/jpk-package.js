'use strict';

const router = require('express').Router();
const https = require('https');
const { fetchInvoicePdf } = require('../ifirma-client');
const { sendMail } = require('../mail-sender');
const { sendTelegram } = require('../telegram-utils');
const { performWdtMatching } = require('./jpk');

// ============ HELPERS ============

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

function httpsGetBinary(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers };
    https.get(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

// ============ BUILD PACKAGE ============

router.post('/build-package', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = (req.body && req.body.year) || prevMonth.getFullYear();
    const m = (req.body && req.body.month) || (prevMonth.getMonth() + 1);
    const period = `${y}-${String(m).padStart(2, '0')}`;

    // a) Create or find package
    let pkg = await prisma.monthlyPackage.findUnique({ where: { period } });
    if (!pkg) {
      pkg = await prisma.monthlyPackage.create({ data: { period, status: 'building' } });
    } else {
      await prisma.monthlyPackage.update({ where: { id: pkg.id }, data: { status: 'building' } });
    }

    // b) Get WDT matching results for CMR
    let matchResult;
    try {
      matchResult = await performWdtMatching(prisma, y, m);
    } catch (e) {
      console.error('[package] WDT matching failed:', e.message);
      matchResult = { matched: [] };
    }

    // Login to GlobKurier (once)
    let gkToken = null;
    const gkEmail = (process.env.GLOBKURIER_EMAIL || '').trim();
    const gkPassword = (process.env.GLOBKURIER_PASSWORD || '').trim();
    if (gkEmail && gkPassword) {
      try {
        const loginResp = await httpsPost('https://api.globkurier.pl/v1/auth/login', {}, { email: gkEmail, password: gkPassword });
        if (loginResp.status === 200 && loginResp.body.token) gkToken = loginResp.body.token;
      } catch (e) {
        console.error('[package] GlobKurier login failed:', e.message);
      }
    }

    // Download CMR PDFs
    let cmrDownloaded = 0;
    for (const pair of (matchResult.matched || [])) {
      const invoiceNumber = pair.invoice.number;
      const hash = pair.order.hash;
      const receiverName = pair.order.receiverName || '';

      if (!hash || !gkToken) continue;

      // Check if already exists
      const existing = await prisma.document.findFirst({
        where: { packageId: pkg.id, type: 'cmr', invoiceNumber },
      });
      if (existing) {
        console.log('[package] CMR already exists:', invoiceNumber);
        continue;
      }

      try {
        const url = `https://api.globkurier.pl/v1/order/labels?orderHashes[]=${encodeURIComponent(hash)}&format=A4`;
        const { status, body: pdfBuffer } = await httpsGetBinary(url, {
          'X-Auth-Token': gkToken,
          'Accept-Language': 'pl',
        });

        if (status !== 200 || pdfBuffer.length < 100) {
          console.error(`[package] CMR download failed for ${invoiceNumber}: status ${status}, size ${pdfBuffer.length}`);
          continue;
        }

        await prisma.document.create({
          data: {
            packageId: pkg.id,
            type: 'cmr',
            name: `CMR — ${invoiceNumber} — ${receiverName}`,
            filename: `CMR_${invoiceNumber.replace(/\//g, '_')}.pdf`,
            invoiceNumber,
            mimeType: 'application/pdf',
            data: pdfBuffer,
            size: pdfBuffer.length,
          },
        });
        cmrDownloaded++;
        console.log('[package] CMR:', invoiceNumber, '→', receiverName);
      } catch (e) {
        console.error(`[package] CMR error for ${invoiceNumber}:`, e.message);
      }
    }

    // c) Download invoice PDFs from iFirma
    const startOfMonth = new Date(y, m - 1, 1);
    const lastDay = new Date(y, m, 0).getDate();
    const endOfMonth = new Date(y, m - 1, lastDay, 23, 59, 59, 999);

    const allInvoices = await prisma.invoice.findMany({
      where: { issueDate: { gte: startOfMonth, lte: endOfMonth } },
      include: { contractor: true },
    });

    let invoiceDownloaded = 0;
    for (const inv of allInvoices) {
      if (!inv.ifirmaId) continue;

      // Check if already exists
      const existing = await prisma.document.findFirst({
        where: { packageId: pkg.id, type: 'invoice', invoiceNumber: inv.number },
      });
      if (existing) {
        console.log('[package] Invoice already exists:', inv.number);
        continue;
      }

      try {
        const rodzaj = inv.ifirmaType || inv.type || 'krajowa';
        const pdfBuffer = await fetchInvoicePdf(inv.number, rodzaj, inv.ifirmaId);

        if (!pdfBuffer || pdfBuffer.length < 100) {
          console.error(`[package] Invoice PDF too small for ${inv.number}: ${pdfBuffer ? pdfBuffer.length : 0} bytes`);
          continue;
        }

        const contractorName = (inv.contractor && inv.contractor.name) || '';
        await prisma.document.create({
          data: {
            packageId: pkg.id,
            type: 'invoice',
            name: `FV ${inv.number} — ${contractorName}`,
            filename: `FV_${inv.number.replace(/\//g, '_')}.pdf`,
            invoiceNumber: inv.number,
            mimeType: 'application/pdf',
            data: pdfBuffer,
            size: pdfBuffer.length,
          },
        });
        invoiceDownloaded++;
        console.log('[package] Invoice PDF:', inv.number);
      } catch (e) {
        console.error(`[package] Invoice PDF error for ${inv.number}:`, e.message);
      }
    }

    // d) Update package
    const docs = await prisma.document.findMany({
      where: { packageId: pkg.id },
      select: { type: true, name: true, filename: true, size: true },
    });
    const invoiceCount = docs.filter(d => d.type === 'invoice').length;
    const cmrCount = docs.filter(d => d.type === 'cmr').length;

    await prisma.monthlyPackage.update({
      where: { id: pkg.id },
      data: {
        status: 'ready',
        metadata: { totalInvoices: invoiceCount, totalCmr: cmrCount, buildDate: new Date().toISOString() },
      },
    });

    // e) Telegram
    const tgToken = process.env.TELEGRAM_BOT_TOKEN || '8359714766:AAHHE2bStorakXZRSaxtxZl69EqJWA_GlC4';
    const tgChat = process.env.TELEGRAM_CHAT_ID || '8164528644';
    await sendTelegram(tgToken, tgChat,
      `📦 Pakiet za ${period}:\n• ${invoiceCount} faktur PDF\n• ${cmrCount} listów CMR\nStatus: gotowy`
    ).catch(e => console.error('[package] TG error:', e.message));

    res.json({ ok: true, period, status: 'ready', invoices: invoiceCount, cmrs: cmrCount });
  } catch (e) {
    console.error('[package] build error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ LIST PACKAGES ============

router.get('/packages', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const packages = await prisma.monthlyPackage.findMany({
      orderBy: { period: 'desc' },
      select: { id: true, period: true, status: true, metadata: true, sentTo: true, sentAt: true, createdAt: true },
    });
    res.json(packages);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ PACKAGE DETAILS ============

router.get('/package/:period', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const pkg = await prisma.monthlyPackage.findUnique({
      where: { period: req.params.period },
      include: {
        documents: {
          select: { id: true, type: true, name: true, filename: true, size: true, invoiceNumber: true, mimeType: true, createdAt: true },
          orderBy: [{ type: 'asc' }, { invoiceNumber: 'asc' }],
        },
      },
    });
    if (!pkg) return res.status(404).json({ error: 'Package not found' });
    res.json(pkg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ DOWNLOAD DOCUMENT ============

router.get('/document/:id', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
    res.send(doc.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ BUILD MERGED PDF ============

router.post('/build-merged-pdf', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = (req.body && req.body.year) || prevMonth.getFullYear();
    const m = (req.body && req.body.month) || (prevMonth.getMonth() + 1);
    const period = `${y}-${String(m).padStart(2, '0')}`;

    const pkg = await prisma.monthlyPackage.findUnique({ where: { period } });
    if (!pkg) return res.json({ ok: false, error: 'Pakiet nie istnieje. Uruchom build-package.' });

    const invoiceDocs = await prisma.document.findMany({
      where: { packageId: pkg.id, type: 'invoice' },
      orderBy: { invoiceNumber: 'asc' },
    });

    if (!invoiceDocs.length) return res.json({ ok: false, error: 'Brak faktur w pakiecie.' });

    // Remove existing merged if any
    const existing = await prisma.document.findFirst({ where: { packageId: pkg.id, type: 'merged_invoices' } });
    if (existing) {
      await prisma.document.delete({ where: { id: existing.id } });
      console.log('[package] Removed old merged PDF');
    }

    // Merge PDFs
    const { PDFDocument } = require('pdf-lib');
    const mergedPdf = await PDFDocument.create();
    let totalPages = 0;

    for (const doc of invoiceDocs) {
      try {
        const pdfBytes = new Uint8Array(doc.data);
        console.log('[package] Loading PDF:', doc.invoiceNumber, 'size:', pdfBytes.length, 'first bytes:', pdfBytes.slice(0, 5).join(','));
        const sourcePdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
        const pages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
        pages.forEach(page => mergedPdf.addPage(page));
        totalPages += pages.length;
        console.log('[package] Merged:', doc.invoiceNumber, '—', pages.length, 'pages');
      } catch (err) {
        console.error('[package] Failed to merge:', doc.invoiceNumber, '—', err.message);
      }
    }

    const mergedBytes = await mergedPdf.save();
    const mergedBuffer = Buffer.from(mergedBytes);
    const filename = `FAKTURY_${period.replace('-', '_')}.pdf`;

    await prisma.document.create({
      data: {
        packageId: pkg.id,
        type: 'merged_invoices',
        name: `Wszystkie faktury — ${period}`,
        filename,
        invoiceNumber: null,
        mimeType: 'application/pdf',
        data: mergedBuffer,
        size: mergedBuffer.length,
      },
    });

    console.log(`[package] Merged PDF: ${invoiceDocs.length} invoices, ${totalPages} pages, ${Math.round(mergedBuffer.length / 1024)} KB`);

    res.json({ ok: true, period, pages: totalPages, invoices: invoiceDocs.length, size: mergedBuffer.length, filename });
  } catch (e) {
    console.error('[package] build-merged-pdf error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ SEND PACKAGE ============

router.post('/send-package', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'to (email) is required' });

    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = (req.body && req.body.year) || prevMonth.getFullYear();
    const m = (req.body && req.body.month) || (prevMonth.getMonth() + 1);
    const period = `${y}-${String(m).padStart(2, '0')}`;

    const pkg = await prisma.monthlyPackage.findUnique({ where: { period } });
    if (!pkg) return res.json({ ok: false, error: 'Pakiet nie istnieje' });

    const merged = await prisma.document.findFirst({ where: { packageId: pkg.id, type: 'merged_invoices' } });
    if (!merged) return res.json({ ok: false, error: 'Brak merged PDF. Uruchom build-merged-pdf.' });

    const cmrs = await prisma.document.findMany({
      where: { packageId: pkg.id, type: 'cmr' },
      orderBy: { invoiceNumber: 'asc' },
    });

    const invoiceCount = (pkg.metadata && pkg.metadata.totalInvoices) || '?';
    const cmrCount = cmrs.length;

    const attachments = [
      { filename: merged.filename, content: Buffer.from(merged.data), contentType: 'application/pdf' },
      ...cmrs.map(cmr => ({
        filename: cmr.filename,
        content: Buffer.from(cmr.data),
        contentType: 'application/pdf',
      })),
    ];

    const totalSize = attachments.reduce((s, a) => s + a.content.length, 0);

    const htmlBody = `<h3>Dokumenty za ${period}</h3>
<p>W załączeniu:</p>
<ul>
<li>📄 Zbiorczy PDF faktur (${invoiceCount} faktur)</li>
<li>📦 ${cmrCount} listów przewozowych CMR</li>
</ul>
<p>Wygenerowano automatycznie przez system SurfStickBell.</p>`;

    await sendMail({
      from: 'info@surfstickbell.com',
      to,
      subject: `Dokumenty za ${period} — SurfStickBell`,
      html: htmlBody,
      attachments,
    });

    await prisma.monthlyPackage.update({
      where: { id: pkg.id },
      data: { status: 'sent', sentTo: to, sentAt: new Date() },
    });

    const tgToken = process.env.TELEGRAM_BOT_TOKEN || '8359714766:AAHHE2bStorakXZRSaxtxZl69EqJWA_GlC4';
    const tgChat = process.env.TELEGRAM_CHAT_ID || '8164528644';
    await sendTelegram(tgToken, tgChat,
      `📧 Pakiet za ${period} wysłany na ${to} — ${invoiceCount} faktur + ${cmrCount} CMR`
    ).catch(e => console.error('[package] TG error:', e.message));

    console.log(`[package] Sent package ${period} to ${to} — ${attachments.length} attachments, ${Math.round(totalSize / 1024)} KB`);

    res.json({ ok: true, period, sentTo: to, attachments: attachments.length, totalSize: Math.round(totalSize / 1024) + ' KB' });
  } catch (e) {
    console.error('[package] send-package error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
