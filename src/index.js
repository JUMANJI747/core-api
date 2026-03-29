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
  {ean:"5902082579014", name:"Bell Surf Care Hydrating Cream", category:"pielęgnacja", capacity:"30g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082579021", name:"Bell Surf Extreme Waterproof Gel SPF 50+", category:"ochrona słoneczna", capacity:"40g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082579045", name:"Bell Surf Daily UV Protection SPF 50+", category:"ochrona słoneczna", capacity:"30g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082579052", name:"Bell Surf Lip Balm SPF 50+", category:"ochrona słoneczna", variant:"lip balm", pricePLN:18, priceEUR:4.5},
  {ean:"5902082556022", name:"Surf Stick Bell", category:"ochrona słoneczna", variant:"Blue", capacity:"6.8g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082556053", name:"Surf Stick Bell", category:"ochrona słoneczna", variant:"Pink", capacity:"6.8g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082556046", name:"Surf Stick Bell", category:"ochrona słoneczna", variant:"Purple", capacity:"6.8g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082556039", name:"Surf Stick Bell", category:"ochrona słoneczna", variant:"Mint", capacity:"6.8g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082564935", name:"Surf Stick Bell", category:"ochrona słoneczna", variant:"White", capacity:"6.8g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082564942", name:"Surf Stick Bell", category:"ochrona słoneczna", variant:"Skin", capacity:"6.8g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082576167", name:"Surf Girl Mascara Bell", category:"makijaż", variant:"Mint", capacity:"9ml", pricePLN:18, priceEUR:4.5},
  {ean:"5902082576150", name:"Surf Girl Mascara Bell", category:"makijaż", variant:"Blue", capacity:"9ml", pricePLN:18, priceEUR:4.5},
  {ean:"5902082576174", name:"Surf Girl Mascara Bell", category:"makijaż", variant:"Pink", capacity:"9ml", pricePLN:18, priceEUR:4.5},
  {ean:"5902082576181", name:"Surf Girl Mascara Bell", category:"makijaż", variant:"Black", capacity:"9ml", pricePLN:18, priceEUR:4.5},
  {ean:"BOX-STICK-30", name:"Surf Stick Box / Ekspozytor", category:"box", capacity:"30 szt", variant:"mixed", pricePLN:540, priceEUR:135, unit:"box", extras:{composition:[{ean:"5902082556022",variant:"Blue",qty:5},{ean:"5902082556053",variant:"Pink",qty:5},{ean:"5902082556046",variant:"Purple",qty:5},{ean:"5902082556039",variant:"Mint",qty:5},{ean:"5902082564935",variant:"White",qty:5},{ean:"5902082564942",variant:"Skin",qty:5}],totalQty:30}},
  {ean:"BOX-MASCARA-30", name:"Surf Girl Mascara Box", category:"box", capacity:"30 szt", variant:"mixed", pricePLN:540, priceEUR:135, unit:"box", extras:{composition:[{ean:"5902082576181",variant:"Black",qty:12},{ean:"5902082576167",variant:"Mint",qty:6},{ean:"5902082576174",variant:"Pink",qty:6},{ean:"5902082576150",variant:"Blue",qty:6}],totalQty:30}},
  {ean:"BOX-COLLECTION-30", name:"Surf Collection Box", category:"box", capacity:"30 szt", variant:"mixed", pricePLN:540, priceEUR:135, unit:"box", extras:{composition:[{ean:"5902082579052",variant:"Lip Balm",qty:12},{ean:"5902082579021",variant:"Gel SPF50+",qty:6},{ean:"5902082579045",variant:"Daily UV SPF50+",qty:6},{ean:"5902082579014",variant:"Hydrating Cream",qty:6}],totalQty:30}},
];

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
    let created = 0, skipped = 0;
    for (const p of SEED_PRODUCTS) {
      const exists = await prisma.product.findUnique({ where: { ean: p.ean } });
      if (exists) { skipped++; continue; }
      await prisma.product.create({ data: { ...p, extras: p.extras || {} } });
      created++;
    }
    res.json({ ok: true, created, skipped, total: SEED_PRODUCTS.length });
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
const { fetchInvoices: fetchIfirmaInvoices } = require("./ifirma-client");

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
