'use strict';

const https = require('https');
const crypto = require('crypto');
const router = require('express').Router();
const { sendMail, findAccount, extractInbox, getAccounts } = require('../mail-sender');
const { appendToSent } = require('../imap-sent');
const nodemailer = require('nodemailer');
const { buildTrackingUrl } = require('../services/tracking-urls');
const { sendTrackingNotification, validateShipmentReady, pickLang: pickTrackingLang } = require('../services/tracking-notify');
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
      // Dedup MUSI uwzględniać treść — inaczej dwa RÓŻNE maile do tego samego
      // adresu z tym samym tematem (np. „Re: Zamówienie") w <2 min: drugi był
      // oznaczany jako wysłany BEZ wysyłki. Z bodyFull deduplikujemy tylko
      // realny duplikat (identyczna treść = double-submit).
      ...(body != null ? { bodyFull: body } : {}),
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
  const { inbox, direction, isRead, limit, fromEmail, search, contractorId, folder, important, openDeal, offset } = req.query;
  const where = {};
  // Filtr „niedomknięte deale": maile kontrahentów z extras.openDeal=true
  // (oznaczone ręcznie, auto-zamykane przy wystawieniu FV) LUB maile bez
  // kontrahenta otagowane 'deal-open'.
  if (openDeal === '1' || openDeal === 'true') {
    where.AND = [...(where.AND || []), {
      OR: [
        { tags: { has: 'deal-open' } },
        { contractor: { is: { extras: { path: ['openDeal'], equals: true } } } },
      ],
    }];
  }
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
  } else if (folder === 'pgf') {
    // Folder PGF — automaty "Zgłoszenie od dostawcy" (PGF Master Data).
    where.tags = { has: 'pgf' };
  } else if (!folder || folder === 'inbox') {
    // domyslnie ukrywamy archived, trash ORAZ pgf (zalew od dostawcy —
    // dostepny tylko w osobnym folderze 'pgf', nie zasmieca glownego widoku).
    where.NOT = { tags: { hasSome: ['archived', 'trash', 'pgf'] } };
    // important=1 -> WAZNE: maile ktore wywolaly powiadomienie (tag 'tg_notified')
    // LUB ktore w temacie/tresci maja "zamowienie" w dowolnym jezyku. Drugi
    // warunek lapie zamowienia B2B nawet jak poller ich nie znotyfikowal
    // (i dziala wstecznie na istniejacych mailach).
    if (important === '1' || important === 'true') {
      const ORDER_KW = [
        'zamówien', 'zamowien', 'zamawia',   // PL
        'order',                              // EN
        'pedido', 'encomenda',               // ES/PT
        'commande',                          // FR
        'bestellung', 'bestell', 'bestelling', // DE/NL
        'ordine',                            // IT
      ];
      // Auto-powiadomienia kurierskie ("Potwierdzenie nadania", "List przewozowy
      // do zamowienia GK...") zawieraja "zamowien" -> falszywie wpadaly do Waznych.
      // Wykluczamy je z galezi slow kluczowych po nadawcy (domeny kurierskie) i
      // typowych tematach. Galaz tg_notified zostaje bez zmian (poller i tak nie
      // notyfikuje kurierow).
      const COURIER_FROM = ['globkurier', 'dpd', 'dhl', 'inpost', 'gls', 'fedex', 'geis', 'pocztex', 'paczkomat', 'furgonetka', 'apaczka', 'ups.com', 'noreply', 'no-reply'];
      const NOTIF_SUBJECT = ['potwierdzenie nadania', 'list przewozowy', 'przesyłk', 'przesylk', 'payment reminder', 'przypomnienie o płatności', 'tracking', 'waybill'];
      const excludeOr = [];
      for (const d of COURIER_FROM) excludeOr.push({ fromEmail: { contains: d, mode: 'insensitive' } });
      for (const s of NOTIF_SUBJECT) excludeOr.push({ subject: { contains: s, mode: 'insensitive' } });

      const keywordOr = [];
      for (const kw of ORDER_KW) {
        keywordOr.push({ subject: { contains: kw, mode: 'insensitive' } });
        keywordOr.push({ bodyPreview: { contains: kw, mode: 'insensitive' } });
        keywordOr.push({ bodyFull: { contains: kw, mode: 'insensitive' } });
      }
      where.AND = [...(where.AND || []), {
        OR: [
          { tags: { has: 'tg_notified' } },
          { AND: [{ OR: keywordOr }, { NOT: { OR: excludeOr } }] },
        ],
      }];
    }
  }
  if (search) {
    const s = String(search).trim();
    const or = [
      { fromEmail: { contains: s, mode: 'insensitive' } },
      { toEmail: { contains: s, mode: 'insensitive' } },
      { fromName: { contains: s, mode: 'insensitive' } },
      { subject: { contains: s, mode: 'insensitive' } },
    ];
    // Jak to email — sprawdz tez po domenie i po local-part jako fallback.
    if (s.includes('@')) {
      const [local, domain] = s.split('@');
      if (domain) or.push({ fromEmail: { contains: domain, mode: 'insensitive' } });
      if (local) or.push({ fromEmail: { contains: local, mode: 'insensitive' } });
    }
    where.OR = or;
  }
  // Cap 1000 (było 100 — lista „kończyła się" i nie dało się dojść do starszych).
  // offset → paginacja / „Załaduj starsze".
  const take = Math.min(parseInt(limit) || 20, 1000);
  const skip = Math.max(0, parseInt(offset) || 0);
  const emails = await prisma.email.findMany({
    where,
    include: {
      contractor: true,
      attachments: { select: { id: true, filename: true, contentType: true, size: true } },
    },
    take,
    skip,
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
          createdAt: { gte: new Date(Date.now() - 1095 * 24 * 60 * 60 * 1000) }, // 3 lata wstecz — "Odpowiedziano" tez dla starszych watkow
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
              createdAt: { gte: new Date(Date.now() - 1095 * 24 * 60 * 60 * 1000) },
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
              // Odpowiedz musi byc po inbound, w rozsadnym oknie (365 dni) —
              // szersze niz dawne 90, zeby "Odpowiedziano" lapalo starsze watki.
              const diffDays = (new Date(c.createdAt) - inboundDate) / (24 * 60 * 60 * 1000);
              if (diffDays > 365) continue;
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

// „Niedomknięty deal": oznacz/odznacz wątek klienta. Gdy mail ma kontrahenta →
// flaga na KONTRAHENCIE (extras.openDeal) — wszystkie jego maile wpadają do
// filtra i FLAGA GAŚNIE SAMA przy wystawieniu mu faktury. Bez kontrahenta →
// tag 'deal-open' na samym mailu (nowy klient spoza bazy; zamykasz ręcznie).
// body: { open: true|false } (brak body = toggle).
router.patch('/emails/:id/deal', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const email = await prisma.email.findUnique({
      where: { id: req.params.id },
      select: { id: true, tags: true, contractorId: true },
    });
    if (!email) return res.status(404).json({ error: 'not found' });

    if (email.contractorId) {
      const c = await prisma.contractor.findUnique({ where: { id: email.contractorId }, select: { extras: true, name: true } });
      const ex = (c && typeof c.extras === 'object' && c.extras) || {};
      const open = req.body && typeof req.body.open === 'boolean' ? req.body.open : !ex.openDeal;
      await prisma.contractor.update({
        where: { id: email.contractorId },
        data: { extras: { ...ex, openDeal: open, ...(open ? { openDealAt: new Date().toISOString() } : { dealClosedAt: new Date().toISOString() }) } },
      });
      return res.json({ ok: true, scope: 'contractor', contractorId: email.contractorId, contractorName: c && c.name, open });
    }

    const has = (email.tags || []).includes('deal-open');
    const open = req.body && typeof req.body.open === 'boolean' ? req.body.open : !has;
    const tags = open
      ? (has ? email.tags : [...(email.tags || []), 'deal-open'])
      : (email.tags || []).filter(t => t !== 'deal-open');
    await prisma.email.update({ where: { id: email.id }, data: { tags } });
    res.json({ ok: true, scope: 'email', open });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// LLM-skan WSTECZ: znajdź niedomknięte deale w historii maili i oznacz je.
// Kandydaci deterministycznie (INBOUND w oknie, bez kurierów/automatów/naszych,
// bez kontrahentów z FV wystawioną po rozpoczęciu rozmowy, bez już oznaczonych),
// werdykt jednym zbiorczym callem LLM.
async function runOpenDealScan(prisma, { days = 120, apply = true } = {}) {
  {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);

    const SKIP_FROM = /noreply|no-reply|newsletter|mailer|daemon|globkurier|dpd\.|dhl|inpost|gls|fedex|ups\.|pocztex|furgonetka|apaczka|surfstickbell\.com|ifirma|ksef|podatki\.gov|vercel|github|google\.com|apple\.com|paypal|stripe|allegro|pgf/i;

    const inbound = await prisma.email.findMany({
      where: {
        direction: 'INBOUND',
        createdAt: { gte: since },
        NOT: { tags: { hasSome: ['archived', 'trash', 'pgf', 'deal-open'] } },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, fromEmail: true, fromName: true, subject: true, bodyPreview: true,
        createdAt: true, contractorId: true,
        contractor: { select: { id: true, name: true, extras: true } },
      },
    });

    // Wątek = kontrahent albo adres nadawcy.
    const groups = new Map();
    for (const e of inbound) {
      const from = String(e.fromEmail || '').toLowerCase();
      if (!from || SKIP_FROM.test(from)) continue;
      if (e.contractor && e.contractor.extras && e.contractor.extras.openDeal) continue; // już oznaczony
      const key = e.contractorId || from;
      const g = groups.get(key) || { key, contractorId: e.contractorId, contractorName: e.contractor && e.contractor.name, fromEmail: from, fromName: e.fromName, mails: [] };
      g.mails.push(e);
      groups.set(key, g);
    }

    // Kontrahent z FV wystawioną PO rozpoczęciu rozmowy = deal domknięty.
    const contractorIds = [...groups.values()].map(g => g.contractorId).filter(Boolean);
    const invs = contractorIds.length ? await prisma.invoice.findMany({
      where: { contractorId: { in: contractorIds }, issueDate: { gte: since } },
      select: { contractorId: true, issueDate: true },
    }) : [];
    const lastInvoiceAt = new Map();
    for (const i of invs) {
      const t = lastInvoiceAt.get(i.contractorId);
      if (!t || i.issueDate > t) lastInvoiceAt.set(i.contractorId, i.issueDate);
    }

    const candidates = [];
    for (const g of groups.values()) {
      const inv = g.contractorId && lastInvoiceAt.get(g.contractorId);
      if (inv && inv >= g.mails[0].createdAt) continue;
      candidates.push({ ...g, lastAt: g.mails[g.mails.length - 1].createdAt });
    }
    candidates.sort((a, b) => b.lastAt - a.lastAt);
    // Faktyczny zasięg danych — jak baza maili nie sięga pełnych `days` wstecz
    // (import zaczął się później), raport to pokaże zamiast udawać pełny skan.
    const oldestMailAt = inbound.length ? inbound[0].createdAt : null;
    if (!candidates.length) return { ok: true, scanned: inbound.length, candidates: 0, deals: [], marked: 0, applied: apply, oldestMailAt };

    // WSZYSCY kandydaci, w partiach po 50 na call LLM (wcześniej tylko 60
    // najnowszych wątków — starsze tematy w ogóle nie trafiały do oceny).
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3 });
    const BATCH = 50;
    const deals = []; // { g, reason }
    for (let off = 0; off < candidates.length; off += BATCH) {
      const batch = candidates.slice(off, off + BATCH);
      const digest = batch.map((g, i) => {
        const lines = g.mails.slice(-3).map(m => `  - ${m.createdAt.toISOString().slice(0, 10)} "${(m.subject || '').slice(0, 80)}": ${(m.bodyPreview || '').slice(0, 160)}`).join('\n');
        return `#${i} ${g.contractorName || g.fromName || g.fromEmail} <${g.fromEmail}> (maili: ${g.mails.length}, ostatni: ${new Date(g.lastAt).toISOString().slice(0, 10)})\n${lines}`;
      }).join('\n\n');

      const prompt = `Jesteś asystentem sprzedaży firmy Surf Stick Bell (kosmetyki surfingowe B2B: sticki przeciwsłoneczne, mascary, kremy). Poniżej wątki mailowe z ostatnich ${days} dni, które NIE skończyły się fakturą. Wskaż, które to NIEDOMKNIĘTE DEALE — realne zainteresowanie zakupem/współpracą (pytania o produkty, ceny, zamówienia, próbki, dystrybucję, hurt), gdzie temat umarł i warto wrócić do klienta.
NIE są dealami: spam, oferty usług DLA NAS (marketing, SEO, rekrutacja, logistyka), automaty, potwierdzenia, urzędy, nasi dostawcy.

Zwróć TYLKO czysty JSON (bez markdown): {"deals":[{"index":N,"reason":"krótko po polsku, czego dotyczył"}]}

WĄTKI:
${digest}`;

      let text = '';
      try {
        const llm = await anthropic.messages.create({
          model: process.env.DEAL_SCAN_MODEL || process.env.ORDER_PARSER_MODEL || 'claude-sonnet-4-5-20250929',
          max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }],
        });
        text = (llm.content && llm.content[0] && llm.content[0].text) || '';
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const out = JSON.parse(clean);
        for (const d of (Array.isArray(out.deals) ? out.deals : [])) {
          if (Number.isInteger(d.index) && batch[d.index]) deals.push({ g: batch[d.index], reason: d.reason || '' });
        }
        console.log(`[scan-open-deals] partia ${off / BATCH + 1}/${Math.ceil(candidates.length / BATCH)}: +${(out.deals || []).length} deali`);
      } catch (e) {
        // Jedna zepsuta partia nie ubija całego skanu — log i dalej.
        console.error(`[scan-open-deals] partia od #${off} nieudana:`, e.message, text.slice(0, 150));
      }
    }

    let marked = 0;
    const report = [];
    for (const d of deals) {
      const g = d.g;
      report.push({ who: g.contractorName || g.fromName || g.fromEmail, email: g.fromEmail, contractorId: g.contractorId || null, lastAt: g.lastAt, mails: g.mails.length, reason: d.reason || '' });
      if (!apply) continue;
      try {
        if (g.contractorId) {
          const c = await prisma.contractor.findUnique({ where: { id: g.contractorId }, select: { extras: true } });
          const ex = (c && typeof c.extras === 'object' && c.extras) || {};
          await prisma.contractor.update({
            where: { id: g.contractorId },
            data: { extras: { ...ex, openDeal: true, openDealAt: new Date().toISOString(), dealSource: 'llm-scan', dealReason: (d.reason || '').slice(0, 200) } },
          });
        } else {
          const last = g.mails[g.mails.length - 1];
          const em = await prisma.email.findUnique({ where: { id: last.id }, select: { tags: true } });
          if (em && !(em.tags || []).includes('deal-open')) {
            await prisma.email.update({ where: { id: last.id }, data: { tags: [...(em.tags || []), 'deal-open'] } });
          }
        }
        marked++;
      } catch (e) {
        console.error('[scan-open-deals] mark failed:', e.message);
      }
    }
    return { ok: true, scanned: inbound.length, candidates: candidates.length, deals: report, marked, applied: apply, oldestMailAt };
  }
}

