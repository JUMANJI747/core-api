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

// MARKER_TRUNCATED_REST_OF_FILE
