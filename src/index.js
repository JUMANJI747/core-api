const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { sendMail, findAccount, extractInbox, getAccounts } = require("./mail-sender");

const prisma = new PrismaClient();
const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = (process.env.API_KEY || "").trim();

// ============ AUTH MIDDLEWARE ============
function auth(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers["x-api-key"] || "";
  if (key.trim() !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}
app.use("/api", auth);

// ============ HEALTH ============
app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: true });
  } catch (e) {
    res.json({ ok: true, db: false, error: e.message });
  }
});

// ============ CONTRACTORS ============
app.post("/api/contractors/upsert", async (req, res) => {
  try {
    const { name, nip, type, phone, email, country, city, address, notes, extras, tags, source } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });

    let contractor;
    if (nip) {
      contractor = await prisma.contractor.upsert({
        where: { nip },
        update: { name, type, phone, email, country, city, address, notes, extras, tags, source },
        create: { name, nip, type: type || "BUSINESS", phone, email, country, city, address, notes, extras: extras || {}, tags: tags || [], source },
      });
    } else {
      contractor = await prisma.contractor.create({
        data: { name, type: type || "PERSON", phone, email, country, city, address, notes, extras: extras || {}, tags: tags || [], source },
      });
    }
    res.json(contractor);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/contractors", async (req, res) => {
  const { search, country, tag, limit } = req.query;
  const where = {};
  if (search) where.name = { contains: search, mode: "insensitive" };
  if (country) where.country = { equals: country, mode: "insensitive" };
  if (tag) where.tags = { has: tag };
  const contractors = await prisma.contractor.findMany({ where, take: parseInt(limit) || 50, orderBy: { updatedAt: "desc" } });
  res.json(contractors);
});

app.get("/api/contractors/:id", async (req, res) => {
  const c = await prisma.contractor.findUnique({ where: { id: req.params.id }, include: { deals: true, consignments: true, emails: { take: 10, orderBy: { createdAt: "desc" } } } });
  if (!c) return res.status(404).json({ error: "not found" });
  res.json(c);
});

