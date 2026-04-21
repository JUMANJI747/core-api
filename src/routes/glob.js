'use strict';

const router = require('express').Router();
const { getSenders, getReceivers, getOrders, getOrderTracking, getOrderLabels } = require('../glob-client');

function normalizeText(s) {
  return (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ============ SYNC SENDERS ============

router.post('/glob/sync-senders', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    let allSenders = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const data = await getSenders(offset, limit);
      const items = data.results || data.items || data.data || (Array.isArray(data) ? data : []);
      if (!items.length) break;
      allSenders = allSenders.concat(items);
      if (items.length < limit) break;
      offset += limit;
      if (offset > 1000) break;
    }

    console.log(`[glob/sync-senders] Fetched ${allSenders.length} senders from GlobKurier`);

    let created = 0, updated = 0;
    for (const s of allSenders) {
      const globId = String(s.id || s.addressId || '');
      if (!globId) continue;

      const senderData = {
        globKurierId: globId,
        name: s.name || ((s.firstName || '') + ' ' + (s.lastName || '')).trim() || 'Unknown',
        companyName: s.companyName || s.company || null,
        street: s.street || null,
        houseNumber: s.houseNumber || null,
        postCode: s.postCode || s.zipCode || null,
        city: s.city || null,
        country: s.country || s.countryCode || 'PL',
        countryId: s.countryId || 1,
        phone: s.phone || null,
        email: s.email || null,
        extras: s,
      };

      const existing = await prisma.sender.findUnique({ where: { globKurierId: globId } });
      if (existing) {
        await prisma.sender.update({ where: { id: existing.id }, data: senderData });
        updated++;
      } else {
        await prisma.sender.create({ data: senderData });
        created++;
      }
    }

    res.json({ ok: true, total: allSenders.length, created, updated });
  } catch (err) {
    console.error('[glob/sync-senders]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============ SYNC RECEIVERS ============

router.post('/glob/sync-receivers', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    let allReceivers = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const data = await getReceivers(offset, limit);
      const items = data.results || data.items || data.data || (Array.isArray(data) ? data : []);
      if (!items.length) break;
      allReceivers = allReceivers.concat(items);
      if (items.length < limit) break;
      offset += limit;
      if (offset > 5000) break;
    }

    console.log(`[glob/sync-receivers] Fetched ${allReceivers.length} receivers from GlobKurier`);

    let matched = 0, unmatched = 0;
    const unmatchedList = [];

    for (const r of allReceivers) {
      const globId = String(r.id || r.addressId || '');
      if (!globId) continue;

      const recName = (r.companyName || r.name || '').trim();
      const recCity = (r.city || '').trim();
      const recPostCode = (r.postCode || r.zipCode || '').trim();
      const recEmail = (r.email || '').trim().toLowerCase();

      let contractor = null;

      // 1. Email exact match
      if (recEmail) {
        contractor = await prisma.contractor.findFirst({
          where: { email: { equals: recEmail, mode: 'insensitive' } },
        });
      }

      // 2. Name contains (ILIKE)
      if (!contractor && recName) {
        const nameWords = recName.split(/\s+/).filter(w => w.length > 3);
        if (nameWords.length > 0) {
          contractor = await prisma.contractor.findFirst({
            where: {
              OR: [
                { name: { contains: recName, mode: 'insensitive' } },
                { name: { contains: nameWords[0], mode: 'insensitive' } },
              ],
            },
          });
        }
      }

      // 3. Tradename fallback
      if (!contractor && recName) {
        const all = await prisma.contractor.findMany({ where: { extras: { not: null } } });
        contractor = all.find(c => {
          const extras = typeof c.extras === 'object' ? c.extras : {};
          const tradeName = extras.tradeName || '';
          if (tradeName && recName.toLowerCase().includes(tradeName.toLowerCase())) return true;
          const locations = extras.locations || [];
          return locations.some(loc => loc.tradeName && recName.toLowerCase().includes(loc.tradeName.toLowerCase()));
        }) || null;
      }

      if (contractor) {
        const currentExtras = (typeof contractor.extras === 'object' && contractor.extras) ? contractor.extras : {};
        await prisma.contractor.update({
          where: { id: contractor.id },
          data: {
            extras: {
              ...currentExtras,
              globKurierReceiverId: globId,
              globKurierReceiverData: {
                name: recName,
                city: recCity,
                postCode: recPostCode,
                country: r.country || r.countryCode || '',
                email: recEmail,
                phone: r.phone || null,
                street: r.street || null,
                houseNumber: r.houseNumber || null,
              },
            },
          },
        });
        matched++;
        console.log(`[glob/sync-receivers] Matched: ${recName} → ${contractor.name}`);
      } else {
        unmatched++;
        unmatchedList.push({ globId, name: recName, city: recCity, country: r.country || r.countryCode || '', email: recEmail });
      }
    }

    res.json({ ok: true, total: allReceivers.length, matched, unmatched, unmatchedSample: unmatchedList.slice(0, 20) });
  } catch (err) {
    console.error('[glob/sync-receivers]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============ LIST SENDERS ============

router.get('/glob/senders', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const senders = await prisma.sender.findMany({ orderBy: { name: 'asc' } });
  res.json({ ok: true, count: senders.length, senders });
});

// ============ SET DEFAULT SENDER ============

router.post('/glob/sender/:id/set-default', async (req, res) => {
  const prisma = req.app.locals.prisma;
  await prisma.sender.updateMany({ data: { isDefault: false } });
  const sender = await prisma.sender.update({ where: { id: req.params.id }, data: { isDefault: true } });
  res.json({ ok: true, sender });
});

// ============ ORDERS ============

router.get('/glob/orders', async (req, res) => {
  try {
    const { search, status, limit = 50, offset = 0 } = req.query;
    const data = await getOrders({ limit: Math.min(parseInt(limit) || 50, 100), offset: parseInt(offset) || 0, status });
    let orders = data.results || data.items || data.data || (Array.isArray(data) ? data : []);

    if (!Array.isArray(orders)) {
      return res.json({ ok: true, orders: [], total: 0, note: 'Unexpected response from GlobKurier' });
    }

    if (search) {
      const q = normalizeText(search);
      orders = orders.filter(o => {
        const recv = o.receiverAddress || o.receiver || {};
        const send = o.senderAddress || o.sender || {};
        const fields = [
          o.orderNumber, o.number, o.hash, o.trackingNumber, o.tracking,
          recv.name, recv.companyName, recv.city, recv.country,
          send.name, send.companyName, send.city,
        ].filter(Boolean).map(normalizeText);
        return fields.some(f => f.includes(q));
      });
    }

    const mapped = orders.map(o => {
      const recv = o.receiverAddress || o.receiver || {};
      const send = o.senderAddress || o.sender || {};
      return {
        id: o.id,
        hash: o.hash || o.orderHash,
        orderNumber: o.orderNumber || o.number,
        status: o.status || o.statusName,
        statusId: o.statusId,
        creationDate: o.creationDate || o.created_at || o.createdAt,
        receiver: { name: recv.companyName || recv.name, city: recv.city, country: recv.country || recv.countryCode, postCode: recv.postCode || recv.zipCode },
        sender: { name: send.companyName || send.name, city: send.city },
        tracking: o.trackingNumber || o.tracking,
        product: o.productName || (o.product && o.product.name),
        weight: o.weight,
        price: o.price || o.totalPrice,
      };
    });

    res.json({ ok: true, orders: mapped, total: mapped.length });
  } catch (err) {
    console.error('[glob/orders]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============ TRACKING ============

router.get('/glob/tracking/:hash', async (req, res) => {
  try {
    const data = await getOrderTracking(req.params.hash);
    res.json({ ok: true, tracking: data });
  } catch (err) {
    console.error('[glob/tracking]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============ LABELS (CMR PDF) ============

router.get('/glob/labels/:hash', async (req, res) => {
  try {
    const format = req.query.format || 'A4';
    const result = await getOrderLabels(req.params.hash, format);
    if (result.status !== 200) return res.status(result.status).json({ error: 'Label fetch failed' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="CMR-${req.params.hash.slice(0, 12)}.pdf"`);
    res.send(result.body);
  } catch (err) {
    console.error('[glob/labels]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
