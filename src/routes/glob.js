'use strict';

const router = require('express').Router();
const { getSenders, getReceivers, getOrders, getOrderTracking, getOrderLabels, getQuote, getAddons, getPickupTimes, createOrder } = require('../glob-client');

function normalizeText(s) {
  return (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const PACKAGE_PRESETS = {
  karton_stickow: { name: 'Karton 30 sticków', weight: 1, length: 30, width: 20, height: 8, qty: 30, product: 'stick' },
  karton_mascar: { name: 'Karton 30 mascar', weight: 1, length: 30, width: 20, height: 8, qty: 30, product: 'mascara' },
  karton_collection: { name: 'Karton collection', weight: 2, length: 35, width: 25, height: 12, qty: 30, product: 'collection' },
  maly_karton: { name: 'Mały karton (do 10 szt)', weight: 0.5, length: 20, width: 15, height: 8, qty: 10, product: 'mix' },
};

// GlobKurier countryId mapping (verified from real API data)
const COUNTRY_IDS = {
  PL: 1, BE: 5, CZ: 8, DK: 9, GR: 13, ES: 14, PT: 24, HU: 32, HR: 131, MT: 206, AE: 293,
  // Missing (DE, FR, IT, NL, AT, SE, GB) — will be added when seen in data
};

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
                countryId: r.countryId || null,
                email: recEmail,
                phone: r.phone || null,
                street: r.street || null,
                houseNumber: r.houseNumber || null,
                apartmentNumber: r.apartmentNumber || null,
                contactPerson: r.contactPerson || null,
              },
            },
          },
        });
        matched++;
        console.log(`[glob/sync-receivers] Matched: ${recName} → ${contractor.name}`);
      } else {
        unmatched++;
        unmatchedList.push({ globId, name: recName, city: recCity, country: r.country || r.countryCode || '', countryId: r.countryId || null, email: recEmail });
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
      const pricing = o.pricing || {};
      const carrier = o.carrier || {};
      return {
        id: o.id,
        hash: o.hash || o.orderHash,
        orderNumber: o.number || o.orderNumber,
        status: o.status || o.statusName,
        creationDate: o.creationDate || o.created_at || o.createdAt,
        receiver: {
          name: recv.companyName || recv.name,
          contactPerson: recv.contactPerson,
          city: recv.city,
          postCode: recv.postCode || recv.zipCode,
          countryId: recv.countryId || null,
          country: recv.country || recv.countryCode || null,
          phone: recv.phone,
          email: recv.email,
        },
        sender: {
          name: send.companyName || send.name,
          city: send.city,
          countryId: send.countryId || null,
        },
        tracking: o.trackingNumber || o.tracking,
        product: o.productName || (o.product && o.product.name),
        carrier: typeof carrier === 'object' ? (carrier.name || '') : carrier,
        priceGross: pricing.priceGross || o.priceGross || null,
        priceNet: pricing.priceNet || o.priceNet || null,
        currency: pricing.currency || o.currency || 'PLN',
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

// ============ DEBUG: RAW ==========

router.get('/glob/debug/raw-receiver', async (req, res) => {
  try {
    const data = await getReceivers(0, 3);
    const items = data.results || data.items || data.data || (Array.isArray(data) ? data : []);
    res.json({ ok: true, firstItemKeys: items[0] ? Object.keys(items[0]) : [], sample: items[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/glob/debug/raw-order', async (req, res) => {
  try {
    const data = await getOrders({ limit: 1 });
    const items = data.results || data.items || data.data || (Array.isArray(data) ? data : []);
    res.json({ ok: true, firstItemKeys: items[0] ? Object.keys(items[0]) : [], sample: items[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ PRESETS ============

router.get('/glob/presets', (req, res) => {
  res.json({ ok: true, presets: PACKAGE_PRESETS });
});

// ============ QUOTE ============

router.post('/glob/quote', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    let { preset, receiverSearch, senderId, weight, length, width, height } = req.body || {};

    if (preset && PACKAGE_PRESETS[preset]) {
      const p = PACKAGE_PRESETS[preset];
      weight = weight || p.weight;
      length = length || p.length;
      width = width || p.width;
      height = height || p.height;
    }

    if (!weight || !length || !width || !height) {
      return res.status(400).json({ ok: false, error: 'Brak wymiarów paczki. Podaj preset lub weight/length/width/height' });
    }

    // Sender
    let sender;
    if (senderId) {
      sender = await prisma.sender.findUnique({ where: { id: senderId } });
    } else {
      sender = await prisma.sender.findFirst({ where: { isDefault: true } });
      if (!sender) sender = await prisma.sender.findFirst();
    }
    if (!sender) return res.status(400).json({ ok: false, error: 'Brak nadawcy. POST /api/glob/sync-senders' });

    // Receiver via Contractor search
    if (!receiverSearch) return res.status(400).json({ ok: false, error: 'Podaj receiverSearch (nazwa kontrahenta)' });

    const contractor = await prisma.contractor.findFirst({
      where: {
        OR: [
          { name: { contains: receiverSearch, mode: 'insensitive' } },
          { city: { contains: receiverSearch, mode: 'insensitive' } },
          { email: { contains: receiverSearch, mode: 'insensitive' } },
        ],
      },
    });
    if (!contractor) return res.status(404).json({ ok: false, error: 'Nie znaleziono kontrahenta: ' + receiverSearch });

    const cExtras = (typeof contractor.extras === 'object' && contractor.extras) || {};
    const gkData = cExtras.globKurierReceiverData || {};
    const billing = cExtras.billingAddress || {};
    const receiver = {
      name: contractor.name,
      contractorId: contractor.id,
      city: gkData.city || billing.city || contractor.city || '',
      postCode: gkData.postCode || billing.postCode || '',
      country: gkData.country || billing.country || contractor.country || 'PL',
      countryId: gkData.countryId || null,
      phone: gkData.phone || contractor.phone || '',
      email: gkData.email || contractor.email || '',
      street: gkData.street || billing.street || contractor.address || '',
      houseNumber: gkData.houseNumber || '',
      apartmentNumber: gkData.apartmentNumber || '',
      contactPerson: gkData.contactPerson || null,
    };

    const senderCountryId = sender.countryId || COUNTRY_IDS[sender.country] || 1;
    const receiverCountryId = gkData.countryId || COUNTRY_IDS[receiver.country] || 1;

    const quoteParams = {
      weight, length, width, height,
      senderCountryId,
      senderPostCode: sender.postCode || '',
      receiverCountryId,
      receiverPostCode: receiver.postCode || '',
    };

    const productsData = await getQuote(quoteParams);
    const products = productsData.standard || productsData.results || productsData.items || (Array.isArray(productsData) ? productsData : []);

    if (!Array.isArray(products) || products.length === 0) {
      return res.json({ ok: true, offers: [], note: 'Brak ofert dla tej trasy', rawResponse: productsData });
    }

    const filtered = products
      .filter(p => {
        const name = (p.name || '').toLowerCase();
        const carrier = (p.carrierName || '').toLowerCase();
        return !name.includes('pocztex') && !carrier.includes('pocztex');
      })
      .sort((a, b) => (parseFloat(a.netPrice) || 999) - (parseFloat(b.netPrice) || 999));

    const offers = filtered.slice(0, 10).map(p => ({
      productId: p.id,
      carrier: p.carrierName,
      name: p.name,
      netPrice: parseFloat(p.netPrice),
      grossPrice: parseFloat(p.grossPrice),
      currency: p.currency || 'PLN',
      deliveryTime: p.deliveryTime || p.transitTime,
      maxWeight: p.maxWeight,
    }));

    const quoteStore = req.app.locals.quoteStore = req.app.locals.quoteStore || {};
    const quoteId = Date.now().toString();
    quoteStore[quoteId] = { sender, receiver, quoteParams, offers, preset: preset || null, createdAt: new Date() };
    for (const k of Object.keys(quoteStore)) {
      if (Date.now() - new Date(quoteStore[k].createdAt).getTime() > 30 * 60 * 1000) delete quoteStore[k];
    }

    res.json({
      ok: true,
      quoteId,
      sender: { name: sender.companyName || sender.name, city: sender.city },
      receiver: { name: receiver.name, city: receiver.city, country: receiver.country },
      package: { weight, length, width, height, preset: preset || 'custom' },
      offers,
      cheapest: offers[0] || null,
      note: 'Wybierz ofertę: POST /api/glob/order { quoteId, productId }',
    });
  } catch (err) {
    console.error('[glob/quote]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============ ORDER ============

router.post('/glob/order', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { quoteId, productId } = req.body || {};
    if (!quoteId) return res.status(400).json({ ok: false, error: 'Brak quoteId — najpierw POST /api/glob/quote' });

    const quoteStore = req.app.locals.quoteStore || {};
    const quote = quoteStore[quoteId];
    if (!quote) return res.status(404).json({ ok: false, error: 'Quote wygasł. Pobierz nowy: POST /api/glob/quote' });

    const selectedOffer = productId
      ? quote.offers.find(o => String(o.productId) === String(productId))
      : quote.offers[0];
    if (!selectedOffer) return res.status(404).json({ ok: false, error: 'Nie znaleziono oferty o podanym productId' });

    // Get addons and pickup times
    const addonsData = await getAddons(selectedOffer.productId, quote.quoteParams);
    const addons = addonsData.addons || addonsData.results || [];
    const pickupAddon = addons.find(a => /podjazd/i.test(a.addonName || ''));
    const deliveryAddon = addons.find(a => /doręczenie|delivery/i.test(a.addonName || ''));

    const pickupData = await getPickupTimes(selectedOffer.productId, {
      ...quote.quoteParams,
      receiverCity: quote.receiver.city,
    });
    const pickupList = pickupData.results || pickupData.items || (Array.isArray(pickupData) ? pickupData : []);
    const firstPickup = pickupList[0] || {};

    const sender = quote.sender;
    const receiver = quote.receiver;
    const senderExtras = (typeof sender.extras === 'object' && sender.extras) || {};

    function trimName(name, max = 30) {
      if (!name || name.length <= max) return name;
      return name.split(' ').reduce((acc, w) => {
        const next = (acc + ' ' + w).trim();
        return next.length <= max ? next : acc;
      }, '').trim();
    }

    const orderPayload = {
      shipment: {
        productId: selectedOffer.productId,
        addonIds: [pickupAddon && pickupAddon.id, deliveryAddon && deliveryAddon.id].filter(Boolean),
        collectionDate: firstPickup.date || new Date().toISOString().split('T')[0],
        collectionTimeFrom: firstPickup.from || '09:00',
        collectionTimeTo: firstPickup.to || '17:00',
        parcel: {
          weight: quote.quoteParams.weight,
          length: quote.quoteParams.length,
          width: quote.quoteParams.width,
          height: quote.quoteParams.height,
          quantity: 1,
          contents: 'Cosmetics / Surf Stick Bell',
        },
      },
      senderAddress: {
        name: trimName(senderExtras.name || sender.companyName || sender.name),
        street: senderExtras.street || sender.street || '',
        houseNumber: senderExtras.houseNumber || sender.houseNumber || '',
        postCode: sender.postCode || '',
        city: sender.city || '',
        countryId: sender.countryId || COUNTRY_IDS[sender.country] || 1,
        phone: senderExtras.phone || sender.phone || '',
        email: senderExtras.email || sender.email || 'delivery@surfstickbell.com',
      },
      receiverAddress: {
        name: trimName(receiver.name),
        street: receiver.street || '',
        houseNumber: receiver.houseNumber || '',
        postCode: receiver.postCode || '',
        city: receiver.city || '',
        countryId: receiver.countryId || COUNTRY_IDS[receiver.country] || 1,
        phone: receiver.phone || '',
        email: receiver.email || '',
      },
    };

    function removeNulls(obj) {
      if (Array.isArray(obj)) return obj.map(removeNulls).filter(v => v !== null && v !== undefined && v !== '');
      if (obj && typeof obj === 'object') {
        const cleaned = {};
        for (const [k, v] of Object.entries(obj)) {
          if (v !== null && v !== undefined && v !== '' && v !== 'null') cleaned[k] = removeNulls(v);
        }
        return cleaned;
      }
      return obj;
    }

    const cleanedPayload = removeNulls(orderPayload);
    console.log('[glob/order] Creating order:', JSON.stringify(cleanedPayload));

    const result = await createOrder(cleanedPayload);
    delete quoteStore[quoteId];

    res.json({
      ok: true,
      order: result,
      carrier: selectedOffer.carrier,
      price: selectedOffer.netPrice + ' ' + selectedOffer.currency,
      sender: { name: sender.companyName || sender.name, city: sender.city },
      receiver: { name: receiver.name, city: receiver.city },
    });
  } catch (err) {
    console.error('[glob/order]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
