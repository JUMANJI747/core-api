'use strict';

const router = require('express').Router();
const https = require('https');
const { getSenders, getReceivers, getOrders, getOrderTracking, getOrderLabels, getQuote, getAddons, getPickupTimes, createOrder } = require('../glob-client');

function normalizeText(s) {
  return (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const PACKAGE_PRESETS = {
  maly_kartonik: { name: 'Mały kartonik (30 szt)', weight: 1, length: 20, width: 20, height: 10 },
  duzy_karton: { name: 'Duży karton (40×40×40)', weight: 10, length: 40, width: 40, height: 40 },
  paczkomat_a: { name: 'Paczkomat A (mały)', weight: 1, length: 38, width: 64, height: 8 },
  paczkomat_b: { name: 'Paczkomat B (średni)', weight: 2, length: 38, width: 64, height: 19 },
  paczkomat_c: { name: 'Paczkomat C (duży)', weight: 5, length: 38, width: 64, height: 41 },
};

const PRODUCT_WEIGHTS = {
  stick: 1, mascara: 1, gel: 1, daily: 1, care: 1, lips: 0.5, collection: 2,
};

function calculatePackageFromItems(items) {
  let totalWeight = 0;
  let kartonikCount = 0;
  for (const item of (items || [])) {
    const name = (item.name || item.productName || item.productEan || '').toLowerCase();
    const qty = item.qty || item.quantity || 1;
    let productType = 'stick';
    if (name.includes('mascara') || name.includes('girl')) productType = 'mascara';
    else if (name.includes('gel')) productType = 'gel';
    else if (name.includes('daily')) productType = 'daily';
    else if (name.includes('care')) productType = 'care';
    else if (name.includes('lip')) productType = 'lips';
    else if (name.includes('collection') || name.includes('box')) productType = 'collection';
    const weightPer30 = PRODUCT_WEIGHTS[productType] || 1;
    totalWeight += (qty / 30) * weightPer30;
    kartonikCount += Math.ceil(qty / 36);
  }
  totalWeight = Math.max(1, Math.ceil(totalWeight));

  // Box single: 10×20×20 (h×w×l)
  const BOX = { h: 10, w: 20, l: 20 };
  let dimensions;
  if (kartonikCount <= 1) {
    dimensions = { length: BOX.l, width: BOX.w, height: BOX.h };
  } else if (kartonikCount <= 2) {
    dimensions = { length: BOX.l, width: BOX.w, height: BOX.h * 2 }; // 20×20×20
  } else if (kartonikCount <= 4) {
    dimensions = { length: BOX.l * 2, width: BOX.w, height: BOX.h * 2 }; // 40×20×20
  } else if (kartonikCount <= 6) {
    dimensions = { length: BOX.l * 2, width: BOX.w, height: BOX.h * 3 }; // 40×20×30
  } else if (kartonikCount <= 8) {
    dimensions = { length: BOX.l * 2, width: BOX.w * 2, height: BOX.h * 2 }; // 40×40×20
  } else if (kartonikCount <= 12) {
    dimensions = { length: BOX.l * 2, width: BOX.w * 2, height: BOX.h * 3 }; // 40×40×30
  } else {
    dimensions = { length: 40, width: 40, height: 40 };
    if (kartonikCount > 16) {
      dimensions.height = Math.min(60, Math.ceil(kartonikCount / 4) * BOX.h);
    }
  }

  return {
    weight: totalWeight,
    ...dimensions,
    kartonikCount,
    description: `${kartonikCount} kartonik(ów) ${dimensions.length}×${dimensions.width}×${dimensions.height} cm, ${totalWeight} kg`,
  };
}

const PACZKOMAT_SIZES = {
  A: { maxHeight: 8, maxWidth: 38, maxLength: 64 },
  B: { maxHeight: 19, maxWidth: 38, maxLength: 64 },
  C: { maxHeight: 41, maxWidth: 38, maxLength: 64 },
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

async function handleSearchOrders(req, res) {
  try {
    const params = { ...req.query, ...(req.body || {}) };
    const { search, status, limit = 50, offset = 0 } = params;
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
}

router.get('/glob/orders', handleSearchOrders);
router.post('/glob/orders', handleSearchOrders);

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

// ============ SEND LABEL TO TELEGRAM ============

router.post('/glob/send-label', async (req, res) => {
  try {
    const { hash, chatId, caption } = req.body || {};
    if (!hash) return res.status(400).json({ ok: false, error: 'Brak hash zamówienia' });

    const tgToken = process.env.TELEGRAM_BOT_TOKEN || '8359714766:AAHHE2bStorakXZRSaxtxZl69EqJWA_GlC4';
    const tgChat = chatId || process.env.TELEGRAM_CHAT_ID || '8164528644';
    if (!tgToken || !tgChat) return res.status(500).json({ ok: false, error: 'Brak konfiguracji Telegram' });

    const result = await getOrderLabels(hash, 'A4');
    if (result.status !== 200 || !result.body || result.body.length === 0) {
      return res.status(404).json({ ok: false, error: 'Nie udało się pobrać etykiety', status: result.status });
    }
    const pdfBuffer = result.body;
    const filename = `CMR-${hash.slice(0, 16)}.pdf`;
    const captionText = caption || `List przewozowy ${hash.slice(0, 12)}...`;

    // Build multipart body (same pattern as invoices.js)
    const boundary = '----FormBoundary' + Date.now();
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${tgChat}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${captionText}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
    ];
    const pre = Buffer.from(parts.join('\r\n') + '\r\n', 'utf8');
    const post = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([pre, pdfBuffer, post]);

    const tgResult = await new Promise((resolve, reject) => {
      const tgUrl = new URL(`https://api.telegram.org/bot${tgToken}/sendDocument`);
      const options = {
        hostname: tgUrl.hostname,
        path: tgUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      };
      const req2 = https.request(options, r => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          try { resolve({ status: r.statusCode, body: JSON.parse(text) }); }
          catch (e) { resolve({ status: r.statusCode, body: text }); }
        });
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    if (!tgResult.body || tgResult.body.ok !== true) {
      console.error('[glob/send-label] Telegram error:', tgResult.body);
      return res.status(500).json({ ok: false, error: 'Telegram send failed', details: tgResult.body });
    }

    res.json({
      ok: true,
      hash,
      sent: true,
      size: pdfBuffer.length,
      telegramMessageId: tgResult.body.result && tgResult.body.result.message_id,
    });
  } catch (err) {
    console.error('[glob/send-label]', err.message);
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

// ============ CALCULATE PACKAGE ============

router.post('/glob/calculate-package', async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, error: 'Podaj items z qty i name' });
  const result = calculatePackageFromItems(items);
  res.json({ ok: true, ...result });
});

router.post('/glob/quote', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    let { preset, packageType, quantity, weightPerPackage, invoiceNumber,
          receiverSearch, senderSearch, senderId,
          weight, length, width, height, items, paczkomat, deliveryType, pickupDate } = req.body || {};

    // Resolve pickupDate
    function nextWorkingDay(date) {
      const d = new Date(date);
      if (d.getDay() === 6) d.setDate(d.getDate() + 2); // sobota → pn
      else if (d.getDay() === 0) d.setDate(d.getDate() + 1); // niedziela → pn
      return d;
    }
    if (!pickupDate) {
      const now = new Date();
      const target = new Date(now);
      if (now.getHours() >= 14) target.setDate(target.getDate() + 1);
      pickupDate = nextWorkingDay(target).toISOString().split('T')[0];
    } else if (pickupDate === 'jutro' || pickupDate === 'tomorrow') {
      const t = new Date(); t.setDate(t.getDate() + 1);
      pickupDate = nextWorkingDay(t).toISOString().split('T')[0];
    } else if (pickupDate === 'pojutrze') {
      const t = new Date(); t.setDate(t.getDate() + 2);
      pickupDate = nextWorkingDay(t).toISOString().split('T')[0];
    } else if (pickupDate === 'dzis' || pickupDate === 'dziś' || pickupDate === 'today') {
      pickupDate = new Date().toISOString().split('T')[0];
    }

    // 1. SENDER — search > id > default
    let sender;
    if (senderSearch) {
      sender = await prisma.sender.findFirst({
        where: {
          OR: [
            { name: { contains: senderSearch, mode: 'insensitive' } },
            { companyName: { contains: senderSearch, mode: 'insensitive' } },
            { city: { contains: senderSearch, mode: 'insensitive' } },
          ],
        },
      });
      if (!sender) return res.status(404).json({ ok: false, error: 'Nie znaleziono nadawcy: ' + senderSearch });
    } else if (senderId) {
      sender = await prisma.sender.findUnique({ where: { id: senderId } });
    } else {
      sender = await prisma.sender.findFirst({ where: { isDefault: true } });
      if (!sender) sender = await prisma.sender.findFirst();
    }
    if (!sender) return res.status(400).json({ ok: false, error: 'Brak nadawcy. POST /api/glob/sync-senders' });

    // 2A. PACZKA — z faktury
    if (invoiceNumber) {
      const invoice = await prisma.invoice.findFirst({
        where: { number: invoiceNumber },
        orderBy: { createdAt: 'desc' },
      });
      if (invoice && invoice.extras && Array.isArray(invoice.extras.items)) {
        const calc = calculatePackageFromItems(invoice.extras.items);
        weight = weight || calc.weight;
        length = length || calc.length;
        width = width || calc.width;
        height = height || calc.height;
      } else if (invoice) {
        weight = weight || 1;
        length = length || 20; width = width || 20; height = height || 10;
      }
    }

    // 2B. PRESET × quantity
    if (packageType && PACKAGE_PRESETS[packageType]) {
      const p = PACKAGE_PRESETS[packageType];
      const qty = quantity || 1;
      weight = (weightPerPackage || p.weight) * qty;
      length = p.length;
      width = p.width;
      height = qty === 1 ? p.height : Math.min(p.height * qty, 60);
    }

    // 2C. Auto-kalkulacja z items
    let packageCalc = null;
    if (items && Array.isArray(items) && items.length > 0 && !weight) {
      packageCalc = calculatePackageFromItems(items);
      weight = packageCalc.weight;
      length = packageCalc.length;
      width = packageCalc.width;
      height = packageCalc.height;
    }

    // Legacy preset support
    if (preset && PACKAGE_PRESETS[preset] && !weight) {
      const p = PACKAGE_PRESETS[preset];
      weight = p.weight; length = p.length; width = p.width; height = p.height;
    }

    if (!weight || !length || !width || !height) {
      return res.status(400).json({ ok: false, error: 'Brak wymiarów paczki. Podaj packageType/invoiceNumber/items lub weight/length/width/height' });
    }

    // 3. PACZKOMAT — fit dimensions
    let paczkomatSize = null;
    if (paczkomat) {
      const dims = [length, width, height].sort((a, b) => a - b);
      for (const [size, lim] of Object.entries(PACZKOMAT_SIZES)) {
        if (dims[0] <= lim.maxHeight && dims[1] <= lim.maxWidth && dims[2] <= lim.maxLength) {
          paczkomatSize = size;
          height = Math.min(dims[0], lim.maxHeight);
          width = Math.min(dims[1], lim.maxWidth);
          length = Math.min(dims[2], lim.maxLength);
          break;
        }
      }
      if (!paczkomatSize) {
        return res.json({
          ok: true, offers: [],
          warning: 'Paczka za duża na paczkomat InPost (max C: 41×38×64). Użyj kuriera do drzwi.',
          package: { weight, length, width, height },
        });
      }
    }

    // 4. RECEIVER — Contractor → GlobKurier API → Sender table
    if (!receiverSearch) return res.status(400).json({ ok: false, error: 'Podaj receiverSearch (nazwa kontrahenta)' });

    let receiver = null;
    let receiverSource = null;
    let gkData = {};

    // Step 1: Contractor (local DB)
    const contractor = await prisma.contractor.findFirst({
      where: {
        OR: [
          { name: { contains: receiverSearch, mode: 'insensitive' } },
          { city: { contains: receiverSearch, mode: 'insensitive' } },
          { email: { contains: receiverSearch, mode: 'insensitive' } },
        ],
      },
    });

    if (contractor) {
      const cExtras = (typeof contractor.extras === 'object' && contractor.extras) || {};
      gkData = cExtras.globKurierReceiverData || {};
      const billing = cExtras.billingAddress || {};
      receiver = {
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
      receiverSource = 'contractor';
    }

    // Step 2: GlobKurier address book (API search)
    if (!receiver) {
      try {
        const gkRes = await getReceivers(0, 20, receiverSearch);
        const results = gkRes.results || gkRes.items || gkRes.data || (Array.isArray(gkRes) ? gkRes : []);
        if (results.length > 0) {
          const r = results[0];
          receiver = {
            name: r.companyName || r.name || r.contactPerson || receiverSearch,
            city: r.city || '',
            postCode: r.postCode || r.zipCode || '',
            country: r.countryCode || r.country || 'PL',
            countryId: r.countryId || null,
            phone: r.phone || '',
            email: r.email || '',
            street: r.street || '',
            houseNumber: r.houseNumber || '',
            apartmentNumber: r.apartmentNumber || '',
            contactPerson: r.contactPerson || null,
            globKurierId: r.id,
          };
          receiverSource = 'globkurier';
        }
      } catch (err) {
        console.log('[glob/quote] GlobKurier receiver search failed:', err.message);
      }
    }

    // Step 3: Sender table (in case user mixed up sender/receiver names)
    if (!receiver) {
      const senderAsReceiver = await prisma.sender.findFirst({
        where: {
          OR: [
            { name: { contains: receiverSearch, mode: 'insensitive' } },
            { companyName: { contains: receiverSearch, mode: 'insensitive' } },
            { city: { contains: receiverSearch, mode: 'insensitive' } },
          ],
        },
      });
      if (senderAsReceiver) {
        receiver = {
          name: senderAsReceiver.companyName || senderAsReceiver.name,
          city: senderAsReceiver.city || '',
          postCode: senderAsReceiver.postCode || '',
          country: senderAsReceiver.country || 'PL',
          countryId: senderAsReceiver.countryId || null,
          phone: senderAsReceiver.phone || '',
          email: senderAsReceiver.email || '',
          street: senderAsReceiver.street || '',
          houseNumber: senderAsReceiver.houseNumber || '',
        };
        receiverSource = 'sender_table';
      }
    }

    if (!receiver) {
      return res.status(404).json({ ok: false, error: 'Nie znaleziono odbiorcy: ' + receiverSearch + '. Sprawdź kontrahentów, książkę adresową GlobKurier lub nadawców.' });
    }

    const senderCountryId = sender.countryId || COUNTRY_IDS[sender.country] || 1;
    const receiverCountryId = receiver.countryId || COUNTRY_IDS[receiver.country] || 1;

    const collectionType = req.body.collectionType || 'PICKUP';
    const deliveryType = req.body.deliveryType || 'DOOR';
    const quoteParams = {
      weight, length, width, height,
      senderCountryId,
      senderPostCode: sender.postCode || '',
      receiverCountryId,
      receiverPostCode: receiver.postCode || '',
      collectionType,
      deliveryType,
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
      .sort((a, b) => (parseFloat(a.grossPrice) || 999) - (parseFloat(b.grossPrice) || 999));

    const offers = filtered.slice(0, 10).map(p => ({
      productId: p.id,
      carrier: p.carrierName,
      name: p.name,
      price: parseFloat(p.grossPrice),
      currency: p.currency || 'PLN',
      deliveryTime: p.deliveryTime || p.transitTime,
      maxWeight: p.maxWeight,
    }));

    const quoteStore = req.app.locals.quoteStore = req.app.locals.quoteStore || {};
    const quoteId = Date.now().toString();
    quoteStore[quoteId] = { sender, receiver, quoteParams, offers, preset: preset || null, pickupDate, collectionType, deliveryType, createdAt: new Date() };
    for (const k of Object.keys(quoteStore)) {
      if (Date.now() - new Date(quoteStore[k].createdAt).getTime() > 30 * 60 * 1000) delete quoteStore[k];
    }

    res.json({
      ok: true,
      quoteId,
      sender: { name: sender.companyName || sender.name, city: sender.city },
      receiver: { name: receiver.name, city: receiver.city, country: receiver.country },
      receiverSource,
      package: { weight, length, width, height },
      packageCalc,
      pickupDate,
      paczkomatSize: paczkomatSize || null,
      offers,
      cheapest: offers[0] ? { carrier: offers[0].carrier, price: offers[0].price, currency: offers[0].currency } : null,
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
    let { quoteId, productId } = req.body || {};
    const quoteStore = req.app.locals.quoteStore || {};

    // Fallback 1: extract quoteId from free-text query
    if (!quoteId && req.body && req.body.query) {
      const m = String(req.body.query).match(/quoteId[=:\s]+(\d+)/i);
      if (m) quoteId = m[1];
    }

    // Fallback 2: use latest quote in store
    if (!quoteId) {
      const keys = Object.keys(quoteStore).sort((a, b) => b - a);
      if (keys.length > 0) {
        quoteId = keys[0];
        console.log('[glob/order] Using latest quoteId:', quoteId);
      }
    }

    if (!quoteId) return res.status(400).json({ ok: false, error: 'Brak quoteId — najpierw POST /api/glob/quote' });

    const quote = quoteStore[quoteId];
    if (!quote) return res.status(404).json({ ok: false, error: 'Quote wygasł. Pobierz nowy: POST /api/glob/quote' });

    const deliveryType = (req.body && req.body.deliveryType) || quote.deliveryType || 'DOOR';
    const collectionType = (req.body && req.body.collectionType) || quote.collectionType || 'PICKUP';

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

    // Required defaults (GlobKurier rejects empty required fields)
    const DEFAULT_SENDER_PHONE = '+48502189886';
    const DEFAULT_SENDER_EMAIL = 'delivery@surfstickbell.com';
    const DEFAULT_RECEIVER_PHONE = '000000000';
    const DEFAULT_RECEIVER_EMAIL = 'delivery@surfstickbell.com';

    // Refresh contractor for receiver fallback if missing data
    let contractorForReceiver = null;
    if (receiver.contractorId) {
      try { contractorForReceiver = await prisma.contractor.findUnique({ where: { id: receiver.contractorId } }); } catch (_) {}
    }
    const cExtras = (contractorForReceiver && typeof contractorForReceiver.extras === 'object' && contractorForReceiver.extras) || {};
    const cBilling = cExtras.billingAddress || {};
    const cGkData = cExtras.globKurierReceiverData || {};

    const senderName = trimName(senderExtras.name || sender.companyName || sender.name || 'Surf Stick Bell');
    const senderStreet = senderExtras.street || sender.street || '';
    const senderHouse = senderExtras.houseNumber || sender.houseNumber || '';
    const senderPostCode = sender.postCode || senderExtras.postCode || '';
    const senderCity = sender.city || senderExtras.city || '';
    const senderPhone = senderExtras.phone || sender.phone || DEFAULT_SENDER_PHONE;
    const senderEmail = senderExtras.email || sender.email || DEFAULT_SENDER_EMAIL;

    const receiverName = trimName(receiver.name || cGkData.name || (contractorForReceiver && contractorForReceiver.name) || 'Receiver');
    const receiverStreet = receiver.street || cGkData.street || cBilling.street || (contractorForReceiver && contractorForReceiver.address) || '';
    const receiverHouse = receiver.houseNumber || cGkData.houseNumber || '';
    const receiverPostCode = receiver.postCode || cGkData.postCode || cBilling.postCode || '';
    const receiverCity = receiver.city || cGkData.city || cBilling.city || (contractorForReceiver && contractorForReceiver.city) || '';
    const receiverPhone = receiver.phone || cGkData.phone || (contractorForReceiver && contractorForReceiver.phone) || DEFAULT_RECEIVER_PHONE;
    const receiverEmail = receiver.email || cGkData.email || (contractorForReceiver && contractorForReceiver.email) || DEFAULT_RECEIVER_EMAIL;

    // Sanitize phone — must contain digits, no leading zeros only
    function sanitizePhone(phone, fallback) {
      if (!phone) return fallback;
      const cleaned = String(phone).replace(/[^\d+]/g, '');
      if (cleaned.length < 7 || /^0+$/.test(cleaned)) return fallback;
      return cleaned;
    }
    const cleanReceiverPhone = sanitizePhone(receiverPhone, DEFAULT_SENDER_PHONE);
    const cleanSenderPhone = sanitizePhone(senderPhone, DEFAULT_SENDER_PHONE);
    const cleanReceiverHouse = receiverHouse || (receiverStreet ? '1' : '1'); // GlobKurier wymaga niepustego

    const addonsArr = [pickupAddon && pickupAddon.id, deliveryAddon && deliveryAddon.id]
      .filter(Boolean)
      .map(id => ({ id: parseInt(id) }));

    const orderPayload = {
      shipment: {
        productId: parseInt(selectedOffer.productId),
        weight: quote.quoteParams.weight || 1,
        length: quote.quoteParams.length || 20,
        width: quote.quoteParams.width || 20,
        height: quote.quoteParams.height || 10,
        quantity: 1,
      },
      senderAddress: {
        name: senderName,
        street: senderStreet,
        houseNumber: senderHouse || '1',
        postCode: senderPostCode,
        city: senderCity,
        countryId: sender.countryId || COUNTRY_IDS[sender.country] || 1,
        phone: cleanSenderPhone,
        email: senderEmail,
      },
      receiverAddress: {
        name: receiverName,
        street: receiverStreet,
        houseNumber: cleanReceiverHouse,
        postCode: receiverPostCode,
        city: receiverCity,
        countryId: receiver.countryId || COUNTRY_IDS[receiver.country] || 1,
        phone: cleanReceiverPhone,
        email: receiverEmail,
      },
      pickup: {
        date: quote.pickupDate || firstPickup.date || new Date().toISOString().split('T')[0],
        timeFrom: firstPickup.from || '09:00',
        timeTo: firstPickup.to || '17:00',
      },
      addons: addonsArr,
      content: 'Cosmetics / Surf Stick Bell',
      collectionType,
      paymentId: 9,
    };

    console.log('[glob/order] Creating order:', JSON.stringify(orderPayload));

    const result = await createOrder(orderPayload);
    console.log('[glob/order] GlobKurier response:', JSON.stringify(result).slice(0, 500));

    // Detect error response from GlobKurier
    if (result && (result.errors || result.error || result.fields)) {
      return res.status(400).json({ ok: false, error: 'GlobKurier validation error', details: result, payload: orderPayload });
    }

    delete quoteStore[quoteId];

    res.json({
      ok: true,
      order: result,
      carrier: selectedOffer.carrier,
      price: selectedOffer.price + ' ' + selectedOffer.currency,
      sender: { name: sender.companyName || sender.name, city: sender.city },
      receiver: { name: receiver.name, city: receiver.city },
    });
  } catch (err) {
    console.error('[glob/order]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
