'use strict';

const router = require('express').Router();
const https = require('https');
const { getReceivers, getQuote, getPickupTimes, findNearestPickupDate, getAddons, getOrderLabels, createOrder, getOrders } = require('../glob-client');
const { PACKAGE_PRESETS, calculatePackageFromItems, PACZKOMAT_SIZES, COUNTRY_IDS, normalizeCountry } = require('./glob-helpers');
const { scoreContractor } = require('../services/contractor-match');

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
          weight, length, width, height, items, paczkomat, deliveryType, pickupDate,
          deliveryAddress, declaredValue } = req.body;

    // Accept deliveryAddress as object OR JSON string (n8n LLM tools sometimes
    // serialize objects). Silently ignore unparseable input.
    if (typeof deliveryAddress === 'string' && deliveryAddress.trim()) {
      try { deliveryAddress = JSON.parse(deliveryAddress); }
      catch (_) { deliveryAddress = null; }
    }
    if (deliveryAddress && (typeof deliveryAddress !== 'object' || Array.isArray(deliveryAddress))) {
      deliveryAddress = null;
    }

    // Hard validation of dimensions — LLM agents have been observed to
    // hallucinate values like length=180 cm for what should be 30×20×20.
    // Reject obviously impossible dimensions instead of forwarding garbage
    // to GlobKurier (which prices it as oversized and returns 200+ PLN).
    // Limits: courier max length is typically 175 cm, max girth 360 cm,
    // max weight ~30 kg. We allow some slack but block clearly bogus values.
    const validateDim = (val, name, max) => {
      if (val == null || val === '') return null;
      const n = Number(val);
      if (Number.isNaN(n) || n <= 0) return `${name} musi być liczbą dodatnią (dostałem: ${JSON.stringify(val)})`;
      if (n > max) return `${name}=${n} przekracza limit ${max} ${name === 'weight' ? 'kg' : 'cm'} — typowa paczka kurierska to max 100 cm. Sprawdź czy nie pomyliłeś jednostek lub pomnożyłeś przez quantity.`;
      return null;
    };
    const dimErrors = [
      validateDim(weight, 'weight', 50),
      validateDim(length, 'length', 175),
      validateDim(width, 'width', 175),
      validateDim(height, 'height', 175),
    ].filter(Boolean);
    if (dimErrors.length) {
      return res.status(400).json({
        ok: false,
        error: 'Niepoprawne wymiary paczki',
        issues: dimErrors,
      });
    }

    // Track which source set the package dimensions — surfaced in response
    // so the agent / user know whether values came from invoice, items
    // smart-packing, manual input, preset, or the default fallback.
    let dimensionsSource = (weight || length || width || height) ? 'manual' : null;

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
          grossAmount: Number(invoice.grossAmount),
          currency: invoice.currency,
          itemsCount: (invoice.extras && Array.isArray(invoice.extras.items)) ? invoice.extras.items.length : 0,
        };
      }

      // Lazy-load items from iFirma PDF if missing in extras.
      // iFirma's GET endpoint returns header only — items must be parsed
      // from the PDF (which we generate at confirm time and can re-fetch).
      let itemsFromPdf = false;
      if (invoice && !weight && (!invoice.extras || !Array.isArray(invoice.extras.items) || invoice.extras.items.length === 0) && invoice.ifirmaId) {
        try {
          const { backfillInvoiceItems } = require('../services/invoice-backfill');
          const result = await backfillInvoiceItems(prisma, invoice);
          if (result.items && result.items.length > 0) {
            const currentExtras = (typeof invoice.extras === 'object' && invoice.extras) ? invoice.extras : {};
            invoice.extras = { ...currentExtras, items: result.items, itemsSource: 'pdf-parse' };
            if (foundInvoice) foundInvoice.itemsCount = result.items.length;
            itemsFromPdf = true;
            console.log(`[glob/quote] Backfilled ${result.items.length} items from PDF for invoice ${invoice.number}`);
          }
        } catch (err) {
          console.log('[glob/quote] PDF backfill failed:', err.message);
        }
      }

      if (invoice && invoice.extras && Array.isArray(invoice.extras.items) && invoice.extras.items.length > 0) {
        const calc = calculatePackageFromItems(invoice.extras.items);
        weight = weight || calc.weight;
        length = length || calc.length;
        width = width || calc.width;
        height = height || calc.height;
        const sourceSuffix = itemsFromPdf ? ', items odzyskane z PDF' : '';
        dimensionsSource = `invoice ${invoice.number} (smart packing z items faktury${sourceSuffix})`;
      } else if (invoice && !weight && !packageType && !preset && !(items && items.length > 0)) {
        // Invoice exists but has no items, and PDF backfill couldn't recover
        // them, and the agent didn't supply alternative dims — ask the user
        // instead of silently shipping a fake "1 kartonik 1 kg" weight.
        return res.json({
          ok: false,
          needsItems: true,
          invoice: { number: invoice.number, contractorName: invoiceContractorName, ifirmaId: invoice.ifirmaId, grossAmount: Number(invoice.grossAmount), currency: invoice.currency },
          message: `Faktura ${invoice.number} nie ma zapisanych pozycji w bazie i nie udało się odzyskać ich z PDF. Powiedz co było w paczce — np. "60 sticków" / "30 mascar" / "2 boxy MIX" — wtedy policzę wymiary i wagę.`,
        });
      } else if (invoice) {
        weight = weight || 1;
        length = length || 20; width = width || 20; height = height || 10;
        dimensionsSource = `invoice ${invoice.number} (brak items na fakturze — wymiary domyślne 1 kartonik)`;
      }
    }

    // Collect non-fatal hints to surface in the response. Used by the agent
    // to give the user a truthful explanation instead of fabricating one.
    const warnings = [];

    // 2B. PRESET × quantity
    const hadManualDims = Boolean(weight || length || width || height);
    if (packageType && PACKAGE_PRESETS[packageType]) {
      if (hadManualDims) {
        warnings.push(`POMINIĘTO RĘCZNE WYMIARY — użyto preseta "${packageType}". Aby wycenić ręczne wymiary, NIE podawaj packageType.`);
        weight = null; length = null; width = null; height = null;
      }
      const p = PACKAGE_PRESETS[packageType];
      const qty = Number(quantity) || 1;
      weight = (Number(weightPerPackage) || p.weight) * qty;
      length = p.length;
      width = p.width;
      height = qty === 1 ? p.height : Math.min(p.height * qty, 60);
      dimensionsSource = `preset ${packageType}${qty > 1 ? ` × ${qty}` : ''}`;
    }

    // 2C. Auto-kalkulacja z items — items wygrywa nad manual dims (LLM
    // agents tend to hallucinate dims; trust items if they're present).
    let packageCalc = null;
    if (items && Array.isArray(items) && items.length > 0) {
      if (weight || length || width || height) {
        warnings.push('POMINIĘTO RĘCZNE WYMIARY — wykryto items, użyto smart packing (calculatePackageFromItems). Aby użyć ręcznych wymiarów, NIE podawaj items.');
      }
      packageCalc = calculatePackageFromItems(items);
      weight = packageCalc.weight;
      length = packageCalc.length;
      width = packageCalc.width;
      height = packageCalc.height;
      const itemsSummary = items.map(i => `${i.qty}× ${i.name || i.ean || '?'}`).join(', ');
      dimensionsSource = `items smart-packing: ${itemsSummary} → ${packageCalc.kartonikCount} kartonik(ów)`;
    }

    if (preset && PACKAGE_PRESETS[preset] && !weight) {
      const p = PACKAGE_PRESETS[preset];
      weight = p.weight; length = p.length; width = p.width; height = p.height;
    }

    // 4. RECEIVER (resolved before final dimension fallbacks so we can auto-lookup latest invoice for the contractor)
    if (!receiverSearch && !(deliveryAddress && (deliveryAddress.city || deliveryAddress.street))) {
      return res.status(400).json({ ok: false, error: 'Podaj receiverSearch (nazwa kontrahenta) lub deliveryAddress' });
    }

    let receiver = null;
    let receiverSource = null;
    let gkData = {};
    let contractor = null;

    // 4A. Inline deliveryAddress override — agent supplied an address directly
    // (e.g. user typed it, or pulled from VIES / GK history). Skip the lookup
    // chain entirely; only resolve the contractor binding if receiverSearch is
    // also given so we keep contractorId for invoice auto-lookups.
    if (deliveryAddress && (deliveryAddress.city || deliveryAddress.street)) {
      if (receiverSearch) {
        // Use the same fuzzy logic as the regular contractor lookup so
        // typo/spelling variants ("HolaOla" vs "HOLA OLA RIBADEO SLU") still
        // bind the contractor — needed below to backfill missing fields
        // (postCode, phone, email) from extras.locations.
        const tokens = receiverSearch.toLowerCase().split(/\s+/).filter(t => t.length >= 3).slice(0, 4);
        const orFilters = [
          { name: { contains: receiverSearch, mode: 'insensitive' } },
          { email: { contains: receiverSearch, mode: 'insensitive' } },
          ...tokens.map(t => ({ name: { contains: t, mode: 'insensitive' } })),
        ];
        let candidates = await prisma.contractor.findMany({
          where: { OR: orFilters },
          select: { id: true, name: true, nip: true, country: true, email: true, city: true, address: true, phone: true, extras: true },
          take: 50,
        });
        if (candidates.length === 0) {
          candidates = await prisma.contractor.findMany({
            select: { id: true, name: true, nip: true, country: true, email: true, city: true, address: true, phone: true, extras: true },
            take: 500,
          });
        }
        const scored = candidates
          .map(c => ({ c, score: scoreContractor(c, receiverSearch) }))
          .filter(x => x.score >= 50)
          .sort((a, b) => b.score - a.score);
        if (scored.length) contractor = scored[0].c;
      }

      // Backfill missing deliveryAddress fields from contractor's saved
      // delivery locations (extras.locations[]). Pick the location whose
      // street/city best matches the inline values; fall back to the first.
      const cExtras = (contractor && typeof contractor.extras === 'object' && contractor.extras) || {};
      const savedLocs = Array.isArray(cExtras.locations) ? cExtras.locations : [];
      const norm = s => (s || '').toString().toLowerCase().trim();
      const matchedLoc = savedLocs.find(l =>
        (deliveryAddress.street && norm(l.street).includes(norm(deliveryAddress.street).slice(0, 15))) ||
        (deliveryAddress.city && norm(l.city) === norm(deliveryAddress.city))
      ) || savedLocs[0] || {};

      receiver = {
        name: (contractor && contractor.name) || receiverSearch || 'Receiver',
        contractorId: contractor ? contractor.id : null,
        city: deliveryAddress.city || matchedLoc.city || (contractor && contractor.city) || '',
        postCode: deliveryAddress.postCode || matchedLoc.postCode || '',
        country: deliveryAddress.country || matchedLoc.country || (contractor && contractor.country) || 'PL',
        countryId: deliveryAddress.countryId || null,
        phone: deliveryAddress.phone || matchedLoc.phone || (contractor && contractor.phone) || '',
        email: deliveryAddress.email || matchedLoc.email || (contractor && contractor.email) || '',
        street: deliveryAddress.street || matchedLoc.street || '',
        houseNumber: deliveryAddress.houseNumber || matchedLoc.houseNumber || '',
        apartmentNumber: deliveryAddress.apartmentNumber || '',
        contactPerson: deliveryAddress.contactPerson || matchedLoc.contactPerson || null,
      };
      receiverSource = 'inline_address';
    }

    if (!contractor && !receiver && receiverSearch) {
      // Fuzzy match contractors by name (handles e.g. "ocean republic" → "OCEAN REPUBLIK SOCIETY S.L").
      // First narrow with a token-based SQL prefilter so we don't load every
      // contractor in memory; then score the candidates and pick the best one
      // with score >= 50 (same threshold as invoice-preview).
      const tokens = receiverSearch.toLowerCase().split(/\s+/).filter(t => t.length >= 3).slice(0, 4);
      const orFilters = [
        { name: { contains: receiverSearch, mode: 'insensitive' } },
        { email: { contains: receiverSearch, mode: 'insensitive' } },
        ...tokens.map(t => ({ name: { contains: t, mode: 'insensitive' } })),
      ];
      let candidates = await prisma.contractor.findMany({
        where: { OR: orFilters },
        select: { id: true, name: true, nip: true, country: true, email: true, city: true, address: true, phone: true, extras: true },
        take: 50,
      });
      // Fallback: if SQL prefilter found nothing (e.g. "holaola" vs "Hola Ola"
      // — different whitespace), load a wider set and rely on the fuzzy score.
      if (candidates.length === 0) {
        candidates = await prisma.contractor.findMany({
          select: { id: true, name: true, nip: true, country: true, email: true, city: true, address: true, phone: true, extras: true },
          take: 500,
        });
      }
      const scored = candidates
        .map(c => ({ c, score: scoreContractor(c, receiverSearch) }))
        .filter(x => x.score >= 50)
        .sort((a, b) => b.score - a.score);
      if (scored.length) {
        contractor = scored[0].c;
        console.log(`[glob/quote] fuzzy match: "${receiverSearch}" → "${contractor.name}" (score ${scored[0].score})`);
      }
    }

    if (contractor && !receiver) {
      const cExtras = (typeof contractor.extras === 'object' && contractor.extras) || {};
      gkData = cExtras.globKurierReceiverData || {};
      const billing = cExtras.billingAddress || {};
      const locations = Array.isArray(cExtras.locations) ? cExtras.locations : [];

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

      // ALWAYS try to backfill from extras.locations[] — gkData / contractor.city
      // often has only city without street, and the user has manually saved
      // full delivery addresses to locations[]. Pick best match by city,
      // fall back to single/first.
      if (locations.length > 0) {
        const norm = (s) => (s || '').toString().toLowerCase().trim();
        const matched =
          locations.find(l => receiver.city && norm(l.city) === norm(receiver.city)) ||
          (locations.length === 1 ? locations[0] : null);
        if (matched) {
          receiver.street = receiver.street || matched.street || '';
          receiver.houseNumber = receiver.houseNumber || matched.houseNumber || '';
          receiver.city = receiver.city || matched.city || '';
          receiver.postCode = receiver.postCode || matched.postCode || '';
          receiver.country = receiver.country || matched.country || receiver.country;
          receiver.contactPerson = receiver.contactPerson || matched.contactPerson || null;
          receiver.phone = receiver.phone || matched.phone || receiver.phone;
          receiver.email = receiver.email || matched.email || receiver.email;
          receiverSource = 'contractor + extras.locations';
          console.log(`[glob/quote] Backfilled address from extras.locations for ${contractor.name}: street="${receiver.street}" houseNumber="${receiver.houseNumber}" city="${receiver.city}"`);
        }
      }

      // GK ORDERS HISTORY fallback — last automatic step before bothering
      // the user. If we have a contractor but no street yet, scan the last
      // 100 GK shipments for a match by canonical contractor.name (handles
      // user typos like "Republic" vs "Republik" through prefix tokens),
      // grab the most recent receiver address, and persist to
      // extras.locations[] so future quotes hit the cached path.
      if (contractor && !receiver.street) {
        try {
          // Pull 200 — cache (extras.locations) handles recent shipments,
          // so the orders fallback typically resolves OLD clients we
          // haven't shipped to in a while. Need depth, not breadth.
          const ordersData = await getOrders({ limit: 200 });
          const orders = (ordersData && (ordersData.results || ordersData.items || ordersData.data))
            || (Array.isArray(ordersData) ? ordersData : []);
          const norm = (s) => (s || '').toString().toLowerCase().trim();
          const searchSource = contractor.name || receiverSearch;
          const q = norm(searchSource);
          const tokens = q.split(/\s+/).filter(t => t.length >= 4);
          const matchOrders = orders.filter(o => {
            const r = o.receiverAddress || o.receiver || {};
            const name = norm(r.name || '') + ' ' + norm(r.contactPerson || '');
            if (q && name.includes(q)) return true;
            if (!tokens.length) return false;
            // Count how many tokens (or their first-5-char prefix) appear
            // in the candidate name. Require at least 2 hits so different
            // wordings of the same client match (e.g. "Ocean Republik
            // Society S.L" in DB vs "Ocean Republik School" in GK panel —
            // shared "ocean" + "republik" is enough).
            const hits = tokens.filter(t => {
              if (name.includes(t)) return true;
              const prefix = t.slice(0, Math.min(5, t.length));
              return prefix.length >= 4 && name.includes(prefix);
            }).length;
            // 1-token names need an exact include; 2+ token names need ≥2 hits.
            const minHits = tokens.length === 1 ? 1 : 2;
            return hits >= minHits;
          });
          matchOrders.sort((a, b) => new Date(b.creationDate || b.created_at || b.createdAt || 0) - new Date(a.creationDate || a.created_at || a.createdAt || 0));
          console.log(`[glob/quote] GK orders history fallback: searched="${searchSource}", scanned=${orders.length}, matched=${matchOrders.length}`);

          // LLM fallback: token-based matching catches typos and prefix
          // variants but fails when the GK shipping name is semantically
          // different from the billing name ("Society S.L" vs "School").
          // If we have a contractor and zero token hits, ask Haiku to pick
          // by combining all signals (name + nip + email + phone + city +
          // country). One call (~$0.01), result cached to extras.locations.
          if (matchOrders.length === 0 && contractor && orders.length > 0) {
            try {
              const { matchGkOrderToContractor } = require('../services/match-gk-order-to-contractor');
              const llmMatch = await matchGkOrderToContractor(contractor, orders);
              console.log(`[glob/quote] LLM GK matcher: ${llmMatch.matched ? 'matched idx=' + llmMatch.index : 'no_match'} — ${llmMatch.reason || ''}`);
              if (llmMatch.matched) {
                matchOrders.push(orders[llmMatch.index]);
              }
            } catch (e) {
              console.log('[glob/quote] LLM GK matcher failed:', e.message);
            }
          }

          if (matchOrders.length) {
            const r = matchOrders[0].receiverAddress || matchOrders[0].receiver || {};
            receiver.street = receiver.street || r.street || '';
            receiver.houseNumber = receiver.houseNumber || r.houseNumber || '';
            receiver.city = receiver.city || r.city || '';
            receiver.postCode = receiver.postCode || r.postCode || r.zipCode || '';
            receiver.country = receiver.country || r.countryCode || r.country || receiver.country;
            receiver.phone = receiver.phone || r.phone || receiver.phone;
            receiver.email = receiver.email || r.email || receiver.email;
            receiver.contactPerson = receiver.contactPerson || r.contactPerson || null;
            receiverSource = (receiverSource || 'contractor') + ' + gk_orders_history';
            console.log(`[glob/quote] adres z historii GK: ${receiver.street}, ${receiver.city}, ${receiver.country}`);

            if (receiver.street) {
              try {
                const cExtras = (typeof contractor.extras === 'object' && contractor.extras) || {};
                const locs = Array.isArray(cExtras.locations) ? [...cExtras.locations] : [];
                const normL = (s) => (s || '').toString().toLowerCase().trim();
                const dup = locs.find(l =>
                  normL(l.street) === normL(receiver.street) &&
                  normL(l.city) === normL(receiver.city) &&
                  normL(l.postCode) === normL(receiver.postCode)
                );
                if (!dup) {
                  locs.push({
                    street: receiver.street, houseNumber: receiver.houseNumber, city: receiver.city,
                    postCode: receiver.postCode, country: receiver.country, contactPerson: receiver.contactPerson,
                    phone: receiver.phone, email: receiver.email,
                    source: 'gk_orders_history', addedAt: new Date().toISOString(),
                  });
                  await prisma.contractor.update({ where: { id: contractor.id }, data: { extras: { ...cExtras, locations: locs } } });
                  console.log(`[glob/quote] saved address from GK history to contractor.extras.locations`);
                }
              } catch (e) {
                console.log('[glob/quote] failed to persist address:', e.message);
              }
            }
          }
        } catch (err) {
          console.log('[glob/quote] GK orders history lookup failed:', err.message);
        }
      }

      // Couriers (DPD, FedEx, DHL) require street for international shipments.
      // Treat the address as usable only when we have at least a street; city
      // alone is not enough.
      const hasUsableAddress = !!receiver.street && (!!receiver.city || !!receiver.postCode);
      if (!hasUsableAddress) {
        if (locations.length > 1) {
          return res.json({
            ok: false,
            needsAddress: true,
            reason: 'multiple_locations',
            contractor: { id: contractor.id, name: contractor.name, nip: contractor.nip, country: contractor.country || null },
            knownLocations: locations,
            message: `Kontrahent ${contractor.name} ma ${locations.length} zapisanych adresów dostawy. Który użyć? ` +
              locations.map((l, i) => `${i + 1}. ${[l.street, l.city, l.postCode, l.country].filter(Boolean).join(', ')}`).join(' | '),
          });
        } else {
          return res.json({
            ok: false,
            needsAddress: true,
            reason: 'no_address',
            contractor: { id: contractor.id, name: contractor.name, nip: contractor.nip, country: contractor.country || null },
            knownLocations: locations,
            partialAddress: { city: receiver.city || null, postCode: receiver.postCode || null, country: receiver.country || null },
            options: ['manual', 'vies', 'receivers_book', 'orders_history', 'emails'],
            message: `Znaleziono kontrahenta ${contractor.name}` + (contractor.country ? ` (${contractor.country})` : '') +
              `, ale brak ulicy w adresie dostawy. ` +
              (receiver.city ? `Mamy: ${[receiver.city, receiver.postCode, receiver.country].filter(Boolean).join(', ')}. ` : '') +
              `Brakuje ulicy + numeru. Skąd wziąć: podaj ręcznie, VIES, książka GlobKurier, historia wysyłek, maile.`,
          });
        }
      }
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

    // GK orders history fallback was moved to the contractor branch above
    // (right before the hasUsableAddress check) — that's the only point
    // where it can actually run; placing it after the contractor block
    // returned needsAddress would have been dead code.

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
          grossAmount: Number(latestInvoice.grossAmount),
          currency: latestInvoice.currency,
        };

        if ((!latestInvoice.extras || !Array.isArray(latestInvoice.extras.items) || latestInvoice.extras.items.length === 0) && latestInvoice.ifirmaId) {
          try {
            const { backfillInvoiceItems } = require('../services/invoice-backfill');
            const result = await backfillInvoiceItems(prisma, latestInvoice);
            if (result.items && result.items.length > 0) {
              const calc = calculatePackageFromItems(result.items);
              weight = calc.weight;
              length = calc.length;
              width = calc.width;
              height = calc.height;
              foundInvoice.itemsCount = result.items.length;
              dimensionsSource = `invoice ${latestInvoice.number} (smart packing, items odzyskane z PDF)`;
              console.log(`[glob/quote] Auto-loaded from latest invoice ${latestInvoice.number} (PDF): ${calc.description}`);
            }
          } catch (err) {
            console.log('[glob/quote] PDF backfill failed:', err.message);
          }
        } else if (latestInvoice.extras && Array.isArray(latestInvoice.extras.items) && latestInvoice.extras.items.length > 0) {
          const calc = calculatePackageFromItems(latestInvoice.extras.items);
          weight = calc.weight;
          length = calc.length;
          width = calc.width;
          height = calc.height;
          foundInvoice.itemsCount = latestInvoice.extras.items.length;
          dimensionsSource = `invoice ${latestInvoice.number} (smart packing z items faktury)`;
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
      dimensionsSource = 'default (maly_kartonik fallback — brak items/preset/faktury)';
      console.log('[glob/quote] Fallback to maly_kartonik');
      warnings.push('UŻYTO DOMYŚLNYCH WYMIARÓW (mały kartonik 20×20×10 cm, 1 kg) — żadne wymiary nie zostały podane w request. Wycena prawdopodobnie zaniżona dla większej paczki.');
    }

    if (!weight || !length || !width || !height) {
      return res.status(400).json({ ok: false, error: 'Brak wymiarów paczki. Podaj packageType/invoiceNumber/items lub weight/length/width/height. Aby użyć ostatniej faktury kontrahenta: invoiceNumber="latest"' });
    }

    // Detect country fallback to PL — happens when contractor exists but
    // has no country and no inline deliveryAddress.country was provided.
    if (receiver.country === 'PL' && contractor && !contractor.country &&
        !(deliveryAddress && deliveryAddress.country)) {
      warnings.push('KRAJ ODBIORCY USTAWIONY NA PL DOMYŚLNIE — kontrahent nie ma zapisanego kraju. Wycena dotyczy trasy krajowej; jeśli odbiorca jest za granicą, podaj deliveryAddress.country.');
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

    // Normalize country to ISO-2 — LLMs sometimes pass "Hiszpania"/"Spain"
    // instead of "ES", which silently fell back to PL via COUNTRY_IDS lookup.
    sender.country = normalizeCountry(sender.country) || sender.country;
    receiver.country = normalizeCountry(receiver.country) || receiver.country;
    const senderCountryId = sender.countryId || COUNTRY_IDS[sender.country] || 1;
    const receiverCountryId = receiver.countryId || COUNTRY_IDS[receiver.country] || 1;
    if (receiverCountryId === 1 && receiver.country !== 'PL') {
      warnings.push(`KRAJ ODBIORCY "${receiver.country}" NIE MA ZNANEGO countryId w GlobKurier — wycena leci jako PL→PL. Sprawdź czy to obsługiwany kraj.`);
    }

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

    console.log(`[glob/quote] params: ${sender.country || sender.countryId}/${sender.postCode} → ${receiver.country || receiverCountryId}/${receiver.postCode}, ${weight}kg ${length}×${width}×${height}cm, ${collectionType}/${deliveryType}`);

    let productsData;
    try {
      productsData = await getQuote(quoteParams);
    } catch (gkErr) {
      console.error('[glob/quote] GlobKurier getQuote failed:', gkErr.message);
      return res.status(502).json({
        ok: false,
        error: 'GlobKurier API error: ' + gkErr.message,
        sentParams: {
          from: { country: sender.country, postCode: sender.postCode },
          to: { country: receiver.country, postCode: receiver.postCode, countryId: receiverCountryId },
          dimensions: { weight, length, width, height },
          collectionType, deliveryType,
        },
      });
    }
    const products = productsData.standard || productsData.results || productsData.items || (Array.isArray(productsData) ? productsData : []);

    if (!Array.isArray(products) || products.length === 0) {
      return res.json({
        ok: false,
        offers: [],
        message: `Brak ofert dla trasy ${sender.country || '?'} → ${receiver.country || '?'} ${weight}kg ${length}×${width}×${height}cm. Sprawdź czy adres odbiorcy jest kompletny (kraj, kod pocztowy) i czy wymiary mieszczą się w limitach kuriera.`,
        sentParams: {
          from: { country: sender.country, postCode: sender.postCode },
          to: { country: receiver.country, postCode: receiver.postCode, countryId: receiverCountryId },
          dimensions: { weight, length, width, height },
          collectionType, deliveryType,
        },
        rawResponse: productsData,
      });
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

    // Resolve realistic pickup date per top-5 offer (parallel). GlobKurier
    // returns no terms on weekends/holidays/before cutoff, so the requested
    // pickupDate often isn't actually bookable — checking up front lets us
    // show the user the soonest realistic date and keeps order_shipping
    // from blindly retrying carriers in a loop.
    //
    // Send the full sender address to /pickupTimeRanges (GK doc: "providing
    // as much data as possible allows for better matching of shipping dates
    // for a given location"). DPD especially can flip a "no slots" answer
    // to "available" when given the actual city / street, not just postcode.
    const TOP_OFFERS_TO_PROBE = 5;
    const PROBE_MAX_DAYS = 14;
    const senderExtras = (typeof sender.extras === 'object' && sender.extras) || {};
    const pickupParamsBase = {
      senderCountryId,
      senderPostCode: sender.postCode || '',
      senderCity: sender.city || senderExtras.city || '',
      senderStreet: senderExtras.street || sender.street || '',
      senderHouseNumber: senderExtras.houseNumber || sender.houseNumber || '',
      receiverCountryId,
      receiverPostCode: receiver.postCode || '',
      receiverCity: receiver.city || '',
      weight,
      date: pickupDate,
    };
    await Promise.all(offers.slice(0, TOP_OFFERS_TO_PROBE).map(async (o) => {
      try {
        const nearest = await findNearestPickupDate(o.productId, pickupParamsBase, PROBE_MAX_DAYS);
        o.nearestPickup = nearest; // { date, timeFrom, timeTo, daysAhead } or null
      } catch (e) {
        o.nearestPickup = null;
      }
    }));

    // If every probed offer came back with no slots, surface a clear
    // message to the agent instead of letting it blindly propose an order.
    const probedOffers = offers.slice(0, TOP_OFFERS_TO_PROBE);
    const allNoSlots = probedOffers.length > 0 && probedOffers.every(o => o.nearestPickup === null);
    if (allNoSlots) {
      return res.json({
        ok: false,
        noPickupAnyOffer: true,
        offers, // include offers so agent can describe what was tried
        sender: { name: sender.companyName || sender.name, city: sender.city, country: sender.country },
        receiver: { name: receiver.name, city: receiver.city, country: receiver.country, postCode: receiver.postCode },
        message: `GlobKurier nie ma dostępnych terminów odbioru dla żadnej z ${probedOffers.length} ofert na trasie ${sender.country || '?'} → ${receiver.country || '?'} w ciągu ${PROBE_MAX_DAYS} dni — najpewniej długi weekend / święto. Spróbuj ponownie za parę dni albo zmień datę odbioru ręcznie (parametr pickupDate).`,
      });
    }

    // declaredValue — required by some carriers (esp. cross-border FedEx)
    // for customs/insurance. Priority: explicit user input → sum(items)
    // → matched invoice.grossAmount → fallback 100.
    let resolvedDeclaredValue = Number(declaredValue) || 0;
    if (!resolvedDeclaredValue && items && Array.isArray(items)) {
      resolvedDeclaredValue = items.reduce((acc, it) => {
        const qty = Number(it.qty || it.quantity || 0);
        const price = Number(it.priceNetto || it.price || 0);
        return acc + qty * price;
      }, 0);
    }
    if (!resolvedDeclaredValue && foundInvoice && foundInvoice.grossAmount) {
      resolvedDeclaredValue = Number(foundInvoice.grossAmount);
    }
    if (!resolvedDeclaredValue) resolvedDeclaredValue = 100;
    resolvedDeclaredValue = Math.round(resolvedDeclaredValue * 100) / 100;

    const quoteStore = req.app.locals.quoteStore = req.app.locals.quoteStore || {};
    const quoteId = Date.now().toString();
    quoteStore[quoteId] = { sender, receiver, quoteParams, offers, preset: preset || null, pickupDate, collectionType, deliveryType, declaredValue: resolvedDeclaredValue, createdAt: new Date() };
    for (const k of Object.keys(quoteStore)) {
      if (Date.now() - new Date(quoteStore[k].createdAt).getTime() > 30 * 60 * 1000) delete quoteStore[k];
    }

    res.json({
      ok: true,
      quoteId,
      sender: { name: sender.companyName || sender.name, city: sender.city, country: sender.country },
      receiver: { name: receiver.name, city: receiver.city, country: receiver.country, postCode: receiver.postCode },
      receiverSource,
      receiverAddressFrom: receiverSource,
      invoice: foundInvoice,
      package: { weight, length, width, height },
      dimensionsSource,
      packageCalc,
      pickupDate,
      paczkomatSize: paczkomatSize || null,
      offers,
      cheapest: offers[0] ? { carrier: offers[0].carrier, price: offers[0].price, currency: offers[0].currency } : null,
      warnings: warnings.length ? warnings : undefined,
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

    // Stateless sub-agents call order without remembering the quoteId from
    // the previous turn — they tend to either omit it, send "latest", or
    // hallucinate placeholders ("UNKNOWN", "64/2026_holaola"). Treat all
    // of these as "use the most recent quote in the store" so we don't
    // bounce the agent into a retry loop. Real quoteIds are 13-digit
    // timestamps (Date.now()), so anything that's clearly not numeric is
    // treated as a sentinel.
    const isLatestSentinel = !quoteId
      || ['latest', 'ostatnia', 'last', 'unknown', 'newest'].includes(String(quoteId).toLowerCase())
      || !/^\d{10,}$/.test(String(quoteId));
    if (isLatestSentinel) {
      const keys = Object.keys(quoteStore).sort((a, b) => b - a);
      if (keys.length > 0) {
        const fallback = keys[0];
        console.log(`[glob/order] quoteId "${quoteId}" treated as "latest" → ${fallback}`);
        quoteId = fallback;
      } else {
        quoteId = null;
      }
    }

    if (!quoteId) {
      console.log('[glob/order] No quoteId and store empty — abort');
      return res.status(400).json({ ok: false, error: 'Brak quoteId — najpierw POST /api/glob/quote' });
    }

    const quote = quoteStore[quoteId];
    if (!quote) {
      console.log(`[glob/order] Quote ${quoteId} not in store (expired/wrong id) — abort`);
      return res.status(404).json({ ok: false, error: 'Quote wygasł. Pobierz nowy: POST /api/glob/quote' });
    }

    console.log(`[glob/order] Quote resolved: id=${quoteId}, offers=${(quote.offers || []).length}, productIdRequested=${JSON.stringify(productId)}`);

    const deliveryType = (req.body && req.body.deliveryType) || quote.deliveryType || 'PICKUP';
    const collectionType = (req.body && req.body.collectionType) || quote.collectionType || 'PICKUP';

    // Agent sometimes sends productId as the carrier NAME ("FedEx Regional
    // Economy") instead of the numeric id. Match by name as a fallback so
    // we don't 404 just because of that.
    let selectedOffer = null;
    if (productId) {
      const pidStr = String(productId).trim();
      selectedOffer = quote.offers.find(o => String(o.productId) === pidStr)
        || quote.offers.find(o => (o.carrier || '').toLowerCase() === pidStr.toLowerCase())
        || quote.offers.find(o => (o.name || '').toLowerCase() === pidStr.toLowerCase())
        || quote.offers.find(o => (o.carrier || '').toLowerCase().includes(pidStr.toLowerCase()))
        || quote.offers.find(o => (o.name || '').toLowerCase().includes(pidStr.toLowerCase()));
    }
    if (!selectedOffer) selectedOffer = quote.offers[0];
    if (!selectedOffer) {
      console.log(`[glob/order] No offers in quote ${quoteId} — quote likely failed earlier`);
      return res.status(404).json({ ok: false, error: 'Quote nie zawiera ofert. Wygeneruj nowy.' });
    }
    console.log(`[glob/order] Selected offer: productId=${selectedOffer.productId}, carrier=${selectedOffer.carrier}, name=${selectedOffer.name}, price=${selectedOffer.price}`);

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
      return data.results || data.items || data.data || data.pickupRanges || data.ranges || data.slots || data.timeRanges || [];
    }

    // Prefer the pickup slot already resolved by quote_shipping for this
    // offer — saves an API roundtrip and guarantees we use a date the
    // carrier actually accepts. Fall back to live lookup only when the
    // quote didn't probe this offer (e.g. it was beyond TOP_OFFERS_TO_PROBE).
    if (selectedOffer.nearestPickup && selectedOffer.nearestPickup.date) {
      pickupDate = selectedOffer.nearestPickup.date;
      pickupTimeFrom = selectedOffer.nearestPickup.timeFrom || pickupTimeFrom;
      pickupTimeTo = selectedOffer.nearestPickup.timeTo || pickupTimeTo;
      console.log('[glob/order] Using pre-resolved pickup from quote:', pickupDate, pickupTimeFrom, '-', pickupTimeTo);
    } else {
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

    function extractRequiredAddonIds(errorResult) {
      const fields = (errorResult && (errorResult.fields || (errorResult.errors && errorResult.errors.fields))) || {};
      const ids = new Set();
      for (const [key, val] of Object.entries(fields)) {
        if (typeof val !== 'string') continue;
        if (!key.toLowerCase().includes('addon') && !val.toLowerCase().includes('dodatk')) continue;
        const matches = val.matchAll(/\(id\s+(\d+)\)/gi);
        for (const m of matches) ids.add(parseInt(m[1]));
      }
      return Array.from(ids);
    }

    async function createOrderWithAddonRetry(payload) {
      let r = await createOrder(payload);
      for (let i = 0; i < 2; i++) {
        if (!r || !(r.errors || r.error || r.fields)) break;
        const newIds = extractRequiredAddonIds(r);
        if (newIds.length === 0) break;
        const existing = new Set((payload.addons || []).map(a => parseInt(a.id)));
        let added = false;
        payload.addons = payload.addons || [];
        for (const id of newIds) {
          if (!existing.has(id)) { payload.addons.push({ id }); existing.add(id); added = true; }
        }
        if (!added) break;
        console.log('[glob/order] Auto-fixing addons from error, retrying with:', JSON.stringify(payload.addons));
        r = await createOrder(payload);
      }
      return r;
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
      // Top-level customs/insurance fields. GK rejects shipment.declaredValue
      // as "Nadmiarowe pole" (e.g. FedEx productId 3562) but accepts it at
      // root level for cross-border carriers that need customs declaration.
      declaredValue: quote.declaredValue || 100,
      purpose: 'SOLD',
      paymentId: 9,
    };

    console.log('[glob/order] Creating order:', JSON.stringify(orderPayload));

    function humanizeGkErrors(errResult) {
      const errFields = (errResult && (errResult.fields || (errResult.errors && errResult.errors.fields) || errResult.errors)) || {};
      const problems = [];
      for (const [field, raw] of Object.entries(errFields)) {
        const msg = String(raw || '');
        if (field.includes('pickup') && /nie jest możliwe|niemożliw/i.test(msg)) {
          problems.push('Brak dostępnych terminów odbioru dla tego kuriera. Spróbuj innego (np. DPD zamiast InPost).');
        } else if (field.toLowerCase().includes('phone') || /phone|telefon/i.test(msg)) {
          problems.push('Brakuje telefonu odbiorcy. Podaj numer telefonu dla ' + ((receiver && receiver.name) || 'odbiorcy') + '.');
        } else if (field.toLowerCase().includes('street') || field.toLowerCase().includes('housenumber') || field.toLowerCase().includes('address')) {
          problems.push('Niepełny adres odbiorcy. Sprawdź ulicę i numer domu dla ' + ((receiver && receiver.name) || 'odbiorcy') + '.');
        } else if (field.toLowerCase().includes('email')) {
          problems.push('Brakuje emaila odbiorcy.');
        } else if (field.toLowerCase().includes('postcode')) {
          problems.push('Brakuje kodu pocztowego odbiorcy.');
        } else if (field.toLowerCase().includes('addon')) {
          continue;
        } else {
          problems.push(field + ': ' + msg);
        }
      }
      if (problems.length === 0) problems.push('Nieznany błąd GlobKurier. Spróbuj ponownie.');
      return problems.join('\n');
    }

    const result = await createOrderWithAddonRetry(orderPayload);
    console.log('[glob/order] GlobKurier response:', JSON.stringify(result).slice(0, 500));

    if (result && (result.errors || result.error || result.fields)) {
      const fields = result.fields || (result.errors && result.errors.fields) || {};
      const pickupError = fields['pickup[date]'] || fields['pickup.date'] || '';

      if (pickupError) {
        console.log('[glob/order] Pickup date rejected, trying next 7 days');

        let retrySuccess = false;
        const baseDate = quote.pickupDate || new Date().toISOString().split('T')[0];

        for (let dayOffset = 1; dayOffset <= 7; dayOffset++) {
          const d = new Date(baseDate);
          d.setDate(d.getDate() + dayOffset);
          if (d.getDay() === 0 || d.getDay() === 6) continue;

          const tryDate = d.toISOString().split('T')[0];

          let timeFrom = null, timeTo = null;
          try {
            const times = await getPickupTimes(parseInt(selectedOffer.productId), {
              ...quote.quoteParams,
              receiverCity: (receiver && receiver.city) || '',
              date: tryDate,
            });
            const list = Array.isArray(times)
              ? times
              : (times && (times.results || times.items || times.data)) || [];
            if (list.length > 0) {
              timeFrom = list[0].from;
              timeTo = list[0].to;
            }
          } catch (err) {
            console.log('[glob/order] getPickupTimes failed for', tryDate, err.message);
          }

          if (!timeFrom || !timeTo) {
            console.log('[glob/order] No pickup slots for', tryDate, '- skipping');
            continue;
          }

          orderPayload.pickup.date = tryDate;
          orderPayload.pickup.timeFrom = timeFrom;
          orderPayload.pickup.timeTo = timeTo;

          console.log('[glob/order] Retrying with', tryDate, timeFrom, '-', timeTo);
          const retryResult = await createOrderWithAddonRetry(orderPayload);

          if (retryResult && (retryResult.hash || retryResult.orderHash || retryResult.number)) {
            Object.assign(result, retryResult);
            retrySuccess = true;
            console.log('[glob/order] Success on', tryDate);
            break;
          }

          const retryFields = (retryResult && (retryResult.fields || (retryResult.errors && retryResult.errors.fields))) || {};
          const retryPickupError = retryFields['pickup[date]'] || retryFields['pickup.date'] || '';
          if (!retryPickupError) {
            console.log('[glob/order] Non-pickup error on', tryDate, ':', JSON.stringify(retryResult).slice(0, 300));
            return res.status(400).json({
              ok: false,
              error: humanizeGkErrors(retryResult),
              carrier: selectedOffer && selectedOffer.carrier,
              receiverName: receiver && receiver.name,
            });
          }
        }

        if (!retrySuccess) {
          return res.status(400).json({
            ok: false,
            error: 'Brak dostępnych terminów odbioru dla ' + ((selectedOffer && selectedOffer.carrier) || 'tego kuriera') + ' w ciągu 7 dni (możliwe święta/długi weekend). Spróbuj innego kuriera (np. DPD) lub późniejszy termin.',
            carrier: selectedOffer && selectedOffer.carrier,
          });
        }
      } else {
        return res.status(400).json({
          ok: false,
          error: humanizeGkErrors(result),
          carrier: selectedOffer && selectedOffer.carrier,
          receiverName: receiver && receiver.name,
        });
      }
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
