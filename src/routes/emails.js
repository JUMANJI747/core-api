'use strict';

const https = require('https');
const router = require('express').Router();
const { sendMail, findAccount, extractInbox, getAccounts } = require('../mail-sender');
const { scoreContractor } = require('./contractors');
const { OFFER_TEMPLATES } = require('../offer-templates');

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
  const take = Math.min(parseInt(req.query.limit) || 50, 100);
  const emails = await prisma.email.findMany({
    select: { id: true, fromEmail: true, fromName: true, subject: true, bodyPreview: true, tags: true, inbox: true, createdAt: true, contractor: { select: { name: true, country: true } } },
    orderBy: { createdAt: 'desc' },
    take,
  });
  res.json(emails);
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
  const emails = await prisma.email.findMany({ where, include: { contractor: true }, take, orderBy: { createdAt: 'desc' } });
  res.json(emails);
});

router.patch('/emails/:id/read', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const email = await prisma.email.update({ where: { id: req.params.id }, data: { isRead: true } });
  res.json(email);
});

// ============ SEND EMAIL (HITL) ============

router.post('/send-email', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { from, to, subject, body, replyTo, draft = true } = req.body;
    if (!from || !to || !subject || !body) {
      return res.status(400).json({ error: 'from, to, subject, body are required' });
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
          ...(replyTo ? { inReplyTo: replyTo } : {}),
          contractorId,
        },
      });

      return res.json({
        ok: true,
        draft: true,
        emailId: saved.id,
        preview: { from, to, subject, body },
      });
    }

    const saved = await sendMail({ from, to, subject, body, replyTo });
    return res.json({ ok: true, sent: true, emailId: saved.id });
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

    await sendMail({
      from: email.fromEmail,
      to: email.toEmail,
      subject: email.subject || '',
      body: email.bodyFull || '',
      replyTo: email.inReplyTo || undefined,
    });

    await prisma.email.update({ where: { id: email.id }, data: { direction: 'OUTBOUND' } });

    return res.json({ ok: true, sent: true, emailId: email.id, from: email.fromEmail, to: email.toEmail, subject: email.subject, message: `Mail wysłany z ${email.fromEmail} do ${email.toEmail}, temat: ${email.subject}` });
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

    await sendMail({
      from: draft.fromEmail,
      to: draft.toEmail,
      subject: draft.subject || '',
      body: draft.bodyFull || '',
      replyTo: draft.inReplyTo || undefined,
    });

    await prisma.email.update({ where: { id: draft.id }, data: { direction: 'OUTBOUND' } });

    return res.json({ ok: true, sent: true, to: draft.toEmail, subject: draft.subject });
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

    await sendMail({
      from: email.fromEmail,
      to: email.toEmail,
      subject: email.subject || '',
      body: email.bodyFull || '',
      replyTo: email.inReplyTo || undefined,
    });

    await prisma.email.update({ where: { id: email.id }, data: { direction: 'OUTBOUND' } });

    return res.json({
      ok: true,
      sent: true,
      emailId: email.id,
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
    let { to, language, contractorSearch } = req.body;

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
      from: 'info@surfstickbell.com',
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
