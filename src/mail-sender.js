'use strict';

const nodemailer = require('nodemailer');
const crypto = require('crypto');
const prisma = require('./db');
const { appendToSent } = require('./imap-sent');

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
    console.log('[mail-sender] account keys:', Object.keys(account));
    console.log('[mail-sender] account has pass:', !!account.pass, 'passLength:', (account.pass || '').length);
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

async function sendMail({ from, to, cc, subject, body, html, replyTo, inReplyTo, references, attachments }) {
  // Diag: pokaz co dokladnie wchodzi do sendMail. Pomoglo zdiagnozowac bug
  // "wyslany mail pusty" — body byl pusty z frontu mimo ze user widzial tekst
  // w composer textarea. Body znika gdzies w przesylce frontend->backend.
  console.log(`[mail-sender] sendMail called: from=${from} to=${to} subjectLen=${(subject || '').length} bodyLen=${(body || '').length} bodyType=${typeof body} bodyPreview="${String(body || '').slice(0, 100)}"`);
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

  // Jeden wspolny Message-ID dla OBU transportow (raw->Sent i realny SMTP).
  // Bez tego nodemailer generowal inny ID dla kazdego wywolania => kopia w
  // folderze Sent miala inny ID niz zapisany w bazie => dedup pollera Sent
  // nie lapal jej i tworzyl PUSTY duplikat OUTBOUND. Wspolny ID = dedup dziala.
  const fixedMessageId = `<${crypto.randomUUID()}@${(String(from).split('@')[1] || 'mail.local').trim()}>`;

  const mailOptions = {
    from,
    to,
    ...(cc ? { cc } : {}),
    subject,
    messageId: fixedMessageId,
    ...(html ? { html } : {}),
    ...(body ? { text: body } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(inReplyTo ? { inReplyTo, references: references || inReplyTo } : {}),
    ...(attachments && attachments.length ? { attachments: attachments.map(a => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
      // Obrazki wklejone w tresc: cid + inline -> <img src="cid:..."> w HTML.
      ...(a.cid ? { cid: a.cid, contentDisposition: 'inline' } : {}),
    })) } : {}),
  };
  console.log(`[mail-sender] mailOptions: hasText=${!!mailOptions.text} hasHtml=${!!mailOptions.html} textLen=${(mailOptions.text || '').length}`);

  // Generate the raw RFC822 first so we can also APPEND it to the IMAP
  // Sent folder after SMTP delivery succeeds (Thunderbird / other IMAP
  // clients only see messages they find on the server — SMTP send alone
  // doesn't make them appear in Sent).
  let rawMessage = null;
  try {
    const streamTransport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const generated = await streamTransport.sendMail(mailOptions);
    rawMessage = generated.message; // Buffer
  } catch (e) {
    console.error('[mail-sender] raw generation failed, APPEND to Sent will be skipped:', e.message);
  }

  const result = await transporter.sendMail(mailOptions);
  const sentMessageId = result.messageId || fixedMessageId;
  // SMTP server accepted the message AND returned a Message-ID. Bez tego
  // nie mamy 100% pewności że trafił — zapisujemy jako FAILED i rzucamy
  // tak żeby caller mógł powiadomić użytkownika.
  if (!sentMessageId) {
    console.error(`[mail-sender] WARN: sendMail returned no messageId, treating as failure. Response:`, JSON.stringify(result).slice(0, 500));
    const failedEmail = await prisma.email.create({
      data: {
        direction: 'FAILED',
        inbox: extractInbox(from),
        fromEmail: from,
        toEmail: to,
        subject: subject || null,
        bodyPreview: (body || html || '').replace(/<[^>]*>/g, '').slice(0, 300),
        bodyFull: (body || html || '').slice(0, 2000),
        messageId: null,
        inReplyTo: inReplyTo || null,
        references: references || null,
        contractorId: null,
      },
    });
    try {
      const { logActivity } = require('./services/activity-log');
      logActivity(prisma, {
        type: 'mail.failed',
        summary: `Mail FAILED: ${subject || '(brak tematu)'} → ${to}`,
        source: 'system',
        emailId: failedEmail.id,
        actorType: 'system',
        payload: { subject, fromEmail: from, toEmail: to, reason: 'SMTP nie zwrócił Message-ID' },
        tags: [`inbox:${extractInbox(from)}`],
      });
    } catch (_) {}
    const err = new Error('SMTP nie zwrócił Message-ID — wysyłka niepotwierdzona');
    err.smtpResponse = result;
    throw err;
  }

  console.log(`[mail-sender] sent from ${from} to ${to} subject: ${subject} messageId=${sentMessageId}`);

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
      bodyPreview: (body || html || '').replace(/<[^>]*>/g, '').slice(0, 300),
      bodyFull: (body || html || '').slice(0, 2000),
      bodyHtml: html || null,
      messageId: sentMessageId,
      inReplyTo: inReplyTo || null,
      references: references || null,
      contractorId,
      // CC nie ma kolumny — trzymamy w extras (do podgladu/historii).
      ...(cc ? { extras: { cc } } : {}),
    },
  });

  // Utrwal zalaczniki (w tym obrazki inline z cid) zeby CRM mogl je
  // wyswietlic w wyslanych mailach. Wczesniej outbound nie zapisywal ich wcale.
  if (attachments && attachments.length) {
    for (const a of attachments) {
      if (!a || !a.content || !a.filename) continue;
      const buf = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content);
      try {
        await prisma.emailAttachment.create({
          data: {
            emailId: saved.id,
            filename: a.filename,
            contentType: a.contentType || 'application/octet-stream',
            size: buf.length,
            data: buf,
            cid: a.cid || null,
          },
        });
      } catch (e) {
        console.error('[mail-sender] zapis zalacznika nieudany:', e.message);
      }
    }
  }

  // CRM v2 Etap 4.4 — activity event. setImmediate w helperze, nie blokuje.
  try {
    const { logActivity } = require('./services/activity-log');
    logActivity(prisma, {
      type: 'mail.sent',
      summary: `Mail wysłany: ${subject || '(brak tematu)'} → ${to}`,
      source: 'system',
      contractorId,
      emailId: saved.id,
      actorType: 'system',
      payload: { subject, fromEmail: from, toEmail: to, messageId: sentMessageId, hasAttachments: !!(attachments && attachments.length) },
      tags: [`inbox:${extractInbox(from)}`],
    });
  } catch (_) {}

  // Fire-and-forget: APPEND to IMAP Sent so messages show up in Thunderbird
  // / webmail. SMTP already succeeded so we don't await this. The previous
  // gate was added after a false alarm — user later confirmed via webmail
  // that messages were never actually deleted, just hidden by Thunderbird's
  // local cache state. Default-on now; set DISABLE_APPEND_TO_SENT=1 to
  // turn off if needed.
  if (rawMessage && process.env.DISABLE_APPEND_TO_SENT !== '1') {
    setImmediate(() => { appendToSent(account, rawMessage); });
  }

  return saved;
}

module.exports = { sendMail, findAccount, extractInbox, getAccounts };