// ============ DEALS (PIPELINE) ============
app.post("/api/deals", async (req, res) => {
  try {
    const { contractorId, status, language, campaign, value, currency, notes, nextAction, nextActionDate } = req.body;
    if (!contractorId) return res.status(400).json({ error: "contractorId required" });
    const deal = await prisma.deal.create({
      data: { contractorId, status: status || "LEAD", language, campaign, value, currency, notes, nextAction, nextActionDate: nextActionDate ? new Date(nextActionDate) : null },
    });
    await prisma.activity.create({ data: { dealId: deal.id, type: "STATUS_CHANGE", note: `Created as ${deal.status}`, actor: "system" } });
    res.json(deal);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/deals/:id/status", async (req, res) => {
  try {
    const { status, note, actor } = req.body;
    if (!status) return res.status(400).json({ error: "status required" });
    const deal = await prisma.deal.update({ where: { id: req.params.id }, data: { status, updatedAt: new Date() } });
    await prisma.activity.create({ data: { dealId: deal.id, type: "STATUS_CHANGE", note: note || `→ ${status}`, actor: actor || "user" } });
    res.json(deal);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/deals/:id/activity", async (req, res) => {
  try {
    const { type, note, data, actor } = req.body;
    const activity = await prisma.activity.create({
      data: { dealId: req.params.id, type: type || "NOTE", note, data: data || {}, actor: actor || "user" },
    });
    res.json(activity);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/deals", async (req, res) => {
  const { status, campaign, limit } = req.query;
  const where = {};
  if (status) where.status = status;
  if (campaign) where.campaign = { contains: campaign, mode: "insensitive" };
  const deals = await prisma.deal.findMany({ where, include: { contractor: true, activities: { take: 5, orderBy: { createdAt: "desc" } } }, take: parseInt(limit) || 50, orderBy: { updatedAt: "desc" } });
  res.json(deals);
});

app.get("/api/deals/:id", async (req, res) => {
  const deal = await prisma.deal.findUnique({ where: { id: req.params.id }, include: { contractor: true, activities: { orderBy: { createdAt: "desc" } } } });
  if (!deal) return res.status(404).json({ error: "not found" });
  res.json(deal);
});

// ============ CONSIGNMENTS (KOMIS) ============
app.post("/api/consignments/open", async (req, res) => {
  try {
    const { contractorId, notes } = req.body;
    if (!contractorId) return res.status(400).json({ error: "contractorId required" });
    const c = await prisma.consignment.create({ data: { contractorId, notes } });
    res.json(c);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/consignments/:id/received", async (req, res) => {
  try {
    const { items } = req.body; // [{name, unitPrice, qty}]
    if (!items?.length) return res.status(400).json({ error: "items required" });
    const results = [];
    for (const item of items) {
      const existing = await prisma.consignmentItem.findUnique({
        where: { consignmentId_name: { consignmentId: req.params.id, name: item.name } },
      });
      if (existing) {
        const updated = await prisma.consignmentItem.update({
          where: { id: existing.id },
          data: { qtyReceived: existing.qtyReceived + (item.qty || 1), unitPrice: item.unitPrice || existing.unitPrice },
        });
        results.push(updated);
      } else {
        const created = await prisma.consignmentItem.create({
          data: { consignmentId: req.params.id, name: item.name, unitPrice: item.unitPrice || 0, qtyReceived: item.qty || 1 },
        });
        results.push(created);
      }
    }
    res.json({ ok: true, items: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/consignments/:id/returned", async (req, res) => {
  try {
    const { items } = req.body; // [{name, qty, note?}]
    if (!items?.length) return res.status(400).json({ error: "items required" });
    const results = [];
    for (const item of items) {
      const found = await prisma.consignmentItem.findFirst({
        where: { consignmentId: req.params.id, name: { equals: item.name, mode: "insensitive" } },
        include: { returns: true },
      });
      if (!found) { results.push({ name: item.name, error: "not found" }); continue; }
      const totalReturned = found.returns.reduce((s, r) => s + r.qty, 0);
      const maxReturn = found.qtyReceived - totalReturned;
      const qty = Math.min(item.qty || 1, maxReturn);
      if (qty <= 0) { results.push({ name: item.name, error: "nothing to return" }); continue; }
      const ret = await prisma.consignmentReturn.create({ data: { itemId: found.id, qty, note: item.note } });
      results.push({ name: item.name, returned: qty, ret });
    }
    res.json({ ok: true, items: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/consignments/:id/summary", async (req, res) => {
  try {
    const consignment = await prisma.consignment.findUnique({
      where: { id: req.params.id },
      include: { contractor: true, items: { include: { returns: true } } },
    });
    if (!consignment) return res.status(404).json({ error: "not found" });

    let totalValue = 0;
    const lines = consignment.items.map((item) => {
      const returned = item.returns.reduce((s, r) => s + r.qty, 0);
      const sold = item.qtyReceived - returned;
      const value = sold * item.unitPrice;
      totalValue += value;
      return { name: item.name, unitPrice: item.unitPrice, received: item.qtyReceived, returned, sold, value };
    });

    res.json({
      id: consignment.id,
      contractor: consignment.contractor.name,
      status: consignment.status,
      lines,
      totalValue,
      createdAt: consignment.createdAt,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/consignments/:id/settle", async (req, res) => {
  try {
    const { method, note } = req.body; // NO_INVOICE | INVOICE | CASH | TRANSFER
    const consignment = await prisma.consignment.update({
      where: { id: req.params.id },
      data: { status: "SETTLED", settledAt: new Date(), notes: note },
    });
    await prisma.auditLog.create({
      data: { actor: "user", action: "CONSIGNMENT_SETTLED", entityType: "consignment", entityId: req.params.id, payload: { method, note } },
    });
    res.json(consignment);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/consignments", async (req, res) => {
  const { status, contractorId } = req.query;
  const where = {};
  if (status) where.status = status;
  if (contractorId) where.contractorId = contractorId;
  const list = await prisma.consignment.findMany({ where, include: { contractor: true }, orderBy: { createdAt: "desc" } });
  res.json(list);
});

// ============ EMAILS (INBOX) ============
app.post("/api/emails", async (req, res) => {
  try {
    const email = await prisma.email.create({ data: req.body });
    // Auto-link to contractor by email
    if (email.direction === "INBOUND" && email.fromEmail) {
      const contractor = await prisma.contractor.findFirst({ where: { email: { equals: email.fromEmail, mode: "insensitive" } } });
      if (contractor) {
        await prisma.email.update({ where: { id: email.id }, data: { contractorId: contractor.id } });
      }
    }
    res.json(email);
  } catch (e) {
    if (e.code === "P2002") return res.json({ ok: true, duplicate: true });
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/emails", async (req, res) => {
  const { inbox, direction, isRead, limit, fromEmail, search, contractorId } = req.query;
  const where = {};
  if (inbox) where.inbox = inbox;
  if (direction) where.direction = direction;
  if (isRead !== undefined) where.isRead = isRead === "true";
  if (fromEmail) where.fromEmail = { contains: fromEmail, mode: "insensitive" };
  if (contractorId) where.contractorId = contractorId;
  if (search) {
    const searchTerm = search.includes('@') ? search.split('@')[0] : search;
    where.OR = [
      { fromEmail: { contains: searchTerm, mode: "insensitive" } },
      { fromName: { contains: searchTerm, mode: "insensitive" } },
      { subject: { contains: searchTerm, mode: "insensitive" } },
    ];
  }
  const take = Math.min(parseInt(limit) || 20, 100);
  const emails = await prisma.email.findMany({ where, include: { contractor: true }, take, orderBy: { createdAt: "desc" } });
  res.json(emails);
});

app.patch("/api/emails/:id/read", async (req, res) => {
  const email = await prisma.email.update({ where: { id: req.params.id }, data: { isRead: true } });
  res.json(email);
});

// ============ SEND EMAIL (HITL) ============

app.post("/api/send-email", async (req, res) => {
  try {
    const { from, to, subject, body, replyTo, draft = true } = req.body;
    if (!from || !to || !subject || !body) {
      return res.status(400).json({ error: "from, to, subject, body are required" });
    }

    const account = findAccount(from);
    if (!account) {
      const available = getAccounts().map(a => a.user).join(", ");
      return res.status(400).json({ error: `Unknown sender address, available: ${available}` });
    }

    if (draft) {
      // Save as DRAFT — no SMTP
      let contractorId = null;
      const contractor = await prisma.contractor.findFirst({
        where: { email: { contains: to, mode: "insensitive" } },
      });
      if (contractor) contractorId = contractor.id;

      const saved = await prisma.email.create({
        data: {
          direction: "DRAFT",
          inbox: extractInbox(from),
          fromEmail: from,
          toEmail: to,
          subject: subject || null,
          bodyPreview: (body || "").slice(0, 300),
          bodyFull: (body || "").slice(0, 2000),
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

    // Send immediately
    const saved = await sendMail({ from, to, subject, body, replyTo });
    return res.json({ ok: true, sent: true, emailId: saved.id });
  } catch (e) {
    const status = e.message.startsWith("Rate limit") ? 429 : 500;
    res.status(status).json({ error: e.message });
  }
});

app.get("/api/send-email/drafts", async (req, res) => {
  const drafts = await prisma.email.findMany({
    where: { direction: "DRAFT" },
    select: { id: true, fromEmail: true, toEmail: true, subject: true, bodyPreview: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  res.json(drafts);
});

app.post("/api/send-email/confirm", async (req, res) => {
  try {
    const { emailId } = req.body;
    if (!emailId) return res.status(400).json({ error: "emailId is required" });
    const email = await prisma.email.findUnique({ where: { id: emailId } });
    if (!email) return res.status(404).json({ error: "Email not found" });
    if (email.direction !== "DRAFT") return res.status(400).json({ error: "Not a draft" });

    await sendMail({
      from: email.fromEmail,
      to: email.toEmail,
      subject: email.subject || "",
      body: email.bodyFull || "",
      replyTo: email.inReplyTo || undefined,
    });

    await prisma.email.update({ where: { id: email.id }, data: { direction: "OUTBOUND" } });

    return res.json({ ok: true, sent: true, emailId: email.id, from: email.fromEmail, to: email.toEmail, subject: email.subject, message: `Mail wysłany z ${email.fromEmail} do ${email.toEmail}, temat: ${email.subject}` });
  } catch (e) {
    const status = e.message.startsWith("Rate limit") ? 429 : 500;
    res.status(status).json({ error: e.message });
  }
});

app.post("/api/send-email/:id/confirm", async (req, res) => {
  try {
    const email = await prisma.email.findUnique({ where: { id: req.params.id } });
    if (!email) return res.status(404).json({ error: "Email not found" });
    if (email.direction !== "DRAFT") return res.status(400).json({ error: "Not a draft" });

    await sendMail({
      from: email.fromEmail,
      to: email.toEmail,
      subject: email.subject || "",
      body: email.bodyFull || "",
      replyTo: email.inReplyTo || undefined,
    });

    await prisma.email.update({ where: { id: email.id }, data: { direction: "OUTBOUND" } });

    return res.json({
      ok: true,
      sent: true,
      emailId: email.id,
      message: `Sent from ${email.fromEmail} to ${email.toEmail}`,
    });
  } catch (e) {
    const status = e.message.startsWith("Rate limit") ? 429 : 500;
    res.status(status).json({ error: e.message });
  }
});

// ============ MAILING CONTACTS ============
app.post("/api/mailing/import", async (req, res) => {
  try {
    const { contacts, campaign } = req.body; // [{email, name, website, phone, region, country}]
    if (!contacts?.length) return res.status(400).json({ error: "contacts required" });
    let created = 0, skipped = 0;
    for (const c of contacts) {
      try {
        await prisma.mailingContact.create({
          data: { ...c, campaign: campaign || c.campaign, status: "PENDING" },
        });
        created++;
      } catch (e) {
        if (e.code === "P2002") skipped++;
        else throw e;
      }
    }
    res.json({ ok: true, created, skipped, total: contacts.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/mailing/pending", async (req, res) => {
  const { campaign, limit } = req.query;
  const where = { status: "PENDING" };
  if (campaign) where.campaign = { contains: campaign, mode: "insensitive" };
  const contacts = await prisma.mailingContact.findMany({ where, take: parseInt(limit) || 200, orderBy: { createdAt: "asc" } });
  res.json(contacts);
});

app.patch("/api/mailing/:id/sent", async (req, res) => {
  const { sentFrom, sentVariant } = req.body;
  const contact = await prisma.mailingContact.update({
    where: { id: req.params.id },
    data: { status: "SENT", sentAt: new Date(), sentFrom, sentVariant },
  });
  res.json(contact);
});

app.get("/api/mailing/stats", async (req, res) => {
  const { campaign } = req.query;
  const where = campaign ? { campaign: { contains: campaign, mode: "insensitive" } } : {};
  const total = await prisma.mailingContact.count({ where });
  const pending = await prisma.mailingContact.count({ where: { ...where, status: "PENDING" } });
  const sent = await prisma.mailingContact.count({ where: { ...where, status: "SENT" } });
  const replied = await prisma.mailingContact.count({ where: { ...where, status: "REPLIED" } });
  const bounced = await prisma.mailingContact.count({ where: { ...where, status: "BOUNCED" } });
  const clients = await prisma.mailingContact.count({ where: { ...where, status: "CLIENT" } });
  res.json({ campaign: campaign || "all", total, pending, sent, replied, bounced, clients });
});

// ============ CONFIG ============
app.get("/api/config", async (req, res) => {
  const configs = await prisma.config.findMany();
  const obj = {};
  configs.forEach((c) => (obj[c.key] = c.value));
  res.json(obj);
});

app.put("/api/config/:key", async (req, res) => {
  const { value } = req.body;
  const config = await prisma.config.upsert({
    where: { key: req.params.key },
    update: { value: String(value) },
    create: { key: req.params.key, value: String(value) },
  });
  res.json(config);
});

// ============ MEMORY ============
app.get("/api/memory", async (req, res) => {
  const { limit } = req.query;
  const messages = await prisma.memory.findMany({ take: parseInt(limit) || 20, orderBy: { createdAt: "desc" } });
  res.json(messages.reverse());
});

app.post("/api/memory", async (req, res) => {
  const { role, content } = req.body;
  const msg = await prisma.memory.create({ data: { role, content } });
  res.json(msg);
});

app.delete("/api/memory/clear", async (req, res) => {
  await prisma.memory.deleteMany();
  res.json({ ok: true });
});

// ============ AUDIT ============
app.post("/api/audit", async (req, res) => {
  const log = await prisma.auditLog.create({ data: req.body });
  res.json(log);
});

// ============ DASHBOARD STATS ============
app.get("/api/stats", async (req, res) => {
  const [contractors, openDeals, openConsignments, unreadEmails, pendingMailing] = await Promise.all([
    prisma.contractor.count(),
    prisma.deal.count({ where: { status: { notIn: ["PAID", "CLIENT", "LOST"] } } }),
    prisma.consignment.count({ where: { status: "OPEN" } }),
    prisma.email.count({ where: { isRead: false, direction: "INBOUND" } }),
    prisma.mailingContact.count({ where: { status: "PENDING" } }),
  ]);
  res.json({ contractors, openDeals, openConsignments, unreadEmails, pendingMailing });
});

// ============ NIP VERIFICATION ============
app.post("/api/contractors/verify-nip", async (req, res) => {
  try {
    let { nip, country } = req.body;
    if (!nip) return res.status(400).json({ error: "nip required" });
    nip = nip.trim().replace(/[\s\-]/g, "").toUpperCase();
    if (country) country = country.trim().toUpperCase();

    const hasPrefix = /^[A-Z]{2}/.test(nip);
    if (!hasPrefix) {
      if (country) {
        nip = country + nip;
      } else if (/^\d{10}$/.test(nip)) {
        nip = "PL" + nip;
      } else {
        return res.status(400).json({ error: "Cannot determine country for NIP. Provide country (e.g. 'ES') or use a NIP with country prefix (e.g. 'ESB12345678')." });
      }
    }

    const isPolish = /^PL\d{10}$/.test(nip);

    if (isPolish) {
      const nipNum = nip.slice(2);
      const today = new Date().toISOString().slice(0, 10);

      const mfRes = await fetch(`https://wl-api.mf.gov.pl/api/search/nip/${nipNum}?date=${today}`);
      if (mfRes.status === 404) return res.status(404).json({ error: "Company not found" });
      if (!mfRes.ok) return res.status(502).json({ error: "MF API error", status: mfRes.status });

      const mfData = await mfRes.json();
      const s = mfData?.result?.subject;
      if (!s) return res.status(404).json({ error: "Company not found" });

      return res.json({ source: "MF", nip: nipNum, name: s.name, regon: s.regon, krs: s.krs, address: s.workingAddress, statusVat: s.statusVat });
    } else {
      // European VAT — VIES
      const countryCode = nip.slice(0, 2);
      const vatNumber = nip.slice(2);

      const viesRes = await fetch("https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ countryCode, vatNumber }),
      });

      if (!viesRes.ok) return res.status(502).json({ error: "VIES API error", status: viesRes.status });
      const data = await viesRes.json();

      console.log(`[verify-nip] VIES response: valid=${data.valid}, name=${data.name}`);

      return res.json({ source: "VIES", nip, countryCode, vatNumber, valid: data.valid === true, name: data.name, address: data.address, requestDate: data.requestDate });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ START ============
app.listen(PORT, () => {
  console.log(`Core API running on port ${PORT}`);
});

// ============ INBOX POLLER ============
require('./inbox-poller');
