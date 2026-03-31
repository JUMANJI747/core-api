'use strict';

const router = require('express').Router();
const { fetchInvoices: fetchIfirmaInvoices } = require('../ifirma-client');

// ============ FUZZY CONTRACTOR MATCH ============

function normalizeContractorName(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
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

  if (normName === normSearch) return 100;
  if (searchWords.length > 0 && searchWords.every(w => normName.includes(w))) return 90;
  if (searchWords.some(w => normName.includes(w))) return 80;

  const nameWords = normName.split(/\s+/).filter(w => w.length >= 3);
  const has70 = searchWords.some(sw => nameWords.some(nw => nw.includes(sw) || sw.includes(nw)));
  if (has70) return 70;

  const aliases = (contractor.extras && Array.isArray(contractor.extras.aliases)) ? contractor.extras.aliases : [];
  if (aliases.some(a => normalizeContractorName(a) === normSearch)) return 60;

  if (contractor.nip && contractor.nip.replace(/\s/g, '').includes(search.replace(/\s/g, ''))) return 50;

  const has40 = searchWords.some(sw => {
    const pfx = sw.slice(0, 4);
    return nameWords.some(nw => nw.startsWith(pfx));
  });
  if (has40) return 40;

  return 0;
}

// ============ IFIRMA IMPORT HELPERS ============

function guessCountryFromInv(inv) {
  const rodzaj = (inv.Rodzaj || '').toLowerCase();
  const waluta = (inv.Waluta || 'PLN').toUpperCase();
  const nip = (inv.NIPKontrahenta || '').replace(/[\s\-]/g, '');
  if (rodzaj.includes('kraj')) return 'PL';
  if (waluta === 'EUR') {
    if (/^\d{9}$/.test(nip) && parseInt(nip[0]) >= 1 && parseInt(nip[0]) <= 5) return 'PT';
    if (/^[BXA-Z]/i.test(nip)) return 'ES';
    if (/^\d{11}$/.test(nip) && nip[0] === '0') return 'IT';
    if (/^\d{11}$/.test(nip) && nip[0] === '4') return 'FR';
  }
  return null;
}

async function processIfirmaInvoices(invoices, prisma) {
  const nipToInv = new Map();
  for (const inv of invoices) {
    const rawNip = (inv.NIPKontrahenta || '').replace(/[\s\-]/g, '');
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
      const rawName = (inv.NazwaKontrahenta || '').replace(/^-+\s*/, '').trim();
      const country = guessCountryFromInv(inv);
      const ifirmaContractorIdVal = inv.IdentyfikatorKontrahenta || null;
      const created = await prisma.contractor.create({
        data: {
          name: rawName,
          nip,
          type: 'BUSINESS',
          country,
          source: 'ifirma',
          tags: ['ifirma-import'],
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

    const rawNip = (inv.NIPKontrahenta || '').replace(/[\s\-]/g, '');
    const contractorId = rawNip ? (nipToContractorId.get(rawNip) || null) : null;
    const grossAmount = parseFloat(inv.Brutto || 0);
    const paidAmount = parseFloat(inv.Zaplacono || 0);
    const currency = (inv.Waluta || 'PLN').toUpperCase();
    const status = paidAmount >= grossAmount ? 'paid' : paidAmount > 0 ? 'partial' : 'unpaid';

    const existing = await prisma.invoice.findUnique({ where: { ifirmaId } });
    if (existing) {
      await prisma.invoice.update({ where: { ifirmaId }, data: { paidAmount, status } });
      invoicesUpdated++;
    } else {
      await prisma.invoice.create({
        data: {
          ifirmaId,
          contractorId,
          number: inv.PelnyNumer || '',
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

  const allContractors = await prisma.contractor.findMany({ select: { id: true, name: true } });
  let linked = 0;
  for (const contractor of allContractors) {
    if (!contractor.name || contractor.name.length < 4) continue;
    const updated = await prisma.email.updateMany({
      where: { contractorId: null, fromName: { contains: contractor.name, mode: 'insensitive' } },
      data: { contractorId: contractor.id },
    });
    linked += updated.count;
  }

  return { contractors: { created: contractorsCreated, skipped: contractorsSkipped }, invoices: { created: invoicesCreated, updated: invoicesUpdated }, linked };
}

// ============ ROUTES ============

router.post('/upsert', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { name, nip, type, phone, email, country, city, address, notes, extras, tags, source } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    let existing = null;
    if (nip) existing = await prisma.contractor.findUnique({ where: { nip } });
    if (!existing && email) existing = await prisma.contractor.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });

    let contractor;
    if (existing) {
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
        data: { name, nip, type: type || (nip ? 'BUSINESS' : 'PERSON'), phone, email, country, city, address, notes, extras: extras || {}, tags: tags || [], source },
      });
    }
    res.json(contractor);
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

      const mfRes = await fetch(`https://wl-api.mf.gov.pl/api/search/nip/${nipNum}?date=${today}`);
      if (mfRes.status === 404) return res.status(404).json({ error: 'Company not found' });
      if (!mfRes.ok) return res.status(502).json({ error: 'MF API error', status: mfRes.status });

      const mfData = await mfRes.json();
      const s = mfData?.result?.subject;
      if (!s) return res.status(404).json({ error: 'Company not found' });

      return res.json({ source: 'MF', nip: nipNum, name: s.name, regon: s.regon, krs: s.krs, address: s.workingAddress, statusVat: s.statusVat });
    } else {
      const countryCode = nip.slice(0, 2);
      const vatNumber = nip.slice(2);

      const viesRes = await fetch('https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countryCode, vatNumber }),
      });

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
  const where = {};
  if (search) where.name = { contains: search, mode: 'insensitive' };
  if (country) where.country = { equals: country, mode: 'insensitive' };
  if (tag) where.tags = { has: tag };
  const contractors = await prisma.contractor.findMany({ where, take: parseInt(limit) || 50, orderBy: { updatedAt: 'desc' } });
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

module.exports = { router, scoreContractor, normalizeContractorName, processIfirmaInvoices };
