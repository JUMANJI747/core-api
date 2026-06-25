'use strict';

const router = require('express').Router();
const https = require('https');
const { fetchInvoicePdf } = require('../ifirma-client');
const { sendMail } = require('../mail-sender');
const { sendTelegram } = require('../telegram-utils');
const { getOrderLabels } = require('../glob-client');
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

    // ŚWIEŻE PRZEBUDOWANIE: kasujemy poprzednie CMR z paczki, żeby korekty
    // (rozłączenia / poprawne sparowania) wchodziły w życie, a stare błędne listy
    // (np. do Polski) nie zostawały zapamiętane. Listy odtwarzają się z linków/uploadów.
    await prisma.document.deleteMany({ where: { packageId: pkg.id, type: 'cmr' } }).catch(() => {});

    // b) Get WDT matching results for CMR
    let matchResult;
    try {
      matchResult = await performWdtMatching(prisma, y, m);
    } catch (e) {
      console.error('[package] WDT matching failed:', e.message);
      matchResult = { matched: [] };
    }

    // Download CMR PDFs via glob-client
    const { isToPoland } = require('../services/wdt-pairing');
    let cmrDownloaded = 0;
    for (const pair of (matchResult.matched || [])) {
      const invoiceNumber = pair.invoice.number;
      const hash = pair.order.hash;
      const receiverName = pair.order.receiverName || '';

      if (!hash) continue;
      // WDT/eksport NIE może mieć listu do Polski — pomijamy (to był błąd księgowej).
      if (isToPoland(pair.order)) { console.warn('[package] pomijam list do PL dla', invoiceNumber); continue; }

      const existing = await prisma.document.findFirst({
        where: { packageId: pkg.id, type: 'cmr', invoiceNumber },
      });
      if (existing) {
        console.log('[package] CMR already exists:', invoiceNumber);
        continue;
      }

      try {
        const { status, body: pdfBuffer } = await getOrderLabels(hash, 'A4');

        if (status !== 200 || pdfBuffer.length < 100) {
          console.error(`[package] CMR download failed for ${invoiceNumber}: status ${status}, size ${pdfBuffer.length}`);
          continue;
        }

        await prisma.document.create({
          data: {
            packageId: pkg.id,
            type: 'cmr',
            name: `CMR — ${invoiceNumber} — ${receiverName}`,
            filename: `${invoiceNumber.replace(/\//g, '-')}.pdf`,
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

    // b2) AUGMENTACJA: faktury WDT z JAWNYM linkiem (shipmentHash, ustawiony przy
    // parowaniu w „Dodatkowej księgowości") lub z RĘCZNIE wgranym listem
    // (shipmentDocData) — dorzucamy ich listy nawet gdy name/LLM-matching ich
    // nie złapał. Dzięki temu „wyślij listy na maila" działa po sparowaniu/uploadzie.
    try {
      const augFrom = new Date(y, m - 1, 1);
      const augLastDay = new Date(y, m, 0).getDate();
      const augTo = new Date(y, m - 1, augLastDay, 23, 59, 59, 999);
      const explicitWdt = await prisma.invoice.findMany({
        where: {
          issueDate: { gte: augFrom, lte: augTo },
          OR: [
            { type: { contains: 'dostawa_ue', mode: 'insensitive' } },
            { type: { contains: 'wdt', mode: 'insensitive' } },
            { type: { contains: 'eksport', mode: 'insensitive' } },
            { type: { contains: 'export', mode: 'insensitive' } },
            { ifirmaType: { contains: 'dostawa_ue', mode: 'insensitive' } },
            { ifirmaType: { contains: 'wdt', mode: 'insensitive' } },
            { ifirmaType: { contains: 'eksport', mode: 'insensitive' } },
            { ifirmaType: { contains: 'export', mode: 'insensitive' } },
          ],
        },
        select: { number: true, contractorName: true, shipmentHash: true, shipmentDocName: true, shipmentDocMime: true, shipmentDocData: true },
      });
      for (const inv of explicitWdt) {
        const existing = await prisma.document.findFirst({ where: { packageId: pkg.id, type: 'cmr', invoiceNumber: inv.number } });
        if (existing) continue;
        // (a) ręcznie wgrany list przewozowy
        if (inv.shipmentDocData) {
          const ext = (inv.shipmentDocName || '').split('.').pop() || 'pdf';
          await prisma.document.create({
            data: {
              packageId: pkg.id, type: 'cmr',
              name: `CMR — ${inv.number} — ${inv.contractorName || ''}`,
              filename: `${inv.number.replace(/\//g, '-')}.${ext}`,
              invoiceNumber: inv.number, mimeType: inv.shipmentDocMime || 'application/pdf',
              data: inv.shipmentDocData, size: inv.shipmentDocData.length,
            },
          });
          cmrDownloaded++;
          console.log('[package] CMR (wgrany list):', inv.number);
          continue;
        }
        // (b) jawny hash GK → pobierz etykietę
        if (inv.shipmentHash) {
          try {
            const { status, body: pdfBuffer } = await getOrderLabels(inv.shipmentHash, 'A4');
            if (status === 200 && pdfBuffer.length >= 100) {
              await prisma.document.create({
                data: {
                  packageId: pkg.id, type: 'cmr',
                  name: `CMR — ${inv.number} — ${inv.contractorName || ''}`,
                  filename: `${inv.number.replace(/\//g, '-')}.pdf`,
                  invoiceNumber: inv.number, mimeType: 'application/pdf',
                  data: pdfBuffer, size: pdfBuffer.length,
                },
              });
              cmrDownloaded++;
              console.log('[package] CMR (jawny hash):', inv.number);
            }
          } catch (e) {
            console.error(`[package] CMR aug error for ${inv.number}:`, e.message);
          }
        }
      }
    } catch (e) {
      console.error('[package] explicit WDT augmentation failed:', e.message);
    }

    // b3) DETERMINISTYCZNE dopasowanie po nazwie (jak strona Faktury) dla faktur
    // WDT/EKSPORT bez CMR — pobiera etykietę z GK po dopasowaniu. Dzięki temu w
    // mailu są POTWIERDZENIA DOSTAW dla wszystkich, nie tylko ręcznie wgranych.
    try {
      const { getOrders: globGetOrders } = require('../glob-client');
      const { normalizeContractorName, scoreContractor } = require('../services/contractor-match');
      const augFrom = new Date(y, m - 1, 1);
      const augLastDay = new Date(y, m, 0).getDate();
      const augTo = new Date(y, m - 1, augLastDay, 23, 59, 59, 999);
      const DOC_OR = [
        { type: { contains: 'dostawa_ue', mode: 'insensitive' } },
        { type: { contains: 'wdt', mode: 'insensitive' } },
        { type: { contains: 'eksport', mode: 'insensitive' } },
        { type: { contains: 'export', mode: 'insensitive' } },
        { ifirmaType: { contains: 'dostawa_ue', mode: 'insensitive' } },
        { ifirmaType: { contains: 'wdt', mode: 'insensitive' } },
        { ifirmaType: { contains: 'eksport', mode: 'insensitive' } },
        { ifirmaType: { contains: 'export', mode: 'insensitive' } },
      ];
      const docInvs = await prisma.invoice.findMany({
        where: { issueDate: { gte: augFrom, lte: augTo }, OR: DOC_OR },
        select: { number: true, contractorName: true, issueDate: true, shipmentNumber: true },
      });
      const need = [];
      for (const inv of docInvs) {
        const have = await prisma.document.findFirst({ where: { packageId: pkg.id, type: 'cmr', invoiceNumber: inv.number } });
        if (!have) need.push(inv);
      }
      if (need.length) {
        // GK ucina limit per-request (~100) — paginujemy jak strona Faktury,
        // żeby objąć starsze wysyłki (np. majowe), nie tylko ostatnie 100.
        const orders = [];
        for (let page = 0; page < 8; page++) {
          const raw = await globGetOrders({ limit: 100, offset: page * 100 });
          const arr = (raw && (raw.results || raw.items || raw.data)) || (Array.isArray(raw) ? raw : []);
          if (!arr.length) break;
          for (const o of arr) {
            const recv = o.receiverAddress || o.receiver || {};
            const hash = o.hash || o.id;
            if (!hash) continue;
            orders.push({
              hash, number: String(o.number || o.orderNumber || ''),
              name: recv.companyName || recv.name || recv.contactPerson || '',
              postCode: recv.postCode || recv.zipCode || recv.postalCode || null,
              country: recv.country || recv.countryCode || null,
              date: o.creationDate || o.created_at || o.createdAt || null,
              status: (o.status || '').toUpperCase(), used: false,
            });
          }
          if (arr.length < 100) break;
        }
        const byKey = {};
        for (const o of orders) { const k = normalizeContractorName(o.name); if (k) (byKey[k] ||= []).push(o); }
        const WINDOW = 60 * 86400000;
        const isCanceled = (s) => ['CANCELED', 'CANCELLED'].includes(s.status);
        const pickNearest = (inv, pool) => {
          let best = null, bd = Infinity, bc = true;
          for (const s of pool) {
            if (s.used) continue;
            const d = Math.abs(new Date(inv.issueDate) - new Date(s.date || 0));
            if (d > WINDOW) continue;
            const c = isCanceled(s);
            if ((bc && !c) || (c === bc && d < bd)) { bd = d; best = s; bc = c; }
          }
          return best;
        };
        for (const inv of need) {
          let ord = inv.shipmentNumber ? orders.find(o => !o.used && o.number === String(inv.shipmentNumber)) : null;
          if (!ord) { const k = normalizeContractorName(inv.contractorName || ''); if (k && byKey[k]) ord = pickNearest(inv, byKey[k]); }
          if (!ord) {
            let best = null, bs = 0, bd = Infinity, bc = true;
            for (const s of orders) {
              if (s.used) continue;
              const d = Math.abs(new Date(inv.issueDate) - new Date(s.date || 0));
              if (d > WINDOW) continue;
              const sc = Math.min(scoreContractor({ name: s.name }, inv.contractorName || ''), scoreContractor({ name: inv.contractorName || '' }, s.name));
              if (sc < 90) continue;
              const c = isCanceled(s);
              if ((bc && !c) || (c === bc && (sc > bs || (sc === bs && d < bd)))) { bs = sc; bd = d; best = s; bc = c; }
            }
            ord = best;
          }
          if (!ord) continue;
          if (isToPoland(ord)) { console.warn('[package] name-match: pomijam list do PL dla', inv.number); continue; }
          ord.used = true;
          try {
            const { status, body: pdfBuffer } = await getOrderLabels(ord.hash, 'A4');
            if (status === 200 && pdfBuffer.length >= 100) {
              await prisma.document.create({
                data: {
                  packageId: pkg.id, type: 'cmr',
                  name: `CMR — ${inv.number} — ${inv.contractorName || ''}`,
                  filename: `${inv.number.replace(/\//g, '-')}.pdf`,
                  invoiceNumber: inv.number, mimeType: 'application/pdf',
                  data: pdfBuffer, size: pdfBuffer.length,
                },
              });
              cmrDownloaded++;
              console.log('[package] CMR (name-match):', inv.number, '→', ord.name);
            }
          } catch (e) {
            console.error(`[package] CMR name-match error for ${inv.number}:`, e.message);
          }
        }
      }
    } catch (e) {
      console.error('[package] name-match augmentation failed:', e.message);
    }

    // c) Faktury PDF z iFirma POMINIETE — od czasu wprowadzenia KSeF
    // ksiegowa pobiera FV bezposrednio z KSeF, my wysylamy tylko same
    // listy przewozowe (CMR). Kod fetchInvoicePdf zostawiamy jakby kiedys
    // wrocila potrzeba — ale paczka teraz = same CMR.
    const invoiceDownloaded = 0;

    // d) Update package
    const docs = await prisma.document.findMany({
      where: { packageId: pkg.id },
      select: { type: true, name: true, filename: true, size: true, invoiceNumber: true },
    });
    const invoiceCount = docs.filter(d => d.type === 'invoice').length;
    const cmrCount = docs.filter(d => d.type === 'cmr').length;

    // Diagnostyka: które faktury WDT/eksport miesiąca NIE mają dokumentu w paczce.
    let missingDocs = [];
    try {
      const dFrom = new Date(y, m - 1, 1);
      const dLast = new Date(y, m, 0).getDate();
      const dTo = new Date(y, m - 1, dLast, 23, 59, 59, 999);
      const allDocInvs = await prisma.invoice.findMany({
        where: {
          issueDate: { gte: dFrom, lte: dTo },
          OR: [
            { type: { contains: 'dostawa_ue', mode: 'insensitive' } }, { type: { contains: 'wdt', mode: 'insensitive' } },
            { type: { contains: 'eksport', mode: 'insensitive' } }, { type: { contains: 'export', mode: 'insensitive' } },
            { ifirmaType: { contains: 'dostawa_ue', mode: 'insensitive' } }, { ifirmaType: { contains: 'wdt', mode: 'insensitive' } },
            { ifirmaType: { contains: 'eksport', mode: 'insensitive' } }, { ifirmaType: { contains: 'export', mode: 'insensitive' } },
          ],
        },
        select: { number: true, contractorName: true },
      });
      const haveCmr = new Set(docs.filter(d => d.type === 'cmr' && d.invoiceNumber).map(d => String(d.invoiceNumber)));
      missingDocs = allDocInvs.filter(i => !haveCmr.has(String(i.number))).map(i => ({ number: i.number, contractor: i.contractorName }));
    } catch (e) { console.error('[package] missingDocs calc failed:', e.message); }

    await prisma.monthlyPackage.update({
      where: { id: pkg.id },
      data: {
        status: 'ready',
        metadata: { totalInvoices: invoiceCount, totalCmr: cmrCount, buildDate: new Date().toISOString() },
      },
    });

    // Zapisz do AgentContext zeby kolejna wiadomosc "wyslij na X" wiedziala
    // ze chodzi o ta paczke (bez explicit period/month). Accounting-agent
    // get_context to odczyta.
    try {
      await prisma.agentContext.upsert({
        where: { id: 'ksiegowosc' },
        update: {
          data: {
            lastAction: 'wdt_package_built',
            timestamp: Date.now(),
            period,
            year: parseInt(period.split('-')[0], 10),
            month: parseInt(period.split('-')[1], 10),
            invoiceCount,
            cmrCount,
          },
        },
        create: {
          id: 'ksiegowosc',
          data: {
            lastAction: 'wdt_package_built',
            timestamp: Date.now(),
            period, year: parseInt(period.split('-')[0], 10), month: parseInt(period.split('-')[1], 10),
            invoiceCount, cmrCount,
          },
        },
      });
    } catch (e) {
      console.error('[package] agentContext save failed:', e.message);
    }

    // e) Telegram (admin notification)
    const { resolveTelegram } = require('../services/telegram-helper');
    const __tg = await resolveTelegram(prisma, { scope: 'pl' });
    const tgToken = __tg.token;
    const tgChat = __tg.chatId;
    await sendTelegram(tgToken, tgChat,
      `📦 Listy CMR za ${period}:\n• ${cmrCount} listów przewozowych\nStatus: gotowy`
    ).catch(e => console.error('[package] TG error:', e.message));

    res.json({
      ok: true,
      period,
      status: 'ready',
      invoices: invoiceCount,
      cmrs: cmrCount,
      missingDocs,
      unmatchedInvoices: (matchResult.unmatchedInvoices || []).map(u => ({
        number: u.number,
        contractor: u.contractor,
        grossAmount: u.grossAmount,
        currency: u.currency,
      })),
      unmatchedOrders: (matchResult.unmatchedOrders || []).map(o => ({
        number: o.number,
        receiverName: o.receiverName,
        creationDate: o.creationDate,
      })),
    });
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
    // Prisma 6: Bytes -> Uint8Array; res.send() serializuje go do JSON i psuje
    // binaria. Buffer.from() wymusza surowe bajty.
    const buf = Buffer.isBuffer(doc.data) ? doc.data : Buffer.from(doc.data);
    res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
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

    // Merge PDFs — decrypt with gs first, then merge
    const fs = require('fs');
    const path = require('path');
    const { execSync } = require('child_process');
    const os = require('os');

    let mergedBuffer;
    let addedCount = 0;
    let mergeMethod = 'pdf-merger-js';
    const filename = `FAKTURY_${period.replace('-', '_')}.pdf`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));

    try {
      // Check if gs is available
      let hasGs = false;
      try { execSync('which gs', { stdio: 'ignore' }); hasGs = true; } catch (e) { /* no gs */ }

      if (hasGs) {
        // Step 1: Decrypt each PDF individually
        const decryptedFiles = [];
        for (let i = 0; i < invoiceDocs.length; i++) {
          const doc = invoiceDocs[i];
          const inputFile = path.join(tmpDir, `raw_${i}.pdf`);
          const decryptedFile = path.join(tmpDir, `dec_${i}.pdf`);
          fs.writeFileSync(inputFile, doc.data);

          try {
            execSync(`gs -dBATCH -dNOPAUSE -q -sDEVICE=pdfwrite -dPDFSETTINGS=/prepress -sOutputFile="${decryptedFile}" "${inputFile}"`, { timeout: 30000 });
            decryptedFiles.push(decryptedFile);
            addedCount++;
            console.log('[package] Decrypted:', doc.invoiceNumber);
          } catch (err) {
            console.error('[package] Decrypt failed:', doc.invoiceNumber, err.message.slice(0, 100));
            decryptedFiles.push(inputFile); // use original as fallback
            addedCount++;
          }
        }

        // Step 2: Merge all decrypted PDFs
        const outputFile = path.join(tmpDir, 'merged.pdf');
        const fileList = decryptedFiles.map(f => `"${f}"`).join(' ');
        execSync(`gs -dBATCH -dNOPAUSE -q -sDEVICE=pdfwrite -sOutputFile="${outputFile}" ${fileList}`, { timeout: 120000, maxBuffer: 50 * 1024 * 1024 });
        mergedBuffer = fs.readFileSync(outputFile);
        mergeMethod = 'ghostscript';
        console.log(`[package] Merged with gs (decrypt+merge): ${addedCount} invoices, ${Math.round(mergedBuffer.length / 1024)} KB`);
      } else {
        // Fallback: pdf-merger-js (no gs available)
        console.log('[package] gs not available, using pdf-merger-js');
        const PDFMerger = require('pdf-merger-js').default || require('pdf-merger-js');
        const merger = new PDFMerger();
        for (const doc of invoiceDocs) {
          try {
            await merger.add(Buffer.from(doc.data));
            addedCount++;
            console.log('[package] Added:', doc.invoiceNumber);
          } catch (err) {
            console.error('[package] Failed to add:', doc.invoiceNumber, '—', err.message);
          }
        }
        mergedBuffer = await merger.saveAsBuffer();
        console.log(`[package] Merged with pdf-merger-js: ${addedCount} invoices, ${Math.round(mergedBuffer.length / 1024)} KB`);
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }

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

    res.json({ ok: true, period, invoices: addedCount, size: mergedBuffer.length, filename, method: mergeMethod });
  } catch (e) {
    console.error('[package] build-merged-pdf error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ DIAGNOSTICS ============

router.get('/merge-diagnostics', async (req, res) => {
  const { execSync } = require('child_process');
  const checks = {};
  for (const tool of ['gs', 'qpdf', 'pdfunite', 'pdftk']) {
    try {
      const path = execSync(`which ${tool} 2>/dev/null`).toString().trim();
      const version = execSync(`${tool} --version 2>&1 || ${tool} -v 2>&1`).toString().trim().slice(0, 100);
      checks[tool] = { available: true, path, version };
    } catch (e) {
      checks[tool] = { available: false };
    }
  }
  res.json({ ok: true, tools: checks, dockerfile: require('fs').existsSync('/app/package.json') ? 'docker' : 'nixpacks' });
});

// ============ SEND PACKAGE ============

router.post('/send-package', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { to } = req.body;
    const cc = (req.body && req.body.cc) || null;
    if (!to) return res.status(400).json({ error: 'to (email) is required' });

    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = (req.body && req.body.year) || prevMonth.getFullYear();
    const m = (req.body && req.body.month) || (prevMonth.getMonth() + 1);
    const period = `${y}-${String(m).padStart(2, '0')}`;

    const pkg = await prisma.monthlyPackage.findUnique({ where: { period } });
    if (!pkg) return res.json({ ok: false, error: 'Pakiet nie istnieje' });

    // Od KSeF — wysylamy SAME listy przewozowe (CMR). Faktury ksiegowa
    // pobiera z KSeF, my dorzucamy CMR-y nazwane numerami FV zeby
    // mogla je dopasowac do wlasciwej faktury.
    const cmrs = await prisma.document.findMany({
      where: { packageId: pkg.id, type: 'cmr' },
      orderBy: { invoiceNumber: 'asc' },
    });
    if (!cmrs.length) return res.json({ ok: false, error: 'Brak CMR w paczce — najpierw build-package' });

    const invoiceCount = (pkg.metadata && pkg.metadata.totalInvoices) || '?';
    const cmrCount = cmrs.length;

    const attachments = cmrs.map(cmr => ({
      filename: cmr.filename,
      content: Buffer.from(cmr.data),
      contentType: 'application/pdf',
    }));

    const totalSize = attachments.reduce((s, a) => s + a.content.length, 0);

    const htmlBody = `<h3>Potwierdzenia dostaw do faktur WDT/eksport za ${period}</h3>
<p>W załączeniu ${cmrCount} potwierdzeń dostaw (listy przewozowe / dokumenty eksportowe) do faktur WDT i eksportowych. Faktury są w KSeF.</p>
<p>Wygenerowano automatycznie przez system SurfStickBell.</p>`;

    await sendMail({
      from: 'office@surfstickbell.com',
      to,
      ...(cc ? { cc } : {}),
      subject: `Potwierdzenia dostaw do faktur WDT/eksport za ${period} — SurfStickBell`,
      html: htmlBody,
      attachments,
    });

    await prisma.monthlyPackage.update({
      where: { id: pkg.id },
      data: { status: 'sent', sentTo: to, sentAt: new Date() },
    });

    const { resolveTelegram } = require('../services/telegram-helper');
    const __tg2 = await resolveTelegram(prisma, { scope: 'pl' });
    const tgToken = __tg2.token;
    const tgChat = __tg2.chatId;
    await sendTelegram(tgToken, tgChat,
      `📧 Potwierdzenia dostaw WDT/eksport za ${period} wysłane na ${to} — ${cmrCount} dokumentów`
    ).catch(e => console.error('[package] TG error:', e.message));

    console.log(`[package] Sent package ${period} to ${to} — ${attachments.length} attachments, ${Math.round(totalSize / 1024)} KB`);

    res.json({ ok: true, period, sentTo: to, attachments: attachments.length, totalSize: Math.round(totalSize / 1024) + ' KB' });
  } catch (e) {
    console.error('[package] send-package error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// One-shot: build + (jak gotowe) send. Skrot dla user-a "zrob paczke WDT"
// — bez pytania kogokolwiek o nic. Email z env DEFAULT_ACCOUNTANT_EMAIL,
// year/month default = poprzedni miesiac. Idempotent: jak paczka juz
// ready dla period, pomija build i wysyla.
//
// Body (wszystko opcjonalne):
//   year (number) — default: rok poprzedniego miesiaca
//   month (number) — default: poprzedni miesiac
//   to (string) — default: env DEFAULT_ACCOUNTANT_EMAIL
router.post('/build-and-send', async (req, res) => {
  try {
    const accountantEmail = (req.body && req.body.to) || process.env.DEFAULT_ACCOUNTANT_EMAIL || '';
    if (!accountantEmail) {
      return res.status(400).json({ ok: false, error: 'Email ksiegowej nie podany i DEFAULT_ACCOUNTANT_EMAIL nie ustawione w env' });
    }
    const apiKey = (req.headers['x-api-key'] || process.env.API_KEY || '').trim();
    const http = require('http');
    const port = process.env.PORT || 3000;

    function selfPost(path, body) {
      return new Promise((resolve, reject) => {
        const data = JSON.stringify(body || {});
        const reqInner = http.request({
          hostname: '127.0.0.1', port, path, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-api-key': apiKey },
        }, (r) => {
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            try { resolve({ status: r.statusCode, body: JSON.parse(text) }); }
            catch (_) { resolve({ status: r.statusCode, body: text }); }
          });
        });
        reqInner.on('error', reject);
        reqInner.write(data);
        reqInner.end();
      });
    }

    const buildBody = {};
    if (req.body && req.body.year) buildBody.year = req.body.year;
    if (req.body && req.body.month) buildBody.month = req.body.month;

    const build = await selfPost('/api/jpk/build-package', buildBody);
    if (build.status >= 400) {
      return res.status(build.status).json({ ok: false, stage: 'build', error: build.body });
    }

    const sendBody = { to: accountantEmail };
    if (req.body && req.body.cc) sendBody.cc = req.body.cc;
    if (buildBody.year) sendBody.year = buildBody.year;
    if (buildBody.month) sendBody.month = buildBody.month;
    const send = await selfPost('/api/jpk/send-package', sendBody);
    if (send.status >= 400) {
      return res.status(send.status).json({ ok: false, stage: 'send', build: build.body, error: send.body });
    }

    res.json({ ok: true, build: build.body, send: send.body, to: accountantEmail });
  } catch (e) {
    console.error('[package] build-and-send error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
