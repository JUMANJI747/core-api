'use strict';

const https = require('https');
const crypto = require('crypto');
const router = require('express').Router();
const { sendMail, findAccount, extractInbox, getAccounts } = require('../mail-sender');
const { scoreContractor } = require('./contractors');
const { OFFER_TEMPLATES } = require('../offer-templates');
const { parseOrderWithLLM } = require('../order-llm-parser');

const OFFER_PDFS = {
  FR: { fileId: '112mOTMThWgaCAoy70E6JMG-dAnPYetqx', filename: 'Offre_SurfStickBell.pdf' },
  PT: { fileId: '1KCFnyTyBECMPZtM4Z14jy4pYzjbKUB3Q', filename: 'Oferta_SurfStickBell.pdf' },
  ES: { fileId: '1QG2YrS5f2Ls1EAwjEw60WJRdOUoURVXt', filename: 'Oferta_SurfStickBell.pdf' },
  EN: { fileId: '1WFyKYs7HVQgXFsLq-t-rgRsSwqTRFuhb', filename: 'Offer_SurfStickBell.pdf' },
  PL: { fileId: '1spzOpX62gzZ_J138t3Jxl0tL750qtd-D', filename: 'Oferta_SurfStickBell.pdf' },
};

const OFFER_SUBJECTS = {
  FR: 'Surf Stick Bell - Protection solaire SPF 50+',
  PT: 'Surf Stick Bell - Proteção solar SPF 50+',
  ES: 'Surf Stick Bell - Protección solar SPF 50+',
  EN: 'Surf Stick Bell - Sun Protection SPF 50+',
  PL: 'Surf Stick Bell - Ochrona słoneczna SPF 50+',
};

const COUNTRY_TO_LANG = { PT: 'PT', ES: 'ES', FR: 'FR', GB: 'EN', US: 'EN', DE: 'EN', IT: 'EN', PL: 'PL' };

function downloadPdf(fileId) {
  return new Promise((resolve, reject) => {
    const url = `https://drive.google.com/uc?export=download&id=${fileId}`;
    const follow = (u, redirects) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) return reject(new Error(`Download failed: ${res.statusCode}`));
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    };
    follow(url, 0);
  });
}

// ============ DEDUP ============

async function wasRecentlySent(prisma, to, subject, body) {
  const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
  const recent = await prisma.email.findFirst({
    where: {
      direction: 'OUTBOUND',
      toEmail: to,
      subject: subject || '',
      createdAt: { gte: twoMinAgo },
    },
  });
  return recent !== null;
}

// ============ INBOX ============

router.post('/emails', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const email = await prisma.email.create({ data: req.body });
    if (email.direction === 'INBOUND' && email.fromEmail) {
      const contractor = await prisma.contractor.findFirst({ where: { email: { equals: email.fromEmail, mode: 'insensitive' } } });
      if (contractor) {
        await prisma.email.update({ where: { id: email.id }, data: { contractorId: contractor.id } });
      }
    }
    res.json(email);
  } catch (e) {
    if (e.code === 'P2002') return res.json({ ok: true, duplicate: true });
    res.status(500).json({ error: e.message });
  }
});

router.get('/emails/recent', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const take = Math.min(Math.max(1, parseInt(req.query.limit) || 50), 100);
  const skip = Math.max(0, parseInt(req.query.offset) || 0);
  const emails = await prisma.email.findMany({
    select: {
      id: true, fromEmail: true, fromName: true, subject: true, bodyPreview: true,
      tags: true, inbox: true, createdAt: true, extras: true,
      contractor: { select: { name: true, country: true } },
      _count: { select: { attachments: true } },
    },
    orderBy: { createdAt: 'desc' },
    skip,
    take,
  });
  const mapped = emails.map(e => ({
    ...e,
    attachmentCount: (e._count && e._count.attachments) || 0,
    hasOrder: !!(e.extras && e.extras.parsedOrder) || (Array.isArray(e.tags) && e.tags.includes('attachment_order')),
    _count: undefined,
  }));
  res.json(mapped);
});

