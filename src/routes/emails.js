'use strict';

const https = require('https');
const crypto = require('crypto');
const router = require('express').Router();
const { sendMail, findAccount, extractInbox, getAccounts } = require('../mail-sender');
const { appendToSent } = require('../imap-sent');
const nodemailer = require('nodemailer');
const { buildTrackingUrl } = require('../services/tracking-urls');
const { sendTrackingNotification, validateShipmentReady } = require('../services/tracking-notify');
const { getOrders } = require('../glob-client');
const { sendTelegram } = require('../telegram-utils');
const { notifyMailResult } = require('../services/notify-mail-result');
const { scoreContractor } = require('../services/contractor-match');
const { OFFER_TEMPLATES } = require('../offer-templates');
const { parseOrderWithLLM } = require('../order-llm-parser');
const { translateToPl, translateFromPl, countryToLang, langName } = require('../services/email-translate');
const { fetchInvoicePdf } = require('../ifirma-client');

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
    // Dedup guard: Email.messageId is `String? @unique`, ktore w Postgres
    // pozwala na N rekordow z NULL. IMAP czasem zwraca maile bez naglowka
    // Message-ID (lub poller go gubi w mapowaniu) — taki mail laduje do
    // bazy co poll cycle (zaobserwowane 79 kopii jednego maila). Syntetyczny
    // hash z (from|subject|date|body[:500]) wpada w existing unique index
    // i dalsze polly konczą się P2002 (handled below jako duplicate=true).
    if (!req.body.messageId) {
      const fromAddr = String(req.body.fromEmail || '').toLowerCase().trim();
      const subj = String(req.body.subject || '').trim();
      const rawDate = req.body.sentAt || (req.body.extras && (req.body.extras.date || req.body.extras.sentAt)) || null;
      const dateMs = rawDate ? new Date(rawDate).getTime() : 0;
      const bodyExcerpt = String(req.body.bodyFull || req.body.bodyPreview || '').slice(0, 500);
      const hash = crypto.createHash('sha256').update(`${fromAddr}|${subj}|${dateMs}|${bodyExcerpt}`).digest('hex').slice(0, 32);
      req.body.messageId = `synthetic:${hash}`;
    }
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
  // direction filter — 'OUTBOUND' / 'INBOUND' / 'DRAFT' (case-insensitive).
  // Default: no filter, returns all.
  const dirRaw = (req.query.direction || '').toString().toUpperCase();
  const where = ['INBOUND', 'OUTBOUND', 'DRAFT', 'FAILED'].includes(dirRaw) ? { direction: dirRaw } : {};
  const emails = await prisma.email.findMany({
    where,
    select: {
      id: true, direction: true, fromEmail: true, fromName: true, toEmail: true,
      subject: true, bodyPreview: true, messageId: true,
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
  const { inbox, direction, isRead, limit, fromEmail, search, contractorId, folder } = req.query;
  const where = {};
  if (inbox) where.inbox = inbox;
  if (direction) where.direction = direction;
  if (isRead !== undefined) where.isRead = isRead === 'true';
  if (fromEmail) where.fromEmail = { contains: fromEmail, mode: 'insensitive' };
  if (contractorId) where.contractorId = contractorId;
  // folder-based tag filtering
  if (folder === 'trash') {
    where.tags = { has: 'trash' };
  } else if (folder === 'archived') {
    where.tags = { has: 'archived' };
  } else if (!folder || folder === 'inbox') {
    // domyslnie ukrywamy archived i trash
    where.NOT = { tags: { hasSome: ['archived', 'trash'] } };
  }
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

  // Dolaczamy replyId dla INBOUND - id najnowszego OUTBOUND/DRAFT ktory
  // referencjuje ten mail. 3 strategie matchingu w kolejnosci od najpewniejszego:
  //   1. inReplyTo exact match (normalized: trim, strip <>, lowercase)
  //   2. references chain zawiera messageId (Thunderbird/Outlook czasem nie
  //      wypelniaja inReplyTo ale dopisuja messageId do references)
  //   3. Subject Re: + odbiorca match (fromEmail INBOUND == toEmail OUTBOUND)
  //      w oknie 90 dni - fallback gdy headers nie dotarly poprawnie (np.
  //      maile z webmaila lub przez forwarding)
  try {
    const inbounds = emails.filter(e => e.direction === 'INBOUND');
    if (inbounds.length) {
      // Normalizacja messageId — IMAP czasem zwraca z <>, czasem bez, czesto
      // z whitespace na koncach. Zeby match dzialal po obu stronach (OUTBOUND
      // wpisuje raw header value), buduje set wszystkich wariantow.
      const normalize = (id) => (id || '').trim().replace(/^<|>$/g, '').toLowerCase();

      const msgIdMap = {}; // norm -> inbound email
      for (const e of inbounds) {
        if (e.messageId) {
          const n = normalize(e.messageId);
          if (n) msgIdMap[n] = e;
        }
      }
      const allNormIds = Object.keys(msgIdMap);

      // Strategia 1+2: znajdz wszystkie OUTBOUND/DRAFT ktore w inReplyTo lub
      // references referencuja ktorykolwiek z inbound messageIds.
      // Prisma nie ma OR w array contains - robimy 2 osobne queries i merge.
      const candidates = await prisma.email.findMany({
        where: {
          direction: { in: ['OUTBOUND', 'DRAFT'] },
          createdAt: { gte: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) }, // limit do roku w tyl
          OR: [
            { inReplyTo: { not: null } },
            { references: { not: null } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          inReplyTo: true,
          references: true,
          direction: true,
          createdAt: true,
          toEmail: true,
          subject: true,
        },
      });

      const replyMap = {}; // inboundId -> {id, direction, createdAt, source}

      // Strategia 1: inReplyTo match
      for (const c of candidates) {
        if (!c.inReplyTo) continue;
        const n = normalize(c.inReplyTo);
        const inbound = msgIdMap[n];
        if (inbound && !replyMap[inbound.id]) {
          replyMap[inbound.id] = { id: c.id, direction: c.direction, createdAt: c.createdAt, source: 'inReplyTo' };
        }
      }

      // Strategia 2: references contains
      for (const c of candidates) {
        if (!c.references) continue;
        const refsLower = c.references.toLowerCase();
        for (const normId of allNormIds) {
          if (refsLower.includes(normId)) {
            const inbound = msgIdMap[normId];
            if (inbound && !replyMap[inbound.id]) {
              replyMap[inbound.id] = { id: c.id, direction: c.direction, createdAt: c.createdAt, source: 'references' };
            }
          }
        }
      }

      // Strategia 3: subject + recipient fallback. Dla INBOUND bez znalezionej
      // odpowiedzi szuka OUTBOUND z subject startujacym od "Re:" i toEmail =
      // fromEmail inbound, w oknie 90 dni od inbound.
      const stillMissing = inbounds.filter(e => !replyMap[e.id]);
      if (stillMissing.length) {
        const fromEmails = [...new Set(stillMissing.map(e => (e.fromEmail || '').toLowerCase()).filter(Boolean))];
        if (fromEmails.length) {
          const subjectCandidates = await prisma.email.findMany({
            where: {
              direction: { in: ['OUTBOUND', 'DRAFT'] },
              toEmail: { in: fromEmails, mode: 'insensitive' },
              createdAt: { gte: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) },
            },
            orderBy: { createdAt: 'desc' },
            select: { id: true, toEmail: true, subject: true, direction: true, createdAt: true },
          });
          // Normalizacja subjectu - strip "Re:", "Fwd:", "RE:" prefixy
          const stripPrefix = (s) => (s || '').replace(/^\s*(re|fwd|fw|odp|wg|aw):\s*/i, '').trim().toLowerCase();
          for (const inbound of stillMissing) {
            const inboundSubj = stripPrefix(inbound.subject);
            if (!inboundSubj) continue;
            const inboundFrom = (inbound.fromEmail || '').toLowerCase();
            const inboundDate = new Date(inbound.createdAt);
            for (const c of subjectCandidates) {
              if ((c.toEmail || '').toLowerCase() !== inboundFrom) continue;
              if (stripPrefix(c.subject) !== inboundSubj) continue;
              // OUTBOUND musi byc PO inbound (replyto, nie przed)
              if (new Date(c.createdAt) < inboundDate) continue;
              // W oknie 90 dni
              const diffDays = (new Date(c.createdAt) - inboundDate) / (24 * 60 * 60 * 1000);
              if (diffDays > 90) continue;
              if (!replyMap[inbound.id]) {
                replyMap[inbound.id] = { id: c.id, direction: c.direction, createdAt: c.createdAt, source: 'subject' };
              }
              break; // pierwszy match jest najswiezszy (sorted desc)
            }
          }
        }
      }

      for (const e of emails) {
        const r = replyMap[e.id];
        if (r) {
          e.replyId = r.id;
          e.replyDirection = r.direction;
          e.replyCreatedAt = r.createdAt;
          e.replyMatchedBy = r.source;
        }
      }
    }
  } catch (err) {
    console.error('[emails GET] reply lookup failed:', err.message);
  }

  res.json(emails);
});

router.patch('/emails/:id/read', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const email = await prisma.email.update({ where: { id: req.params.id }, data: { isRead: true } });
  res.json(email);
});