// POST startuje skan W TLE i odpowiada od razu — synchroniczny wariant
// przekraczał limit proxy (60 s) i iOS ucinał żądanie ("Load failed").
// Wynik ląduje w AgentContext 'deal-scan'; front odpytuje GET .../status.
// body: { days?: 120, apply?: true, sync?: false }.
router.post('/emails/scan-open-deals', async (req, res) => {
  const prisma = req.app.locals.prisma;
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });
  const days = Math.min(365, Number(req.body && req.body.days) || 120);
  const apply = !(req.body && req.body.apply === false);
  if (req.body && req.body.sync) {
    try { return res.json(await runOpenDealScan(prisma, { days, apply })); }
    catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  const saveState = (data) => prisma.agentContext.upsert({
    where: { id: 'deal-scan' }, update: { data }, create: { id: 'deal-scan', data },
  });
  await saveState({ status: 'running', startedAt: new Date().toISOString(), days });
  setImmediate(async () => {
    try {
      const result = await runOpenDealScan(prisma, { days, apply });
      await saveState({ status: 'done', finishedAt: new Date().toISOString(), days, result });
      console.log(`[scan-open-deals] done: ${result.marked}/${result.candidates} oznaczonych`);
    } catch (e) {
      console.error('[scan-open-deals] background error:', e.message);
      await saveState({ status: 'error', finishedAt: new Date().toISOString(), error: e.message }).catch(() => {});
    }
  });
  res.json({ ok: true, started: true });
});

