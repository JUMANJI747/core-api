'use strict';

const router = require('express').Router();
const { processIfirmaInvoices } = require('../services/ifirma-sync');
const { fetchWithTimeout } = require('../http');
const { findAddressInContractorEmails, saveAddressToContractorLocations } = require('../services/address-from-emails');
const { findAddressInGkOrders } = require('../services/find-address-in-gk-orders');
const { scoreContractor } = require('../services/contractor-match');

// ============ ROUTES ============

router.post('/upsert', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const body = req.body;

    // Normalize empty strings to null
    const trim = v => (v && typeof v === 'string' && v.trim()) ? v.trim() : null;
    const n = {
      name: trim(body.name),
      nip: trim(body.nip),
      phone: trim(body.phone),
      email: trim(body.email),
      country: trim(body.country),
      city: trim(body.city),
      address: trim(body.address),
      notes: trim(body.notes),
      type: body.type || 'BUSINESS',
      tags: Array.isArray(body.tags) ? body.tags.filter(t => t && String(t).trim()) : [],
      source: trim(body.source) || 'api',
      extras: body.extras || {},
    };

    if (!n.name) return res.status(400).json({ error: 'name required' });

    // Optional delivery address — appended to extras.locations[] (idempotent).
    // This is the shipping address; distinct from the billing/main address
    // on the contractor row. A contractor can have many delivery locations.
    // n8n LLM tools sometimes serialize objects as JSON strings — accept both.
    let deliveryAddress = null;
    if (body.deliveryAddress) {
      if (typeof body.deliveryAddress === 'object' && !Array.isArray(body.deliveryAddress)) {
        deliveryAddress = body.deliveryAddress;
      } else if (typeof body.deliveryAddress === 'string' && body.deliveryAddress.trim()) {
        try { deliveryAddress = JSON.parse(body.deliveryAddress); }
        catch (_) { /* invalid JSON / plain text — silently ignore */ }
      }
      if (deliveryAddress && (typeof deliveryAddress !== 'object' || Array.isArray(deliveryAddress))) {
        deliveryAddress = null;
      }
    }

    function appendLocation(locations, addr, fallbackCountry) {
      const list = Array.isArray(locations) ? [...locations] : [];
      if (!addr || (!addr.street && !addr.city)) return { list, added: false };
      const norm = (s) => (s || '').toString().toLowerCase().trim();
      const newLoc = {
        street: addr.street || null,
        houseNumber: addr.houseNumber || null,
        city: addr.city || null,
        postCode: addr.postCode || null,
        country: addr.country || fallbackCountry || null,
        contactPerson: addr.contactPerson || null,
        phone: addr.phone || null,
        email: addr.email || null,
        source: addr.source || 'upsert',
        addedAt: new Date().toISOString(),
      };
      const dup = list.find(l =>
        norm(l.street) === norm(newLoc.street) &&
        norm(l.city) === norm(newLoc.city) &&
        norm(l.postCode) === norm(newLoc.postCode)
      );
      if (dup) return { list, added: false };
      list.push(newLoc);
      return { list, added: true };
    }

    // Find existing: by NIP, then by email, then by exact name
    let existing = null;
    if (n.nip) existing = await prisma.contractor.findUnique({ where: { nip: n.nip } });
    if (!existing && n.email) existing = await prisma.contractor.findFirst({ where: { email: { equals: n.email, mode: 'insensitive' } } });
    if (!existing && !n.nip) existing = await prisma.contractor.findFirst({ where: { name: { equals: n.name, mode: 'insensitive' } } });

    let contractor;
    let deliveryAddressAdded = false;
    if (existing) {
      const mergedExtras = { ...(existing.extras || {}), ...n.extras };

      if (n.nip && existing.nip && n.nip !== existing.nip) {
        mergedExtras.nipList = Array.from(new Set([existing.nip, n.nip, ...(mergedExtras.nipList || [])]));
      }
      if (n.phone && existing.phone && n.phone !== existing.phone) {
        mergedExtras.phoneList = Array.from(new Set([existing.phone, n.phone, ...(mergedExtras.phoneList || [])]));
      }
      if (n.email && existing.email && n.email.toLowerCase() !== existing.email.toLowerCase()) {
        mergedExtras.emailList = Array.from(new Set([existing.email, n.email, ...(mergedExtras.emailList || [])]));
      }

      if (deliveryAddress) {
        const { list, added } = appendLocation(mergedExtras.locations, deliveryAddress, n.country || existing.country);
        mergedExtras.locations = list;
        deliveryAddressAdded = added;
      }

      const mergedTags = Array.from(new Set([...(existing.tags || []), ...n.tags]));

      contractor = await prisma.contractor.update({
        where: { id: existing.id },
        data: {
          name: n.name,
          ...(n.nip ? { nip: n.nip } : {}),
          ...(body.type !== undefined ? { type: n.type } : {}),
          ...(n.phone ? { phone: n.phone } : {}),
          ...(n.email ? { email: n.email } : {}),
          ...(n.address !== null ? { address: n.address } : {}),
          ...(n.city !== null ? { city: n.city } : {}),
          ...(n.country !== null ? { country: n.country } : {}),
          ...(n.notes !== null ? { notes: n.notes } : {}),
          ...(body.source !== undefined ? { source: n.source } : {}),
          extras: mergedExtras,
          tags: mergedTags,
        },
      });
    } else {
      const createExtras = { ...n.extras };
      if (deliveryAddress) {
        const { list, added } = appendLocation(createExtras.locations, deliveryAddress, n.country);
        createExtras.locations = list;
        deliveryAddressAdded = added;
      }
      contractor = await prisma.contractor.create({
        data: {
          name: n.name,
          nip: n.nip,
          type: n.nip ? 'BUSINESS' : (n.type || 'PERSON'),
          phone: n.phone,
          email: n.email,
          country: n.country,
          city: n.city,
          address: n.address,
          notes: n.notes,
          extras: createExtras,
          tags: n.tags,
          source: n.source,
        },
      });
    }
    res.json(deliveryAddress ? { ...contractor, deliveryAddressAdded } : contractor);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/import-ifirma', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { invoices } = req.body;
    if (!Array.isArray(invoices) || !invoices.length) return res.status(400).json({ error: 'invoices array required' });
    const result = await processIfirmaInvoices(invoices, prisma);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/verify-nip', async (req, res) => {
  try {
    let { nip, country } = req.body;
    if (!nip) return res.status(400).json({ error: 'nip required' });
    nip = nip.trim().replace(/[\s\-]/g, '').toUpperCase();
    if (country) country = country.trim().toUpperCase();

    const hasPrefix = /^[A-Z]{2}/.test(nip);
    if (!hasPrefix) {
      if (country) {
        nip = country + nip;
      } else if (/^\d{10}$/.test(nip)) {
        nip = 'PL' + nip;
      } else {
        return res.status(400).json({ error: "Cannot determine country for NIP. Provide country (e.g. 'ES') or use a NIP with country prefix (e.g. 'ESB12345678')." });
      }
    }

    const isPolish = /^PL\d{10}$/.test(nip);

    if (isPolish) {
      const nipNum = nip.slice(2);
      const today = new Date().toISOString().slice(0, 10);

      const mfRes = await fetchWithTimeout(`https://wl-api.mf.gov.pl/api/search/nip/${nipNum}?date=${today}`, {}, 10000);
      if (mfRes.status === 404) return res.status(404).json({ error: 'Company not found' });
      if (!mfRes.ok) return res.status(502).json({ error: 'MF API error', status: mfRes.status });

      const mfData = await mfRes.json();
      const s = mfData?.result?.subject;
      if (!s) return res.status(404).json({ error: 'Company not found' });

      return res.json({ source: 'MF', nip: nipNum, name: s.name, regon: s.regon, krs: s.krs, address: s.workingAddress, statusVat: s.statusVat });
    } else {
      const countryCode = nip.slice(0, 2);
      const vatNumber = nip.slice(2);

      const viesRes = await fetchWithTimeout('https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countryCode, vatNumber }),
      }, 20000);

      if (!viesRes.ok) return res.status(502).json({ error: 'VIES API error', status: viesRes.status });
      const data = await viesRes.json();

      console.log(`[verify-nip] VIES response: valid=${data.valid}, name=${data.name}`);

      return res.json({ source: 'VIES', nip, countryCode, vatNumber, valid: data.valid === true, name: data.name, address: data.address, requestDate: data.requestDate });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { search, country, tag, limit } = req.query;
  const take = parseInt(limit) || 50;
  const where = {};
  if (search) where.name = { contains: search, mode: 'insensitive' };
  if (country) where.country = { equals: country, mode: 'insensitive' };
  if (tag) where.tags = { has: tag };
  const contractors = await prisma.contractor.findMany({ where, take, orderBy: { updatedAt: 'desc' } });

  // Fuzzy fallback: if naive `name contains` failed (e.g. "holaola" vs
  // "Hola Ola" — spacing differs) and no other filter narrowed the set,
  // load all contractors and score them against the search term.
  if (search && contractors.length === 0 && !country && !tag) {
    const all = await prisma.contractor.findMany({
      select: { id: true, name: true, nip: true, country: true, email: true, phone: true, city: true, address: true, tags: true, source: true, extras: true, createdAt: true, updatedAt: true },
      take: 500,
    });
    const scored = all
      .map(c => ({ c, score: scoreContractor(c, search) }))
      .filter(x => x.score >= 50)
      .sort((a, b) => b.score - a.score)
      .slice(0, take);
    if (scored.length) {
      console.log(`[contractors/search] fuzzy fallback: "${search}" → ${scored.length} match(es), top: "${scored[0].c.name}" (score ${scored[0].score})`);
      return res.json(scored.map(x => x.c));
    }
  }

  res.json(contractors);
});