router.get('/emails/check-sent', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { invoiceNumber, to } = req.query;

  if (!invoiceNumber) return res.status(400).json({ ok: false, error: 'Podaj invoiceNumber' });

  const where = {
    direction: 'OUTBOUND',
    subject: { contains: invoiceNumber },
  };
  if (to) where.toEmail = { contains: to, mode: 'insensitive' };

  const emails = await prisma.email.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, toEmail: true, subject: true, createdAt: true, messageId: true },
  });

  res.json({
    ok: true,
    sent: emails.length > 0,
    count: emails.length,
    emails: emails.map(e => ({
      to: e.toEmail,
      subject: e.subject,
      date: e.createdAt,
      messageId: e.messageId,
    })),
  });
});

router.get('/emails', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { inbox, direction, isRead, limit, fromEmail, search, contractorId } = req.query;
  const where = {};
  if (inbox) where.inbox = inbox;
  if (direction) where.direction = direction;
  if (isRead !== undefined) where.isRead = isRead === 'true';
  if (fromEmail) where.fromEmail = { contains: fromEmail, mode: 'insensitive' };
  if (contractorId) where.contractorId = contractorId;
  if (search) {
    const searchTerm = search.includes('@') ? search.split('@')[0] : search;
    where.OR = [
      { fromEmail: { contains: searchTerm, mode: 'insensitive' } },
      { fromName: { contains: searchTerm, mode: 'insensitive' } },
      { subject: { contains: searchTerm, mode: 'insensitive' } },
    ];
  }
  const take = Math.min(parseInt(limit) || 20, 100);
  const emails = await prisma.email.findMany({
    where,
    include: {
      contractor: true,
      attachments: { select: { id: true, filename: true, contentType: true, size: true } },
    },
    take,
    orderBy: { createdAt: 'desc' },
  });
  res.json(emails);
});

router.patch('/emails/:id/read', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const email = await prisma.email.update({ where: { id: req.params.id }, data: { isRead: true } });
  res.json(email);
});

// ============ EMAIL DETAIL WITH ATTACHMENTS ============

router.get('/emails/:id', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const email = await prisma.email.findUnique({
      where: { id: req.params.id },
      include: {
        contractor: true,
        attachments: { select: { id: true, filename: true, contentType: true, size: true, createdAt: true } },
      },
    });
    if (!email) return res.status(404).json({ error: 'Email not found' });
    res.json(email);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/emails/:id/parse-attachments', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const email = await prisma.email.findUnique({
      where: { id: req.params.id },
      include: { attachments: true, contractor: true },
    });
    if (!email) return res.status(404).json({ ok: false, error: 'Email not found' });

    if (email.extras && email.extras.parsedOrder) {
      return res.json({
        ok: true,
        cached: true,
        emailId: email.id,
        contractorName: (email.contractor && email.contractor.name) || email.fromName,
        order: email.extras.parsedOrder,
      });
    }

    if (!email.attachments || email.attachments.length === 0) {
      return res.json({ ok: true, attachments: 0, message: 'Brak załączników' });
    }

    const results = [];
    let detectedOrder = null;

    for (const att of email.attachments) {
      const filename = (att.filename || '').toLowerCase();
      const mimeType = (att.contentType || '').toLowerCase();

      if (filename.endsWith('.pdf') || mimeType.includes('pdf')) {
        try {
          const { PDFParse } = require('pdf-parse');
          const parser = new PDFParse({ data: att.data });
          const parsed = await parser.getText();
          const text = (parsed.text || '').trim();
          results.push({ filename: att.filename, type: 'pdf', size: att.data.length, preview: text.substring(0, 500) });

          if (text.length > 50 && !detectedOrder) {
            const contractorName = (email.contractor && email.contractor.name) || email.fromName;
            const llmOrder = await parseOrderWithLLM(text, contractorName);
            if (llmOrder && llmOrder.hasItems) {
              detectedOrder = {
                isOrder: true,
                items: llmOrder.items,
                total: llmOrder.totalBrutto || llmOrder.totalNetto,
                totalNetto: llmOrder.totalNetto,
                totalBrutto: llmOrder.totalBrutto,
                currency: llmOrder.currency || 'PLN',
                orderNumber: llmOrder.orderNumber,
                buyerName: llmOrder.buyerName,
                buyerNip: llmOrder.buyerNip,
                vatRate: llmOrder.vatRate,
                notes: llmOrder.notes,
                hasItems: true,
                parsedBy: 'llm',
              };
            }
          }
        } catch (err) {
          results.push({ filename: att.filename, type: 'pdf', error: err.message });
        }
      } else if (filename.endsWith('.xml') || filename.endsWith('.csv') || filename.endsWith('.txt') || mimeType.includes('text')) {
        const text = att.data.toString('utf-8');
        results.push({ filename: att.filename, type: filename.split('.').pop(), size: att.data.length, preview: text.substring(0, 500) });
      } else if (mimeType.includes('image')) {
        results.push({ filename: att.filename, type: 'image', size: att.data.length, note: 'Obraz — wymaga OCR' });
      } else {
        results.push({ filename: att.filename, type: 'other', size: att.data.length });
      }
    }

    if (detectedOrder) {
      const currentExtras = (typeof email.extras === 'object' && email.extras) ? email.extras : {};
      await prisma.email.update({
        where: { id: email.id },
        data: {
          extras: { ...currentExtras, parsedOrder: detectedOrder },
          tags: { push: 'attachment_order' },
        },
      });
    }

    res.json({
      ok: true,
      emailId: email.id,
      from: email.fromEmail,
      subject: email.subject,
      contractorName: (email.contractor && email.contractor.name) || email.fromName,
      attachments: results,
      order: detectedOrder,
    });
  } catch (err) {
    console.error('[parse-attachments]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/emails/:emailId/attachments', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const attachments = await prisma.emailAttachment.findMany({
    where: { emailId: req.params.emailId },
    select: { id: true, filename: true, contentType: true, size: true, createdAt: true },
  });
  res.json(attachments);
});