router.get('/emails/scan-open-deals/status', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const row = await prisma.agentContext.findUnique({ where: { id: 'deal-scan' } }).catch(() => null);
  res.json({ ok: true, ...(row && row.data ? row.data : { status: 'never' }) });
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
  // Jedno zapytanie zamiast 2×N sekwencyjnych update'ów (było N+1 na 100+ maili).
  let affected = 0;
  if (action === 'read' || action === 'unread') {
    const r = await prisma.email.updateMany({ where: { id: { in: ids } }, data: { isRead: action === 'read' } });
    affected = r.count;
  } else {
    // Tagi to text[] — Prisma updateMany nie umie append/remove per-wiersz,
    // więc robimy to jednym UPDATE-em z array_append/array_remove.
    const tag = (action === 'archive' || action === 'unarchive') ? 'archived' : 'trash';
    const adding = (action === 'archive' || action === 'trash');
    if (adding) {
      // dodaj tag tylko tam, gdzie jeszcze go nie ma (bez duplikatów)
      affected = await prisma.$executeRaw`UPDATE "Email" SET tags = array_append(tags, ${tag}) WHERE id = ANY(${ids}) AND NOT (${tag} = ANY(tags))`;
    } else {
      affected = await prisma.$executeRaw`UPDATE "Email" SET tags = array_remove(tags, ${tag}) WHERE id = ANY(${ids})`;
    }
  }
  res.json({ ok: true, action, affected });
});

// ============ EMAIL DETAIL WITH ATTACHMENTS ============

// Caly watek konwersacji (odebrane + nasze odpowiedzi) dla danego maila.
// Grupowanie spojne z lista po stronie klienta: stripped(subject) + (contractorId
// LUB email partnera). Zwraca najnowsze NA GORZE — zeby od razu bylo widac
// ostatnia odpowiedz ("odpowiedziane").
// GET /api/emails/recipient-suggest — wszystkie adresy email kontrahentow
// (PL Contractor + ContractorContact + ES EsContractor) do autouzupelniania
// pola "Do" w kompozytorze. Zwraca distinct {email, name, source}. MUSI byc
// zdefiniowane PRZED router.get('/emails/:id') — inaczej :id przechwytuje
// "recipient-suggest". Front laduje raz i filtruje po stronie klienta.
router.get('/emails/recipient-suggest', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const q = String(req.query.q || '').trim().toLowerCase();
  try {
    const out = new Map(); // email -> {email, name, source}
    const add = (email, name, source) => {
      if (!email) return;
      const e = String(email).trim().toLowerCase();
      if (!e.includes('@')) return;
      if (q && !e.startsWith(q) && !(name && name.toLowerCase().includes(q))) return;
      if (!out.has(e)) out.set(e, { email: e, name: name || null, source });
    };

    const [pls, contacts, ess] = await Promise.all([
      prisma.contractor.findMany({
        where: { OR: [{ email: { not: null } }, { primaryEmail: { not: null } }] },
        select: { name: true, email: true, primaryEmail: true },
        take: 5000,
      }),
      prisma.contractorContact.findMany({
        where: { type: 'email' },
        select: { value: true, contractor: { select: { name: true } } },
        take: 5000,
      }),
      prisma.esContractor.findMany({
        where: { email: { not: null } },
        select: { name: true, organization: true, email: true },
        take: 5000,
      }),
    ]);

    for (const c of pls) { add(c.primaryEmail, c.name, 'pl'); add(c.email, c.name, 'pl'); }
    for (const c of contacts) add(c.value, c.contractor && c.contractor.name, 'pl');
    for (const c of ess) add(c.email, c.organization || c.name, 'es');

    const list = Array.from(out.values()).sort((a, b) => {
      if (q) {
        const ap = a.email.startsWith(q) ? 0 : 1;
        const bp = b.email.startsWith(q) ? 0 : 1;
        if (ap !== bp) return ap - bp;
      }
      return a.email.localeCompare(b.email);
    });
    res.json({ ok: true, count: list.length, suggestions: list.slice(0, 1000) });
  } catch (e) {
    console.error('[emails/recipient-suggest] error:', e.message);
    res.status(500).json({ ok: false, error: e.message, suggestions: [] });
  }
});

