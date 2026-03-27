'use strict';

const nodemailer = require('nodemailer');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const SMTP_HOST = process.env.SMTP_HOST || 'h22.seohost.pl';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465');

// ============ RATE LIMIT ============

let rateCount = 0;
let rateWindowStart = Date.now();
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkRateLimit() {
  const now = Date.now();
  if (now - rateWindowStart > RATE_WINDOW_MS) {
    rateCount = 0;
    rateWindowStart = now;
  }
  if (rateCount >= RATE_LIMIT) {
    throw new Error('Rate limit exceeded (max 20/h)');
  }
  rateCount++;
}

// ============ HELPERS ============

function getAccounts() {
  try {
    return JSON.parse(process.env.IMAP_ACCOUNTS || '[]');
  } catch (e) {
    return [];
  }
}

function findAccount(fromEmail) {
  const accounts = getAccounts();
  const from = fromEmail.toLowerCase();
  const account = accounts.find(a => {
    const user = (a.user || '').toLowerCase();
    return user === from || from.includes(user) || user.includes(from);
  }) || null;
  if (account) {
    console.log(`[mail-sender] found account for ${fromEmail}`);
  } else {
    const available = accounts.map(a => a.user).join(', ');
    console.log(`[mail-sender] no account found for ${fromEmail}, available: ${available}`);
  }
  return account;
}

function extractInbox(email) {
  return (email.split('@')[0] || email).toLowerCase();
}

// ============ SEND MAIL ============

async function sendMail({ from, to, subject, body, replyTo }) {
  console.log('[mail-sender] IMAP_ACCOUNTS parsed:', JSON.stringify(getAccounts().map(a => ({ inbox: a.inbox, user: a.user, hasPass: !!a.pass }))));
  console.log('[mail-sender] looking for FROM:', from);
  const account = findAccount(from);
  console.log('[mail-sender] findAccount result:', account ? { user: account.user, inbox: account.inbox } : null);
  if (!account) {
    const available = getAccounts().map(a => a.user).join(', ');
    throw new Error(`Unknown sender address, available: ${available}`);
  }

  checkRateLimit();

  console.log('[mail-sender] SMTP config:', { host: SMTP_HOST, port: SMTP_PORT, user: account.user, hasPass: !!account.pass, passLength: (account.pass || '').length });

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true, // SSL/TLS on 465
    auth: {
      user: account.user,
      pass: account.pass,
    },
  });

  await transporter.sendMail({
    from,
    to,
    subject,
    text: body,
    ...(replyTo ? { replyTo } : {}),
  });

  console.log(`[mail-sender] sent from ${from} to ${to} subject: ${subject}`);

  // Find contractor by toEmail
  let contractorId = null;
  const contractor = await prisma.contractor.findFirst({
    where: { email: { contains: to, mode: 'insensitive' } },
  });
  if (contractor) contractorId = contractor.id;

  const saved = await prisma.email.create({
    data: {
      direction: 'OUTBOUND',
      inbox: extractInbox(from),
      fromEmail: from,
      toEmail: to,
      subject: subject || null,
      bodyPreview: (body || '').slice(0, 300),
      bodyFull: (body || '').slice(0, 2000),
      contractorId,
    },
  });

  return saved;
}

module.exports = { sendMail, findAccount, extractInbox, getAccounts };