router.get('/attachment/:id', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const att = await prisma.emailAttachment.findUnique({ where: { id: req.params.id } });
    if (!att) return res.status(404).json({ error: 'Attachment not found' });
    res.setHeader('Content-Type', att.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${att.filename}"`);
    res.send(att.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/attachment/:id/parse', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const att = await prisma.emailAttachment.findUnique({ where: { id: req.params.id } });
    if (!att) return res.status(404).json({ error: 'Attachment not found' });

    if (att.contentType === 'application/pdf' || att.filename.endsWith('.pdf')) {
      try {
        const { PDFParse } = require('pdf-parse');
        const parser = new PDFParse({ data: att.data });
        const result = await parser.getText();
        return res.json({ ok: true, filename: att.filename, size: att.size, pages: result.pages || result.numpages, text: result.text });
      } catch (e) {
        return res.json({ ok: false, filename: att.filename, error: 'PDF parse failed: ' + e.message });
      }
    }

    if (att.contentType === 'text/plain' || att.filename.endsWith('.txt') || att.filename.endsWith('.csv')) {
      return res.json({ ok: true, filename: att.filename, size: att.size, text: att.data.toString('utf-8') });
    }

    res.json({ ok: false, filename: att.filename, contentType: att.contentType, error: 'Unsupported format for text extraction' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ SEND EMAIL (HITL) ============

router.post('/send-email', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    let { from, to, subject, body, replyTo, emailId: replyToEmailId, draft = true } = req.body;

    // Reply-in-thread: resolve from/to/subject from original email
    let inReplyTo = null;
    let references = null;

    if (replyToEmailId) {
      const originalEmail = await prisma.email.findUnique({ where: { id: replyToEmailId } });
      if (!originalEmail) return res.status(404).json({ error: 'emailId not found — mail to reply to does not exist' });

      to = to || originalEmail.fromEmail;
      // Map inbox name to full email using IMAP_ACCOUNTS
      if (!from && originalEmail.inbox) {
        const accounts = getAccounts();
        const matchedAccount = accounts.find(a => (a.inbox || '').toLowerCase() === originalEmail.inbox.toLowerCase());
        from = matchedAccount ? matchedAccount.user : 'info@surfstickbell.com';
      }
      from = from || 'info@surfstickbell.com';
      if (!subject) {
        const origSubject = originalEmail.subject || '';
        subject = origSubject.replace(/^(Re:\s*)+/i, '').trim();
        subject = `Re: ${subject}`;
      }
      if (originalEmail.messageId) {
        inReplyTo = originalEmail.messageId;
        references = ((originalEmail.references || '') + ' ' + originalEmail.messageId).trim();
      }
      console.log(`[send-email] Reply-in-thread: emailId=${replyToEmailId}, inReplyTo=${inReplyTo}, from=${from}, to=${to}`);
    }

    if (!from || !to || !subject || !body) {
      return res.status(400).json({ error: 'from, to, subject, body are required (or provide emailId to auto-fill)' });
    }

    const account = findAccount(from);
    if (!account) {
      const available = getAccounts().map(a => a.user).join(', ');
      return res.status(400).json({ error: `Unknown sender address, available: ${available}` });
    }

    if (draft) {
      let contractorId = null;
      const contractor = await prisma.contractor.findFirst({
        where: { email: { contains: to, mode: 'insensitive' } },
      });
      if (contractor) contractorId = contractor.id;

      const saved = await prisma.email.create({
        data: {
          direction: 'DRAFT',
          inbox: extractInbox(from),
          fromEmail: from,
          toEmail: to,
          subject: subject || null,
          bodyPreview: (body || '').slice(0, 300),
          bodyFull: (body || '').slice(0, 2000),
          inReplyTo: inReplyTo || null,
          references: references || null,
          contractorId,
        },
      });

      return res.json({
        ok: true,
        draft: true,
        emailId: saved.id,
        preview: { from, to, subject, body, replyToThread: !!inReplyTo },
      });
    }

    if (await wasRecentlySent(prisma, to, subject, body)) {
      console.log('[dedup] Skipping duplicate send to', to, subject);
      return res.json({ ok: true, deduplicated: true, message: 'Identical email sent in last 2 minutes, skipped to prevent duplicate' });
    }

    const saved = await sendMail({ from, to, subject, body, inReplyTo, references });
    return res.json({ ok: true, sent: true, emailId: saved.id, replyToThread: !!inReplyTo });
  } catch (e) {
    const status = e.message.startsWith('Rate limit') ? 429 : 500;
    res.status(status).json({ error: e.message });
  }
});

router.get('/send-email/drafts', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const drafts = await prisma.email.findMany({
    where: { direction: 'DRAFT' },
    select: { id: true, fromEmail: true, toEmail: true, subject: true, bodyPreview: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  res.json(drafts);
});

router.post('/send-email/confirm', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { emailId } = req.body;
    if (!emailId) return res.status(400).json({ error: 'emailId is required' });
    const email = await prisma.email.findUnique({ where: { id: emailId } });
    if (!email) return res.status(404).json({ error: 'Email not found' });
    if (email.direction !== 'DRAFT') return res.status(400).json({ error: 'Not a draft' });

    if (await wasRecentlySent(prisma, email.toEmail, email.subject, email.bodyFull)) {
      console.log('[dedup] Skipping duplicate confirm to', email.toEmail, email.subject);
      await prisma.email.update({ where: { id: email.id }, data: { direction: 'OUTBOUND' } });
      return res.json({ ok: true, deduplicated: true, message: 'Identical email sent in last 2 minutes, skipped to prevent duplicate' });
    }

    await sendMail({
      from: email.fromEmail,
      to: email.toEmail,
      subject: email.subject || '',
      body: email.bodyFull || '',
      inReplyTo: email.inReplyTo || undefined,
      references: email.references || undefined,
    });

    await prisma.email.update({ where: { id: email.id }, data: { direction: 'OUTBOUND' } });

    return res.json({ ok: true, sent: true, emailId: email.id, from: email.fromEmail, to: email.toEmail, subject: email.subject, replyToThread: !!email.inReplyTo, message: `Mail wysłany z ${email.fromEmail} do ${email.toEmail}, temat: ${email.subject}` });
  } catch (e) {
    const status = e.message.startsWith('Rate limit') ? 429 : 500;
    res.status(status).json({ error: e.message });
  }
});

router.post('/send-email/confirm-latest', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    const draft = await prisma.email.findFirst({
      where: { direction: 'DRAFT', createdAt: { gte: thirtyMinutesAgo } },
      orderBy: { createdAt: 'desc' },
    });
    if (!draft) return res.json({ ok: false, error: 'Brak aktywnego draftu' });

    if (await wasRecentlySent(prisma, draft.toEmail, draft.subject, draft.bodyFull)) {
      console.log('[dedup] Skipping duplicate confirm-latest to', draft.toEmail, draft.subject);
      await prisma.email.update({ where: { id: draft.id }, data: { direction: 'OUTBOUND' } });
      return res.json({ ok: true, deduplicated: true, message: 'Identical email sent in last 2 minutes, skipped to prevent duplicate' });
    }

    await sendMail({
      from: draft.fromEmail,
      to: draft.toEmail,
      subject: draft.subject || '',
      body: draft.bodyFull || '',
      inReplyTo: draft.inReplyTo || undefined,
      references: draft.references || undefined,
    });

    await prisma.email.update({ where: { id: draft.id }, data: { direction: 'OUTBOUND' } });

    return res.json({ ok: true, sent: true, to: draft.toEmail, subject: draft.subject, replyToThread: !!draft.inReplyTo });
  } catch (e) {
    const status = e.message.startsWith('Rate limit') ? 429 : 500;
    res.status(status).json({ error: e.message });
  }
});

router.post('/send-email/:id/confirm', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const email = await prisma.email.findUnique({ where: { id: req.params.id } });
    if (!email) return res.status(404).json({ error: 'Email not found' });
    if (email.direction !== 'DRAFT') return res.status(400).json({ error: 'Not a draft' });

    if (await wasRecentlySent(prisma, email.toEmail, email.subject, email.bodyFull)) {
      console.log('[dedup] Skipping duplicate /:id/confirm to', email.toEmail, email.subject);
      await prisma.email.update({ where: { id: email.id }, data: { direction: 'OUTBOUND' } });
      return res.json({ ok: true, deduplicated: true, message: 'Identical email sent in last 2 minutes, skipped to prevent duplicate' });
    }

    await sendMail({
      from: email.fromEmail,
      to: email.toEmail,
      subject: email.subject || '',
      body: email.bodyFull || '',
      inReplyTo: email.inReplyTo || undefined,
      references: email.references || undefined,
    });

    await prisma.email.update({ where: { id: email.id }, data: { direction: 'OUTBOUND' } });

    return res.json({
      ok: true,
      sent: true,
      emailId: email.id,
      replyToThread: !!email.inReplyTo,
      message: `Sent from ${email.fromEmail} to ${email.toEmail}`,
    });
  } catch (e) {
    const status = e.message.startsWith('Rate limit') ? 429 : 500;
    res.status(status).json({ error: e.message });
  }
});

