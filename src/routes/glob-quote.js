'use strict';

const router = require('express').Router();
const https = require('https');
const { getReceivers, getQuote, getPickupTimes, getAddons, getOrderLabels, createOrder } = require('../glob-client');
const { PACKAGE_PRESETS, calculatePackageFromItems, PACZKOMAT_SIZES, COUNTRY_IDS } = require('./glob-helpers');

// ============ PRESETS ============

router.get('/glob/presets', (req, res) => {
  res.json({ ok: true, presets: PACKAGE_PRESETS });
});

// ============ CALCULATE PACKAGE ============

router.post('/glob/calculate-package', async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, error: 'Podaj items z qty i name' });
  const result = calculatePackageFromItems(items);
  res.json({ ok: true, ...result });
});

// ============ QUOTE ============

router.post('/glob/quote', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    req.body = req.body || {};
    for (const key of Object.keys(req.body)) {
      if (req.body[key] === '' || req.body[key] === 'undefined' || req.body[key] === 'null') {
        delete req.body[key];
      }
    }

    let { preset, packageType, quantity, weightPerPackage, invoiceNumber,
          receiverSearch, senderSearch, senderId,
          weight, length, width, height, items, paczkomat, deliveryType, pickupDate } = req.body;

    function nextWorkingDay(date) {
      const d = new Date(date);
      if (d.getDay() === 6) d.setDate(d.getDate() + 2);
      else if (d.getDay() === 0) d.setDate(d.getDate() + 1);
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

    // 1. SENDER
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
    let foundInvoice = null;
    if (invoiceNumber) {
      const isLatest = ['latest', 'ostatnia', 'last'].includes(String(invoiceNumber).toLowerCase());
      let invoice = null;
      let invoiceContractorName = null;

      if (isLatest && receiverSearch) {
        const ctr = await prisma.contractor.findFirst({
          where: {
            OR: [
              { name: { contains: receiverSearch, mode: 'insensitive' } },
              { email: { contains: receiverSearch, mode: 'insensitive' } },
            ],
          },
        });
        if (ctr) {
          invoice = await prisma.invoice.findFirst({
            where: { contractorId: ctr.id },
            orderBy: { createdAt: 'desc' },
            include: { contractor: { select: { name: true } } },
          });
          invoiceContractorName = ctr.name;
          if (invoice) console.log(`[glob/quote] Latest invoice ${invoice.number} for ${ctr.name}`);
        }
      } else if (!isLatest) {
        invoice = await prisma.invoice.findFirst({
          where: { number: invoiceNumber },
          orderBy: { createdAt: 'desc' },
          include: { contractor: { select: { name: true } } },
        });
        invoiceContractorName = invoice && invoice.contractor && invoice.contractor.name;
      }

      if (invoice) {
        foundInvoice = {
          number: invoice.number,
          contractorName: invoiceContractorName || (invoice.extras && invoice.extras.kontrahentNazwa) || null,
          issueDate: invoice.issueDate,
          grossAmount: invoice.grossAmount,
          currency: invoice.currency,
          itemsCount: (invoice.extras && Array.isArray(invoice.extras.items)) ? invoice.extras.items.length : 0,
        };
      }

      // Lazy-load items from iFirma if missing in extras
      if (invoice && !weight && (!invoice.extras || !Array.isArray(invoice.extras.items) || invoice.extras.items.length === 0) && invoice.ifirmaId) {
        try {
          const { fetchInvoiceDetails } = require('../ifirma-client');
          const details = await fetchInvoiceDetails(invoice.ifirmaId, invoice.ifirmaType || invoice.type);
          const positions = details && (details.Pozycje || details.pozycje);
          if (Array.isArray(positions) && positions.length > 0) {
            const items = positions.map(p => ({
              name: p.NazwaPelna || p.Nazwa || p.StawkaNazwa || '',
              qty: parseInt(p.Ilosc) || 1,
              priceNetto: parseFloat(p.CenaJednostkowa) || 0,
              ean: p.KodKreskowy || p.EAN || null,
            }));
            const currentExtras = (typeof invoice.extras === 'object' && invoice.extras) ? invoice.extras : {};
            await prisma.invoice.update({
              where: { id: invoice.id },
              data: { extras: { ...currentExtras, items } },
            });
            invoice.extras = { ...currentExtras, items };
            if (foundInvoice) foundInvoice.itemsCount = items.length;
            console.log(`[glob/quote] Lazy-loaded ${items.length} items from iFirma for invoice ${invoice.number}`);
          }
        } catch (err) {
          console.log('[glob/quote] iFirma lazy-load failed:', err.message);
        }
      }

      if (invoice && invoice.extras && Array.isArray(invoice.extras.items) && invoice.extras.items.length > 0) {
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

    if (preset && PACKAGE_PRESETS[preset] && !weight) {
      const p = PACKAGE_PRESETS[preset];
      weight = p.weight; length = p.length; width = p.width; height = p.height;
    }

    // 4. RECEIVER (resolved before final dimension fallbacks so we can auto-lookup latest invoice for the contractor)
    if (!receiverSearch) return res.status(400).json({ ok: false, error: 'Podaj receiverSearch (nazwa kontrahenta)' });

    let receiver = null;
    let receiverSource = null;
    let gkData = {};

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

    // Auto-lookup latest invoice if no dimensions and we have a contractor
    if (!weight && !length && !width && !height && receiver && receiver.contractorId) {
      const latestInvoice = await prisma.invoice.findFirst({
        where: { contractorId: receiver.contractorId },
        orderBy: { createdAt: 'desc' },
      });

      if (latestInvoice) {
        foundInvoice = {
          number: latestInvoice.number,
          contractorName: (latestInvoice.extras && latestInvoice.extras.kontrahentNazwa) || receiver.name,
          issueDate: latestInvoice.issueDate,
          grossAmount: latestInvoice.grossAmount,
          currency: latestInvoice.currency,
        };

        if ((!latestInvoice.extras || !Array.isArray(latestInvoice.extras.items) || latestInvoice.extras.items.length === 0) && latestInvoice.ifirmaId) {
          try {
            const { fetchInvoiceDetails } = require('../ifirma-client');
            const details = await fetchInvoiceDetails(latestInvoice.ifirmaId, latestInvoice.ifirmaType || 'fakturakraj');
            const positions = details && (details.Pozycje || details.pozycje);
            if (Array.isArray(positions) && positions.length > 0) {
              const items = positions.map(p => ({
                name: p.NazwaPelna || p.Nazwa || '',
                qty: parseInt(p.Ilosc) || 1,
                priceNetto: parseFloat(p.CenaJednostkowa) || 0,
                ean: p.KodKreskowy || p.EAN || null,
              }));
              const currentExtras = (typeof latestInvoice.extras === 'object' && latestInvoice.extras) ? latestInvoice.extras : {};
              await prisma.invoice.update({
                where: { id: latestInvoice.id },
                data: { extras: { ...currentExtras, items } },
              });
              const calc = calculatePackageFromItems(items);
              weight = calc.weight;
              length = calc.length;
              width = calc.width;
              height = calc.height;
              foundInvoice.itemsCount = items.length;
              console.log(`[glob/quote] Auto-loaded from latest invoice ${latestInvoice.number}: ${calc.description}`);
            }
          } catch (err) {
            console.log('[glob/quote] iFirma lazy-load failed:', err.message);
          }
        } else if (latestInvoice.extras && Array.isArray(latestInvoice.extras.items) && latestInvoice.extras.items.length > 0) {
          const calc = calculatePackageFromItems(latestInvoice.extras.items);
          weight = calc.weight;
          length = calc.length;
          width = calc.width;
          height = calc.height;
          foundInvoice.itemsCount = latestInvoice.extras.items.length;
          console.log(`[glob/quote] Auto-loaded from cached items of invoice ${latestInvoice.number}: ${calc.description}`);
        }
      }
    }

    if (!weight && !length && !width && !height) {
      const defaultPreset = PACKAGE_PRESETS['maly_kartonik'];
      weight = defaultPreset.weight;
      length = defaultPreset.length;
      width = defaultPreset.width;
      height = defaultPreset.height;
      console.log('[glob/quote] Fallback to maly_kartonik');
    }

    if (!weight || !length || !width || !height) {
      return res.status(400).json({ ok: false, error: 'Brak wymiarów paczki. Podaj packageType/invoiceNumber/items lub weight/length/width/height. Aby użyć ostatniej faktury kontrahenta: invoiceNumber="latest"' });
    }

    // PACZKOMAT — fit dimensions
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

    const senderCountryId = sender.countryId || COUNTRY_IDS[sender.country] || 1;
    const receiverCountryId = receiver.countryId || COUNTRY_IDS[receiver.country] || 1;

    const collectionType = req.body.collectionType || 'PICKUP';
    if (!deliveryType) deliveryType = 'PICKUP';
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
      invoice: foundInvoice,
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

    if (!quoteId && req.body && req.body.query) {
      const m = String(req.body.query).match(/quoteId[=:\s]+(\d+)/i);
      if (m) quoteId = m[1];
    }

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

    const deliveryType = (req.body && req.body.deliveryType) || quote.deliveryType || 'PICKUP';
    const collectionType = (req.body && req.body.collectionType) || quote.collectionType || 'PICKUP';

    const selectedOffer = productId
      ? quote.offers.find(o => String(o.productId) === String(productId))
      : quote.offers[0];
    if (!selectedOffer) return res.status(404).json({ ok: false, error: 'Nie znaleziono oferty o podanym productId' });

    let pickupDate = quote.pickupDate || new Date().toISOString().split('T')[0];
    let pickupTimeFrom = '09:00';
    let pickupTimeTo = '17:00';

    function nextWorkingDay(dateStr) {
      const d = new Date(dateStr);
      d.setDate(d.getDate() + 1);
      if (d.getDay() === 0) d.setDate(d.getDate() + 1);
      if (d.getDay() === 6) d.setDate(d.getDate() + 2);
      return d.toISOString().split('T')[0];
    }

    function extractPickupList(data) {
      if (!data) return [];
      if (Array.isArray(data)) return data;
      return data.results || data.items || data.data || [];
    }

    try {
      const pickupData = await getPickupTimes(selectedOffer.productId, {
        ...quote.quoteParams,
        receiverCity: (quote.receiver && quote.receiver.city) || '',
        date: pickupDate,
      });
      let pickupList = extractPickupList(pickupData);

      if (pickupList.length === 0) {
        pickupDate = nextWorkingDay(pickupDate);
        const retry = await getPickupTimes(selectedOffer.productId, {
          ...quote.quoteParams,
          receiverCity: (quote.receiver && quote.receiver.city) || '',
          date: pickupDate,
        });
        pickupList = extractPickupList(retry);
      }

      if (pickupList.length > 0) {
        pickupDate = pickupList[0].date || pickupDate;
        pickupTimeFrom = pickupList[0].from || pickupTimeFrom;
        pickupTimeTo = pickupList[0].to || pickupTimeTo;
      }
    } catch (err) {
      console.log('[glob/order] getPickupTimes failed:', err.message);
    }

    let requiredAddons = [];
    try {
      const addonsData = await getAddons(selectedOffer.productId, quote.quoteParams);
      const addonsList = (addonsData && (addonsData.addons || addonsData.results || addonsData.items)) || (Array.isArray(addonsData) ? addonsData : []);
      if (Array.isArray(addonsList)) {
        requiredAddons = addonsList
          .filter(a => a.isRequired || a.required)
          .map(a => ({ id: parseInt(a.id) }));
        console.log('[glob/order] Required addons from API:', JSON.stringify(requiredAddons));
      }
    } catch (err) {
      console.log('[glob/order] getAddons failed:', err.message);
    }

    if (requiredAddons.length === 0 && (collectionType === 'PICKUP' || !collectionType)) {
      requiredAddons = [{ id: 1341 }];
      console.log('[glob/order] Using fallback addon 1341 (Zamawiam podjazd kuriera)');
    }

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

    const DEFAULT_SENDER_PHONE = '+48502189886';
    const DEFAULT_SENDER_EMAIL = 'delivery@surfstickbell.com';
    const DEFAULT_RECEIVER_PHONE = '000000000';
    const DEFAULT_RECEIVER_EMAIL = 'delivery@surfstickbell.com';

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

    function sanitizePhone(phone, fallback) {
      if (!phone) return fallback;
      const cleaned = String(phone).replace(/[^\d+]/g, '');
      if (cleaned.length < 7 || /^0+$/.test(cleaned)) return fallback;
      return cleaned;
    }
    const cleanReceiverPhone = sanitizePhone(receiverPhone, DEFAULT_SENDER_PHONE);
    const cleanSenderPhone = sanitizePhone(senderPhone, DEFAULT_SENDER_PHONE);
    const cleanReceiverHouse = receiverHouse || (receiverStreet ? '1' : '1');

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
        date: pickupDate,
        timeFrom: pickupTimeFrom,
        timeTo: pickupTimeTo,
      },
      addons: requiredAddons,
      content: 'Cosmetics / Surf Stick Bell',
      collectionType,
      paymentId: 9,
    };

    console.log('[glob/order] Creating order:', JSON.stringify(orderPayload));

    const result = await createOrder(orderPayload);
    console.log('[glob/order] GlobKurier response:', JSON.stringify(result).slice(0, 500));

    if (result && (result.errors || result.error || result.fields)) {
      return res.status(400).json({ ok: false, error: 'GlobKurier validation error', details: result, payload: orderPayload });
    }

    delete quoteStore[quoteId];

    const orderHash = result && (result.hash || result.orderHash);
    let cmrSent = false;
    if (orderHash) {
      try {
        await new Promise(r => setTimeout(r, 3000));
        const labelResult = await getOrderLabels(orderHash, 'A4');
        const pdfBuffer = labelResult && labelResult.body;
        if (pdfBuffer && pdfBuffer.length > 100) {
          const tgToken = process.env.TELEGRAM_BOT_TOKEN || '8359714766:AAHHE2bStorakXZRSaxtxZl69EqJWA_GlC4';
          const tgChat = process.env.TELEGRAM_CHAT_ID || '8164528644';
          if (tgToken && tgChat) {
            const orderNum = result.number || orderHash.slice(0, 12);
            const boundary = '----FormBoundary' + Date.now();
            const filename = `CMR-${orderNum}.pdf`;
            const caption = `List przewozowy ${orderNum} (${selectedOffer.carrier})`;
            const parts = [
              `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${tgChat}`,
              `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}`,
              `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
            ];
            const pre = Buffer.from(parts.join('\r\n') + '\r\n', 'utf8');
            const post = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
            const tgBody = Buffer.concat([pre, pdfBuffer, post]);

            await new Promise((resolve, reject) => {
              const tgReq = https.request({
                hostname: 'api.telegram.org',
                path: `/bot${tgToken}/sendDocument`,
                method: 'POST',
                headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': tgBody.length },
              }, r => { r.resume(); r.on('end', resolve); });
              tgReq.on('error', reject);
              tgReq.write(tgBody);
              tgReq.end();
            });
            cmrSent = true;
            console.log('[glob/order] CMR sent to Telegram:', orderNum);
          }
        }
      } catch (cmrErr) {
        console.log('[glob/order] Failed to send CMR:', cmrErr.message);
      }
    }

    res.json({
      ok: true,
      order: result,
      cmrSent,
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
