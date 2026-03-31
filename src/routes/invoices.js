'use strict';

const router = require('express').Router();
const { fetchInvoices: fetchIfirmaInvoices, createInvoice, fetchInvoicePdf, fetchInvoiceDetails } = require('../ifirma-client');
const { sendMail } = require('../mail-sender');
const { sendTelegram } = require('../telegram-utils');
const { invoicePreviews, savePreview, getPreview } = require('../stores');
const { scoreContractor, processIfirmaInvoices } = require('./contractors');

const CENNIK = {
  PLN: {
    default: 18,
    wyjatki: {
      'Super -Pharm Holding': 16.10,
      'Nordsøen Designs': 13.32,
    },
  },
  EUR: {
    default: 4.50,
    wyjatki: {
      'Nuno Viegas Costa': 3.00,
      'Sirena Sardinia': 3.00,
    },
  },
};

// ============ IFIRMA SYNC ============

router.post('/ifirma/sync', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { dataOd, dataDo } = req.body || {};
    const defaultOd = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const invoices = await fetchIfirmaInvoices({ dataOd: dataOd || defaultOd, dataDo });
    const result = await processIfirmaInvoices(invoices, prisma);
    res.json({ ok: true, fetched: invoices.length, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/ifirma/invoices', async (req, res) => {
  try {
    const { dataOd, dataDo, status, nipKontrahenta } = req.query;
    const invoices = await fetchIfirmaInvoices({ dataOd, dataDo, status, nipKontrahenta });
    res.json(invoices);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ INVOICE PREVIEW ============

router.post('/ifirma/invoice-preview', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { contractorId, contractorSearch, items } = req.body;
    let parsedItems = items;
    if (typeof items === 'string') {
      try { parsedItems = JSON.parse(items); } catch(e) { return res.status(400).json({ error: 'items must be valid JSON array' }); }
    }
    if (!parsedItems || !parsedItems.length) return res.status(400).json({ error: 'items required' });
    console.log('[invoice-preview] parsed items:', JSON.stringify(parsedItems));

    let contractor;
    if (contractorId) {
      contractor = await prisma.contractor.findUnique({ where: { id: contractorId } });
    } else if (contractorSearch) {
      const all = await prisma.contractor.findMany({
        select: { id: true, name: true, nip: true, country: true, email: true, address: true, city: true, extras: true },
      });
      const scored = all
        .map(c => ({ contractor: c, score: scoreContractor(c, contractorSearch) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      console.log(`[invoice-preview] contractor match: "${contractorSearch}" → "${best ? best.contractor.name : 'none'}" (score: ${best ? best.score : 0})`);

      if (best && best.score >= 50) {
        contractor = await prisma.contractor.findUnique({ where: { id: best.contractor.id } });
      } else {
        const suggestions = scored.slice(0, 5).map(x => ({ id: x.contractor.id, name: x.contractor.name, score: x.score }));
        return res.json({ ok: false, suggestions });
      }
    }
    if (!contractor) return res.status(404).json({ error: 'contractor not found' });

    const waluta = (contractor.country || 'PL').toUpperCase() === 'PL' ? 'PLN' : 'EUR';
    const rodzaj = waluta === 'EUR' ? 'wdt' : 'krajowa';

    const pozycje = [];
    for (const item of parsedItems) {
      const ean = item.productEan || item.ean;
      console.log('[invoice-preview] looking for product EAN:', ean);
      const product = await prisma.product.findUnique({ where: { ean } });
      if (!product) return res.status(404).json({ error: `product not found: ${ean}` });

      console.log('[invoice-preview] template extras:', JSON.stringify(product.extras));
      if (product.category === 'template' && product.extras && product.extras.composition) {
        for (const comp of product.extras.composition) {
          console.log('[invoice-preview] composition item:', JSON.stringify(comp));
          const sub = await prisma.product.findUnique({ where: { ean: comp.ean } });
          if (sub) pozycje.push({ product: sub, ilosc: comp.qty * (item.qty || 1) });
        }
      } else {
        pozycje.push({ product, ilosc: item.qty || 1, itemCena: item.cena ?? null });
      }
    }

    const cennikWaluta = CENNIK[waluta] || CENNIK.PLN;
    const resolvePrice = (itemCena, contractorName, contractorExtras) => {
      if (itemCena != null) return { cena: itemCena, source: 'user' };
      if (contractorExtras && contractorExtras.lastPrice != null) {
        return { cena: contractorExtras.lastPrice, source: 'lastPrice' };
      }
      const nameNorm = (contractorName || '').toLowerCase();
      for (const [key, val] of Object.entries(cennikWaluta.wyjatki)) {
        if (nameNorm.includes(key.toLowerCase())) return { cena: val, source: 'wyjątek' };
      }
      return { cena: cennikWaluta.default, source: 'default' };
    };

    const linee = pozycje.map(({ product: p, ilosc, itemCena }) => {
      const { cena, source } = resolvePrice(itemCena, contractor.name, contractor.extras);
      console.log(`[invoice-preview] price for ${contractor.name}: ${cena} brutto (source: ${source})`);
      const wartosc = Math.round(cena * ilosc * 100) / 100;
      return { ean: p.ean, nazwa: p.name, wariant: p.variant || null, ilosc, cena, wartosc };
    });

    const brutto = Math.round(linee.reduce((s, l) => s + l.wartosc, 0) * 100) / 100;
    const netto = rodzaj === 'wdt' ? brutto : Math.round(brutto / 1.23 * 100) / 100;
    const vat = Math.round((brutto - netto) * 100) / 100;
    const terminPlatnosci = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const preview = {
      contractor: { id: contractor.id, name: contractor.name, nip: contractor.nip, country: contractor.country, address: contractor.address },
      waluta,
      rodzaj,
      pozycje: linee,
      suma: { brutto, netto, vat },
      terminPlatnosci,
    };

    const previewId = require('crypto').randomUUID();
    savePreview(previewId, { preview, contractorData: contractor, pozycjeData: linee, waluta, rodzaj });

    prisma.agentContext.upsert({
      where: { id: 'ksiegowosc' },
      update: { data: { lastAction: 'preview', previewId, contractor: { name: contractor.name, nip: contractor.nip, country: contractor.country }, suma: preview.suma, waluta, timestamp: Date.now() } },
      create: { id: 'ksiegowosc', data: { lastAction: 'preview', previewId, contractor: { name: contractor.name, nip: contractor.nip, country: contractor.country }, suma: preview.suma, waluta, timestamp: Date.now() } },
    }).catch(e => console.error('[invoice-preview] AgentContext save error:', e.message));

    res.json({ ok: true, preview, previewId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ INVOICE CONFIRM LATEST ============

router.post('/ifirma/invoice-confirm-latest', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const now = Date.now();
    let bestId = null;
    let bestExpiry = 0;
    for (const [id, entry] of invoicePreviews.entries()) {
      if (entry.expiresAt > now && entry.expiresAt > bestExpiry) {
        bestExpiry = entry.expiresAt;
        bestId = id;
      }
    }
    if (!bestId) return res.status(404).json({ error: 'Brak aktywnego podglądu. Utwórz nowy.' });

    const stored = getPreview(bestId);
    if (!stored) return res.status(404).json({ error: 'Brak aktywnego podglądu. Utwórz nowy.' });

    const { contractorData: contractor, pozycjeData: pozycje, waluta, rodzaj } = stored;

    const [tgTokenCfg, tgChatCfg] = await Promise.all([
      prisma.config.findUnique({ where: { key: 'telegram_bot_token' } }),
      prisma.config.findUnique({ where: { key: 'telegram_chat_id' } }),
    ]);
    const tgToken = tgTokenCfg && tgTokenCfg.value;
    const tgChat = tgChatCfg && tgChatCfg.value;

    let ifirmaResult;
    try {
      ifirmaResult = await createInvoice({
        kontrahent: {
          name: contractor.name,
          nip: contractor.nip,
          address: contractor.address,
          city: contractor.city,
          postCode: contractor.extras && contractor.extras.postCode || '',
          country: contractor.country,
          ifirmaId: contractor.extras && contractor.extras.ifirmaId || null,
        },
        pozycje,
        rodzaj,
      });
    } catch (ifirmaErr) {
      const raw = ifirmaErr.ifirmaRaw || null;
      const kod = raw && raw.response && raw.response.Kod;
      const info = raw && raw.response && raw.response.Informacja;
      console.log('[invoice-confirm] sending iFirma response to Telegram (error)');
      if (tgToken && tgChat) {
        sendTelegram(tgToken, tgChat,
          `IFIRMA ODPOWIEDŹ:\nStatus: BŁĄD\nKod: ${kod != null ? kod : '?'}\nInformacja: ${info || ifirmaErr.message}\nKontrahent: ${contractor.name}\nPełna odpowiedź: ${JSON.stringify(raw)}`
        ).catch(e => console.error('[invoice-confirm] tg error:', e.message));
      }
      return res.json({ ok: false, error: 'iFirma error', ifirmaResponse: raw });
    }

    const ifirmaRaw = ifirmaResult.ifirmaRaw;
    const fakturaId = ifirmaRaw && ifirmaRaw.response && ifirmaRaw.response.Identyfikator || null;
    const ifirmaIdNum = ifirmaRaw && ifirmaRaw.response && ifirmaRaw.response.Wynik && ifirmaRaw.response.Wynik.FakturaId || fakturaId || null;

    let pelnyNumer = ifirmaResult.invoiceNumber || 'UNKNOWN';
    try {
      const today = new Date().toISOString().slice(0, 10);
      const todayInvoices = await fetchIfirmaInvoices({ dataOd: today, dataDo: today });
      const matched = todayInvoices.find(inv => String(inv.FakturaId) === String(ifirmaIdNum));
      if (matched) {
        pelnyNumer = matched.PelnyNumer || matched.Numer || pelnyNumer;
        console.log(`[invoice-confirm] found invoice: PelnyNumer=${pelnyNumer}, FakturaId=${ifirmaIdNum}`);
      } else {
        console.log(`[invoice-confirm] invoice not found in today list, using: ${pelnyNumer}`);
      }
    } catch (lookupErr) {
      console.error('[invoice-confirm] invoice lookup error:', lookupErr.message);
    }

    const brutto = stored.preview.suma.brutto;

    const invoice = await prisma.invoice.create({
      data: {
        contractorId: contractor.id,
        ifirmaId: ifirmaIdNum,
        number: pelnyNumer,
        issueDate: new Date(),
        dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        grossAmount: brutto,
        currency: waluta,
        paidAmount: 0,
        status: 'unpaid',
        type: rodzaj,
        extras: { pozycje: pozycje.map(p => ({ ean: p.ean, nazwa: p.nazwa, ilosc: p.ilosc, pricePLN: p.cena, priceEUR: p.cena })) },
      },
    });

    console.log('[invoice-confirm] sending iFirma response to Telegram');
    if (tgToken && tgChat) {
      const info = ifirmaRaw && ifirmaRaw.response && ifirmaRaw.response.Informacja || '';
      sendTelegram(tgToken, tgChat,
        `IFIRMA ODPOWIEDŹ:\nStatus: SUKCES\nKod: 0\nInformacja: ${info}\nIdentyfikator: ${fakturaId}\nKontrahent: ${contractor.name}\nKwota: ${stored.preview.suma.brutto} ${waluta}`
      ).catch(e => console.error('[invoice-confirm] tg notify error:', e.message));
    }

    const pdfBuffer = await fetchInvoicePdf(pelnyNumer, rodzaj, fakturaId);

    let pdfSent = false;
    try {
      if (tgToken && tgChat) {
        const boundary = '----FormBoundary' + Date.now();
        const caption = `Faktura ${pelnyNumer} dla ${contractor.name}`;
        const filename = `faktura_${pelnyNumer.replace(/\//g, '_')}.pdf`;

        const parts = [
          `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${tgChat}`,
          `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}`,
          `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
        ];

        const pre = Buffer.from(parts.join('\r\n') + '\r\n', 'utf8');
        const post = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
        const body = Buffer.concat([pre, pdfBuffer, post]);

        await new Promise((resolve, reject) => {
          const tgUrl = new URL(`https://api.telegram.org/bot${tgToken}/sendDocument`);
          const options = {
            hostname: tgUrl.hostname,
            path: tgUrl.pathname,
            method: 'POST',
            headers: {
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
              'Content-Length': body.length,
            },
          };
          const req2 = require('https').request(options, r => { r.resume(); resolve(); });
          req2.on('error', reject);
          req2.write(body);
          req2.end();
        });
        pdfSent = true;
      }
    } catch (tgErr) {
      console.error('[invoice-confirm-latest] Telegram error:', tgErr.message);
    }

    invoicePreviews.delete(bestId);

    prisma.agentContext.upsert({
      where: { id: 'ksiegowosc' },
      update: { data: { lastAction: 'confirmed', invoiceNumber: pelnyNumer, invoiceId: invoice.id, contractor: { name: contractor.name }, timestamp: Date.now() } },
      create: { id: 'ksiegowosc', data: { lastAction: 'confirmed', invoiceNumber: pelnyNumer, invoiceId: invoice.id, contractor: { name: contractor.name }, timestamp: Date.now() } },
    }).catch(e => console.error('[invoice-confirm-latest] AgentContext save error:', e.message));

    res.json({ ok: true, invoiceNumber: pelnyNumer, invoiceId: invoice.id, pdfSent, ifirmaResponse: ifirmaRaw });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ INVOICE CONFIRM ============

router.post('/ifirma/invoice-confirm', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { previewId } = req.body;
    if (!previewId) return res.status(400).json({ error: 'previewId required' });

    const stored = getPreview(previewId);
    if (!stored) return res.status(404).json({ error: 'preview not found or expired' });

    const { contractorData: contractor, pozycjeData: pozycje, waluta, rodzaj } = stored;

    const ifirmaResp = await createInvoice({
      kontrahent: {
        name: contractor.name,
        nip: contractor.nip,
        address: contractor.address,
        city: contractor.city,
        postCode: contractor.extras && contractor.extras.postCode || '',
        country: contractor.country,
      },
      pozycje,
      waluta,
      rodzaj,
    });

    const ifirmaInvoice = ifirmaResp.response && ifirmaResp.response.Wynik;
    const pelnyNumer = ifirmaInvoice && (ifirmaInvoice.PelnyNumer || ifirmaInvoice.Numer) || 'UNKNOWN';
    const ifirmaId = ifirmaInvoice && ifirmaInvoice.FakturaId || null;

    const brutto = stored.preview.suma.brutto;

    const invoice = await prisma.invoice.create({
      data: {
        contractorId: contractor.id,
        ifirmaId,
        number: pelnyNumer,
        issueDate: new Date(),
        dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        grossAmount: brutto,
        currency: waluta,
        paidAmount: 0,
        status: 'unpaid',
        type: rodzaj,
        extras: { pozycje: pozycje.map(p => ({ ean: p.ean, nazwa: p.nazwa, ilosc: p.ilosc, pricePLN: p.cena, priceEUR: p.cena })) },
      },
    });

    const pdfBuffer = await fetchInvoicePdf(pelnyNumer, rodzaj);

    let pdfSent = false;
    try {
      const [tokenCfg, chatCfg] = await Promise.all([
        prisma.config.findUnique({ where: { key: 'telegram_bot_token' } }),
        prisma.config.findUnique({ where: { key: 'telegram_chat_id' } }),
      ]);
      const token = tokenCfg && tokenCfg.value;
      const chatId = chatCfg && chatCfg.value;

      if (token && chatId) {
        const boundary = '----FormBoundary' + Date.now();
        const caption = `Faktura ${pelnyNumer} dla ${contractor.name}`;
        const filename = `faktura_${pelnyNumer.replace(/\//g, '_')}.pdf`;

        const parts = [
          `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}`,
          `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}`,
          `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
        ];

        const pre = Buffer.from(parts.join('\r\n') + '\r\n', 'utf8');
        const post = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
        const body = Buffer.concat([pre, pdfBuffer, post]);

        await new Promise((resolve, reject) => {
          const tgUrl = new URL(`https://api.telegram.org/bot${token}/sendDocument`);
          const options = {
            hostname: tgUrl.hostname,
            path: tgUrl.pathname,
            method: 'POST',
            headers: {
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
              'Content-Length': body.length,
            },
          };
          const req2 = require('https').request(options, r => { r.resume(); resolve(); });
          req2.on('error', reject);
          req2.write(body);
          req2.end();
        });
        pdfSent = true;
      }
    } catch (tgErr) {
      console.error('[invoice-confirm] Telegram error:', tgErr.message);
    }

    invoicePreviews.delete(previewId);
    res.json({ ok: true, invoiceNumber: pelnyNumer, invoiceId: invoice.id, pdfSent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ SEND INVOICE EMAIL ============

router.post('/ifirma/send-invoice-email', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { invoiceId, toEmail } = req.body;
    if (!invoiceId || !toEmail) return res.status(400).json({ error: 'invoiceId and toEmail required' });

    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) return res.status(404).json({ error: 'invoice not found' });

    const pdfBuffer = await fetchInvoicePdf(invoice.number, invoice.type);
    const filename = `faktura_${invoice.number.replace(/\//g, '_')}.pdf`;

    await sendMail({
      from: 'info@surfstickbell.com',
      to: toEmail,
      subject: `Faktura ${invoice.number} - Surf Stick Bell`,
      body: 'W załączeniu faktura.',
      attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
    });

    res.json({ ok: true, sent: true, invoiceNumber: invoice.number });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ INVOICE MANAGEMENT ============

router.post('/invoices/extract-prices', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const contractors = await prisma.contractor.findMany({
      where: { nip: { not: null } },
      select: { id: true, name: true, nip: true, extras: true },
    });

    const results = [];
    for (const contractor of contractors) {
      try {
        const invoices = await fetchIfirmaInvoices({ nipKontrahenta: contractor.nip });
        if (!invoices.length) { results.push({ id: contractor.id, name: contractor.name, skipped: 'no invoices' }); continue; }

        invoices.sort((a, b) => new Date(b.DataWystawienia || 0) - new Date(a.DataWystawienia || 0));
        const latest = invoices[0];
        const fakturaId = latest.Identyfikator || latest.id;
        const rodzaj = latest.Rodzaj || 'krajowa';
        const waluta = latest.Waluta || 'PLN';

        const details = await fetchInvoiceDetails(fakturaId, rodzaj);
        const pozycje = details && (details.Pozycje || details.pozycje);
        if (!pozycje || !pozycje.length) { results.push({ id: contractor.id, name: contractor.name, skipped: 'no positions in invoice' }); continue; }

        const cena = pozycje[0].CenaJednostkowa;
        const extras = { ...(contractor.extras || {}), lastPrice: cena, lastPriceCurrency: waluta };
        await prisma.contractor.update({ where: { id: contractor.id }, data: { extras } });
        results.push({ id: contractor.id, name: contractor.name, lastPrice: cena, lastPriceCurrency: waluta });
      } catch (e) {
        results.push({ id: contractor.id, name: contractor.name, error: e.message });
      }
    }

    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/invoices/delete-search', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { contractorSearch, dateFrom, dateTo, limit } = req.body;
    if (!contractorSearch) return res.status(400).json({ error: 'contractorSearch required' });

    const all = await prisma.contractor.findMany({ select: { id: true, name: true, nip: true, country: true, email: true, extras: true } });
    const scored = all.map(c => ({ c, score: scoreContractor(c, contractorSearch) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    if (!scored.length) return res.status(404).json({ error: 'Nie znaleziono kontrahenta: ' + contractorSearch });
    const contractor = scored[0].c;

    const today = new Date().toISOString().slice(0, 10);
    const where = {
      contractorId: contractor.id,
      issueDate: { gte: new Date(dateFrom || today), lte: new Date(dateTo || today + 'T23:59:59.999Z') },
    };
    const invoices = await prisma.invoice.findMany({
      where,
      orderBy: { issueDate: 'desc' },
      take: limit || 50,
      select: { id: true, number: true, grossAmount: true, currency: true, issueDate: true, status: true, ifirmaId: true, type: true },
    });

    if (!invoices.length) return res.status(404).json({ error: `Brak faktur dla ${contractor.name} w podanym okresie.` });

    res.json({
      ok: true,
      invoices,
      message: `Znaleziono ${invoices.length} faktur dla ${contractor.name}. Potwierdź kasowanie.`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/invoices/delete-confirm', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { invoiceIds } = req.body;
    if (!Array.isArray(invoiceIds) || !invoiceIds.length) return res.status(400).json({ error: 'invoiceIds required' });

    const deleted = [];
    for (const id of invoiceIds) {
      const inv = await prisma.invoice.findUnique({ where: { id } });
      if (!inv) { deleted.push({ id, error: 'not found' }); continue; }

      await prisma.invoice.delete({ where: { id } });
      console.log(`[invoices] deleted from local DB: ${inv.number}, ifirmaId=${inv.ifirmaId} (iFirma manual deletion required)`);
      deleted.push({ id, number: inv.number });
    }

    res.json({ ok: true, deleted, note: 'Skasowano z lokalnej bazy. Faktury w iFirma trzeba skasować ręcznie w panelu.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/invoices/unpaid', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const now = new Date();
    const invoices = await prisma.invoice.findMany({
      where: { status: { not: 'paid' } },
      orderBy: { dueDate: 'asc' },
      include: { contractor: { select: { name: true, nip: true, country: true } } },
    });

    const result = invoices.map(inv => ({
      id: inv.id,
      number: inv.number,
      contractor: inv.contractor ? { name: inv.contractor.name, nip: inv.contractor.nip, country: inv.contractor.country } : null,
      grossAmount: inv.grossAmount,
      currency: inv.currency,
      paidAmount: inv.paidAmount,
      status: inv.status,
      issueDate: inv.issueDate,
      dueDate: inv.dueDate,
      daysOverdue: inv.dueDate ? Math.max(0, Math.floor((now - new Date(inv.dueDate)) / 86400000)) : null,
    }));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
