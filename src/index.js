const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { sendMail, findAccount, extractInbox, getAccounts } = require("./mail-sender");
const { sendTelegram } = require("./telegram-utils");

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

    // Find existing by nip or email
    let existing = null;
    if (nip) existing = await prisma.contractor.findUnique({ where: { nip } });
    if (!existing && email) existing = await prisma.contractor.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });

    let contractor;
    if (existing) {
      // Additive merge
      const mergedExtras = { ...(existing.extras || {}), ...(extras || {}) };

      if (nip && existing.nip && nip !== existing.nip) {
        mergedExtras.nipList = Array.from(new Set([existing.nip, nip, ...(mergedExtras.nipList || [])]));
      }
      if (phone && existing.phone && phone !== existing.phone) {
        mergedExtras.phoneList = Array.from(new Set([existing.phone, phone, ...(mergedExtras.phoneList || [])]));
      }
      if (email && existing.email && email.toLowerCase() !== existing.email.toLowerCase()) {
        mergedExtras.emailList = Array.from(new Set([existing.email, email, ...(mergedExtras.emailList || [])]));
      }

      const mergedTags = Array.from(new Set([...(existing.tags || []), ...(tags || [])]));

      contractor = await prisma.contractor.update({
        where: { id: existing.id },
        data: {
          name,
          ...(type !== undefined ? { type } : {}),
          ...(address !== undefined ? { address } : {}),
          ...(city !== undefined ? { city } : {}),
          ...(country !== undefined ? { country } : {}),
          ...(notes !== undefined ? { notes } : {}),
          ...(source !== undefined ? { source } : {}),
          extras: mergedExtras,
          tags: mergedTags,
        },
      });
    } else {
      contractor = await prisma.contractor.create({
        data: { name, nip, type: type || (nip ? "BUSINESS" : "PERSON"), phone, email, country, city, address, notes, extras: extras || {}, tags: tags || [], source },
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

app.post("/api/contractors/:id/alias", async (req, res) => {
  try {
    const { alias } = req.body;
    if (!alias || typeof alias !== "string") return res.status(400).json({ error: "alias required" });
    const c = await prisma.contractor.findUnique({ where: { id: req.params.id } });
    if (!c) return res.status(404).json({ error: "contractor not found" });
    const extras = c.extras || {};
    const aliases = Array.isArray(extras.aliases) ? extras.aliases : [];
    const normalized = alias.trim().toLowerCase();
    if (!aliases.includes(normalized)) aliases.push(normalized);
    await prisma.contractor.update({ where: { id: req.params.id }, data: { extras: { ...extras, aliases } } });
    res.json({ ok: true, aliases });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

app.get("/api/emails/recent", async (req, res) => {
  const take = Math.min(parseInt(req.query.limit) || 50, 100);
  const emails = await prisma.email.findMany({
    select: { id: true, fromEmail: true, fromName: true, subject: true, bodyPreview: true, tags: true, inbox: true, createdAt: true, contractor: { select: { name: true, country: true } } },
    orderBy: { createdAt: "desc" },
    take,
  });
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

// ============ PRODUCTS ============
const SEED_PRODUCTS = [
  {ean:"5902082579014", name:"SURF CARE hydrating cream", category:"pielęgnacja", capacity:"30g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082579021", name:"SURF GEL extreme waterproof gel spf 50+", category:"ochrona słoneczna", capacity:"40g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082579045", name:"SURF DAILY protection spf 50", category:"ochrona słoneczna", capacity:"30g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082579052", name:"SURF LIPS lip balm spf 50+", category:"ochrona słoneczna", pricePLN:18, priceEUR:4.5},
  {ean:"5902082556022", name:"SURF STICK zinc stick spf 50+", category:"ochrona słoneczna", variant:"Blue", capacity:"6.8g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082556053", name:"SURF STICK zinc stick spf 50+", category:"ochrona słoneczna", variant:"Pink", capacity:"6.8g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082556046", name:"SURF STICK zinc stick spf 50+", category:"ochrona słoneczna", variant:"Purple", capacity:"6.8g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082556039", name:"SURF STICK zinc stick spf 50+", category:"ochrona słoneczna", variant:"Mint", capacity:"6.8g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082564935", name:"SURF STICK zinc stick spf 50+", category:"ochrona słoneczna", variant:"White", capacity:"6.8g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082564942", name:"SURF STICK zinc stick spf 50+", category:"ochrona słoneczna", variant:"Skin", capacity:"6.8g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082576150", name:"SURF GIRL waterproof mascara", category:"makijaż", variant:"Blue", capacity:"9ml", pricePLN:18, priceEUR:4.5},
  {ean:"5902082576167", name:"SURF GIRL waterproof mascara", category:"makijaż", variant:"Mint", capacity:"9ml", pricePLN:18, priceEUR:4.5},
  {ean:"5902082576174", name:"SURF GIRL waterproof mascara", category:"makijaż", variant:"Pink", capacity:"9ml", pricePLN:18, priceEUR:4.5},
  {ean:"5902082576181", name:"SURF GIRL waterproof mascara", category:"makijaż", variant:"Black", capacity:"9ml", pricePLN:18, priceEUR:4.5},
  {ean:"BOX-STICK-30", name:"Surf Stick Box / Ekspozytor", category:"template", capacity:"30 szt", variant:"mixed", pricePLN:540, priceEUR:135, unit:"box", extras:{isTemplate:true, composition:[{ean:"5902082556022",variant:"Blue",qty:5},{ean:"5902082556053",variant:"Pink",qty:5},{ean:"5902082556046",variant:"Purple",qty:5},{ean:"5902082556039",variant:"Mint",qty:5},{ean:"5902082564935",variant:"White",qty:5},{ean:"5902082564942",variant:"Skin",qty:5}],totalQty:30}},
  {ean:"BOX-MASCARA-30", name:"Surf Girl Mascara Box", category:"template", capacity:"30 szt", variant:"mixed", pricePLN:540, priceEUR:135, unit:"box", extras:{isTemplate:true, composition:[{ean:"5902082576181",variant:"Black",qty:12},{ean:"5902082576167",variant:"Mint",qty:6},{ean:"5902082576174",variant:"Pink",qty:6},{ean:"5902082576150",variant:"Blue",qty:6}],totalQty:30}},
  {ean:"BOX-COLLECTION-30", name:"Surf Collection Box", category:"template", capacity:"30 szt", variant:"mixed", pricePLN:540, priceEUR:135, unit:"box", extras:{isTemplate:true, composition:[{ean:"5902082579052",variant:"Lip Balm",qty:12},{ean:"5902082579021",variant:"Gel SPF50+",qty:6},{ean:"5902082579045",variant:"Daily UV SPF50+",qty:6},{ean:"5902082579014",variant:"Hydrating Cream",qty:6}],totalQty:30}},
];

app.get("/api/products/expand-box", async (req, res) => {
  try {
    const { ean, qty } = req.query;
    if (!ean) return res.status(400).json({ error: "ean required" });
    const multiplier = Math.max(1, parseInt(qty) || 1);

    const template = await prisma.product.findUnique({ where: { ean } });
    if (!template) return res.status(404).json({ error: "product not found" });

    const composition = template.extras && template.extras.composition;
    if (!composition || !Array.isArray(composition)) return res.status(400).json({ error: "product has no composition" });

    const eans = composition.map(c => c.ean);
    const products = await prisma.product.findMany({ where: { ean: { in: eans } } });
    const byEan = Object.fromEntries(products.map(p => [p.ean, p]));

    const lines = composition.map(c => {
      const p = byEan[c.ean] || {};
      return {
        ean: c.ean,
        name: p.name || null,
        variant: c.variant || p.variant || null,
        qty: c.qty * multiplier,
        pricePLN: p.pricePLN ?? null,
        priceEUR: p.priceEUR ?? null,
      };
    });

    res.json(lines);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/products", async (req, res) => {
  const { category, active } = req.query;
  const where = {};
  if (category) where.category = { equals: category, mode: "insensitive" };
  if (active !== undefined) where.active = active === "true";
  const products = await prisma.product.findMany({ where, orderBy: { category: "asc" } });
  res.json(products);
});

app.post("/api/products/seed", async (req, res) => {
  try {
    let created = 0, updated = 0;
    for (const p of SEED_PRODUCTS) {
      const data = { ...p, extras: p.extras || {} };
      const existing = await prisma.product.findUnique({ where: { ean: p.ean } });
      if (existing) {
        await prisma.product.update({ where: { ean: p.ean }, data: { name: p.name, variant: p.variant ?? null, category: p.category, capacity: p.capacity ?? null, pricePLN: p.pricePLN, priceEUR: p.priceEUR } });
        updated++;
      } else {
        await prisma.product.create({ data });
        created++;
      }
    }
    res.json({ ok: true, created, updated, total: SEED_PRODUCTS.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ EVENTS ============
app.get("/api/events", async (req, res) => {
  const { type, severity, resolved, limit, since } = req.query;
  const where = {};
  if (type) where.type = type;
  if (severity) where.severity = severity;
  if (resolved !== undefined) where.resolved = resolved === "true";
  if (since) where.createdAt = { gte: new Date(since) };
  const events = await prisma.systemEvent.findMany({
    where,
    take: Math.min(parseInt(limit) || 50, 500),
    orderBy: { createdAt: "desc" },
  });
  res.json(events);
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

// ============ IFIRMA ============
const { fetchInvoices: fetchIfirmaInvoices, createInvoice, fetchInvoicePdf } = require("./ifirma-client");

function guessCountryFromInv(inv) {
  const rodzaj = (inv.Rodzaj || "").toLowerCase();
  const waluta = (inv.Waluta || "PLN").toUpperCase();
  const nip = (inv.NIPKontrahenta || "").replace(/[\s\-]/g, "");
  if (rodzaj.includes("kraj")) return "PL";
  if (waluta === "EUR") {
    if (/^\d{9}$/.test(nip) && parseInt(nip[0]) >= 1 && parseInt(nip[0]) <= 5) return "PT";
    if (/^[BXA-Z]/i.test(nip)) return "ES";
    if (/^\d{11}$/.test(nip) && nip[0] === "0") return "IT";
    if (/^\d{11}$/.test(nip) && nip[0] === "4") return "FR";
  }
  return null;
}

async function processIfirmaInvoices(invoices) {
  // Build unique contractors by NIP
  const nipToInv = new Map();
  for (const inv of invoices) {
    const rawNip = (inv.NIPKontrahenta || "").replace(/[\s\-]/g, "");
    if (!rawNip) continue;
    if (!nipToInv.has(rawNip)) nipToInv.set(rawNip, inv);
  }

  let contractorsCreated = 0, contractorsSkipped = 0;
  const nipToContractorId = new Map();

  for (const [nip, inv] of nipToInv) {
    const existing = await prisma.contractor.findUnique({ where: { nip } });
    if (existing) {
      contractorsSkipped++;
      nipToContractorId.set(nip, existing.id);
    } else {
      const rawName = (inv.NazwaKontrahenta || "").replace(/^-+\s*/, "").trim();
      const country = guessCountryFromInv(inv);
      const ifirmaContractorIdVal = inv.IdentyfikatorKontrahenta || null;
      const created = await prisma.contractor.create({
        data: {
          name: rawName,
          nip,
          type: "BUSINESS",
          country,
          source: "ifirma",
          tags: ["ifirma-import"],
          extras: ifirmaContractorIdVal ? { ifirmaId: ifirmaContractorIdVal } : {},
        },
      });
      contractorsCreated++;
      nipToContractorId.set(nip, created.id);
    }
  }

  let invoicesCreated = 0, invoicesUpdated = 0;
  for (const inv of invoices) {
    const ifirmaId = inv.FakturaId || null;
    if (!ifirmaId) continue;

    const rawNip = (inv.NIPKontrahenta || "").replace(/[\s\-]/g, "");
    const contractorId = rawNip ? (nipToContractorId.get(rawNip) || null) : null;
    const grossAmount = parseFloat(inv.Brutto || 0);
    const paidAmount = parseFloat(inv.Zaplacono || 0);
    const currency = (inv.Waluta || "PLN").toUpperCase();
    const status = paidAmount >= grossAmount ? "paid" : paidAmount > 0 ? "partial" : "unpaid";

    const existing = await prisma.invoice.findUnique({ where: { ifirmaId } });
    if (existing) {
      await prisma.invoice.update({ where: { ifirmaId }, data: { paidAmount, status } });
      invoicesUpdated++;
    } else {
      await prisma.invoice.create({
        data: {
          ifirmaId,
          contractorId,
          number: inv.PelnyNumer || "",
          issueDate: inv.DataWystawienia ? new Date(inv.DataWystawienia) : new Date(),
          dueDate: inv.TerminPlatnosci ? new Date(inv.TerminPlatnosci) : null,
          grossAmount,
          currency,
          paidAmount,
          status,
          type: inv.Rodzaj || null,
          ifirmaContractorId: inv.IdentyfikatorKontrahenta ? String(inv.IdentyfikatorKontrahenta) : null,
          extras: {},
        },
      });
      invoicesCreated++;
    }
  }

  // Link emails without contractorId to contractors by name (min 4 chars, case insensitive)
  const allContractors = await prisma.contractor.findMany({ select: { id: true, name: true } });
  let linked = 0;
  for (const contractor of allContractors) {
    if (!contractor.name || contractor.name.length < 4) continue;
    const updated = await prisma.email.updateMany({
      where: { contractorId: null, fromName: { contains: contractor.name, mode: "insensitive" } },
      data: { contractorId: contractor.id },
    });
    linked += updated.count;
  }

  return { contractors: { created: contractorsCreated, skipped: contractorsSkipped }, invoices: { created: invoicesCreated, updated: invoicesUpdated }, linked };
}

app.post("/api/contractors/import-ifirma", async (req, res) => {
  try {
    const { invoices } = req.body;
    if (!Array.isArray(invoices) || !invoices.length) return res.status(400).json({ error: "invoices array required" });
    const result = await processIfirmaInvoices(invoices);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/ifirma/sync", async (req, res) => {
  try {
    const { dataOd, dataDo } = req.body || {};
    const defaultOd = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const invoices = await fetchIfirmaInvoices({ dataOd: dataOd || defaultOd, dataDo });
    const result = await processIfirmaInvoices(invoices);
    res.json({ ok: true, fetched: invoices.length, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/ifirma/invoices", async (req, res) => {
  try {
    const { dataOd, dataDo, status, nipKontrahenta } = req.query;
    const invoices = await fetchIfirmaInvoices({ dataOd, dataDo, status, nipKontrahenta });
    res.json(invoices);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ AGENT CONTEXT ============

app.get("/api/agent-context/:agentId", async (req, res) => {
  try {
    const entry = await prisma.agentContext.findUnique({ where: { id: req.params.agentId } });
    res.json(entry ? entry.data : {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/agent-context/:agentId", async (req, res) => {
  try {
    const { data } = req.body;
    if (data === undefined) return res.status(400).json({ error: "data required" });
    const entry = await prisma.agentContext.upsert({
      where: { id: req.params.agentId },
      update: { data },
      create: { id: req.params.agentId, data },
    });
    res.json({ ok: true, data: entry.data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ INVOICE HITL ============

// In-memory preview store with 30-min TTL
const invoicePreviews = new Map();
const PREVIEW_TTL_MS = 30 * 60 * 1000;

function savePreview(id, data) {
  invoicePreviews.set(id, { data, expiresAt: Date.now() + PREVIEW_TTL_MS });
}

function getPreview(id) {
  const entry = invoicePreviews.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { invoicePreviews.delete(id); return null; }
  return entry.data;
}

function genUuid() {
  return crypto.randomUUID ? crypto.randomUUID() : require('crypto').randomUUID();
}

// ============ FUZZY CONTRACTOR MATCH ============

function normalizeContractorName(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/ñ/g, 'n')
    .replace(/ç/g, 'c').replace(/[ãõ]/g, a => a === 'ã' ? 'a' : 'o')
    .replace(/[-.,&]/g, ' ')
    .replace(/\b(lda|slu|sl|sa|sp|gmbh|srl|snc|unipessoal|spolka|sp z o o|sp\. z o\.o\.?)\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function scoreContractor(contractor, search) {
  const normSearch = normalizeContractorName(search);
  const normName = normalizeContractorName(contractor.name);
  const searchWords = normSearch.split(/\s+/).filter(w => w.length >= 3);

  // 100: exact match
  if (normName === normSearch) return 100;

  // 90: name contains ALL words from search
  if (searchWords.length > 0 && searchWords.every(w => normName.includes(w))) return 90;

  // 80: name contains ANY word from search (min 3 chars)
  if (searchWords.some(w => normName.includes(w))) return 80;

  // 70: any search word is substring of name token or vice versa
  const nameWords = normName.split(/\s+/).filter(w => w.length >= 3);
  const has70 = searchWords.some(sw => nameWords.some(nw => nw.includes(sw) || sw.includes(nw)));
  if (has70) return 70;

  // 60: extras.aliases contains search
  const aliases = (contractor.extras && Array.isArray(contractor.extras.aliases)) ? contractor.extras.aliases : [];
  if (aliases.some(a => normalizeContractorName(a) === normSearch)) return 60;

  // 50: NIP contains search string
  if (contractor.nip && contractor.nip.replace(/\s/g, '').includes(search.replace(/\s/g, ''))) return 50;

  // 40: phonetic — first 3-4 chars of each search word match a name word
  const has40 = searchWords.some(sw => {
    const pfx = sw.slice(0, 4);
    return nameWords.some(nw => nw.startsWith(pfx));
  });
  if (has40) return 40;

  return 0;
}

app.post("/api/ifirma/invoice-preview", async (req, res) => {
  try {
    const { contractorId, contractorSearch, items } = req.body;
    let parsedItems = items;
    if (typeof items === 'string') {
      try { parsedItems = JSON.parse(items); } catch(e) { return res.status(400).json({ error: 'items must be valid JSON array' }); }
    }
    if (!parsedItems || !parsedItems.length) return res.status(400).json({ error: 'items required' });
    console.log('[invoice-preview] parsed items:', JSON.stringify(parsedItems));

    // Resolve contractor
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
    if (!contractor) return res.status(404).json({ error: "contractor not found" });

    const waluta = (contractor.country || "PL").toUpperCase() === "PL" ? "PLN" : "EUR";
    const rodzaj = waluta === "EUR" ? "wdt" : "krajowa";

    // Expand items (resolve products + boxes)
    const pozycje = [];
    for (const item of parsedItems) {
      const ean = item.productEan || item.ean;
      console.log('[invoice-preview] looking for product EAN:', ean);
      const product = await prisma.product.findUnique({ where: { ean } });
      if (!product) return res.status(404).json({ error: `product not found: ${ean}` });

      console.log('[invoice-preview] template extras:', JSON.stringify(product.extras));
      if (product.category === "template" && product.extras && product.extras.composition) {
        for (const comp of product.extras.composition) {
          console.log('[invoice-preview] composition item:', JSON.stringify(comp));
          const sub = await prisma.product.findUnique({ where: { ean: comp.ean } });
          if (sub) pozycje.push({ product: sub, ilosc: comp.qty * (item.qty || 1) });
        }
      } else {
        pozycje.push({ product, ilosc: item.qty || 1 });
      }
    }

    // Determine prices — check last invoice for this contractor
    const lastInvoice = await prisma.invoice.findFirst({
      where: { contractorId: contractor.id },
      orderBy: { issueDate: "desc" },
    });
    const lastInvoiceExtras = lastInvoice && lastInvoice.extras && lastInvoice.extras.pozycje;
    const priceOverride = {};
    if (lastInvoiceExtras && Array.isArray(lastInvoiceExtras)) {
      for (const p of lastInvoiceExtras) {
        if (p.ean) priceOverride[p.ean] = { pricePLN: p.pricePLN, priceEUR: p.priceEUR };
      }
    }

    const linee = pozycje.map(({ product: p, ilosc }) => {
      const override = priceOverride[p.ean] || {};
      const cenaNetto = waluta === "EUR"
        ? (override.priceEUR ?? p.priceEUR)
        : (override.pricePLN ?? p.pricePLN);
      const wartoscNetto = Math.round(cenaNetto * ilosc * 100) / 100;
      return {
        ean: p.ean,
        nazwa: p.name,
        wariant: p.variant || null,
        ilosc,
        cenaNetto,
        wartoscNetto,
      };
    });

    const sumaNetto = Math.round(linee.reduce((s, l) => s + l.wartoscNetto, 0) * 100) / 100;
    const vat = rodzaj === "wdt" ? 0 : Math.round(sumaNetto * 0.23 * 100) / 100;
    const brutto = Math.round((sumaNetto + vat) * 100) / 100;
    const terminPlatnosci = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const preview = {
      contractor: { id: contractor.id, name: contractor.name, nip: contractor.nip, country: contractor.country, address: contractor.address },
      waluta,
      rodzaj,
      pozycje: linee,
      suma: { netto: sumaNetto, vat, brutto },
      terminPlatnosci,
    };

    const previewId = require("crypto").randomUUID();
    savePreview(previewId, { preview, contractorData: contractor, pozycjeData: linee, waluta, rodzaj });

    prisma.agentContext.upsert({
      where: { id: "ksiegowosc" },
      update: { data: { lastAction: "preview", previewId, contractor: { name: contractor.name, nip: contractor.nip, country: contractor.country }, suma: preview.suma, waluta, timestamp: Date.now() } },
      create: { id: "ksiegowosc", data: { lastAction: "preview", previewId, contractor: { name: contractor.name, nip: contractor.nip, country: contractor.country }, suma: preview.suma, waluta, timestamp: Date.now() } },
    }).catch(e => console.error('[invoice-preview] AgentContext save error:', e.message));

    res.json({ ok: true, preview, previewId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/ifirma/invoice-confirm-latest", async (req, res) => {
  try {
    // Find the most recently created, non-expired preview
    const now = Date.now();
    let bestId = null;
    let bestExpiry = 0;
    for (const [id, entry] of invoicePreviews.entries()) {
      if (entry.expiresAt > now && entry.expiresAt > bestExpiry) {
        bestExpiry = entry.expiresAt;
        bestId = id;
      }
    }
    if (!bestId) return res.status(404).json({ error: "Brak aktywnego podglądu. Utwórz nowy." });

    const stored = getPreview(bestId);
    if (!stored) return res.status(404).json({ error: "Brak aktywnego podglądu. Utwórz nowy." });

    const { contractorData: contractor, pozycjeData: pozycje, waluta, rodzaj } = stored;

    // Get Telegram config (used for both success and error notifications)
    const [tgTokenCfg, tgChatCfg] = await Promise.all([
      prisma.config.findUnique({ where: { key: "telegram_bot_token" } }),
      prisma.config.findUnique({ where: { key: "telegram_chat_id" } }),
    ]);
    const tgToken = tgTokenCfg && tgTokenCfg.value;
    const tgChat = tgChatCfg && tgChatCfg.value;

    // Create invoice in iFirma
    let ifirmaResult;
    try {
      ifirmaResult = await createInvoice({
        kontrahent: {
          name: contractor.name,
          nip: contractor.nip,
          address: contractor.address,
          city: contractor.city,
          postCode: contractor.extras && contractor.extras.postCode || "",
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
          `IFIRMA ODPOWIEDŹ:\nStatus: BŁĄD\nKod: ${kod != null ? kod : "?"}\nInformacja: ${info || ifirmaErr.message}\nKontrahent: ${contractor.name}\nPełna odpowiedź: ${JSON.stringify(raw)}`
        ).catch(e => console.error('[invoice-confirm] tg error:', e.message));
      }
      return res.json({ ok: false, error: "iFirma error", ifirmaResponse: raw });
    }

    const ifirmaRaw = ifirmaResult.ifirmaRaw;
    const fakturaId = ifirmaRaw && ifirmaRaw.response && ifirmaRaw.response.Identyfikator || null;
    const ifirmaIdNum = ifirmaRaw && ifirmaRaw.response && ifirmaRaw.response.Wynik && ifirmaRaw.response.Wynik.FakturaId || fakturaId || null;

    // Resolve PelnyNumer by fetching today's invoices and matching by FakturaId
    let pelnyNumer = ifirmaResult.invoiceNumber || "UNKNOWN";
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

    const sumaNetto = stored.preview.suma.netto;
    const brutto = stored.preview.suma.brutto;

    // Save to DB
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
        status: "unpaid",
        type: rodzaj,
        extras: { pozycje: pozycje.map(p => ({ ean: p.ean, nazwa: p.nazwa, ilosc: p.ilosc, pricePLN: p.cenaNetto, priceEUR: p.cenaNetto })) },
      },
    });

    // Notify Telegram — iFirma success response
    console.log('[invoice-confirm] sending iFirma response to Telegram');
    if (tgToken && tgChat) {
      const info = ifirmaRaw && ifirmaRaw.response && ifirmaRaw.response.Informacja || "";
      sendTelegram(tgToken, tgChat,
        `IFIRMA ODPOWIEDŹ:\nStatus: SUKCES\nKod: 0\nInformacja: ${info}\nIdentyfikator: ${fakturaId}\nKontrahent: ${contractor.name}\nKwota: ${stored.preview.suma.brutto} ${waluta}`
      ).catch(e => console.error('[invoice-confirm] tg notify error:', e.message));
    }

    // Fetch PDF — always use fakturaId (Identyfikator from iFirma response)
    const pdfBuffer = await fetchInvoicePdf(pelnyNumer, rodzaj, fakturaId);

    // Send PDF to Telegram
    let pdfSent = false;
    try {
      const token = tgToken;
      const chatId = tgChat;

      if (token && chatId) {
        const boundary = "----FormBoundary" + Date.now();
        const caption = `Faktura ${pelnyNumer} dla ${contractor.name}`;
        const filename = `faktura_${pelnyNumer.replace(/\//g, "_")}.pdf`;

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
      console.error('[invoice-confirm-latest] Telegram error:', tgErr.message);
    }

    invoicePreviews.delete(bestId);

    prisma.agentContext.upsert({
      where: { id: "ksiegowosc" },
      update: { data: { lastAction: "confirmed", invoiceNumber: pelnyNumer, invoiceId: invoice.id, contractor: { name: contractor.name }, timestamp: Date.now() } },
      create: { id: "ksiegowosc", data: { lastAction: "confirmed", invoiceNumber: pelnyNumer, invoiceId: invoice.id, contractor: { name: contractor.name }, timestamp: Date.now() } },
    }).catch(e => console.error('[invoice-confirm-latest] AgentContext save error:', e.message));

    res.json({ ok: true, invoiceNumber: pelnyNumer, invoiceId: invoice.id, pdfSent, ifirmaResponse: ifirmaRaw });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/ifirma/invoice-confirm", async (req, res) => {
  try {
    const { previewId } = req.body;
    if (!previewId) return res.status(400).json({ error: "previewId required" });

    const stored = getPreview(previewId);
    if (!stored) return res.status(404).json({ error: "preview not found or expired" });

    const { contractorData: contractor, pozycjeData: pozycje, waluta, rodzaj } = stored;

    // Create invoice in iFirma
    const ifirmaResp = await createInvoice({
      kontrahent: {
        name: contractor.name,
        nip: contractor.nip,
        address: contractor.address,
        city: contractor.city,
        postCode: contractor.extras && contractor.extras.postCode || "",
        country: contractor.country,
      },
      pozycje,
      waluta,
      rodzaj,
    });

    const ifirmaInvoice = ifirmaResp.response && ifirmaResp.response.Wynik;
    const pelnyNumer = ifirmaInvoice && (ifirmaInvoice.PelnyNumer || ifirmaInvoice.Numer) || "UNKNOWN";
    const ifirmaId = ifirmaInvoice && ifirmaInvoice.FakturaId || null;

    const sumaNetto = stored.preview.suma.netto;
    const brutto = stored.preview.suma.brutto;

    // Save to DB
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
        status: "unpaid",
        type: rodzaj,
        extras: { pozycje: pozycje.map(p => ({ ean: p.ean, nazwa: p.nazwa, ilosc: p.ilosc, pricePLN: p.cenaNetto, priceEUR: p.cenaNetto })) },
      },
    });

    // Fetch PDF
    const pdfBuffer = await fetchInvoicePdf(pelnyNumer, rodzaj);

    // Send to Telegram
    let pdfSent = false;
    try {
      const [tokenCfg, chatCfg] = await Promise.all([
        prisma.config.findUnique({ where: { key: "telegram_bot_token" } }),
        prisma.config.findUnique({ where: { key: "telegram_chat_id" } }),
      ]);
      const token = tokenCfg && tokenCfg.value;
      const chatId = chatCfg && chatCfg.value;

      if (token && chatId) {
        const boundary = "----FormBoundary" + Date.now();
        const caption = `Faktura ${pelnyNumer} dla ${contractor.name}`;
        const filename = `faktura_${pelnyNumer.replace(/\//g, "_")}.pdf`;

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

app.post("/api/ifirma/send-invoice-email", async (req, res) => {
  try {
    const { invoiceId, toEmail } = req.body;
    if (!invoiceId || !toEmail) return res.status(400).json({ error: "invoiceId and toEmail required" });

    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) return res.status(404).json({ error: "invoice not found" });

    const pdfBuffer = await fetchInvoicePdf(invoice.number, invoice.type);
    const filename = `faktura_${invoice.number.replace(/\//g, "_")}.pdf`;

    await sendMail({
      from: "info@surfstickbell.com",
      to: toEmail,
      subject: `Faktura ${invoice.number} - Surf Stick Bell`,
      body: "W załączeniu faktura.",
      attachments: [{ filename, content: pdfBuffer, contentType: "application/pdf" }],
    });

    res.json({ ok: true, sent: true, invoiceNumber: invoice.number });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ INVOICE MANAGEMENT ============

app.post("/api/invoices/delete-search", async (req, res) => {
  try {
    const { contractorSearch, dateFrom, dateTo, limit } = req.body;
    if (!contractorSearch) return res.status(400).json({ error: "contractorSearch required" });

    const all = await prisma.contractor.findMany({ select: { id: true, name: true, nip: true, country: true, email: true, extras: true } });
    const scored = all.map(c => ({ c, score: scoreContractor(c, contractorSearch) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    if (!scored.length) return res.status(404).json({ error: "Nie znaleziono kontrahenta: " + contractorSearch });
    const contractor = scored[0].c;

    const today = new Date().toISOString().slice(0, 10);
    const where = {
      contractorId: contractor.id,
      issueDate: { gte: new Date(dateFrom || today), lte: new Date(dateTo || today + "T23:59:59.999Z") },
    };
    const invoices = await prisma.invoice.findMany({
      where,
      orderBy: { issueDate: "desc" },
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

app.post("/api/invoices/delete-confirm", async (req, res) => {
  try {
    const { invoiceIds } = req.body;
    if (!Array.isArray(invoiceIds) || !invoiceIds.length) return res.status(400).json({ error: "invoiceIds required" });

    const deleted = [];
    for (const id of invoiceIds) {
      const inv = await prisma.invoice.findUnique({ where: { id } });
      if (!inv) { deleted.push({ id, error: "not found" }); continue; }

      await prisma.invoice.delete({ where: { id } });
      console.log(`[invoices] deleted from local DB: ${inv.number}, ifirmaId=${inv.ifirmaId} (iFirma manual deletion required)`);
      deleted.push({ id, number: inv.number });
    }

    res.json({ ok: true, deleted, note: "Skasowano z lokalnej bazy. Faktury w iFirma trzeba skasować ręcznie w panelu." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/invoices/unpaid", async (req, res) => {
  try {
    const now = new Date();
    const invoices = await prisma.invoice.findMany({
      where: { status: { not: "paid" } },
      orderBy: { dueDate: "asc" },
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