router.get('/emails/:id/thread', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const seed = await prisma.email.findUnique({
      where: { id: req.params.id },
      select: { id: true, subject: true, direction: true, fromEmail: true, toEmail: true, contractorId: true },
    });
    if (!seed) return res.status(404).json({ error: 'Email not found' });

    const strip = (s) => {
      let x = (s || '').trim();
      while (/^(re|fwd|fw|odp|wg|aw):\s*/i.test(x)) x = x.replace(/^(re|fwd|fw|odp|wg|aw):\s*/i, '').trim();
      return x.toLowerCase();
    };
    const subjKey = strip(seed.subject);
    const partner = ((seed.direction === 'INBOUND' ? seed.fromEmail : seed.toEmail) || '').toLowerCase();

    // Bez tematu => mail solo (nie da sie sensownie zgrupowac).
    if (!subjKey) {
      const solo = await prisma.email.findUnique({
        where: { id: seed.id },
        include: { contractor: true, attachments: { select: { id: true, filename: true, contentType: true, size: true, cid: true } } },
      });
      return res.json([solo]);
    }

    // Krok 1: lekko — kandydaci po partnerze/kontrahencie, tylko pola do filtra.
    const or = [];
    if (partner) {
      or.push({ fromEmail: { equals: partner, mode: 'insensitive' } });
      or.push({ toEmail: { equals: partner, mode: 'insensitive' } });
    }
    if (seed.contractorId) or.push({ contractorId: seed.contractorId });
    const candidates = await prisma.email.findMany({
      where: or.length ? { OR: or } : { id: seed.id },
      select: { id: true, subject: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 400,
    });

    // Krok 2: te z pasujacym (po zdjeciu prefiksow) tematem; max 50 najnowszych.
    const ids = candidates.filter(c => strip(c.subject) === subjKey).map(c => c.id);
    if (!ids.includes(seed.id)) ids.push(seed.id);
    const limited = ids.slice(0, 50);

    // Krok 3: pelne dane tylko dla czlonkow watku.
    const thread = await prisma.email.findMany({
      where: { id: { in: limited } },
      include: { contractor: true, attachments: { select: { id: true, filename: true, contentType: true, size: true, cid: true } } },
      orderBy: { createdAt: 'desc' }, // najnowsze na gorze
    });

    // Odfiltruj PUSTE kikuty OUTBOUND/DRAFT (artefakt synchronizacji folderu
    // Sent z innym Message-ID — duplikat bez tresci). INBOUND zostawiamy zawsze.
    const hasContent = (e) =>
      (e.bodyFull && e.bodyFull.trim()) ||
      (e.bodyHtml && e.bodyHtml.trim()) ||
      (e.bodyPreview && e.bodyPreview.trim()) ||
      (e.attachments && e.attachments.length);
    const cleaned = thread.filter(e => e.direction === 'INBOUND' || hasContent(e));
    return res.json(cleaned.length ? cleaned : thread);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/emails/:id', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const email = await prisma.email.findUnique({
      where: { id: req.params.id },
      include: {
        contractor: true,
        attachments: { select: { id: true, filename: true, contentType: true, size: true, cid: true, createdAt: true } },
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
        select: { id: true, bodyFull: true, bodyHtml: true, messageId: true, createdAt: true },
        take: 5,
      });
      if (dupes.length) {
        console.log(`[emails/:id] DUPLICATES found for ${email.toEmail} "${email.subject}":`);
        for (const d of dupes) {
          console.log(`  id=${d.id} createdAt=${d.createdAt.toISOString()} bodyLen=${(d.bodyFull||'').length} msgId=${d.messageId}`);
        }
        // Fallback: jesli ten rekord ma puste bodyFull, ale duplikat ma tresc — pokaz z duplikatu.
        // IMAP sent-rescan czasem tworzy stub bez body; oryginal z sendMail ma body.
        if (!email.bodyFull || !email.bodyFull.trim()) {
          const withBody = dupes.find(d => d.bodyFull && d.bodyFull.trim());
          if (withBody) {
            email.bodyFull = withBody.bodyFull;
            email.bodyPreview = (withBody.bodyFull || '').replace(/<[^>]*>/g, '').slice(0, 300);
            if (!email.bodyHtml && withBody.bodyHtml) email.bodyHtml = withBody.bodyHtml;
            console.log(`[emails/:id] body recovered from duplicate ${withBody.id}`);
          }
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

// Mapowanie rozszerzenie → MIME (gdy w bazie zapisany generyczny/pusty typ, np.
// octet-stream — iOS wtedy nie wie, czym otworzyć xlsx/docx).
const EXT_CT = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  csv: 'text/csv', txt: 'text/plain', pdf: 'application/pdf', zip: 'application/zip',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};
function resolveContentType(ct, ext) {
  if (ct && ct !== 'application/octet-stream' && !/^binary/i.test(ct)) return ct;
  return EXT_CT[ext] || ct || 'application/octet-stream';
}

router.get('/attachment/:id', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const att = await prisma.emailAttachment.findUnique({ where: { id: req.params.id } });
    if (!att) return res.status(404).json({ error: 'Attachment not found' });
    // Prisma 6 zwraca Bytes jako Uint8Array (nie Buffer). res.send() z czystym
    // Uint8Array serializuje do JSON (psuje binaria — "Invalid PDF structure").
    // Buffer.from() gwarantuje wyslanie surowych bajtow.
    const buf = Buffer.isBuffer(att.data) ? att.data : Buffer.from(att.data);
    const name = (att.filename || 'plik').replace(/[\r\n"]/g, '_');
    const ext = (name.split('.').pop() || '').toLowerCase();
    const ct = resolveContentType(att.contentType, ext);
    res.setHeader('Content-Type', ct);
    // inline TYLKO dla PDF/obrazów (iOS ma dla nich viewer). Reszta (xlsx/docx/
    // zip…) → attachment, żeby telefon zaproponował zapis/otwórz w aplikacji,
    // a nie pokazywał pustej karty. ?download=1 wymusza attachment zawsze.
    const previewable = ct === 'application/pdf' || ct.startsWith('image/');
    const forceDl = req.query.download === '1' || req.query.dl === '1';
    const disp = (previewable && !forceDl) ? 'inline' : 'attachment';
    // filename* (RFC5987) — nazwy z polskimi znakami psuły nagłówek/odpowiedź.
    const ascii = name.replace(/[^\x20-\x7E]/g, '_');
    res.setHeader('Content-Disposition', `${disp}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
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
    let { from, to, cc, subject, body, html, attachments, uploadIds, replyTo, emailId: replyToEmailId, draft = true } = req.body;
    cc = (cc && String(cc).trim()) || null;

    // Zalaczniki z frontu: [{ filename, contentBase64, contentType, cid? }].
    // Inline obrazki (wklejone w tresc) maja cid -> <img src="cid:..."> w html.
    const mailAttachments = Array.isArray(attachments) ? attachments
      .filter(a => a && a.contentBase64 && a.filename)
      .map(a => ({
        filename: String(a.filename),
        content: Buffer.from(a.contentBase64, 'base64'),
        contentType: a.contentType || 'application/octet-stream',
        ...(a.cid ? { cid: String(a.cid) } : {}),
      })) : [];

    // Duże załączniki przyszły chunked (omijają limit 4.5MB Vercela) — backend
    // trzyma je po uploadId; doklejamy je tutaj jako pełne pliki.
    if (Array.isArray(uploadIds) && uploadIds.length) {
      const { getFinalizedUpload } = require('./upload');
      for (const uid of uploadIds) {
        const f = getFinalizedUpload(uid);
        if (!f) return res.status(400).json({ error: `Załącznik wygasł lub nie został wgrany (uploadId ${uid}). Dodaj plik ponownie.` });
        mailAttachments.push({ filename: f.filename, content: f.buffer, contentType: f.contentType });
      }
    }

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
    // Wyślij z DOKŁADNEGO adresu konta (np. niko@ → nikodem@), nie z surowego „Od".
    if (account.user && account.user.toLowerCase() !== from.toLowerCase()) {
      console.log(`[send-email] from "${from}" → konto "${account.user}"`);
      from = account.user;
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
          bodyFull: body || '',        // PEŁNA treść — było ucinane do 2000 → confirm wysyłał ucięty mail
          bodyHtml: html || null,      // HTML (inline obrazki cid) — bez tego confirm gubił formatowanie
          inReplyTo: inReplyTo || null,
          references: references || null,
          contractorId,
          ...(cc ? { extras: { cc } } : {}),
        },
      });

      // Zapisz załączniki draftu (composer/uploady) jako EmailAttachment —
      // confirm wysyła załączniki WŁAŚNIE stąd. Bez tego draft→wyślij szedł
      // BEZ załączników (klient nie dostawał np. PDF).
      if (mailAttachments.length) {
        await prisma.emailAttachment.createMany({
          data: mailAttachments.map(a => ({
            emailId: saved.id,
            filename: a.filename,
            contentType: a.contentType || 'application/octet-stream',
            size: a.content.length,
            data: a.content,
            cid: a.cid || null,
          })),
        });
      }

      // Preview tlumaczenie PL — gdy draft jest w obcym jezyku, dorzucamy
      // tlumaczenie zeby user mogl zweryfikowac co bot napisal PRZED
      // wyslaniem. Tlumaczenie nie idzie do klienta — tylko do podgladu.
      // Haiku (najtanszy) za $0.001/draft.
      let previewTranslationPl = null;
      let previewSourceLang = null;
      try {
        const Anthropic = require('@anthropic-ai/sdk');
        if (process.env.ANTHROPIC_API_KEY && body && body.length > 20) {
          const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: Number(process.env.ANTHROPIC_MAX_RETRIES) || 5 });
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

    const saved = await sendMail({
      from, to, subject, body,
      ...(cc ? { cc } : {}),
      ...(html ? { html } : {}),
      ...(mailAttachments.length ? { attachments: mailAttachments } : {}),
      inReplyTo, references,
    });
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

    // Dolacz zapisane zalaczniki (np. PDF faktury z draft-with-invoice).
    const draftAtts = await prisma.emailAttachment.findMany({ where: { emailId: email.id } });

    if (await wasRecentlySent(prisma, email.toEmail, email.subject, email.bodyFull)) {
      console.log('[dedup] Skipping duplicate confirm to', email.toEmail, email.subject);
      await prisma.email.update({ where: { id: email.id }, data: { direction: 'OUTBOUND' } });
      return res.json({ ok: true, deduplicated: true, message: 'Identical email sent in last 2 minutes, skipped to prevent duplicate' });
    }

    await sendMail({
      from: email.fromEmail,
      to: email.toEmail,
      cc: (email.extras && email.extras.cc) || undefined,
      subject: email.subject || '',
      body: email.bodyFull || '',
      html: email.bodyHtml || undefined,
      inReplyTo: email.inReplyTo || undefined,
      references: email.references || undefined,
      attachments: draftAtts.length
        ? draftAtts.map(a => ({ filename: a.filename, content: Buffer.from(a.data), contentType: a.contentType, ...(a.cid ? { cid: a.cid } : {}) }))
        : undefined,
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

    // Drafty z FV (draft-with-invoice) maja PDF zapisany jako EmailAttachment.
    // Bez tego wysylka szla z pustym mailem — faktura gubila sie po "tak".
    const draftAtts = await prisma.emailAttachment.findMany({ where: { emailId: draft.id } });

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
        cc: (draft.extras && draft.extras.cc) || undefined,
        subject: draft.subject || '',
        body: draft.bodyFull || '',
        html: draft.bodyHtml || undefined,
        inReplyTo: draft.inReplyTo || undefined,
        references: draft.references || undefined,
        attachments: draftAtts.length
          ? draftAtts.map(a => ({ filename: a.filename, content: Buffer.from(a.data), contentType: a.contentType, ...(a.cid ? { cid: a.cid } : {}) }))
          : undefined,
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

    // Dolacz zapisane zalaczniki (np. PDF faktury z draft-with-invoice).
    const draftAtts = await prisma.emailAttachment.findMany({ where: { emailId: email.id } });

    if (await wasRecentlySent(prisma, email.toEmail, email.subject, email.bodyFull)) {
      console.log('[dedup] Skipping duplicate /:id/confirm to', email.toEmail, email.subject);
      await prisma.email.update({ where: { id: email.id }, data: { direction: 'OUTBOUND' } });
      return res.json({ ok: true, deduplicated: true, message: 'Identical email sent in last 2 minutes, skipped to prevent duplicate' });
    }

    await sendMail({
      from: email.fromEmail,
      to: email.toEmail,
      cc: (email.extras && email.extras.cc) || undefined,
      subject: email.subject || '',
      body: email.bodyFull || '',
      html: email.bodyHtml || undefined,
      inReplyTo: email.inReplyTo || undefined,
      references: email.references || undefined,
      attachments: draftAtts.length
        ? draftAtts.map(a => ({ filename: a.filename, content: Buffer.from(a.data), contentType: a.contentType, ...(a.cid ? { cid: a.cid } : {}) }))
        : undefined,
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

    // Dopasuj kontrahenta PO ADRESIE tym samym warunkiem co zapis maila
    // (mail-sender: email contains to). Sluzy do: (a) doboru jezyka,
    // (b) RZETELNEGO raportu — zeby agent nie dorabial nazwy z kontekstu
    // rozmowy. Brak dopasowania => contractor=null => raport pokaze sam adres.
    if (!contractor && to) {
      contractor = await prisma.contractor.findFirst({
        where: { email: { contains: to, mode: 'insensitive' } },
        select: { id: true, name: true, country: true },
      }).catch(() => null);
    }
    if (!language && contractor && contractor.country) {
      language = COUNTRY_TO_LANG[contractor.country.toUpperCase()] || null;
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

    console.log(`[send-offer] sent ${language} offer to ${to} (contractor=${contractor ? contractor.name : 'BRAK'})`);
    return res.json({
      ok: true, sent: true, to, language, subject,
      // Prawdziwy kontrahent (lub null). Agent ma raportowac TYLKO to — bez
      // zgadywania nazwy z kontekstu rozmowy.
      contractor: contractor ? { id: contractor.id, name: contractor.name } : null,
    });
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
      where: { direction: 'INBOUND', isRead: false, tags: { has: 'tg_notified' } },
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
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: Number(process.env.ANTHROPIC_MAX_RETRIES) || 5 });
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
// Lista dostępnych adresów nadawczych (do pola „Od" w composerze). Tylko
// adresy (a.user) — bez haseł/konfiguracji.
router.get('/mail-accounts', (req, res) => {
  try {
    const accounts = (typeof getAccounts === 'function') ? (getAccounts() || []) : [];
    const list = accounts.map(a => a.user).filter(Boolean);
    res.json({ accounts: list });
  } catch (e) {
    res.json({ accounts: [], error: e.message });
  }
});

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
// Adresy "nasze" — nigdy nie traktuj ich jako maila klienta. Bez tego, gdy
// GlobKurier ma zapisany delivery@... jako odbiorce (fallback przy braku maila
// kontrahenta), tracking poszedlby sam do siebie.
const OWN_TRACKING_EMAILS = new Set(
  [process.env.TRACKING_NOTIFY_FROM, 'delivery@surfstickbell.com']
    .filter(Boolean)
    .map((e) => String(e).trim().toLowerCase())
);
const isEmailAddr = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
const isOwnEmailAddr = (s) => isEmailAddr(s) && OWN_TRACKING_EMAILS.has(s.trim().toLowerCase());

// Najlepszy mail kontrahenta: primaryEmail -> ContractorContact(email; isPrimary
// najpierw) -> plaskie email. Pomija adresy "nasze". Zwraca null gdy brak — wtedy
// pytamy usera (NIE wysylamy na zastepczy adres).
async function bestContractorEmail(prisma, contractorId) {
  if (!contractorId) return null;
  let rec = null;
  try {
    rec = await prisma.contractor.findUnique({
      where: { id: contractorId },
      select: { email: true, primaryEmail: true },
    });
  } catch (_) {}
  if (rec && isEmailAddr(rec.primaryEmail) && !isOwnEmailAddr(rec.primaryEmail)) return rec.primaryEmail.trim();
  try {
    const contacts = await prisma.contractorContact.findMany({
      where: { contractorId, type: 'email' },
      orderBy: [{ isPrimary: 'desc' }],
      select: { value: true },
    });
    const hit = contacts.find((x) => isEmailAddr(x.value) && !isOwnEmailAddr(x.value));
    if (hit) return hit.value.trim();
  } catch (_) {}
  if (rec && isEmailAddr(rec.email) && !isOwnEmailAddr(rec.email)) return rec.email.trim();
  return null;
}

// ccTLD adresu e-mail -> ISO-2 (tylko kraje z jezykiem szablonu). ".pt" -> PT.
function tldToIso(email) {
  const m = String(email || '').toLowerCase().trim().match(/\.([a-z]{2})>?$/);
  if (!m) return null;
  const KNOWN = new Set(['PL', 'DE', 'AT', 'CH', 'FR', 'BE', 'LU', 'ES', 'NL', 'PT', 'IT']);
  const t = m[1].toUpperCase();
  return KNOWN.has(t) ? t : null;
}

// Dobor kraju (=> jezyk maila) odbiorcy — to samo co robil "stary" system doboru
// jezyka: kraj kontrahenta (znormalizowany do ISO) -> kraj odbiorcy z GK ->
// prefiks NIP UE -> forma prawna w nazwie (LDA->PT, GmbH->DE) -> ccTLD e-maila.
// Jezyk maila trackingowego. Kraj daje pewny jezyk (PT->pt). Gdy kraj pusty lub
// nieznany (=> en), wykryj jezyk z OSTATNIEGO maila OD kontrahenta (klient pisal
// w swoim jezyku) — extras.language albo tag 'xx'. Zwraca kod jezyka albo null.
async function resolveTrackingLang(prisma, contractor, country) {
  try {
    if (country && pickTrackingLang(country) !== 'en') return null; // kraj wystarczy
    if (!contractor || !contractor.id) return null;
    const lastIn = await prisma.email.findFirst({
      where: { contractorId: contractor.id, direction: 'INBOUND' },
      orderBy: { createdAt: 'desc' },
      select: { extras: true, tags: true },
    });
    if (!lastIn) return null;
    let el = (lastIn.extras && lastIn.extras.language) || null;
    if (!el && Array.isArray(lastIn.tags)) {
      const t = lastIn.tags.find(x => typeof x === 'string' && /^[a-z]{2}$/i.test(x) && x.length === 2);
      if (t) el = t.toLowerCase();
    }
    return el || null;
  } catch { return null; }
}

function resolveTrackingCountry({ contractor, recvCountry, recvName, email }) {
  const { normalizeIso, nipPrefixToCountry, legalFormToCountry } = require('../services/country-helper');
  return (
    normalizeIso(contractor && contractor.country) ||
    normalizeIso(recvCountry) ||
    nipPrefixToCountry(contractor && contractor.nip) ||
    legalFormToCountry((contractor && contractor.name) || recvName) ||
    tldToIso(email) ||
    ''
  );
}

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
        select: { id: true, name: true, email: true, country: true, nip: true },
      });
    } else {
      resolvedContractor = await prisma.contractor.findFirst({
        where: { name: { contains: search.split(/\s+/)[0], mode: 'insensitive' } },
        select: { id: true, name: true, email: true, country: true, nip: true },
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
    // Kurier z GK bywa OBIEKTEM {name:...} — rozpakuj, inaczej "[object Object]".
    const rawCarrierName = shipment.productName || shipment.carrier || (shipment.product && shipment.product.name) || '';
    const carrierName = (rawCarrierName && typeof rawCarrierName === 'object') ? (rawCarrierName.name || '') : rawCarrierName;

    // GK /v1/orders sometimes returns shipments without trackingNumber populated
    // (the carrier number lives on a separate /v1/order/tracking?orderNumber=...
    // endpoint). Fall back to that when the list view doesn't have it.
    let trackingNumber = shipment.trackingNumber || shipment.tracking;
    if (!trackingNumber) {
      const orderNumber = shipment.number || shipment.orderNumber;
      if (orderNumber) {
        // Number kuriera bywa nadawany z opoznieniem — krotki polling (3×) na
        // zywo z GK zamiast jednej proby. Tak agent zawsze dostaje SWIEZY number
        // bezposrednio z GK, nie polega na tym co bylo zapisane w drafcie.
        const { getOrderTracking } = require('../glob-client');
        for (let i = 0; i < 3 && !trackingNumber; i++) {
          if (i > 0) await new Promise(r => setTimeout(r, 2000));
          try {
            const t = await getOrderTracking(orderNumber);
            const candidate = t && (t.trackingNumber || t.tracking
              || (t.parcels && t.parcels[0] && t.parcels[0].trackingNumber)
              || (Array.isArray(t) && t[0] && t[0].trackingNumber));
            if (candidate && String(candidate).trim()) {
              trackingNumber = String(candidate).trim();
              console.log(`[send-tracking-email] fetched tracking for ${orderNumber} (proba ${i + 1}): ${trackingNumber}`);
            }
          } catch (e) {
            console.error(`[send-tracking-email] getOrderTracking proba ${i + 1} failed:`, e.message);
          }
        }
        // Fallback: numer kuriera bywa już NA ETYKIECIE (liście przewozowym),
        // zanim GK API zacznie go zwracać — parsujemy PDF etykiety (jak w
        // glob/order). Bez tego "tracking-send blocked: no carrier tracking
        // number", choć list z numerem da się pobrać.
        if (!trackingNumber && shipment.hash) {
          const { extractTrackingFromLabel } = require('../services/label-tracking');
          const fromLabel = await extractTrackingFromLabel(shipment.hash);
          if (fromLabel) {
            trackingNumber = fromLabel;
            console.log(`[send-tracking-email] tracking z PDF etykiety: ${trackingNumber}`);
          }
        }
        // Świeży number z GK — zapisz trwale do Transaction, by kolejne
        // wywolania mialy go od reki.
        if (trackingNumber) {
          try {
            await prisma.transaction.updateMany({
              where: { OR: [{ shipmentNumber: String(orderNumber) }, { shipmentHash: shipment.hash || '__none__' }] },
              data: { trackingNumber, hasShipped: true },
            });
          } catch (e) { console.error('[send-tracking-email] zapis trackingNumber do Transaction nieudany:', e.message); }
        }
      }
    }
    const trackingUrl = buildTrackingUrl(carrierName, trackingNumber);

    // 3) Resolve recipient email. NIGDY nie wysylamy na nasz wlasny adres
    //    (delivery@...) — gdyby GK mial go zapisany jako odbiorce, tracking
    //    poszedlby sam do siebie. Kolejnosc: jawny override > kontrahent
    //    (primaryEmail/ContractorContact/email) > mail odbiorcy z GK (o ile
    //    nie nasz) > kontrahent dopasowany po nazwie odbiorcy.
    let toEmail = (isEmailAddr(contractorEmail) && !isOwnEmailAddr(contractorEmail)) ? contractorEmail.trim() : null;
    if (!toEmail && resolvedContractor) toEmail = await bestContractorEmail(prisma, resolvedContractor.id);
    if (!toEmail && isEmailAddr(recv.email) && !isOwnEmailAddr(recv.email)) toEmail = recv.email.trim();
    if (!toEmail && recv.name) {
      const c = await prisma.contractor.findFirst({
        where: { name: { contains: recv.name.split(' ')[0], mode: 'insensitive' } },
        select: { id: true },
      });
      if (c) toEmail = await bestContractorEmail(prisma, c.id);
    }
    if (!toEmail) {
      const who = (resolvedContractor && resolvedContractor.name) || recv.name || search;
      return {
        ok: false,
        error: 'NO_CONTRACTOR_EMAIL',
        needsEmail: true,
        contractor: resolvedContractor
          ? { id: resolvedContractor.id, name: resolvedContractor.name }
          : (recv.name ? { name: recv.name } : null),
        message: `Nie mam adresu e-mail do kontrahenta ${who}. Podaj adres — dopisze go do kontrahenta i wysle tracking. (Albo dodaj w CRM → Kontrahenci → ${who} → pole Email.)`,
        search,
        shipment: { trackingNumber, name: recv.name, city: recv.city, country: recv.country },
      };
    }

    // "Dopisz do kontrahenta": gdy mail podany jawnie (user na czacie), a
    // kontrahent go nie ma — zapisz, zeby nastepnym razem nie pytac.
    if (isEmailAddr(contractorEmail) && !isOwnEmailAddr(contractorEmail) && resolvedContractor && resolvedContractor.id) {
      try {
        const existing = await prisma.contractor.findUnique({
          where: { id: resolvedContractor.id },
          select: { email: true, primaryEmail: true },
        });
        const patch = {};
        if (!isEmailAddr(existing && existing.email)) patch.email = contractorEmail.trim();
        if (!isEmailAddr(existing && existing.primaryEmail)) patch.primaryEmail = contractorEmail.trim().toLowerCase();
        if (Object.keys(patch).length) {
          await prisma.contractor.update({ where: { id: resolvedContractor.id }, data: patch });
          console.log(`[send-tracking-email] zapisano e-mail do kontrahenta ${resolvedContractor.id}: ${contractorEmail.trim()}`);
        }
      } catch (e) {
        console.error('[send-tracking-email] zapis e-maila kontrahenta nieudany:', e.message);
      }
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
    const country = resolveTrackingCountry({ contractor: resolvedContractor, recvCountry: recv.country, recvName: recv.name, email: toEmail });
    const lang = await resolveTrackingLang(prisma, resolvedContractor, country);
    const r = await sendTrackingNotification({
      toEmail,
      country,
      lang,
      trackingNumber,
      carrier: carrierName,
      from: fromOverride,
      prisma,
      reqChatId,
      // Nazwa z listu przewozowego + miasto — klient widzi, której paczki
      // dotyczy wiadomość.
      reference: [recv.name || recv.companyName, recv.city].filter(Boolean).join(', ') || null,
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

// Preview tracking email — same lookup as send but returns composed message
// without actually sending. Frontend shows this for confirmation.
router.post('/send-tracking-email/preview', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { compose, pickLang, validateShipmentReady } = require('../services/tracking-notify');
  const { buildTrackingUrl } = require('../services/tracking-urls');
  const { getOrders } = require('../glob-client');
  const { scoreContractor } = require('../services/contractor-match');

  try {
    const search = (req.body || {}).search;
    const contractorEmailOverride = (req.body || {}).contractorEmail;
    if (!search) return res.json({ ok: false, error: 'search required' });

    const data = await getOrders({ search, limit: 5 });
    const items = (data && (data.results || data.items || data.data)) || (Array.isArray(data) ? data : []);
    const unwrapped = Array.isArray(items) && items.length === 1 && items[0] && Array.isArray(items[0].results) ? items[0].results : items;
    if (!unwrapped || !unwrapped.length) return res.json({ ok: false, error: `No shipment found for "${search}"` });

    // Search wygląda jak konkretny numer GK/kuriera → bierz DOKŁADNIE tę
    // paczkę, nie pierwszą z listy. GK przy bliźniaczych wysyłkach (np.
    // FedEx aktywna + DPD anulowana dla tego samego odbiorcy) zwracał
    // najpierw tę złą — podgląd pokazywał tracking ANULOWANEJ paczki.
    // Ten sam bezpiecznik co w ścieżce wysyłki (looksLikeTracking).
    let shipment = unwrapped[0];
    const wanted = String(search).trim();
    if (/^(?:GK)?\d{9,}$/i.test(wanted)) {
      const exact = unwrapped.find(o =>
        String(o.trackingNumber || '').trim() === wanted ||
        String(o.tracking || '').trim() === wanted ||
        String(o.number || '').trim() === wanted ||
        String(o.orderNumber || '').trim() === wanted ||
        String(o.hash || '').trim() === wanted);
      if (!exact) {
        return res.json({
          ok: false,
          error: `Podano konkretny numer "${wanted}", ale GK zwrócił ${unwrapped.length} innych paczek — nie podstawiam cudzej/anulowanej.`,
          gotShipmentNumbers: unwrapped.slice(0, 5).map(o => ({
            orderNumber: o.number || o.orderNumber,
            tracking: o.trackingNumber || o.tracking,
            carrier: (o.carrier && typeof o.carrier === 'object') ? o.carrier.name : o.carrier,
          })),
        });
      }
      shipment = exact;
    }
    const recv = shipment.receiverAddress || shipment.receiver || {};
    let trackingNumber = shipment.trackingNumber || shipment.tracking || '';
    // Świeża paczka bywa bez numeru kuriera w liście GK — dociągnij go jak w
    // ścieżce wysyłki (tracking endpoint, potem etykieta PDF), żeby podgląd
    // i share miały działający link.
    if (!trackingNumber) {
      const ordNum = shipment.number || shipment.orderNumber;
      if (ordNum) {
        try {
          const { getOrderTracking } = require('../glob-client');
          const t = await getOrderTracking(ordNum);
          const candidate = t && (t.trackingNumber || t.tracking
            || (t.parcels && t.parcels[0] && t.parcels[0].trackingNumber)
            || (t.statuses && t.statuses[0] && t.statuses[0].number)
            || (Array.isArray(t) && t[0] && t[0].trackingNumber));
          if (candidate && String(candidate).trim()) trackingNumber = String(candidate).trim();
        } catch (e) { console.warn('[send-tracking-email/preview] getOrderTracking failed:', e.message); }
      }
      if (!trackingNumber && shipment.hash) {
        try {
          const { extractTrackingFromLabel } = require('../services/label-tracking');
          const fromLabel = await extractTrackingFromLabel(shipment.hash);
          if (fromLabel) trackingNumber = fromLabel;
        } catch (e) { console.warn('[send-tracking-email/preview] label tracking failed:', e.message); }
      }
    }
    // Kurier z GK bywa OBIEKTEM {name:...} — bez rozpakowania w mailu lądował
    // "[object Object]".
    const rawCarrier = shipment.courierName || shipment.carrier || shipment.productName || '';
    const carrierName = (rawCarrier && typeof rawCarrier === 'object') ? (rawCarrier.name || '') : rawCarrier;
    const trackingUrl = buildTrackingUrl(carrierName, trackingNumber);

    // NASZ własny adres (delivery@... zapisany w GK jako mail odbiorcy, gdy
    // klient nie miał maila) NIE jest odbiorcą trackingu — filtr jak w send.
    let toEmail = '';
    if (isEmailAddr(contractorEmailOverride) && !isOwnEmailAddr(contractorEmailOverride)) toEmail = contractorEmailOverride.trim();
    else if (isEmailAddr(recv.email) && !isOwnEmailAddr(recv.email)) toEmail = recv.email.trim();
    let resolvedContractor = null;
    if (!toEmail) {
      const all = await prisma.contractor.findMany({
        select: { id: true, name: true, email: true, primaryEmail: true, country: true, nip: true },
      });
      const recvName = (recv.name || recv.companyName || recv.contactPerson || '').trim();
      if (recvName) {
        // Próg 75, nie 50 — jedno wspólne słowo nazwy nie może podstawić
        // CUDZEGO maila (lekcja z "Salty Crew" → "Tarifa Crew").
        const scored = all.map(c => ({ c, s: scoreContractor(c, recvName) })).filter(x => x.s >= 75).sort((a, b) => b.s - a.s);
        if (scored.length) {
          resolvedContractor = scored[0].c;
          const cand = resolvedContractor.primaryEmail || resolvedContractor.email || '';
          if (isEmailAddr(cand) && !isOwnEmailAddr(cand)) toEmail = cand.trim();
        }
      }
    }
    // BRAK maila kontrahenta ≠ brak podglądu: CRM używa preview też do
    // „Udostępnij" (share/WhatsApp/Messenger), gdzie adres nie jest potrzebny.
    // Zwracamy skomponowaną wiadomość z pustym `to` — front blokuje tylko
    // przycisk „Wyślij mailem".
    const country = resolveTrackingCountry({ contractor: resolvedContractor, recvCountry: recv.country, recvName: recv.name, email: toEmail });
    const lang = await resolveTrackingLang(prisma, resolvedContractor, country);
    const reference = [recv.name || recv.companyName, recv.city].filter(Boolean).join(', ') || null;
    const msg = compose({ country, lang, trackingNumber, carrier: carrierName, trackingUrl, reference });

    // Check if already sent
    const alreadySent = toEmail ? await prisma.email.findFirst({
      where: { direction: 'OUTBOUND', toEmail: { equals: toEmail, mode: 'insensitive' }, subject: { contains: trackingNumber } },
      select: { id: true, createdAt: true },
    }) : null;

    res.json({
      ok: true,
      preview: {
        to: toEmail,
        subject: msg.subject,
        body: msg.text,
        html: msg.html,
        trackingUrl,
        trackingNumber,
        carrier: carrierName,
        country,
        recipientName: recv.name || recv.companyName || '',
        recipientCity: recv.city || '',
        contractorId: resolvedContractor?.id || null,
        contractorName: resolvedContractor?.name || null,
      },
      alreadySent: alreadySent ? { id: alreadySent.id, date: alreadySent.createdAt } : null,
      shipmentNumber: shipment.number || shipment.orderNumber || null,
    });
  } catch (e) {
    console.error('[send-tracking-email/preview]', e.message);
    res.json({ ok: false, error: e.message });
  }
});

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
    res.status(500).json({ error: e.message });
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

    // 2. Resolve recipient. toEmail explicit > kontrahent (po contractorId ORAZ
    //    po NIP z faktury) — z pola primaryEmail/email LUB z kontaktów
    //    (ContractorContact type=email). Wcześniej sprawdzaliśmy tylko główne pole
    //    jednego rekordu → agent mówił "brak emaila" mimo że mail JEST w karcie.
    const contractor = invoice.contractorId
      ? await prisma.contractor.findUnique({ where: { id: invoice.contractorId } })
      : null;
    const looksLikeEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
    let to = looksLikeEmail(toEmail) ? toEmail.trim() : null;
    let toSource = to ? 'request' : null;
    if (!to) {
      const candidateIds = new Set();
      if (invoice.contractorId) candidateIds.add(invoice.contractorId);
      const nip = (invoice.contractorNip || (contractor && contractor.nip) || '').replace(/[^0-9A-Za-z]/g, '');
      if (nip) {
        const byNip = await prisma.contractor.findMany({ where: { nip: { contains: nip } }, select: { id: true }, take: 10 }).catch(() => []);
        for (const c of byNip) candidateIds.add(c.id);
      }
      if (candidateIds.size) {
        const ids = [...candidateIds];
        const mains = await prisma.contractor.findMany({
          where: { id: { in: ids } },
          select: { primaryEmail: true, email: true },
        }).catch(() => []);
        for (const m of mains) {
          if (!to && looksLikeEmail(m.primaryEmail)) { to = m.primaryEmail.trim(); toSource = 'contractor.primaryEmail'; }
          if (!to && looksLikeEmail(m.email)) { to = m.email.trim(); toSource = 'contractor.email'; }
        }
        if (!to) {
          const contacts = await prisma.contractorContact.findMany({ where: { contractorId: { in: ids }, type: 'email' } }).catch(() => []);
          const valid = contacts.filter(c => looksLikeEmail(c.value));
          if (valid.length) {
            const LABEL_PRIO = { accounting: 1, billing: 2, office: 3, sales: 4, support: 5, shipping: 6 };
            valid.sort((a, b) => {
              if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
              return (LABEL_PRIO[String(a.label || '').toLowerCase()] || 9) - (LABEL_PRIO[String(b.label || '').toLowerCase()] || 9);
            });
            to = valid[0].value; toSource = 'contractor_contact';
          }
        }
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

    // 4. Wybierz jezyk odbiorcy. Priorytet (regula biznesowa):
    //    1. contractor.country  2. jezyk ostatniego maila OD kontrahenta  3. EN.
    //    TLD adresu pominiety — klient bywa na gmail/outlook, TLD nic nie mowi.
    function detectLangFromBody(text) {
      if (!text) return null;
      const t = String(text).toLowerCase();
      const patterns = [
        { lang: 'fr', words: ['bonjour', 'cordialement', 'merci', 'votre', 'pouvez', 'nous sommes'] },
        { lang: 'es', words: ['hola', 'saludos', 'gracias', 'buenos días', 'buenas tardes', 'estamos', 'somos'] },
        { lang: 'it', words: ['buongiorno', 'grazie', 'cordiali saluti', 'siamo', 'vorrei'] },
        { lang: 'pt', words: ['olá', 'obrigado', 'cumprimentos', 'estamos', 'somos'] },
        { lang: 'de', words: ['guten tag', 'mit freundlichen', 'danke', 'wir sind', 'ihre'] },
        { lang: 'nl', words: ['geachte', 'met vriendelijke groet', 'bedankt', 'wij zijn', 'kunnen we', 'bestelling', 'onderstaand'] },
        { lang: 'pl', words: ['dzień dobry', 'pozdrawiam', 'dziękuję', 'jesteśmy'] },
      ];
      let best = null, bestScore = 0;
      for (const p of patterns) {
        const score = p.words.filter(w => t.includes(w)).length;
        if (score > bestScore) { bestScore = score; best = p.lang; }
      }
      return bestScore >= 2 ? best : null;
    }
    let lang = countryToLang(contractor && contractor.country);
    let langSource = lang ? 'contractor.country' : null;
    if (!lang && invoice.contractorId) {
      try {
        const lastIn = await prisma.email.findFirst({
          where: { contractorId: invoice.contractorId, direction: 'INBOUND' },
          orderBy: { createdAt: 'desc' },
          select: { bodyFull: true, bodyPreview: true },
        });
        const detected = detectLangFromBody(lastIn && (lastIn.bodyFull || lastIn.bodyPreview));
        if (detected) { lang = detected; langSource = 'contractor_last_email'; }
      } catch (_) { /* ignore */ }
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