router.patch('/emails/:id/archive', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const email = await prisma.email.findUnique({ where: { id: req.params.id }, select: { tags: true } });
  if (!email) return res.status(404).json({ error: 'not found' });
  const has = (email.tags || []).includes('archived');
  const tags = has ? (email.tags || []).filter(t => t !== 'archived') : [...(email.tags || []), 'archived'];
  const updated = await prisma.email.update({ where: { id: req.params.id }, data: { tags } });
  res.json({ ok: true, archived: !has, email: updated });
});

router.patch('/emails/:id/trash', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const email = await prisma.email.findUnique({ where: { id: req.params.id }, select: { tags: true } });
  if (!email) return res.status(404).json({ error: 'not found' });
  const has = (email.tags || []).includes('trash');
  const tags = has ? (email.tags || []).filter(t => t !== 'trash') : [...(email.tags || []), 'trash'];
  const updated = await prisma.email.update({ where: { id: req.params.id }, data: { tags } });
  res.json({ ok: true, trashed: !has, email: updated });
});

router.post('/emails/bulk-action', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { ids, action } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
  if (!['archive', 'trash', 'read', 'unread', 'unarchive', 'untrash'].includes(action)) {
    return res.status(400).json({ error: 'action must be one of: archive, trash, read, unread, unarchive, untrash' });
  }
  let affected = 0;
  for (const id of ids) {
    try {
      if (action === 'read') {
        await prisma.email.update({ where: { id }, data: { isRead: true } });
      } else if (action === 'unread') {
        await prisma.email.update({ where: { id }, data: { isRead: false } });
      } else {
        const email = await prisma.email.findUnique({ where: { id }, select: { tags: true } });
        if (!email) continue;
        let tags = email.tags || [];
        if (action === 'archive') { if (!tags.includes('archived')) tags = [...tags, 'archived']; }
        else if (action === 'unarchive') { tags = tags.filter(t => t !== 'archived'); }
        else if (action === 'trash') { if (!tags.includes('trash')) tags = [...tags, 'trash']; }
        else if (action === 'untrash') { tags = tags.filter(t => t !== 'trash'); }
        await prisma.email.update({ where: { id }, data: { tags } });
      }
      affected++;
    } catch (_) { /* skip missing */ }
  }
  res.json({ ok: true, action, affected });
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
    // Diag: pokaz co backend zwraca z bazy dla maila ktory user otwiera.
    // Pomoze zdiagnozowac bug "(brak treści)" w UI mimo ze sendMail logi
    // pokazaly zapis z body 43 znaki.
    console.log(`[emails/:id] return id=${email.id} dir=${email.direction} subj="${(email.subject||'').slice(0,50)}" bodyFullLen=${(email.bodyFull||'').length} bodyPreviewLen=${(email.bodyPreview||'').length} bodyFullNull=${email.bodyFull===null} bodyPreviewNull=${email.bodyPreview===null}`);
    // Sprawdz tez czy nie ma duplikatow OUTBOUND po toEmail+subject — moglo
    // sie zdarzyc ze sendMail zapisal jeden, a processSentItems poller zrobil
    // drugi z empty body (np. mismatch messageId formats).
    if (email.direction === 'OUTBOUND' && email.subject && email.toEmail) {
      const dupes = await prisma.email.findMany({
        where: {
          direction: 'OUTBOUND',
          toEmail: email.toEmail,
          subject: email.subject,
          id: { not: email.id },
        },
        select: { id: true, bodyFull: true, messageId: true, createdAt: true },
        take: 5,
      });
      if (dupes.length) {
        console.log(`[emails/:id] DUPLICATES found for ${email.toEmail} "${email.subject}":`);
        for (const d of dupes) {
          console.log(`  id=${d.id} createdAt=${d.createdAt.toISOString()} bodyLen=${(d.bodyFull||'').length} msgId=${d.messageId}`);
        }
      }
    }
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
    console.log(`[send-email] req.body keys: ${Object.keys(req.body || {}).join(',')} bodyLen: ${String(req.body && req.body.body || '').length} draft: ${req.body && req.body.draft}`);
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

      // Preview tlumaczenie PL — gdy draft jest w obcym jezyku, dorzucamy
      // tlumaczenie zeby user mogl zweryfikowac co bot napisal PRZED
      // wyslaniem. Tlumaczenie nie idzie do klienta — tylko do podgladu.
      // Haiku (najtanszy) za $0.001/draft.
      let previewTranslationPl = null;
      let previewSourceLang = null;
      try {
        const Anthropic = require('@anthropic-ai/sdk');
        if (process.env.ANTHROPIC_API_KEY && body && body.length > 20) {
          const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
          const r = await anthropic.messages.create({
            model: process.env.DRAFT_TRANSLATE_MODEL || 'claude-haiku-4-5-20251001',
            max_tokens: 600,
            messages: [{
              role: 'user',
              content: `Wykryj jezyk ponizszej tresci i przetlumacz na polski. Zachowaj formatowanie (linki, listy, lamania linii). Plain text bez markdown. Zwroc DOKLADNIE w formacie:\n\nLANG: <kod_iso2_jezyka_originalu>\n---\n<tlumaczenie_pl>\n\nJezeli oryginal JEST po polsku, zwroc:\nLANG: pl\n---\n(pomijam tlumaczenie)\n\nTRESC:\n${body}`,
            }],
          });
          const text = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
          const m = text.match(/^LANG:\s*([a-z]{2})\s*\n---\s*\n([\s\S]+)$/i);
          if (m) {
            previewSourceLang = m[1].toLowerCase();
            const translation = m[2].trim();
            if (previewSourceLang !== 'pl' && !/^\(pomijam/i.test(translation)) {
              previewTranslationPl = translation;
            }
          }
        }
      } catch (e) {
        console.error('[send-email draft] translation preview failed:', e.message);
      }

      return res.json({
        ok: true,
        draft: true,
        emailId: saved.id,
        preview: { from, to, subject, body, replyToThread: !!inReplyTo },
        previewSourceLang,
        previewTranslationPl, // pokazujesz user-owi POD oryginalem; NIE wysyla sie
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
  const reqChatId = req.body && req.body.chatId;
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

    let saved;
    try {
      saved = await sendMail({
        from: draft.fromEmail,
        to: draft.toEmail,
        subject: draft.subject || '',
        body: draft.bodyFull || '',
        inReplyTo: draft.inReplyTo || undefined,
        references: draft.references || undefined,
      });
    } catch (sendErr) {
      await notifyMailResult(prisma, {
        reqChatId, ok: false, to: draft.toEmail, from: draft.fromEmail,
        subject: draft.subject, error: sendErr.message,
      });
      throw sendErr;
    }

    await prisma.email.update({ where: { id: draft.id }, data: { direction: 'OUTBOUND' } });

    await notifyMailResult(prisma, {
      reqChatId, ok: true, to: draft.toEmail, from: draft.fromEmail,
      subject: draft.subject, messageId: saved && saved.messageId,
    });

    return res.json({
      ok: true, sent: true, to: draft.toEmail, subject: draft.subject,
      replyToThread: !!draft.inReplyTo, messageId: saved && saved.messageId,
      smtpConfirmed: !!(saved && saved.messageId),
    });
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

// ============ EXTRACT NIP/VAT FROM EMAILS ============
//
// Przeszukuje Email.bodyFull po regex VAT prefiksów UE i zwraca znalezione.
// Filtruje po fromEmail/fromDomain albo search po nadawcy/contractor name.
// Używane gdy agent ma wystawić FV WDT (potrzebuje Ust-IdNr) i nie widzi
// NIP w bodyPreview (300 znaków). EU_VAT_REGEX centralizowany w
// services/country-helper.js (commit B).
const { EU_VAT_REGEX } = require('../services/country-helper');

router.post('/emails/extract-nip', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { fromEmail, fromDomain, search, limit = 50 } = req.body || {};
  try {
    const where = { direction: 'INBOUND', bodyFull: { not: null } };
    if (fromEmail) where.fromEmail = { contains: fromEmail, mode: 'insensitive' };
    else if (fromDomain) where.fromEmail = { contains: '@' + fromDomain, mode: 'insensitive' };
    else if (search) {
      where.OR = [
        { fromEmail: { contains: search, mode: 'insensitive' } },
        { fromName: { contains: search, mode: 'insensitive' } },
        { subject: { contains: search, mode: 'insensitive' } },
        { bodyFull: { contains: search, mode: 'insensitive' } },
      ];
    } else {
      return res.status(400).json({ ok: false, error: 'pass fromEmail, fromDomain or search' });
    }
    const emails = await prisma.email.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit) || 50, 200),
      select: { id: true, fromEmail: true, fromName: true, subject: true, bodyFull: true, createdAt: true },
    });
    const found = new Map();
    for (const em of emails) {
      const matches = (em.bodyFull || '').match(EU_VAT_REGEX) || [];
      for (const m of matches) {
        const nip = m.toUpperCase();
        if (!found.has(nip)) {
          found.set(nip, {
            nip,
            firstSeenIn: {
              emailId: em.id,
              from: em.fromEmail,
              fromName: em.fromName,
              subject: em.subject,
              ts: em.createdAt,
              bodyFull: em.bodyFull,  // pełna treść — agent wyłuskuje adres/telefon/nazwę
            },
            occurrences: 1,
          });
        } else {
          found.get(nip).occurrences++;
        }
      }
    }
    // Plus zwracamy próbkę bodyFull pierwszego pasującego maila nawet jeśli
    // NIP nie znaleziony — żeby agent mógł zobaczyć kto pisał i co.
    const sampleBody = emails.length && found.size === 0
      ? { emailId: emails[0].id, from: emails[0].fromEmail, fromName: emails[0].fromName, subject: emails[0].subject, bodyFull: emails[0].bodyFull }
      : null;
    const list = [...found.values()].sort((a, b) => b.occurrences - a.occurrences);
    res.json({ ok: true, emailsScanned: emails.length, vatsFound: list.length, vats: list, sampleBodyWhenNoVat: sampleBody });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============ INBOX RESCAN (force fetch by date, ignore lastUid) ============
//
// Wymusza pełen fetch maili z konkretnej skrzynki od daty (default 3 dni).
// Ignoruje lastUid (przydatne gdy ktoś przeniósł mail / UIDValidity reset).
// Dedup po messageId — bez duplikatów. Synchroniczne — zwraca po zakończeniu.
router.post('/inbox-rescan', async (req, res) => {
  const { inbox, daysBack = 3 } = req.body || {};
  if (!inbox) return res.status(400).json({ ok: false, error: 'inbox (string) required' });
  try {
    const { rescanInboxSince } = require('../inbox-poller');
    const result = await rescanInboxSince(inbox, daysBack);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============ COVERAGE DIAGNOSTIC ============
//
// Per skrzynka porównuje liczbę maili na IMAP (INBOX, ostatnie N dni) z liczbą
// w naszej bazie. Duży gap = potencjalne pominięcia. Filter wynik gdzie gap > 0
// żeby zobaczyć tylko problematyczne skrzynki.
router.get('/inbox-coverage', async (req, res) => {
  try {
    const daysBack = parseInt(req.query.daysBack || '30', 10);
    const { getCoverageStats } = require('../inbox-poller');
    const stats = await getCoverageStats(daysBack);
    res.json({ ok: true, daysBack, stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============ INBOX STATS (aggregated counts per inbox) ============
//
// Sidebar w /emails wymaga listy wszystkich skrzynek z licznikami unread.
// Wczesniej liczyl to z `/api/emails?limit=500&direction=INBOUND` ale backend
// cap'uje limit do 100, a po rescan (3000+ rows z createdAt=NOW()) top 100
// dominuje ostatnio-inserted inbox i reszta znika z sidebar.
//
// Tutaj GROUP BY zwraca caly stan. direction=INBOUND filter, total + unread.
router.get('/inbox-stats', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const rows = await prisma.email.groupBy({
      by: ['inbox'],
      where: { direction: 'INBOUND' },
      _count: { _all: true },
    });
    const unreadRows = await prisma.email.groupBy({
      by: ['inbox'],
      where: { direction: 'INBOUND', isRead: false },
      _count: { _all: true },
    });
    const unreadMap = Object.fromEntries(unreadRows.map(r => [r.inbox, r._count._all]));
    // Important unread: CLIENT_REPLY or COURIER_ALERT, unread — te same co idą na Telegram.
    const importantRows = await prisma.email.groupBy({
      by: ['inbox'],
      where: { direction: 'INBOUND', isRead: false, tags: { hasSome: ['CLIENT_REPLY', 'COURIER_ALERT'] } },
      _count: { _all: true },
    });
    const importantMap = Object.fromEntries(importantRows.map(r => [r.inbox, r._count._all]));
    const out = rows
      .map(r => ({ inbox: r.inbox, total: r._count._all, unread: unreadMap[r.inbox] || 0, importantUnread: importantMap[r.inbox] || 0 }))
      .sort((a, b) => (b.importantUnread - a.importantUnread) || (b.unread - a.unread) || a.inbox.localeCompare(b.inbox));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ FORCE POLL TRIGGER ============
//
// Wymusza inbox-pollera do natychmiastowego sprawdzenia wszystkich skrzynek
// (lub konkretnej z body.inbox). Ten sam cycle co normalny timer (co 5 min).
// Używane przed analiza_leads żeby świeże maile od dziś rana były dostępne.
router.post('/inbox-poll-now', async (req, res) => {
  try {
    const { pollAll } = require('../inbox-poller');
    console.log('[inbox-poll-now] forced poll triggered via API');
    // Nie czekamy na pełen cycle — ale zawracamy gdy już startuje, żeby
    // klient nie hangował. Cycle leci w tle.
    pollAll().catch(e => console.error('[inbox-poll-now] error:', e.message));
    res.json({ ok: true, started: true, note: 'Polling started in background. New mails will appear in DB within ~30 sec.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============ LEADS ANALYZER ============
//
// On-demand: pobiera ostatnie maile (default 7 dni), grupuje po external
// adresie (the other side, nie nasze), zwraca timeline + AI klasyfikację
// per wątek (czeka na nasza/ich odpowiedź, świeży/martwy, sugerowana akcja).
// Używane gdy user pisze "przeanalizuj maile", "kto czeka na odpowiedź",
// "status leadów", "zaległe wątki".
router.post('/leads/analyze', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { daysBack = 7, inbox, minThreadSize = 1, model } = req.body || {};

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });
  }

  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const where = { createdAt: { gte: since } };
  if (inbox) where.inbox = inbox;

  const emails = await prisma.email.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, direction: true, inbox: true, fromEmail: true, fromName: true,
      toEmail: true, subject: true, bodyPreview: true, createdAt: true,
      contractorId: true, contractor: { select: { name: true } },
    },
  });

  // Domeny które są NASZE — to nie są kontakty zewnętrzne, pomijamy w grupowaniu.
  const OUR_DOMAINS = ['surfstickbell.com', 'surfstickbell.fr'];
  const isOurs = (e) => !e || OUR_DOMAINS.some(d => e.toLowerCase().endsWith('@' + d));

  // Group by external email (contact who is NOT us). Per INBOUND: fromEmail.
  // Per OUTBOUND: toEmail. Skip noreply/automated.
  const groups = new Map();
  for (const em of emails) {
    let external;
    if (em.direction === 'INBOUND') external = em.fromEmail;
    else if (em.direction === 'OUTBOUND' || em.direction === 'DRAFT') external = em.toEmail;
    else continue;
    if (!external || isOurs(external)) continue;
    if (/noreply|no-reply|mailer-daemon|postmaster|notif/i.test(external)) continue;
    const key = external.toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, {
        contact: external,
        contactName: em.fromName || (em.contractor && em.contractor.name) || '',
        contractorId: em.contractorId,
        contractorName: em.contractor && em.contractor.name,
        timeline: [],
      });
    }
    const g = groups.get(key);
    if (!g.contactName && em.fromName) g.contactName = em.fromName;
    if (!g.contractorName && em.contractor && em.contractor.name) g.contractorName = em.contractor.name;
    g.timeline.push({
      id: em.id,
      direction: em.direction,
      ts: em.createdAt,
      subject: em.subject,
      preview: (em.bodyPreview || '').slice(0, 200),
    });
  }
  const filtered = [...groups.values()].filter(g => g.timeline.length >= minThreadSize);
  if (!filtered.length) {
    return res.json({ ok: true, daysBack, threadsFound: 0, message: 'Brak wątków w tym okresie.' });
  }

  // Build prompt for Claude with grouped threads.
  const now = new Date();
  const threadBlocks = filtered.map((g, i) => {
    const lastMsg = g.timeline[g.timeline.length - 1];
    const lastDir = lastMsg.direction === 'INBOUND' ? 'ON/ONA' : 'MY';
    const lastTs = new Date(lastMsg.ts);
    const daysSinceLast = Math.floor((now - lastTs) / (24 * 60 * 60 * 1000));
    const tline = g.timeline.map(t => {
      const dt = new Date(t.ts);
      const tag = t.direction === 'INBOUND' ? '←' : '→';
      const subj = (t.subject || '(brak tematu)').slice(0, 80);
      const prev = (t.preview || '').replace(/\s+/g, ' ').slice(0, 150);
      return `  ${tag} [${dt.toISOString().slice(0, 10)}] ${subj} | ${prev}`;
    }).join('\n');
    return `${i + 1}. KONTAKT: ${g.contact}${g.contactName ? ' (' + g.contactName + ')' : ''}${g.contractorName ? ' [kontrahent: ' + g.contractorName + ']' : ''}
   Wymian: ${g.timeline.length} | Ostatnia wiadomość: ${lastDir} ${daysSinceLast === 0 ? 'dziś' : daysSinceLast + ' dni temu'}
${tline}`;
  }).join('\n\n');

  const prompt =
    `Przeanalizuj WSZYSTKIE wątki mailowe poniżej (z ostatnich ${daysBack} dni). Bieżąca data: ${now.toISOString().slice(0, 10)}.\n\n` +
    `OBOWIĄZKI:\n` +
    `- KAŻDY wątek z listy MUSI być w tabeli wynikowej. Liczba wierszy w tabeli = liczba wątków poniżej. NIE filtruj, NIE pomijaj.\n` +
    `- Sprawdź OSTATNIĄ wiadomość każdego wątku — symbol "←" = oni do nas, "→" = my do nich.\n\n` +
    `Reguły klasyfikacji (bezwzględne):\n` +
    `- Ostatnia wiadomość "←" (oni) + brak naszej odpowiedzi PO niej → CZEKA_NA_NASZĄ_ODPOWIEDŹ. Priorytet WYSOKI gdy ≥2 dni temu, ŚREDNI gdy mniej.\n` +
    `- Ostatnia wiadomość "→" (my) + brak ich odpowiedzi PO niej → CZEKA_NA_ICH_ODPOWIEDŹ. Priorytet ŚREDNI gdy 5-13 dni, NISKI gdy <5, MARTWY gdy ≥14 dni.\n` +
    `- Wymiana w obie strony w ostatnich 3 dniach + ostatnia "→" → AKTYWNY_DIALOG (NISKI, "czekaj na ich reakcję").\n` +
    `- Jeśli ostatnia wiadomość "←" zawiera potwierdzenie/podziękowanie typu "dziękuję, zamówię" / "ok, czekam na fv" → ZAŁATWIONE (NISKI).\n` +
    `- AUTO/SYSTEM (GlobKurier/InPost/no-reply) → klasa AUTO, priorytet NISKI, sugestia "tylko do informacji".\n\n` +
    `WĄTKI (każdy z numerem; w sumie ${filtered.length} wątków):\n${threadBlocks}\n\n` +
    `Format odpowiedzi:\n` +
    `| # | Kontakt | Klasyfikacja | Priorytet | Sugerowana akcja |\n` +
    `|---|---------|--------------|-----------|------------------|\n` +
    `| 1 | ... | ... | ... | ... |\n\n` +
    `WYMÓG: w tabeli ${filtered.length} wierszy (po jednym per wątek), kolejność po priorytecie WYSOKI→ŚREDNI→NISKI→MARTWY→AUTO. Po tabeli krótkie podsumowanie (ile WYSOKICH/ŚREDNICH/MARTWYCH/AUTO). Bez własnych komentarzy poza tym.`;

  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const llmModel = model || process.env.ACCOUNTING_AGENT_MODEL || 'claude-sonnet-4-5-20250929';
  const llm = await anthropic.messages.create({
    model: llmModel,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });
  const textBlock = llm.content.find(b => b.type === 'text');
  const text = textBlock ? textBlock.text : '';

  res.json({
    ok: true,
    daysBack,
    threadsFound: filtered.length,
    threadsExpected: filtered.length,
    contacts: filtered.map(g => g.contact),
    emailsScanned: emails.length,
    analysis: text,
    tokensUsed: llm.usage,
  });
});

// Backfill: take the last N OUTBOUND mails from the DB and APPEND them to
// the IMAP Sent folder so they show up in Thunderbird / webmail. Only the
// body text + threading headers are reconstructed — original attachments
// (e.g. invoice PDFs) are not in our DB for OUTBOUND, so the appended
// copy is "stub" by design. Idempotent: skips rows whose extras already
// carry { appendedToSentAt }.
// Body: { limit?: number (default 10), force?: bool }
router.post('/emails/backfill-sent', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const limit = Number((req.body && req.body.limit)) || 10;
  const force = !!(req.body && req.body.force);
  try {
    const recent = await prisma.email.findMany({
      where: { direction: 'OUTBOUND' },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const streamTransport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const results = [];

    for (const m of recent) {
      const already = m.extras && m.extras.appendedToSentAt;
      if (already && !force) {
        results.push({ id: m.id, to: m.toEmail, status: 'already_appended', at: already });
        continue;
      }
      const account = findAccount(m.fromEmail);
      if (!account) { results.push({ id: m.id, to: m.toEmail, status: 'no_account' }); continue; }

      const mailOptions = {
        from: m.fromEmail,
        to: m.toEmail,
        subject: m.subject || '',
        text: m.bodyFull || m.bodyPreview || '',
        date: m.createdAt,
        ...(m.messageId ? { messageId: m.messageId } : {}),
        ...(m.inReplyTo ? { inReplyTo: m.inReplyTo, references: m.references || m.inReplyTo } : {}),
      };

      let rawMessage;
      try {
        const generated = await streamTransport.sendMail(mailOptions);
        rawMessage = generated.message;
      } catch (e) {
        results.push({ id: m.id, to: m.toEmail, status: 'compose_failed', error: e.message });
        continue;
      }

      const appendResult = await appendToSent(account, rawMessage);
      if (appendResult.ok) {
        await prisma.email.update({
          where: { id: m.id },
          data: { extras: { ...(m.extras || {}), appendedToSentAt: new Date().toISOString(), appendedFolder: appendResult.folder } },
        });
        results.push({ id: m.id, to: m.toEmail, status: 'appended', folder: appendResult.folder });
      } else {
        results.push({ id: m.id, to: m.toEmail, status: 'append_failed', error: appendResult.reason });
      }
    }

    res.json({ ok: true, processed: results.length, results });
  } catch (e) {
    console.error('[backfill-sent] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Diagnostic: connects to the IMAP server with the same credentials we
// use for sending and lists every folder with message counts. Read-only
// (just LIST + STATUS). Useful when the user can't reach webmail and we
// need to know whether messages are actually on the server or just
// missing from Thunderbird's local cache.
// Body: { inbox?: string }  // empty = run for every IMAP_ACCOUNTS entry
router.post('/emails/imap-diag', async (req, res) => {
  const Imap = require('imap');
  const accounts = getAccounts();
  const target = (req.body && req.body.inbox) || null;
  const picked = target ? accounts.filter(a => a.inbox === target) : accounts;
  if (!picked.length) return res.status(400).json({ error: `no account for inbox=${target}` });

  function connect(account) {
    return new Promise((resolve, reject) => {
      const imap = new Imap({
        user: account.user, password: account.pass,
        host: account.host, port: account.port,
        tls: true, tlsOptions: { rejectUnauthorized: false },
        connTimeout: 20000, authTimeout: 15000,
      });
      imap.once('ready', () => resolve(imap));
      imap.once('error', reject);
      imap.connect();
    });
  }
  function listBoxes(imap) {
    return new Promise((resolve, reject) => {
      imap.getBoxes((err, boxes) => err ? reject(err) : resolve(boxes));
    });
  }
  function statusBox(imap, name) {
    return new Promise((resolve, reject) => {
      imap.openBox(name, true, (err, box) => {
        if (err) return resolve({ error: err.message });
        resolve({
          total: box.messages.total,
          new: box.messages.new,
          unseen: box.messages.unseen,
          uidvalidity: box.uidvalidity,
          uidnext: box.uidnext,
        });
      });
    });
  }
  function flatten(boxes, prefix = '') {
    const out = [];
    for (const [name, box] of Object.entries(boxes || {})) {
      const fullName = prefix ? prefix + box.delimiter + name : name;
      out.push({ name: fullName, attribs: box.attribs || [] });
      if (box.children) out.push(...flatten(box.children, fullName));
    }
    return out;
  }

  const report = [];
  for (const account of picked) {
    const acc = { inbox: account.inbox, user: account.user, host: account.host, folders: [] };
    let imap;
    try {
      imap = await connect(account);
      const boxes = await listBoxes(imap);
      const flat = flatten(boxes);
      for (const f of flat) {
        const st = await statusBox(imap, f.name);
        acc.folders.push({ name: f.name, attribs: f.attribs, ...st });
      }
      try { imap.end(); } catch (_) {}
    } catch (e) {
      acc.error = e.message;
      try { if (imap) imap.end(); } catch (_) {}
    }
    report.push(acc);
  }
  res.json({ ok: true, accounts: report });
});

// Worker: process a single tracking-email request. Pulled out of the
// route handler so the batch endpoint can call it in a loop without
// going through Express. Returns the same shape the single-call route
// returns, plus the input search string for the batch summary.
async function processTrackingSearch(prisma, { search, contractorEmail, from: fromOverride, reqChatId }) {
  if (!search || typeof search !== 'string') return { ok: false, error: 'search required', search };
  try {
    // 1) Resolve the contractor — by email if hint looks like one, else
    //    by name fuzzy. We use this both to look up local Transaction
    //    history (the strongest signal — we know the exact GK number)
    //    and to fall back to GK search by name.
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(search.trim());
    let resolvedContractor = null;
    if (isEmail) {
      resolvedContractor = await prisma.contractor.findFirst({
        where: { email: { equals: search.trim(), mode: 'insensitive' } },
        select: { id: true, name: true, email: true, country: true },
      });
    } else {
      resolvedContractor = await prisma.contractor.findFirst({
        where: { name: { contains: search.split(/\s+/)[0], mode: 'insensitive' } },
        select: { id: true, name: true, email: true, country: true },
      });
    }

    // 1a) Prefer the local Transaction table — we record shipmentNumber
    //     whenever createOrder succeeds. Pulling by contractorId is far
    //     more reliable than fuzzy GK search.
    let txShipmentNumber = null;
    if (resolvedContractor) {
      const tx = await prisma.transaction.findFirst({
        where: { contractorId: resolvedContractor.id, shipmentNumber: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { shipmentNumber: true, trackingNumber: true },
      });
      if (tx && tx.shipmentNumber) txShipmentNumber = tx.shipmentNumber;
    }

    // 2) Build search probes — strongest signals first.
    const searches = [];
    if (txShipmentNumber) searches.push(txShipmentNumber); // exact match in GK
    if (resolvedContractor && resolvedContractor.name) {
      searches.push(resolvedContractor.name);
      const firstWord = resolvedContractor.name.split(/\s+/)[0];
      if (firstWord && firstWord !== resolvedContractor.name) searches.push(firstWord);
    }
    if (isEmail) {
      const localPart = search.split('@')[0];
      const domainRoot = search.split('@')[1].split('.')[0];
      searches.push(localPart.replace(/[._-]+/g, ' '));
      searches.push(domainRoot.replace(/[._-]+/g, ' '));
    } else {
      searches.push(search);
    }

    let items = [];
    let usedSearch = null;
    // GK's /v1/orders sometimes wraps the page as [{offset,total,limit,results:[...]}]
    // — that wrapper-array shape was the cause of an early dropped-100-records
    // bug. Unwrap it consistently with glob-orders.js extractOrdersResults.
    function unwrapGkOrders(data) {
      if (!data) return [];
      if (Array.isArray(data) && data.length === 1 && data[0] && Array.isArray(data[0].results)) {
        return data[0].results;
      }
      if (Array.isArray(data)) return data;
      return data.results || data.items || data.data || [];
    }
    for (const q of [...new Set(searches.filter(Boolean))]) {
      const gkRes = await getOrders({ search: q, limit: 20 });
      const got = unwrapGkOrders(gkRes);
      if (Array.isArray(got) && got.length > 0) {
        items = got;
        usedSearch = q;
        break;
      }
    }
    if (items.length === 0) {
      return {
        ok: false,
        error: 'no shipments matched',
        search,
        attempted: searches,
        resolvedContractor: resolvedContractor ? { id: resolvedContractor.id, name: resolvedContractor.name } : null,
        localTransactionShipmentNumber: txShipmentNumber,
        suggestion: txShipmentNumber
          ? `tracker has shipmentNumber=${txShipmentNumber} but GK doesn't know it — possibly canceled, or recorded without actually being placed`
          : (isEmail && !resolvedContractor
              ? 'email not in Contractor table — add the customer first or pass their name'
              : 'no shipment for this customer in our tracker or GK history'),
      };
    }
    // When the user passed a specific tracking number (long digit string)
    // or GK number, lock to the shipment that has THAT exact number — no
    // "newest" fallback. Otherwise bot can pick a different parcel for
    // the same contractor (case: Benjamin has two shipments, user asked
    // about DHL 30983589308, bot sent DPD 13109408486451).
    const looksLikeTracking = /^(?:GK)?\d{9,}$/i.test(search.trim());
    let shipment;
    if (looksLikeTracking) {
      const wanted = search.trim();
      shipment = items.find(o =>
        String(o.trackingNumber || '').trim() === wanted ||
        String(o.tracking || '').trim() === wanted ||
        String(o.orderNumber || '').trim() === wanted ||
        String(o.number || '').trim() === wanted ||
        String(o.hash || '').trim() === wanted
      );
      if (!shipment) {
        return {
          ok: false,
          error: `tracking-send blocked: search "${wanted}" looks like a specific tracking number but GK returned ${items.length} shipment(s) with different numbers — refusing to substitute a wrong parcel`,
          search,
          attempted: searches,
          gotShipmentNumbers: items.slice(0, 5).map(o => ({
            orderNumber: o.orderNumber || o.number,
            tracking: o.trackingNumber || o.tracking,
            recvName: (o.receiver || o.receiverAddress || {}).name,
          })),
        };
      }
    } else {
      items.sort((a, b) => new Date(b.createdAt || b.orderDate || 0) - new Date(a.createdAt || a.orderDate || 0));
      shipment = items[0];
    }

    const recv = shipment.receiverAddress || shipment.receiver || shipment.recipient || {};
    const send = shipment.senderAddress || shipment.sender || {};
    const carrierName = shipment.productName || shipment.carrier || (shipment.product && shipment.product.name) || '';

    // GK /v1/orders sometimes returns shipments without trackingNumber populated
    // (the carrier number lives on a separate /v1/order/tracking?orderNumber=...
    // endpoint). Fall back to that when the list view doesn't have it.
    let trackingNumber = shipment.trackingNumber || shipment.tracking;
    if (!trackingNumber) {
      const orderNumber = shipment.number || shipment.orderNumber;
      if (orderNumber) {
        try {
          const { getOrderTracking } = require('../glob-client');
          const t = await getOrderTracking(orderNumber);
          const candidate = t && (t.trackingNumber || t.tracking
            || (t.parcels && t.parcels[0] && t.parcels[0].trackingNumber)
            || (Array.isArray(t) && t[0] && t[0].trackingNumber));
          if (candidate && String(candidate).trim()) {
            trackingNumber = String(candidate).trim();
            console.log(`[send-tracking-email] fetched tracking for ${orderNumber}: ${trackingNumber}`);
          }
        } catch (e) {
          console.error('[send-tracking-email] getOrderTracking lookup failed:', e.message);
        }
      }
    }
    const trackingUrl = buildTrackingUrl(carrierName, trackingNumber);

    // 3) Resolve recipient email — explicit override > already-resolved
    //    contractor > GK receiver email > local Contractor by name fuzzy.
    let toEmail = contractorEmail || null;
    if (!toEmail && resolvedContractor && resolvedContractor.email) toEmail = resolvedContractor.email;
    if (!toEmail && recv.email) toEmail = recv.email;
    if (!toEmail && recv.name) {
      const c = await prisma.contractor.findFirst({
        where: { name: { contains: recv.name.split(' ')[0], mode: 'insensitive' } },
        select: { email: true, country: true },
      });
      if (c && c.email) toEmail = c.email;
    }
    if (!toEmail) {
      return {
        ok: false,
        error: 'recipient email not found',
        search,
        shipment: { trackingNumber, name: recv.name, city: recv.city, country: recv.country },
        suggestion: 'pass contractorEmail in body, or set Contractor.email for this customer',
      };
    }

    // 3) Pre-send validation: status sane + tracking is a real carrier
    //    number, not GK internal. Saves us from sending broken links.
    const status = shipment.status || shipment.statusName || '';
    const expectedName = (resolvedContractor && resolvedContractor.name) || null;
    const v = validateShipmentReady({ trackingNumber, status, recvName: recv.name, expectedName });
    if (!v.ok) {
      return {
        ok: false,
        error: `tracking-send blocked: ${v.reason}`,
        search,
        shipment: { trackingNumber, name: recv.name, city: recv.city, country: recv.country, status },
        resolvedContractor: resolvedContractor ? { id: resolvedContractor.id, name: resolvedContractor.name } : null,
      };
    }

    // 4) Send via the shared tracking-notify helper — same template the
    //    automatic post-createOrder hook uses, so the brand voice is
    //    consistent whether it's auto or user-triggered.
    const country = (resolvedContractor && resolvedContractor.country) || recv.country || '';
    const r = await sendTrackingNotification({
      toEmail,
      country,
      trackingNumber,
      carrier: carrierName,
      from: fromOverride,
      prisma,
      reqChatId,
    });
    if (!r.ok) return { ok: false, error: r.error, search };

    return {
      ok: true,
      sent: r.sent,
      search,
      shipment: { trackingNumber, carrier: carrierName, trackingUrl, city: recv.city, country: recv.country, name: recv.name },
      matchedCount: items.length,
      usedSearch,
      resolvedContractor: resolvedContractor ? { id: resolvedContractor.id, name: resolvedContractor.name } : null,
      localTransactionShipmentNumber: txShipmentNumber,
    };
  } catch (e) {
    console.error('[send-tracking-email] error:', e.message);
    return { ok: false, error: e.message, search };
  }
}

// End-to-end single-shot — find shipment by hint (contractor / city / GK#
// / email), resolve customer email, send tracking link in their language.
// Body: { search?, contractorEmail?, from?, chatId? }
router.post('/send-tracking-email', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const result = await processTrackingSearch(prisma, {
    search: (req.body || {}).search,
    contractorEmail: (req.body || {}).contractorEmail,
    from: (req.body || {}).from,
    reqChatId: (req.body || {}).chatId,
  });
  res.status(result.ok ? 200 : 200).json(result);
});

// Batch version: take a list of search hints (mixed GK numbers / names /
// emails) and process them sequentially. One HTTP call from the master
// agent instead of N calls in a loop — eliminates the per-step "Bad
// request" path we kept hitting in the Master n8n flow. Returns a
// per-input result + roll-up counts.
// Body: { searches: string[], from?: string, chatId?: string,
//         stopOnError?: bool (default false) }
router.post('/send-tracking-emails-batch', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const body = req.body || {};
  const list = Array.isArray(body.searches) ? body.searches.filter(s => typeof s === 'string' && s.trim()) : [];
  if (!list.length) return res.status(400).json({ error: 'searches[] required (non-empty)' });
  const stopOnError = body.stopOnError === true;
  const results = [];
  const counts = { ok: 0, fail: 0 };
  for (const search of list) {
    const r = await processTrackingSearch(prisma, {
      search: search.trim(),
      from: body.from,
      reqChatId: body.chatId,
    });
    results.push(r);
    if (r.ok) counts.ok++; else counts.fail++;
    if (!r.ok && stopOnError) break;
  }
  res.json({ ok: true, total: list.length, processed: results.length, counts, results });
});

// POST /api/emails/:id/translate-to-pl
// Lazy tlumaczenie pelnego body maila na polski. Cache wyniku w
// extras.translatedBodyPl + extras.translatedAt. Body params:
//   { force?: boolean } — wymus re-translate (ignoruje cache).
router.post('/emails/:id/translate-to-pl', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { force = false } = req.body || {};
    const email = await prisma.email.findUnique({
      where: { id: req.params.id },
      select: { id: true, bodyFull: true, bodyPreview: true, subject: true, extras: true, tags: true },
    });
    if (!email) return res.status(404).json({ error: 'email not found' });

    const cached = email.extras && email.extras.translatedBodyPl;
    if (cached && !force) {
      return res.json({
        ok: true,
        translatedBody: cached,
        translatedSubject: (email.extras && email.extras.translatedSubjectPl) || null,
        cached: true,
        sourceLang: (email.extras && email.extras.translatedSourceLang) || (email.extras && email.extras.language) || null,
      });
    }

    const text = email.bodyFull || email.bodyPreview || '';
    if (!text.trim()) {
      return res.json({ ok: true, translatedBody: '', translatedSubject: null, cached: false, sourceLang: null });
    }

    // Wykryty jezyk z klasyfikacji w pollerze (zapisany w extras.language albo
    // jako tag 'lang:XX' — sprawdzamy oba)
    let sourceLang = (email.extras && email.extras.language) || null;
    if (!sourceLang && Array.isArray(email.tags)) {
      const langTag = email.tags.find(t => typeof t === 'string' && /^[a-z]{2}$/i.test(t) && t.length === 2);
      if (langTag) sourceLang = langTag.toLowerCase();
    }

    const [translatedBody, translatedSubject] = await Promise.all([
      translateToPl(text, sourceLang),
      email.subject ? translateToPl(email.subject, sourceLang) : Promise.resolve(null),
    ]);

    await prisma.email.update({
      where: { id: email.id },
      data: {
        extras: {
          ...(email.extras || {}),
          translatedBodyPl: translatedBody,
          translatedSubjectPl: translatedSubject,
          translatedSourceLang: sourceLang,
          translatedAt: new Date().toISOString(),
        },
      },
    });

    res.json({ ok: true, translatedBody, translatedSubject, cached: false, sourceLang });
  } catch (e) {
    console.error('[translate-to-pl] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/emails/translate
// Generic translate dla composera (PL -> jezyk odbiorcy). Auto-detect target
// jak nie podany: contractor.country -> jezyk, lub poprzednie maile w watku
// (przez replyToEmailId). Body:
//   { text, sourceLang?='pl', targetLang?, contractorId?, replyToEmailId? }
router.post('/emails/translate', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { text, sourceLang = 'pl', targetLang, contractorId, replyToEmailId } = req.body || {};
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: 'text required' });
    }

    let effectiveTarget = targetLang;
    let autoDetected = false;

    // Auto-detect via contractor.country
    if (!effectiveTarget && contractorId) {
      const c = await prisma.contractor.findUnique({
        where: { id: contractorId },
        select: { country: true },
      });
      if (c && c.country) {
        const lang = countryToLang(c.country);
        if (lang) { effectiveTarget = lang; autoDetected = true; }
      }
    }

    // Auto-detect via thread (poprzedni mail)
    if (!effectiveTarget && replyToEmailId) {
      const e = await prisma.email.findUnique({
        where: { id: replyToEmailId },
        select: { tags: true, extras: true },
      });
      if (e) {
        let lang = (e.extras && e.extras.language) || null;
        if (!lang && Array.isArray(e.tags)) {
          const langTag = e.tags.find(t => typeof t === 'string' && /^[a-z]{2}$/i.test(t) && t.length === 2);
          if (langTag) lang = langTag.toLowerCase();
        }
        if (lang) { effectiveTarget = lang; autoDetected = true; }
      }
    }

    if (!effectiveTarget) effectiveTarget = 'en'; // ostateczny fallback

    if (effectiveTarget === sourceLang) {
      return res.json({ ok: true, translatedText: text, sourceLang, targetLang: effectiveTarget, autoDetected, noop: true });
    }

    const translatedText = await translateFromPl(text, effectiveTarget, sourceLang);
    res.json({ ok: true, translatedText, sourceLang, targetLang: effectiveTarget, autoDetected });
  } catch (e) {
    console.error('[emails/translate] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/emails/cleanup-empty-outbound-dupes
// Usun OUTBOUND maile ktore maja pusty bodyFull/bodyPreview. Tryby:
//   - dryRun: pokaz co usuneloby
//   - allowOrphans=false (default): usuwa TYLKO te ktore maja sibling (ten
//     sam toEmail+subject) z NIE-pustym body. Bezpieczne — nie kasujemy
//     unikalnych emaili.
//   - allowOrphans=true: usuwa TEZ orphany (empty bez sibling) starsze niz
//     orphansMinAgeDays (default 1 dzien) — uzywane gdy sa stare puste rows
//     zostawione przez sknocony processSentItems przed wdrozeniem dedup
//     fixu. Body zostalo utracone w mailparser, nie da sie odzyskac z bazy.
//     Jak chcesz ratowac body — uzyj POST /api/emails/sent-rescan zeby
//     pobrac raw IMAP Sent i uzupelnic body, dopiero POTEM cleanup.
router.post('/emails/cleanup-empty-outbound-dupes', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { dryRun = false, allowOrphans = false, orphansMinAgeDays = 1 } = req.body || {};

    const candidates = await prisma.email.findMany({
      where: {
        direction: 'OUTBOUND',
        OR: [
          { bodyFull: null },
          { bodyFull: '' },
        ],
        subject: { not: null },
        toEmail: { not: '' },
      },
      select: { id: true, subject: true, toEmail: true, fromEmail: true, createdAt: true, messageId: true },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    });

    const toDelete = [];
    const orphans = [];
    for (const cand of candidates) {
      const sibling = await prisma.email.findFirst({
        where: {
          direction: 'OUTBOUND',
          toEmail: cand.toEmail,
          subject: cand.subject,
          id: { not: cand.id },
          NOT: [
            { bodyFull: null },
            { bodyFull: '' },
          ],
        },
        select: { id: true, createdAt: true, bodyFull: true },
      });
      if (sibling) {
        toDelete.push({
          emptyId: cand.id,
          emptyCreatedAt: cand.createdAt,
          emptyMsgId: cand.messageId,
          siblingId: sibling.id,
          siblingCreatedAt: sibling.createdAt,
          siblingBodyLen: (sibling.bodyFull || '').length,
          subject: cand.subject,
          toEmail: cand.toEmail,
        });
      } else {
        orphans.push({
          emptyId: cand.id,
          emptyCreatedAt: cand.createdAt,
          emptyMsgId: cand.messageId,
          subject: cand.subject,
          toEmail: cand.toEmail,
        });
      }
    }

    // Filter orphans po minAgeDays
    let orphansToDelete = [];
    if (allowOrphans) {
      const cutoff = new Date(Date.now() - orphansMinAgeDays * 24 * 60 * 60 * 1000);
      orphansToDelete = orphans.filter(o => new Date(o.emptyCreatedAt) < cutoff);
    }

    if (dryRun) {
      return res.json({
        ok: true,
        dryRun: true,
        scanned: candidates.length,
        wouldDeleteWithSibling: toDelete.length,
        orphansFound: orphans.length,
        orphansToDelete: orphansToDelete.length,
        allowOrphans,
        orphansMinAgeDays,
        sampleSibling: toDelete.slice(0, 5),
        sampleOrphans: orphans.slice(0, 5),
      });
    }

    let deleted = 0;
    for (const item of [...toDelete, ...orphansToDelete]) {
      try {
        await prisma.email.delete({ where: { id: item.emptyId } });
        deleted++;
      } catch (e) {
        console.error('[cleanup-empty-outbound-dupes] delete failed:', item.emptyId, e.message);
      }
    }

    res.json({
      ok: true,
      scanned: candidates.length,
      deleted,
      deletedWithSibling: toDelete.length,
      deletedOrphans: orphansToDelete.length,
    });
  } catch (e) {
    console.error('[cleanup-empty-outbound-dupes] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/emails/sent-rescan
// Wymusza re-fetch IMAP Sent folder od daty N dni wstecz. Dla kazdego maila:
//   - jak istnieje w bazie po messageId (norm) lub fuzzy match — UPDATE body
//     jak puste, inaczej skip
//   - jak nie istnieje — CREATE OUTBOUND
//
// Body: { inbox: string (required), daysBack?: number (default 30) }
//
// Use case: skrzynka swiezo dodana (poller skipnal historie), albo cleanup
// po starych "(brak treści)" rows ktore byly utworzone z empty body przez
// sknocony mailparser w processSentItems przed dedup fixem.
router.post('/emails/sent-rescan', async (req, res) => {
  try {
    const { inbox, daysBack = 30 } = req.body || {};
    if (!inbox || typeof inbox !== 'string') {
      return res.status(400).json({ error: 'inbox (string) required' });
    }
    if (daysBack < 1 || daysBack > 3650) {
      return res.status(400).json({ error: 'daysBack must be 1..3650' });
    }
    const { rescanSentSince } = require('../inbox-poller');
    const result = await rescanSentSince(inbox, daysBack);
    if (!result.ok) {
      return res.status(500).json(result);
    }
    res.json(result);
  } catch (e) {
    console.error('[sent-rescan] error:', e.message);
    res.status(500).json(result);
  }
});

// POST /api/emails/draft-with-invoice
//
// Tworzy DRAFT maila z PDF faktury w attachments + tresc przetlumaczona
// na jezyk kontrahenta. Uzywane przez accounting-agent w flow'ie
// "wyslij FV X mailem" — user widzi pelen draft (Od / Do / Temat / PDF
// w zalaczniku / body w jezyku odbiorcy / tlumaczenie PL) PRZED
// wyslaniem. Wyslanie idzie przez POST /api/send-email/:id/confirm.
//
// Body: {
//   invoiceNumber?: string,  // "88" lub "88/2026" (backend normalizuje)
//   invoiceId?: string,      // UUID — pomija lookup po number
//   toEmail?: string,        // default: contractor.primaryEmail/email
//   customNote?: string,     // dodatkowa tresc do body (np. "zgodnie z rozmowa")
// }
//
// Response: {
//   ok, draftId, from, to, subject, body, bodyPl, lang, langName,
//   attachments: [{filename, sizeKB}]
// }
router.post('/emails/draft-with-invoice', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { invoiceNumber, invoiceId, toEmail, customNote } = req.body || {};
    if (!invoiceNumber && !invoiceId) {
      return res.status(400).json({ error: 'invoiceNumber or invoiceId required' });
    }

    // 1. Resolve FV. Akceptujemy UUID lub luzny numer ("88", "88/2026",
    //    "FV 88") — wzor z send-invoice-email zeby UX byl spojny.
    function normalizeInvoiceQuery(input) {
      if (!input) return null;
      const stripped = String(input).trim()
        .replace(/^(?:fv|faktura|faktur[aęoy])\s*\/?\s*/i, '')
        .replace(/^nr\s*/i, '')
        .trim();
      if (/^\d+\/\d{4}$/.test(stripped)) return stripped;
      if (/^\d+\/\d{2}$/.test(stripped)) {
        const [n, yy] = stripped.split('/');
        return n + '/20' + yy;
      }
      if (/^\d+$/.test(stripped)) return stripped + '/' + new Date().getFullYear();
      return stripped;
    }

    let invoice = null;
    if (invoiceId) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(invoiceId);
      if (isUuid) {
        invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      }
    }
    if (!invoice && invoiceNumber) {
      const normalized = normalizeInvoiceQuery(invoiceNumber);
      const queries = [normalized, invoiceNumber].filter((v, i, a) => v && a.indexOf(v) === i);
      for (const q of queries) {
        invoice = await prisma.invoice.findFirst({
          where: { number: { equals: q, mode: 'insensitive' } },
          orderBy: { createdAt: 'desc' },
        });
        if (invoice) break;
      }
    }
    if (!invoice) return res.status(404).json({ error: `Invoice not found: "${invoiceNumber || invoiceId}"` });

    // 2. Resolve recipient. toEmail explicit > contractor.primaryEmail > contractor.email.
    const contractor = invoice.contractorId
      ? await prisma.contractor.findUnique({ where: { id: invoice.contractorId } })
      : null;
    const looksLikeEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
    let to = looksLikeEmail(toEmail) ? toEmail.trim() : null;
    let toSource = to ? 'request' : null;
    if (!to && contractor) {
      if (contractor.primaryEmail && looksLikeEmail(contractor.primaryEmail)) {
        to = contractor.primaryEmail.trim();
        toSource = 'contractor.primaryEmail';
      } else if (contractor.email && looksLikeEmail(contractor.email)) {
        to = contractor.email.trim();
        toSource = 'contractor.email';
      }
    }
    if (!to) {
      return res.status(400).json({
        error: 'toEmail not provided and contractor has no email on record',
        hint: 'Pass toEmail explicit albo uzupelnij primaryEmail/email kontrahenta.',
      });
    }

    // 3. Pobierz PDF z iFirmy.
    let pdfBuffer;
    try {
      pdfBuffer = await fetchInvoicePdf(invoice.number, invoice.type, invoice.ifirmaId);
    } catch (e) {
      return res.status(502).json({ error: `iFirma PDF fetch failed: ${e.message}` });
    }
    const filename = `Faktura_${invoice.number.replace(/\//g, '_')}.pdf`;
    const sizeKB = Math.round(pdfBuffer.length / 102.4) / 10;

    // 4. Wybierz jezyk odbiorcy. Priorytet: kraj kontrahenta -> TLD adresu -> EN.
    function tldToLang(email) {
      const m = String(email || '').toLowerCase().match(/@[^@\s]+\.([a-z]{2,3})$/);
      const map = { fr: 'fr', es: 'es', de: 'de', it: 'it', pt: 'pt', pl: 'pl', nl: 'nl' };
      return m ? (map[m[1]] || null) : null;
    }
    let lang = countryToLang(contractor && contractor.country);
    let langSource = lang ? 'contractor.country' : null;
    if (!lang) {
      lang = tldToLang(to);
      if (lang) langSource = 'tld';
    }
    if (!lang) { lang = 'en'; langSource = 'fallback'; }
    const LANG_UI = (lang || 'en').toLowerCase();

    // 5. Body templates per jezyk. Trzymamy je krotkie — to draft, user moze
    //    edytowac przed wyslaniem (w przyszlosci /send-email/:id/edit).
    //    PL ekwiwalent osobno — wyslemy do klienta wersje w jego jezyku,
    //    a PL tlumaczenie pokazujemy user-owi do podgladu w drafcie.
    const contractorName = (contractor && contractor.name) || 'Customer';
    const note = (customNote && String(customNote).trim()) || '';
    const BODY_TEMPLATES = {
      pl: `Dzień dobry,\n\nW załączniku przesyłam fakturę ${invoice.number}.${note ? '\n\n' + note : ''}\n\nPozdrawiam,\nMichał Pałyska\nSurf Stick Bell`,
      en: `Dear ${contractorName},\n\nPlease find attached invoice ${invoice.number}.${note ? '\n\n' + note : ''}\n\nBest regards,\nMichał Pałyska\nSurf Stick Bell`,
      es: `Hola,\n\nAdjunto la factura ${invoice.number}.${note ? '\n\n' + note : ''}\n\nUn saludo,\nMichał Pałyska\nSurf Stick Bell`,
      de: `Guten Tag,\n\nIm Anhang die Rechnung ${invoice.number}.${note ? '\n\n' + note : ''}\n\nMit freundlichen Grüßen,\nMichał Pałyska\nSurf Stick Bell`,
      fr: `Bonjour,\n\nVeuillez trouver en pièce jointe la facture ${invoice.number}.${note ? '\n\n' + note : ''}\n\nCordialement,\nMichał Pałyska\nSurf Stick Bell`,
      it: `Buongiorno,\n\nIn allegato la fattura ${invoice.number}.${note ? '\n\n' + note : ''}\n\nCordiali saluti,\nMichał Pałyska\nSurf Stick Bell`,
      pt: `Olá,\n\nSegue em anexo a fatura ${invoice.number}.${note ? '\n\n' + note : ''}\n\nCumprimentos,\nMichał Pałyska\nSurf Stick Bell`,
      nl: `Geachte heer/mevrouw,\n\nIn de bijlage vindt u factuur ${invoice.number}.${note ? '\n\n' + note : ''}\n\nMet vriendelijke groet,\nMichał Pałyska\nSurf Stick Bell`,
    };
    const SUBJECT_TEMPLATES = {
      pl: `Faktura ${invoice.number} - Surf Stick Bell`,
      en: `Invoice ${invoice.number} - Surf Stick Bell`,
      es: `Factura ${invoice.number} - Surf Stick Bell`,
      de: `Rechnung ${invoice.number} - Surf Stick Bell`,
      fr: `Facture ${invoice.number} - Surf Stick Bell`,
      it: `Fattura ${invoice.number} - Surf Stick Bell`,
      pt: `Fatura ${invoice.number} - Surf Stick Bell`,
      nl: `Factuur ${invoice.number} - Surf Stick Bell`,
    };
    const body = BODY_TEMPLATES[LANG_UI] || BODY_TEMPLATES.en;
    const subject = SUBJECT_TEMPLATES[LANG_UI] || SUBJECT_TEMPLATES.en;

    // 6. Tlumaczenie do PL. Jak body juz po polsku — pomijamy.
    let bodyPl = null;
    if (LANG_UI !== 'pl') {
      try {
        bodyPl = await translateToPl(body, LANG_UI);
      } catch (e) {
        console.warn('[draft-with-invoice] translateToPl failed:', e.message);
        bodyPl = '(tlumaczenie PL niedostepne — ' + e.message + ')';
      }
    } else {
      bodyPl = body;
    }

    // 7. Default from. Bierzemy pierwszy account z mail-sender (info@...).
    const accounts = (typeof getAccounts === 'function') ? (getAccounts() || []) : [];
    const fromAccount = accounts.find(a => /^info@/i.test(a.user || '')) || accounts[0];
    const from = (fromAccount && fromAccount.user) || process.env.DEFAULT_FROM_EMAIL || 'info@surfstickbell.com';

    // 8. Stworz DRAFT email + zapisz attachment z PDF. EmailAttachment.data
    //    to Bytes — Prisma akceptuje Buffer.
    const draft = await prisma.email.create({
      data: {
        direction: 'DRAFT',
        inbox: extractInbox(from),
        fromEmail: from,
        toEmail: to,
        subject,
        bodyPreview: (body || '').slice(0, 300),
        bodyFull: body,
        contractorId: invoice.contractorId || null,
      },
    });
    await prisma.emailAttachment.create({
      data: {
        emailId: draft.id,
        filename,
        contentType: 'application/pdf',
        size: pdfBuffer.length,
        data: pdfBuffer,
      },
    });

    res.json({
      ok: true,
      draftId: draft.id,
      from,
      to,
      toSource,
      subject,
      body,
      bodyPl,
      lang: LANG_UI,
      langName: langName(LANG_UI),
      langSource,
      invoiceNumber: invoice.number,
      invoiceId: invoice.id,
      contractorName: contractor && contractor.name,
      attachments: [{ filename, sizeKB }],
    });
  } catch (e) {
    console.error('[draft-with-invoice] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