router.get('/:id', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const c = await prisma.contractor.findUnique({ where: { id: req.params.id }, include: { deals: true, consignments: true, emails: { take: 10, orderBy: { createdAt: 'desc' } } } });
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(c);
});

router.post('/:id/alias', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { alias } = req.body;
    if (!alias || typeof alias !== 'string') return res.status(400).json({ error: 'alias required' });
    const c = await prisma.contractor.findUnique({ where: { id: req.params.id } });
    if (!c) return res.status(404).json({ error: 'contractor not found' });
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

// Append a delivery address to extras.locations[] (idempotent on
// street+city+postCode). Body fields are all optional individually but at
// least street or city must be present. Used by the agent after pulling
// an address from VIES / GK history / mails / user input.
router.post('/:id/delivery-address', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { street, city, postCode, country, houseNumber, contactPerson, phone, email, source } = req.body || {};
    if (!street && !city) return res.status(400).json({ error: 'Provide at least street or city' });

    const c = await prisma.contractor.findUnique({ where: { id: req.params.id } });
    if (!c) return res.status(404).json({ error: 'contractor not found' });

    const extras = (typeof c.extras === 'object' && c.extras) || {};
    const locations = Array.isArray(extras.locations) ? [...extras.locations] : [];
    const norm = (s) => (s || '').toString().toLowerCase().trim();

    const newLoc = {
      street: street || null,
      houseNumber: houseNumber || null,
      city: city || null,
      postCode: postCode || null,
      country: country || c.country || null,
      contactPerson: contactPerson || null,
      phone: phone || null,
      email: email || null,
      source: source || 'manual',
      addedAt: new Date().toISOString(),
    };

    const dup = locations.find(l =>
      norm(l.street) === norm(newLoc.street) &&
      norm(l.city) === norm(newLoc.city) &&
      norm(l.postCode) === norm(newLoc.postCode)
    );
    if (dup) {
      return res.json({ ok: true, deduplicated: true, location: dup, totalLocations: locations.length });
    }

    locations.push(newLoc);
    await prisma.contractor.update({
      where: { id: req.params.id },
      data: { extras: { ...extras, locations } },
    });
    res.json({ ok: true, location: newLoc, totalLocations: locations.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Search contractor's INBOUND emails for a delivery address (signature /
// "ship to" / "dostawa" lines). Calls Claude (Haiku 4.5) — has a token
// cost, so it's a separate endpoint that the agent invokes only when the
// user explicitly chooses "szukaj w mailach". On hit, the address is
// persisted to extras.locations[] so future quotes don't re-pay.
router.post('/:id/find-address-in-emails', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const c = await prisma.contractor.findUnique({ where: { id: req.params.id } });
    if (!c) return res.status(404).json({ error: 'contractor not found' });

    const limit = (req.body && Number(req.body.limit)) || 10;
    const result = await findAddressInContractorEmails(prisma, c.id, { limit });
    if (!result.found) {
      return res.json({ ok: false, found: false, reason: result.reason || 'not_found' });
    }
    const saved = await saveAddressToContractorLocations(prisma, c.id, result.address);
    res.json({ ok: true, found: true, address: result.address, savedToLocations: saved, contractor: { id: c.id, name: c.name } });
  } catch (e) {
    console.error('[find-address-in-emails] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Search recent GK shipments for a delivery address matching this
// contractor (token match + LLM fuzzy fallback). Opt-in because the
// LLM call costs ~$0.02 per miss; the agent invokes only when the
// user explicitly asks for "szukaj w starych wysyłkach".
router.post('/:id/find-address-in-gk-orders', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const c = await prisma.contractor.findUnique({ where: { id: req.params.id } });
    if (!c) return res.status(404).json({ error: 'contractor not found' });

    const limit = (req.body && Number(req.body.limit)) || 200;
    const result = await findAddressInGkOrders(prisma, c, { limit });
    if (!result.found) {
      return res.json({ ok: false, found: false, reason: result.reason, scanned: result.scanned || 0 });
    }
    res.json({ ok: true, found: true, ...result, contractor: { id: c.id, name: c.name } });
  } catch (e) {
    console.error('[find-address-in-gk-orders] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id/price', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { price, typ } = req.body;
    if (price == null) return res.status(400).json({ error: 'price required' });
    if (typ !== 'brutto' && typ !== 'netto') return res.status(400).json({ error: "typ must be 'brutto' or 'netto'" });
    const c = await prisma.contractor.findUnique({ where: { id: req.params.id } });
    if (!c) return res.status(404).json({ error: 'contractor not found' });
    const extras = { ...(c.extras || {}), lastPrice: price, lastPriceTyp: typ };
    await prisma.contractor.update({ where: { id: req.params.id }, data: { extras } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
