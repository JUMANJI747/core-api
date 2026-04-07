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

async function processIfirmaInvoices(invoices, prisma, opts = {}) {
  const { dataOd, dataDo, dryRun = false } = opts;

  // ============ FAZA 1: KONTRAHENCI ============
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
    } else if (!dryRun) {
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
    } else {
      contractorsCreated++;
    }
  }

  // ============ FAZA 2: FAKTURY ============
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
      if (!dryRun) {
        const updateData = { paidAmount, status };
        if (!existing.ifirmaType && inv.Rodzaj) updateData.ifirmaType = inv.Rodzaj;
        await prisma.invoice.update({ where: { ifirmaId }, data: updateData });
      }
      invoicesUpdated++;
    } else {
      if (!dryRun) {
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
            ifirmaType: inv.Rodzaj || null,
            source: 'ifirma_sync',
            ifirmaContractorId: inv.IdentyfikatorKontrahenta ? String(inv.IdentyfikatorKontrahenta) : null,
            extras: { kontrahentNazwa: inv.NazwaKontrahenta || inv.KontrahentNazwa || '' },
          },
        });
      }
      invoicesCreated++;
    }
  }

  // ============ FAZA 2.5: USUWANIE NIEISTNIEJĄCYCH W IFIRMA ============
  const deleted = [];
  if (dataOd && dataDo) {
    const localInvoices = await prisma.invoice.findMany({
      where: { issueDate: { gte: new Date(dataOd), lte: new Date(dataDo + 'T23:59:59Z') } },
    });

    const ifirmaIds = new Set(invoices.map(i => i.FakturaId).filter(Boolean));
    const ifirmaNumbers = new Set(invoices.map(i => i.PelnyNumer).filter(Boolean));

    for (const local of localInvoices) {
      let foundInIfirma = false;
      if (local.ifirmaId) {
        foundInIfirma = ifirmaIds.has(local.ifirmaId);
      } else {
        foundInIfirma = ifirmaNumbers.has(local.number);
      }

      if (!foundInIfirma) {
        if (!dryRun) {
          try {
            await prisma.invoice.delete({ where: { id: local.id } });
          } catch (e) {
            console.error(`[sync] failed to delete invoice ${local.number}:`, e.message);
            continue;
          }
        }
        deleted.push({ id: local.id, number: local.number, ifirmaId: local.ifirmaId, grossAmount: local.grossAmount });
      }
    }
  }

  // ============ FAZA 3: LINKOWANIE EMAILI ============
  let linked = 0;
  if (!dryRun) {
    const allContractors = await prisma.contractor.findMany({ select: { id: true, name: true } });
    for (const contractor of allContractors) {
      if (!contractor.name || contractor.name.length < 4) continue;
      const updated = await prisma.email.updateMany({
        where: { contractorId: null, fromName: { contains: contractor.name, mode: 'insensitive' } },
        data: { contractorId: contractor.id },
      });
      linked += updated.count;
    }
  }

  // ============ TELEGRAM ============
  if (!dryRun && dataOd && dataDo && (invoicesCreated > 0 || invoicesUpdated > 0 || deleted.length > 0)) {
    try {
      const { sendTelegram } = require('../telegram-utils');
      const [tgTokenCfg, tgChatCfg] = await Promise.all([
        prisma.config.findUnique({ where: { key: 'telegram_bot_token' } }),
        prisma.config.findUnique({ where: { key: 'telegram_chat_id' } }),
      ]);
      const tgToken = tgTokenCfg && tgTokenCfg.value;
      const tgChat = tgChatCfg && tgChatCfg.value;
      if (tgToken && tgChat) {
        const localCount = dataOd ? (await prisma.invoice.count({
          where: { issueDate: { gte: new Date(dataOd), lte: new Date(dataDo + 'T23:59:59Z') } },
        })) : '?';
        await sendTelegram(tgToken, tgChat,
          `🔄 Sync iFirma — ${dataOd} → ${dataDo}\n📊 iFirma: ${invoices.length} | Lokalne: ${localCount}\n🗑 Usunięte: ${deleted.length}\n📥 Nowe: ${invoicesCreated}\n✏️ Zaktualizowane: ${invoicesUpdated}`
        );
      }
    } catch (e) {
      console.error('[sync] Telegram notify error:', e.message);
    }
  }

  return {
    contractors: { created: contractorsCreated, skipped: contractorsSkipped },
    invoices: { created: invoicesCreated, updated: invoicesUpdated },
    deleted,
    deletedCount: deleted.length,
    linked,
  };
}

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

    // Find existing: by NIP, then by email, then by exact name
    let existing = null;
    if (n.nip) existing = await prisma.contractor.findUnique({ where: { nip: n.nip } });
    if (!existing && n.email) existing = await prisma.contractor.findFirst({ where: { email: { equals: n.email, mode: 'insensitive' } } });
    if (!existing && !n.nip) existing = await prisma.contractor.findFirst({ where: { name: { equals: n.name, mode: 'insensitive' } } });

    let contractor;
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
          extras: n.extras,
          tags: n.tags,
          source: n.source,
        },
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