// ============ SEND OFFER ============

router.post('/send-offer', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    let { to, language, contractorSearch, from } = req.body;
    const sender = (from && from.trim()) ? from.trim() : 'info@surfstickbell.com';

    // Find contractor if search provided
    let contractor = null;
    if (contractorSearch) {
      const all = await prisma.contractor.findMany({
        select: { id: true, name: true, nip: true, country: true, email: true, address: true, city: true, extras: true },
      });
      const scored = all
        .map(c => ({ contractor: c, score: scoreContractor(c, contractorSearch) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score);
      if (scored.length) contractor = scored[0].contractor;
    }

    // Resolve "to" from contractor if not provided
    if (!to && contractor && contractor.email) {
      to = contractor.email;
    }
    if (!to) return res.status(400).json({ error: 'to is required (or contractorSearch must match a contractor with email)' });

    // Resolve language
    if (!language && contractor && contractor.country) {
      language = COUNTRY_TO_LANG[contractor.country.toUpperCase()] || 'EN';
    }
    language = (language || 'EN').toUpperCase();
    if (!OFFER_TEMPLATES[language]) language = 'EN';

    const subject = OFFER_SUBJECTS[language];
    const html = OFFER_TEMPLATES[language];
    const pdf = OFFER_PDFS[language];

    // Download PDF from Google Drive
    const pdfBuffer = await downloadPdf(pdf.fileId);

    // Send email
    await sendMail({
      from: sender,
      to,
      subject,
      html,
      attachments: [{ filename: pdf.filename, content: pdfBuffer, contentType: 'application/pdf' }],
    });

    console.log(`[send-offer] sent ${language} offer to ${to}`);
    return res.json({ ok: true, sent: true, to, language, subject });
  } catch (e) {
    const status = e.message.startsWith('Rate limit') ? 429 : 500;
    res.status(status).json({ error: e.message });
  }
});

module.exports = router;
