'use strict';

const router = require('express').Router();
const https = require('https');
const { getReceivers, getQuote, getPickupTimes, findNearestPickupDate, getAddons, getOrderLabels, createOrder, getOrders, getCountries } = require('../glob-client');
const { PACKAGE_PRESETS, calculatePackageFromItems, PACZKOMAT_SIZES, COUNTRY_IDS, normalizeCountry } = require('./glob-helpers');
const { scoreContractor } = require('../services/contractor-match');
const {
  upsertContact: upsertCrmContact,
  upsertAddress: upsertCrmAddress,
} = require('../services/contractor-sync-helpers');

// ============ PRESETS ============

router.get('/glob/presets', (req, res) => {
  res.json({ ok: true, presets: PACKAGE_PRESETS });
});

// ============ CALCULATE PACKAGE ============

router.post('/glob/calculate-package', async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(200).json({ ok: false, error: 'Podaj items z qty i name' });
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
      return res.status(200).json({
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
      if (!sender) return res.status(200).json({ ok: false, error: 'Nie znaleziono nadawcy: ' + senderSearch });
    } else if (senderId) {
      sender = await prisma.sender.findUnique({ where: { id: senderId } });
    } else {
      sender = await prisma.sender.findFirst({ where: { isDefault: true } });
      if (!sender) sender = await prisma.sender.findFirst();
    }
    if (!sender) return res.status(200).json({ ok: false, error: 'Brak nadawcy. POST /api/glob/sync-senders' });

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
      return res.status(200).json({ ok: false, error: 'Podaj receiverSearch (nazwa kontrahenta) lub deliveryAddress' });
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

      // GK RECEIVERS BOOK fallback — free GK API call, not paid Anthropic.
      // The receivers book is the user's curated list of delivery addresses
      // already used on past shipments — typically the cleanest source
      // (full street + house + postcode, contact person, phone), so we
      // try this BEFORE diving into orders history. Token match on
      // contractor.name → LLM fuzzy match if zero hits.
      if (contractor && !receiver.street) {
        try {
          const gkRes = await getReceivers(0, 200, '');
          const allReceivers = (gkRes && (gkRes.results || gkRes.items || gkRes.data))
            || (Array.isArray(gkRes) ? gkRes : []);
          const norm = (s) => (s || '').toString().toLowerCase().trim();
          const q = norm(contractor.name || receiverSearch || '');
          const tokens = q.split(/\s+/).filter(t => t.length >= 4);
          let matched = allReceivers.filter(r => {
            const name = norm(r.companyName || r.name || '') + ' ' + norm(r.contactPerson || '');
            if (q && name.includes(q)) return true;
            if (!tokens.length) return false;
            const hits = tokens.filter(t => {
              if (name.includes(t)) return true;
              const prefix = t.slice(0, Math.min(5, t.length));
              return prefix.length >= 4 && name.includes(prefix);
            }).length;
            const minHits = tokens.length === 1 ? 1 : 2;
            return hits >= minHits;
          });
          console.log(`[glob/quote] GK receivers book: scanned=${allReceivers.length}, token-matched=${matched.length}`);

          // LLM fallback — same matcher as orders, but wrap each receiver
          // entry to look like an order (receiverAddress wrapper) so the
          // service can stay product-agnostic.
          if (matched.length === 0 && allReceivers.length > 0) {
            try {
              const { matchGkOrderToContractor } = require('../services/match-gk-order-to-contractor');
              const wrapped = allReceivers.map(r => ({ receiverAddress: r }));
              const llmMatch = await matchGkOrderToContractor(contractor, wrapped);
              console.log(`[glob/quote] LLM receivers-book matcher: ${llmMatch.matched ? 'matched idx=' + llmMatch.index : 'no_match'} — ${llmMatch.reason || ''}`);
              if (llmMatch.matched) matched.push(allReceivers[llmMatch.index]);
            } catch (e) {
              console.log('[glob/quote] LLM receivers-book matcher failed:', e.message);
            }
          }

          if (matched.length) {
            const r = matched[0];
            receiver.street = receiver.street || r.street || '';
            receiver.houseNumber = receiver.houseNumber || r.houseNumber || '';
            receiver.city = receiver.city || r.city || '';
            receiver.postCode = receiver.postCode || r.postCode || r.zipCode || '';
            receiver.country = receiver.country || r.countryCode || r.country || receiver.country;
            receiver.phone = receiver.phone || r.phone || receiver.phone;
            receiver.email = receiver.email || r.email || receiver.email;
            receiver.contactPerson = receiver.contactPerson || r.contactPerson || null;
            receiver.globKurierId = receiver.globKurierId || r.id;
            receiverSource = (receiverSource || 'contractor') + ' + receivers_book';
            console.log(`[glob/quote] adres z książki GK: ${receiver.street}, ${receiver.city}, ${receiver.country}`);

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
                    source: 'receivers_book', addedAt: new Date().toISOString(),
                  });
                  await prisma.contractor.update({ where: { id: contractor.id }, data: { extras: { ...cExtras, locations: locs } } });
                  console.log(`[glob/quote] saved address from GK receivers book to contractor.extras.locations`);
                }
              } catch (e) {
                console.log('[glob/quote] failed to persist address:', e.message);
              }
            }
          }
        } catch (err) {
          console.log('[glob/quote] receivers book lookup failed:', err.message);
        }
      }

      // Note: GK orders history scan was previously here as auto-cascade
      // but moved to opt-in endpoint /api/contractors/:id/find-address-in-gk-orders
      // because the LLM matcher costs ~$0.02 per miss and the user
      // prefers to control when it runs. Receivers book stays auto
      // because GK API itself is free and clean (curated entries).

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
            options: ['orders_history', 'emails', 'vies', 'manual'],
            message: `Znaleziono kontrahenta ${contractor.name}` + (contractor.country ? ` (${contractor.country})` : '') +
              `, ale brak ulicy w adresie dostawy. ` +
              (receiver.city ? `Mamy: ${[receiver.city, receiver.postCode, receiver.country].filter(Boolean).join(', ')}. ` : '') +
              `Brakuje ulicy + numeru. Sprawdziłem już: cache lokalny + książka adresowa GlobKurier — bez trafienia. Skąd szukać dalej: 1) z poprzednich wysyłek (200 ostatnich, fuzzy LLM ~$0.02), 2) z maili od kontrahenta, 3) VIES (adres rejestrowy), 4) podaj ręcznie.`,
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
      return res.status(200).json({ ok: false, error: 'Nie znaleziono odbiorcy: ' + receiverSearch + '. Sprawdź kontrahentów, książkę adresową GlobKurier lub nadawców.' });
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
      return res.status(200).json({ ok: false, error: 'Brak wymiarów paczki. Podaj packageType/invoiceNumber/items lub weight/length/width/height. Aby użyć ostatniej faktury kontrahenta: invoiceNumber="latest"' });
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
    // Merge hardcoded COUNTRY_IDS z dynamiczną mapą z Config (klucz
     // 'gk_country_ids') — po wywołaniu /glob/discover-countries Config
     // zawiera mapowania z bazy odbiorców GK. Pozwala na nowe kraje bez
     // edycji src.
    let dynamicIds = {};
    try {
      const cfg = await prisma.config.findUnique({ where: { key: 'gk_country_ids' } });
      if (cfg && cfg.value) {
        const parsed = typeof cfg.value === 'string' ? JSON.parse(cfg.value) : cfg.value;
        if (parsed && typeof parsed === 'object') dynamicIds = parsed;
      }
    } catch (_) {}
    const mergedIds = { ...COUNTRY_IDS, ...dynamicIds };

    let senderCountryId = sender.countryId || mergedIds[sender.country] || 1;
    let receiverCountryIdMapped = receiver.countryId || mergedIds[receiver.country];

    // Auto-discovery: jeśli kraj odbiorcy nie ma countryId w mapie, ale
    // user wysyłał już do tego kraju (nawet manualnie przez GK panel), to
    // odbiorca jest w bazie GK z prawidłowym countryId. Wystarczy odpalić
    // discovery i ponownie sprawdzić — saves the user from manually
    // calling /glob/discover-countries.
    if (!receiverCountryIdMapped && receiver.country && receiver.country !== 'PL') {
      // 1) Autorytatywne: GET /v1/countries — pełna oficjalna lista (też nowe
      //    kraje jak BG bez wcześniejszej wysyłki).
      console.log(`[glob/quote] auto-discovery: ${receiver.country} brakuje, pobieram oficjalną listę GK /v1/countries...`);
      try {
        const api = await syncCountriesFromApi(prisma);
        const newMerged = { ...COUNTRY_IDS, ...(api.merged || {}) };
        receiverCountryIdMapped = newMerged[receiver.country];
        if (receiverCountryIdMapped) {
          console.log(`[glob/quote] /v1/countries: ${receiver.country} → ${receiverCountryIdMapped} (${api.count} krajów)`);
        }
      } catch (e) {
        console.error('[glob/quote] /v1/countries failed:', e.message);
      }
      // 2) Fallback: skan historii odbiorców (heurystyka prefiksu telefonu).
      if (!receiverCountryIdMapped) {
        console.log(`[glob/quote] auto-discovery fallback: skanuje historię GK dla ${receiver.country}...`);
        try {
          const r = await runCountryDiscovery(prisma);
          const newMerged = { ...COUNTRY_IDS, ...(r.merged || {}) };
          receiverCountryIdMapped = newMerged[receiver.country];
          if (receiverCountryIdMapped) {
            console.log(`[glob/quote] auto-discovery: ${receiver.country} → ${receiverCountryIdMapped} (scan ${r.totalScanned} receivers)`);
          }
        } catch (e) {
          console.error('[glob/quote] auto-discovery failed:', e.message);
        }
      }
    }

    // Hard-block: jeśli nawet po discovery kraj odbiorcy nie ma countryId,
    // GK API zwróciłby ofertę PL→PL (silent fallback) — ceny są wtedy
    // BEZUŻYTECZNE bo kurier nie zabierze paczki za PL-stawkę za granicę.
    if (!receiverCountryIdMapped && receiver.country && receiver.country !== 'PL') {
      const supported = Object.keys(mergedIds).join(', ');
      return res.status(200).json({
        ok: false,
        error: `GlobKurier countryId nieznane dla "${receiver.country}" (auto-discovery też nie znalazło). Wycena PL→${receiver.country} nie jest możliwa.`,
        supportedCountries: supported,
        suggestion: `Wyślij jedną paczkę do ${receiver.country} ręcznie przez panel GK, potem auto-discovery wykryje countryId przy kolejnej wycenie.`,
      });
    }

    const receiverCountryId = receiverCountryIdMapped || 1;

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
    let pickupApiDown = false;
    await Promise.all(offers.slice(0, TOP_OFFERS_TO_PROBE).map(async (o) => {
      try {
        const nearest = await findNearestPickupDate(o.productId, pickupParamsBase, PROBE_MAX_DAYS);
        o.nearestPickup = nearest; // { date, timeFrom, timeTo, daysAhead } or null
      } catch (e) {
        // GK pickupTimeRanges nie odpowiada (timeout) — to NIE znaczy "brak
        // terminow". Oznaczamy jako nieznany i pokazujemy ceny mimo wszystko.
        if (e && e.pickupApiDown) pickupApiDown = true;
        o.nearestPickup = null;
      }
    }));

    // If every probed offer came back with no slots, surface a clear
    // message to the agent instead of letting it blindly propose an order.
    // ALE tylko gdy to realny brak terminow — nie gdy API odbioru padlo
    // (wtedy ceny sa wazne, user moze zamowic, termin dobierze sie przy orderze).
    const probedOffers = offers.slice(0, TOP_OFFERS_TO_PROBE);
    const allNoSlots = !pickupApiDown && probedOffers.length > 0 && probedOffers.every(o => o.nearestPickup === null);
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
    // Persist durably so /glob/order can resolve the quote even if the in-memory
    // store was lost (restart) or the order lands on another instance. Best-effort
    // — a DB hiccup must not break quoting.
    try {
      await prisma.quote.create({ data: { id: quoteId, data: quoteStore[quoteId] } });
      await prisma.quote.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 30 * 60 * 1000) } } });
    } catch (e) {
      console.warn('[glob/quote] durable persist failed:', e.message);
    }

    if (pickupApiDown) {
      warnings.push('Terminy odbioru chwilowo niedostępne (GlobKurier pickupTimeRanges nie odpowiada) — ceny są aktualne, termin odbioru dobierze się przy zamawianiu.');
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
      quoteId = keys.length > 0 ? keys[0] : null;
      if (quoteId) console.log(`[glob/order] sentinel quoteId → latest in memory: ${quoteId}`);
    }

    let quote = quoteId ? quoteStore[quoteId] : null;

    // Durable fallback: the in-memory store can be empty after a restart or when
    // the order lands on a different instance than the quote — which made the
    // agent re-quote instead of ordering. Resolve from the Quote table: by
    // explicit id, otherwise the most recent quote within the 30-min TTL.
    if (!quote) {
      try {
        const cutoff = new Date(Date.now() - 30 * 60 * 1000);
        let row = null;
        if (!isLatestSentinel && quoteId) {
          row = await prisma.quote.findUnique({ where: { id: String(quoteId) } });
        } else {
          row = await prisma.quote.findFirst({ where: { createdAt: { gte: cutoff } }, orderBy: { createdAt: 'desc' } });
        }
        if (row && row.createdAt >= cutoff) {
          quote = row.data;
          quoteId = row.id;
          console.log(`[glob/order] quote ${quoteId} resolved from DB fallback`);
        }
      } catch (e) {
        console.warn('[glob/order] DB quote fallback failed:', e.message);
      }
    }

    if (!quote) {
      console.log(`[glob/order] Quote unresolved (id=${quoteId}) — abort`);
      return res.status(200).json({ ok: false, error: 'Quote wygasł. Pobierz nowy: POST /api/glob/quote' });
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
      return res.status(200).json({ ok: false, error: 'Quote nie zawiera ofert. Wygeneruj nowy.' });
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

    // Mutex addon groups: GlobKurier requires EXACTLY ONE from each group.
    // Picking both (or none) gets rejected with "Dodatek nie może być wybrany
    // we wskazanej grupie". Resolved by inspecting the receiver name for a
    // legal-form suffix (S.L., GmbH, Ltd, Sp. z o.o. ...) — company → 1310,
    // otherwise → 1311 (private individual).
    const ADDON_MUTEX_GROUPS = [
      { ids: [1310, 1311], company: 1310, person: 1311 },
    ];

    function isCompanyName(name) {
      if (!name) return false;
      return /\b(S\.?\s*L\.?(\s*U\.?)?|S\.?\s*A\.?|S\.?\s*A\.?\s*S\.?|GMBH|LTD\.?|LLC|INC\.?|CORP\.?|B\.?V\.?|N\.?V\.?|A\.?B\.?|A\.?S\.?|O\.?Y\.?|S\.?R\.?L\.?|S\.?R\.?L\.?\s*U|LDA\.?|SP\.?\s*Z\s*O\.?\s*O\.?|SP\.?\s*J\.?|SP\.?\s*K\.?)\b/i.test(name);
    }

    function applyAddonMutexGroups(addonsList, receiverName) {
      const ids = new Set(addonsList.map(a => parseInt(a.id)));
      const isCompany = isCompanyName(receiverName);
      let changed = false;
      for (const group of ADDON_MUTEX_GROUPS) {
        const present = group.ids.filter(id => ids.has(id));
        if (present.length > 1) {
          const wanted = isCompany ? group.company : group.person;
          for (const id of group.ids) if (id !== wanted) ids.delete(id);
          changed = true;
        }
      }
      if (!changed) return addonsList;
      return Array.from(ids).map(id => ({ id }));
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
        // Resolve mutex groups (e.g. company-vs-individual delivery): pick
        // exactly one based on receiver legal-form detection.
        payload.addons = applyAddonMutexGroups(
          payload.addons,
          (payload.receiverAddress && payload.receiverAddress.name) || ''
        );
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
    // Mail odbiorcy: sprawdz primaryEmail i ContractorContact (CRM v2), nie tylko
    // plaskie .email — inaczej maile z auto-importu/backfillu "znikaja" i wpada
    // DEFAULT (nasz delivery@), przez co tracking idzie sam do siebie.
    let contractorBestEmail = '';
    if (contractorForReceiver) {
      const prim = contractorForReceiver.primaryEmail;
      const flat = contractorForReceiver.email;
      if (prim && /@/.test(prim)) contractorBestEmail = prim;
      else if (flat && /@/.test(flat)) contractorBestEmail = flat;
      if (!contractorBestEmail) {
        try {
          const contacts = await prisma.contractorContact.findMany({
            where: { contractorId: contractorForReceiver.id, type: 'email' },
            orderBy: [{ isPrimary: 'desc' }],
            select: { value: true },
          });
          const hit = contacts.find((x) => x.value && /@/.test(x.value));
          if (hit) contractorBestEmail = hit.value;
        } catch (_) {}
      }
    }
    const receiverEmail = receiver.email || cGkData.email || contractorBestEmail || DEFAULT_RECEIVER_EMAIL;

    // Mapowanie ISO-2 → numeryczny kod telefoniczny (subset E.164). Używamy
    // do normalizacji telefonu odbiorcy gdy zaczyna się wiodącym '0' a kraj
    // jest non-PL — GK odrzuca lokalne formaty, wymaga E.164.
    const PHONE_DIAL_CODES = {
      PL: '48', DE: '49', FR: '33', IT: '39', ES: '34', NL: '31', BE: '32',
      AT: '43', CZ: '420', SK: '421', HU: '36', SE: '46', DK: '45', FI: '358',
      NO: '47', GB: '44', IE: '353', PT: '351', RO: '40', BG: '359', HR: '385',
      SI: '386', LT: '370', LV: '371', EE: '372', GR: '30', CY: '357', MT: '356',
      LU: '352', CH: '41', AE: '971',
    };
    function sanitizePhone(phone, countryIso, fallback) {
      if (!phone) return fallback;
      let cleaned = String(phone).replace(/[^\d+]/g, '');
      if (cleaned.length < 7 || /^0+$/.test(cleaned)) return fallback;
      // Wiodące '0' w numerze lokalnym + non-PL kraj → konwersja na E.164.
      // Np. DE '01725788429' → '+491725788429'.
      if (cleaned.startsWith('0') && !cleaned.startsWith('00') && countryIso && countryIso !== 'PL') {
        const dial = PHONE_DIAL_CODES[countryIso];
        if (dial) cleaned = '+' + dial + cleaned.slice(1);
      }
      // '00...' (international prefix) → '+...'
      if (cleaned.startsWith('00')) cleaned = '+' + cleaned.slice(2);
      return cleaned;
    }
    // GK odrzuca w polach name/street znaki specjalne: / , ; ( ) [ ] & % + " "
    // Zamieniamy '/' na '-' (najczęstszy case: 'Surfstylefever / Stefan' →
    // 'Surfstylefever - Stefan'), pozostałe usuwamy.
    function sanitizeName(s) {
      if (!s) return s;
      return String(s).replace(/\s*\/\s*/g, ' - ').replace(/[,;()\[\]&%+"”""]/g, '').trim();
    }
    const cleanReceiverPhone = sanitizePhone(receiverPhone, receiver.country, DEFAULT_SENDER_PHONE);
    const cleanSenderPhone = sanitizePhone(senderPhone, sender.country, DEFAULT_SENDER_PHONE);
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
        name: sanitizeName(senderName),
        street: sanitizeName(senderStreet),
        houseNumber: senderHouse || '1',
        postCode: senderPostCode,
        city: senderCity,
        countryId: quote.quoteParams.senderCountryId || sender.countryId || COUNTRY_IDS[sender.country] || 1,
        phone: cleanSenderPhone,
        email: senderEmail,
      },
      receiverAddress: {
        name: sanitizeName(receiverName),
        street: sanitizeName(receiverStreet),
        houseNumber: cleanReceiverHouse,
        postCode: receiverPostCode,
        city: receiverCity,
        countryId: quote.quoteParams.receiverCountryId || receiver.countryId || COUNTRY_IDS[receiver.country] || 1,
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
        const fieldLow = field.toLowerCase();
        const who = field.includes('receiver') ? 'odbiorcy' : (field.includes('sender') ? 'nadawcy' : '');
        if (field.includes('pickup') && /nie jest możliwe|niemożliw/i.test(msg)) {
          problems.push('Brak dostępnych terminów odbioru dla tego kuriera. Spróbuj innego (np. DPD zamiast InPost).');
        } else if (fieldLow.includes('phone')) {
          problems.push(`Telefon ${who || 'odbiorcy'} (${receiverPhone}) odrzucony przez GK: "${msg}". DE/FR/IT wymagają E.164 (+49.../+33...). Sprawdź lub podaj prawidłowy numer.`);
        } else if (fieldLow.includes('street') || fieldLow.includes('housenumber') || fieldLow.includes('address')) {
          problems.push(`Adres ${who || 'odbiorcy'} odrzucony: "${msg}". Sprawdź ulicę/numer domu (bez znaków specjalnych jak / , ; & % + ( ) [ ]).`);
        } else if (fieldLow.includes('email')) {
          problems.push(`Email ${who || 'odbiorcy'}: "${msg}".`);
        } else if (fieldLow.includes('postcode')) {
          problems.push(`Kod pocztowy ${who || 'odbiorcy'}: "${msg}".`);
        } else if (fieldLow.includes('name')) {
          problems.push(`Nazwa ${who || 'odbiorcy'} odrzucona: "${msg}". GK nie pozwala na znaki: / , ; & % + ( ) [ ] " ”. Backend usuwa je automatycznie — jeśli błąd persistuje, zmień nazwę kontrahenta w bazie.`);
        } else if (fieldLow.includes('countryid')) {
          problems.push(`Kraj ${who || ''} odrzucony: "${msg}". Możliwy brak countryId dla tego kraju w GK — uruchom POST /api/glob/discover-countries.`);
        } else if (fieldLow.includes('addon')) {
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
            return res.status(200).json({
              ok: false,
              error: humanizeGkErrors(retryResult),
              carrier: selectedOffer && selectedOffer.carrier,
              receiverName: receiver && receiver.name,
            });
          }
        }

        if (!retrySuccess) {
          return res.status(200).json({
            ok: false,
            error: 'Brak dostępnych terminów odbioru dla ' + ((selectedOffer && selectedOffer.carrier) || 'tego kuriera') + ' w ciągu 7 dni (możliwe święta/długi weekend). Spróbuj innego kuriera (np. DPD) lub późniejszy termin.',
            carrier: selectedOffer && selectedOffer.carrier,
          });
        }
      } else {
        return res.status(200).json({
          ok: false,
          error: humanizeGkErrors(result),
          carrier: selectedOffer && selectedOffer.carrier,
          receiverName: receiver && receiver.name,
        });
      }
    }

    const orderHash = result && (result.hash || result.orderHash);
    const orderNumber = result && result.number;
    // Hard guard against false "ordered" confirmations: GlobKurier MUST return a
    // hash or order number. Without that proof no shipment exists — return a
    // failure so the agent cannot hallucinate "zamówione". The quote is kept (in
    // memory + DB) so the user can retry the same courier pick.
    if (!orderHash && !orderNumber) {
      console.error('[glob/order] GK response has no hash/number — treating as FAILURE:', JSON.stringify(result).slice(0, 400));
      return res.status(200).json({
        ok: false,
        error: 'GlobKurier nie potwierdził zamówienia (brak numeru/hash w odpowiedzi). Paczka NIE została utworzona — spróbuj ponownie lub wybierz innego kuriera.',
        carrier: selectedOffer && selectedOffer.carrier,
        receiverName: receiver && receiver.name,
      });
    }

    delete quoteStore[quoteId];
    // Quote consumed on confirmed success — drop the durable copy too.
    try { await prisma.quote.delete({ where: { id: String(quoteId) } }); } catch (_) {}

    // Operations tracker — link to existing Transaction (matched against an
    // earlier-created invoice) or open a new one. Best-effort.
    if (orderHash) {
      try {
        const { trackShipment } = require('../services/transaction-tracker');
        const itemsForSummary = (quote.quoteParams && quote.quoteParams.items) || quote.items || null;
        const summary = Array.isArray(itemsForSummary) && itemsForSummary.length
          ? itemsForSummary.map(it => `${it.qty}× ${it.name || it.ean || '?'}`).slice(0, 3).join(', ') + (itemsForSummary.length > 3 ? `, +${itemsForSummary.length - 3}` : '')
          : null;
        const fakeOrder = {
          hash: orderHash,
          number: result.number || null,
          trackingNumber: result.trackingNumber || null,
          creationDate: new Date(),
          receiverAddress: receiver,
          pricing: { priceGross: selectedOffer.price, currency: selectedOffer.currency || 'PLN' },
          status: 'IN_PROGRESS',
        };
        await trackShipment(prisma, fakeOrder, {
          source: 'glob/order',
          contractor: contractor || null,
          itemsSummary: summary,
          itemsDetails: itemsForSummary,
        });
      } catch (e) {
        console.error('[glob/order] tracker error:', e.message);
      }

      // CRM v2 Etap 4.4 — shipment.created activity event.
      try {
        const { logActivity } = require('../services/activity-log');
        const carrierTag = selectedOffer && selectedOffer.carrier ? `carrier:${String(selectedOffer.carrier).toLowerCase()}` : null;
        const countryTag = receiver && receiver.country ? `country:${String(receiver.country).toLowerCase()}` : null;
        logActivity(prisma, {
          type: 'shipment.created',
          summary: `Paczka GK${result.number || orderHash} ${selectedOffer ? selectedOffer.carrier : ''} → ${(receiver && (receiver.name || receiver.city)) || '?'}`,
          source: 'gk',
          contractorId: (receiver && receiver.contractorId) || (contractor && contractor.id) || null,
          shipmentNumber: result.number || null,
          actorType: 'user',
          actorId: req.body && req.body.chatId ? String(req.body.chatId) : null,
          payload: {
            orderHash, number: result.number || null, carrier: selectedOffer && selectedOffer.carrier,
            price: selectedOffer && selectedOffer.price, currency: selectedOffer && selectedOffer.currency,
            receiverName: receiver && receiver.name, receiverCity: receiver && receiver.city,
            receiverCountry: receiver && receiver.country,
          },
          tags: [carrierTag, countryTag].filter(Boolean),
        });
      } catch (_) {}

      // CRM v2 Etap 1.5 — sync hook. Adres dostawy + telefon shipping
      // upsertujemy do ContractorContact/Address. Receiver moze byc
      // przepisany na innego niz orginalny kontrahent (np. dropshipping)
      // → preferujemy receiver.contractorId, fallback do contractor.id.
      const crmContractorId = (receiver && receiver.contractorId) || (contractor && contractor.id);
      if (crmContractorId) {
        try {
          if (receiver && receiver.phone) {
            await upsertCrmContact(prisma, crmContractorId, {
              type: 'phone',
              value: receiver.phone,
              label: 'shipping',
              personName: receiver.name || null,
              source: 'gk',
            });
          }
          if (receiver && receiver.email) {
            await upsertCrmContact(prisma, crmContractorId, {
              type: 'email',
              value: receiver.email,
              label: 'shipping',
              source: 'gk',
            });
          }
          const hasAddr = receiver && (receiver.street || receiver.city || receiver.postCode);
          if (hasAddr) {
            await upsertCrmAddress(prisma, crmContractorId, {
              type: 'delivery',
              recipientName: receiver.name || null,
              street: receiver.street || null,
              houseNumber: receiver.houseNumber || null,
              postalCode: receiver.postCode || null,
              city: receiver.city || null,
              country: receiver.country || null,
              fullAddress: [receiver.street, receiver.postCode, receiver.city, receiver.country].filter(Boolean).join(', ') || null,
              source: 'gk',
            });
          }
        } catch (e) {
          console.error('[glob/order] CRM hook failed:', e.message);
        }
      }
    }

    let cmrSent = false;
    if (orderHash) {
      try {
        await new Promise(r => setTimeout(r, 3000));
        const labelResult = await getOrderLabels(orderHash, 'A4');
        const pdfBuffer = labelResult && labelResult.body;
        if (pdfBuffer && pdfBuffer.length > 100) {
          const { resolveTelegram } = require('../services/telegram-helper');
          const tg = await resolveTelegram(prisma, { reqChatId: req.body && req.body.chatId, scope: 'pl' });
          const tgToken = tg.token;
          const tgChat = tg.chatId;
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

    // Build a tracking-email DRAFT (NOT auto-send). After GK assigns the
    // real carrier number we save the draft + push a preview to user's
    // Telegram with the live tracking link — user clicks to verify the
    // link works, then says "tak" and the existing globalny Potwierdź
    // flow (confirm-latest) sends it to the customer.
    // Disable with env DISABLE_TRACKING_NOTIFY=1.
    if (process.env.DISABLE_TRACKING_NOTIFY !== '1') {
      const carrierName = (selectedOffer && selectedOffer.carrier) || result.productName || '';
      const recvCountry = (receiver && (receiver.country || receiver.countryCode)) || '';
      let recipientEmail = (receiver && receiver.email) || null;
      const receiverContractorId = receiver && receiver.contractorId;
      let resolvedCountry = recvCountry;
      let resolvedContractorName = (receiver && receiver.name) || null;
      if ((!recipientEmail || !resolvedCountry) && receiverContractorId) {
        try {
          const c = await prisma.contractor.findUnique({ where: { id: receiverContractorId }, select: { email: true, country: true, name: true } });
          if (c) {
            if (!recipientEmail && c.email) recipientEmail = c.email;
            if (!resolvedCountry && c.country) resolvedCountry = c.country;
            if (!resolvedContractorName) resolvedContractorName = c.name;
          }
        } catch (_) {}
      }
      if (recipientEmail) {
        const { compose } = require('../services/tracking-notify');
        const { buildTrackingUrl } = require('../services/tracking-urls');
        const { getOrderTracking } = require('../glob-client');
        const { resolveTelegram } = require('../services/telegram-helper');
        const { sendTelegram } = require('../telegram-utils');
        const trackingFrom = process.env.TRACKING_NOTIFY_FROM || 'delivery@surfstickbell.com';
        const reqChatId = req.body && req.body.chatId;
        setImmediate(async () => {
          try {
            // Strategia 3-stopniowa wzorem processTrackingSearch (ten
            // sam ktorym send_tracking_to_customer dziala kiedy user
            // wystrzeli go recznie):
            //   1) getOrders({search: orderNumber, limit: 1}) — najszybsze,
            //      lista zamowien zwraca shipment z trackingNumber pakietowo.
            //   2) PDF labels parse (commit c287d20).
            //   3) getOrderTracking polling (defensive fallback).
            let trackingNumber = result.trackingNumber || result.tracking || null;
            const orderNumberForTracking = result.number || result.orderNumber;
            const carrierName = selectedOffer && selectedOffer.carrier;

            // 1) getOrders single-shot (~1-2s)
            if (!trackingNumber && orderNumberForTracking) {
              try {
                await new Promise(r => setTimeout(r, 2000)); // GK index moment
                const gkRes = await getOrders({ search: orderNumberForTracking, limit: 1 });
                const items = Array.isArray(gkRes) && gkRes.length === 1 && gkRes[0] && Array.isArray(gkRes[0].results)
                  ? gkRes[0].results
                  : (Array.isArray(gkRes) ? gkRes : (gkRes && (gkRes.results || gkRes.items || gkRes.data)) || []);
                const shipment = items.find(o =>
                  String(o.number || o.orderNumber || '').trim() === String(orderNumberForTracking).trim()
                ) || items[0];
                const cand = shipment && (shipment.trackingNumber || shipment.tracking);
                if (cand && String(cand).trim()) {
                  trackingNumber = String(cand).trim();
                  console.log(`[glob/order] tracking z getOrders: ${trackingNumber}`);
                }
              } catch (e) {
                console.log('[glob/order] getOrders lookup failed (fallback do PDF):', e.message);
              }
            }

            // 2) PDF labels fallback
            if (!trackingNumber && orderHash) {
              try {
                const labelResp = await getOrderLabels(orderHash, 'A4');
                if (labelResp && labelResp.body && labelResp.body.length > 100) {
                  const { PDFParse } = require('pdf-parse');
                  const parser = new PDFParse({ data: labelResp.body });
                  const parsed = await parser.getText();
                  const labelText = (parsed.text || '').replace(/\s+/g, ' ');
                  const candidates = labelText.match(/\b(?!GK\d+|26\d{6,8}\b)([A-Z0-9]{10,30})\b/g) || [];
                  const tracking = candidates
                    .filter(c => !/^GK/.test(c))
                    .filter(c => !/^(26|25|24|23|22|21|20)\d{6,8}$/.test(c))
                    .filter(c => /\d/.test(c))
                    .sort((a, b) => b.length - a.length)[0];
                  if (tracking) {
                    trackingNumber = tracking;
                    console.log(`[glob/order] tracking z PDF labels: ${trackingNumber}`);
                  }
                }
              } catch (e) {
                console.log('[glob/order] PDF tracking extract failed (fallback do polling):', e.message);
              }
            }

            // 3) getOrderTracking polling — ostatnia szansa, defensywnie.
            const pollAttempts = parseInt(process.env.TRACKING_DRAFT_POLL_ATTEMPTS || '18', 10);
            const pollIntervalMs = parseInt(process.env.TRACKING_DRAFT_POLL_INTERVAL_MS || '15000', 10);
            if (!trackingNumber && orderNumberForTracking) {
              for (let i = 0; i < pollAttempts; i++) {
                await new Promise(r => setTimeout(r, pollIntervalMs));
                try {
                  const t = await getOrderTracking(orderNumberForTracking);
                  if (i === 0 || i === pollAttempts - 1 || i % 4 === 0) {
                    console.log(`[glob/order] getOrderTracking poll #${i + 1}/${pollAttempts} response:`, JSON.stringify(t).slice(0, 400));
                  }
                  const candidate = t && (t.trackingNumber || t.tracking
                    || (t.parcels && t.parcels[0] && t.parcels[0].trackingNumber)
                    || (Array.isArray(t) && t[0] && t[0].trackingNumber));
                  if (candidate && String(candidate).trim()) {
                    trackingNumber = String(candidate).trim();
                    console.log(`[glob/order] carrier tracking resolved (poll #${i + 1}/${pollAttempts}): ${trackingNumber}`);
                    break;
                  }
                } catch (e) {
                  console.error(`[glob/order] getOrderTracking poll #${i + 1}/${pollAttempts} failed:`, e.message);
                }
              }
            }
            if (!trackingNumber) {
              console.log(`[glob/order] tracking-draft skipped after ${pollAttempts} attempts (~${Math.round(pollAttempts * pollIntervalMs / 60000)} min) — carrier tracking number still not assigned (GK# ${result.number || orderHash})`);
              return;
            }
            // Pre-validation: skip if status indicates parcel is registered
            // but not yet with carrier (link would be empty).
            const { validateShipmentReady } = require('../services/tracking-notify');
            const status = result.status || result.statusName || '';
            const v = validateShipmentReady({ trackingNumber, status, recvName: receiver && receiver.name, expectedName: resolvedContractorName });
            if (!v.ok) {
              console.log(`[glob/order] tracking-draft skipped — ${v.reason}`);
              return;
            }

            // Race-condition guard: jak user juz manualnie wystrzelil
            // send_tracking_to_customer w trakcie naszego polling (typowo
            // <5min od ordera), nie tworzymy konkurencyjnego draftu.
            // Szukamy Email z tymsam trackingNumber w extras w ostatnich
            // 30min (DRAFT albo OUTBOUND obojetnie).
            try {
              const alreadyHandled = await prisma.email.findFirst({
                where: {
                  createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
                  OR: [
                    { extras: { path: ['trackingNumber'], equals: trackingNumber } },
                    { bodyFull: { contains: trackingNumber } },
                  ],
                },
                select: { id: true, direction: true },
              });
              if (alreadyHandled) {
                console.log(`[glob/order] tracking-draft skipped — already handled (email ${alreadyHandled.id} direction=${alreadyHandled.direction})`);
                return;
              }
            } catch (e) {
              console.error('[glob/order] tracking-draft dedup check failed (proceeding):', e.message);
            }

            const trackingUrl = buildTrackingUrl(carrierName, trackingNumber, resolvedCountry);
            const { subject, text } = compose({ country: resolvedCountry, trackingNumber, carrier: carrierName, trackingUrl });

            // Save as DRAFT so the existing /send-email/confirm-latest tool
            // can pick it up when the user says "tak". 30-minute window
            // matches what that endpoint expects.
            const trackingDraftEmail = await prisma.email.create({
              data: {
                direction: 'DRAFT',
                inbox: trackingFrom.split('@')[0],
                fromEmail: trackingFrom,
                toEmail: recipientEmail,
                subject,
                bodyPreview: text.slice(0, 300),
                bodyFull: text,
                contractorId: receiverContractorId || null,
                tags: ['tracking_notify'],
                extras: { trackingNumber, carrier: carrierName, country: resolvedCountry, trackingUrl },
              },
            });
            try {
              const { logActivity } = require('../services/activity-log');
              logActivity(prisma, {
                type: 'tracking.notify.draft',
                summary: `Tracking draft: ${carrierName} ${trackingNumber} → ${recipientEmail}`,
                source: 'system',
                contractorId: receiverContractorId || null,
                emailId: trackingDraftEmail.id,
                shipmentNumber: result.number || null,
                trackingNumber,
                actorType: 'system',
                payload: { trackingNumber, trackingUrl, carrier: carrierName, country: resolvedCountry, recipientEmail, subject },
                tags: [carrierName ? `carrier:${String(carrierName).toLowerCase()}` : null, resolvedCountry ? `country:${String(resolvedCountry).toLowerCase()}` : null].filter(Boolean),
              });
            } catch (_) {}

            // Push preview to the operator's Telegram with the LIVE link so
            // they can click → verify → only then approve.
            const tg = await resolveTelegram(prisma, { reqChatId, scope: 'pl' });
            if (tg.ready) {
              const msg =
                `📦 Tracking gotowy — wymaga potwierdzenia\n` +
                `- Klient: ${resolvedContractorName || recipientEmail}\n` +
                `- Do: ${recipientEmail}\n` +
                `- Kurier: ${carrierName || '—'} #${trackingNumber}\n` +
                `- Link: ${trackingUrl || '(brak)'}\n` +
                `- Temat: ${subject}\n\n` +
                `Sprawdź link. Wyślij? "tak" / "wyślij tracking"`;
              try { await sendTelegram(tg.token, String(tg.chatId), msg); }
              catch (e) { console.error('[glob/order] tracking-draft tg push failed:', e.message); }
            } else {
              console.log('[glob/order] tracking-draft saved but no Telegram chat configured');
            }
            console.log(`[glob/order] tracking-draft → ${recipientEmail} (awaiting user approval)`);
          } catch (e) {
            console.error('[glob/order] tracking-draft threw:', e.message);
          }
        });
      } else {
        console.log(`[glob/order] tracking-draft skipped (no recipient email)`);
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

// Mapowanie prefiksów telefonicznych E.164 (longest-prefix-match) → ISO-2.
// GK nie zwraca ISO countryCode na odbiorcach (tylko numeryczne countryId),
// więc kraj wnioskujemy z phone field. Pokrycie EU + sąsiedzi.
const PHONE_PREFIX_TO_ISO = [
  ['+1', 'US'], ['+7', 'RU'],
  ['+30', 'GR'], ['+31', 'NL'], ['+32', 'BE'], ['+33', 'FR'], ['+34', 'ES'],
  ['+36', 'HU'], ['+39', 'IT'],
  ['+40', 'RO'], ['+41', 'CH'], ['+420', 'CZ'], ['+421', 'SK'], ['+43', 'AT'],
  ['+44', 'GB'], ['+45', 'DK'], ['+46', 'SE'], ['+47', 'NO'], ['+48', 'PL'], ['+49', 'DE'],
  ['+351', 'PT'], ['+352', 'LU'], ['+353', 'IE'], ['+354', 'IS'], ['+355', 'AL'],
  ['+356', 'MT'], ['+357', 'CY'], ['+358', 'FI'], ['+359', 'BG'],
  ['+370', 'LT'], ['+371', 'LV'], ['+372', 'EE'], ['+373', 'MD'], ['+374', 'AM'],
  ['+375', 'BY'], ['+376', 'AD'], ['+377', 'MC'], ['+378', 'SM'], ['+380', 'UA'],
  ['+381', 'RS'], ['+382', 'ME'], ['+385', 'HR'], ['+386', 'SI'], ['+387', 'BA'], ['+389', 'MK'],
  ['+90', 'TR'], ['+972', 'IL'], ['+971', 'AE'],
].sort((a, b) => b[0].length - a[0].length); // longest first

function phoneToIso(phone) {
  if (!phone) return null;
  const clean = String(phone).replace(/[\s\-().]/g, '');
  for (const [pref, iso] of PHONE_PREFIX_TO_ISO) {
    if (clean.startsWith(pref)) return iso;
  }
  return null;
}
// Pobiera bazę odbiorców z GK (paginowana), wyciąga unikalne pary
// {countryCode → countryId}, scala z istniejącą mapą i zapisuje w
// Skanuje historię odbiorców GK i mapuje countryId → ISO przez prefix
// telefonu odbiorcy. Idempotent — merguje wynik z Config 'gk_country_ids'.
// Autorytatywne źródło: GET /v1/countries. Buduje mapę ISO→countryId z
// oficjalnej listy GK (zawiera WSZYSTKIE obsługiwane kraje, też nowe jak BG,
// bez potrzeby wcześniejszej wysyłki). Zapisuje do Config 'gk_country_ids'
// (ten sam klucz co quote). Zwraca też nieobsługiwane (lock != null).
async function syncCountriesFromApi(prisma) {
  const list = await getCountries('pl');
  if (!Array.isArray(list)) {
    throw new Error('GK /v1/countries zwróciło nieoczekiwany format: ' + JSON.stringify(list).slice(0, 200));
  }
  const isoToId = {};
  const meta = {};
  const locked = [];
  for (const c of list) {
    const iso = (c.isoCode || '').toUpperCase();
    if (!iso || !c.id) continue;
    isoToId[iso] = c.id;
    meta[iso] = {
      id: c.id,
      name: c.name,
      isUEMember: c.isUEMember,
      isRoadTransportAvailable: c.isRoadTransportAvailable,
      lock: c.lock || null,
    };
    if (c.lock) locked.push(iso);
  }
  const existing = await prisma.config.findUnique({ where: { key: 'gk_country_ids' } });
  let previous = {};
  if (existing && existing.value) {
    try {
      const parsed = typeof existing.value === 'string' ? JSON.parse(existing.value) : existing.value;
      if (parsed && typeof parsed === 'object') previous = parsed;
    } catch (_) {}
  }
  // API jest autorytatywne — nadpisuje wartości z heurystyki telefonowej.
  const merged = { ...previous, ...isoToId };
  await prisma.config.upsert({
    where: { key: 'gk_country_ids' },
    update: { value: JSON.stringify(merged) },
    create: { key: 'gk_country_ids', value: JSON.stringify(merged) },
  });
  return { count: list.length, isoToId, merged, meta, locked };
}

// Wyciągnięte z /glob/discover-countries żeby quote mogło auto-retry
// gdy kraj brakuje w mapie.
async function runCountryDiscovery(prisma) {
  const discovered = {};
  const samples = {};
  const idToIsoVotes = {};
  let offset = 0;
  const pageSize = 200;
  let totalScanned = 0;
  while (offset < 5000) {
    const gkRes = await getReceivers(offset, pageSize, '');
    const items = (gkRes && (gkRes.results || gkRes.items || gkRes.data))
      || (Array.isArray(gkRes) ? gkRes : []);
    if (!Array.isArray(items) || items.length === 0) break;
    for (const r of items) {
      totalScanned++;
      const id = r.countryId || (r.country && typeof r.country === 'object' ? r.country.id : null);
      if (!id) continue;
      const iso = phoneToIso(r.phone);
      if (!iso) continue;
      if (!idToIsoVotes[id]) idToIsoVotes[id] = {};
      idToIsoVotes[id][iso] = (idToIsoVotes[id][iso] || 0) + 1;
      if (!samples[iso]) {
        samples[iso] = { receiverName: r.name || '?', city: r.city || '?', phone: r.phone, countryId: id };
      }
    }
    if (items.length < pageSize) break;
    offset += pageSize;
  }
  for (const [id, votes] of Object.entries(idToIsoVotes)) {
    const sorted = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    const winner = sorted[0];
    if (winner) discovered[winner[0]] = parseInt(id, 10);
  }
  const existing = await prisma.config.findUnique({ where: { key: 'gk_country_ids' } });
  let previous = {};
  if (existing && existing.value) {
    try {
      const parsed = typeof existing.value === 'string' ? JSON.parse(existing.value) : existing.value;
      if (parsed && typeof parsed === 'object') previous = parsed;
    } catch (_) {}
  }
  const merged = { ...previous, ...discovered };
  await prisma.config.upsert({
    where: { key: 'gk_country_ids' },
    update: { value: JSON.stringify(merged) },
    create: { key: 'gk_country_ids', value: JSON.stringify(merged) },
  });
  return { discovered, merged, samples, totalScanned, idToIsoVotes };
}

// Config pod 'gk_country_ids'. Discovery raz po deploy + ad-hoc gdy
// dorzucisz nowy kraj do GK i chcesz go aktywować.
router.post('/glob/discover-countries', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const before = await prisma.config.findUnique({ where: { key: 'gk_country_ids' } });
    const previousMap = (() => { try { return before && before.value ? JSON.parse(before.value) : {}; } catch (_) { return {}; } })();
    const r = await runCountryDiscovery(prisma);
    const newKeys = Object.keys(r.discovered).filter(k => !previousMap[k]);
    res.json({
      ok: true,
      receiversScanned: r.totalScanned,
      discovered: r.discovered,
      samples: r.samples,
      newCountriesAdded: newKeys,
      mergedMap: r.merged,
      hardcodedMap: COUNTRY_IDS,
      idToIsoVotes: r.idToIsoVotes,
    });
  } catch (e) {
    console.error('[glob/discover-countries] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Sync z oficjalnej listy GK (GET /v1/countries) → Config 'gk_country_ids'.
// Najlepszy sposób aktywacji nowego kraju (np. Bułgaria) — bez wcześniejszej
// wysyłki i bez zgadywania z prefiksu telefonu.
router.post('/glob/sync-countries', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const before = await prisma.config.findUnique({ where: { key: 'gk_country_ids' } });
    const prev = (() => { try { return before && before.value ? JSON.parse(before.value) : {}; } catch (_) { return {}; } })();
    const r = await syncCountriesFromApi(prisma);
    const newCountries = Object.keys(r.isoToId).filter(k => !prev[k]);
    res.json({
      ok: true,
      countriesFromApi: r.count,
      newCountriesAdded: newCountries,
      locked: r.locked,
      mergedMap: r.merged,
      meta: r.meta,
    });
  } catch (e) {
    console.error('[glob/sync-countries] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Surowa lista krajów z GK API (bez zapisu) — diagnostyka.
router.get('/glob/countries', async (req, res) => {
  try {
    const list = await getCountries(req.query.lang || 'pl');
    res.json({ ok: true, count: Array.isArray(list) ? list.length : 0, countries: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Podgląd aktualnej scalonej mapy (hardcoded + Config dynamic).
router.get('/glob/country-ids', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const cfg = await prisma.config.findUnique({ where: { key: 'gk_country_ids' } });
    let dynamic = {};
    if (cfg && cfg.value) {
      try {
        const parsed = typeof cfg.value === 'string' ? JSON.parse(cfg.value) : cfg.value;
        if (parsed && typeof parsed === 'object') dynamic = parsed;
      } catch (_) {}
    }
    res.json({ ok: true, hardcoded: COUNTRY_IDS, dynamic, merged: { ...COUNTRY_IDS, ...dynamic } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/glob/parse-address
// Parsuje paste-blob (lub krotka nazwe) na strukture odbiorcy. Klient
// wkleja "Maria Schmidt, Pozo Winds SL, C/ Mayor 12, 35600 Puerto del
// Rosario, Spain" → dostaje {name, street, houseNumber, postCode, city,
// country, phone, email}. Jak to krotka nazwa bez adresu → zwraca tylko
// {name}, frontend uzyje jako receiverSearch (fuzzy match po
// kontrahentach).
//
// Claude Haiku 4.5 (najtanszy, jakosc OK dla parsingu structured data).
router.post('/glob/parse-address', async (req, res) => {
  const { text } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ ok: false, error: 'text required' });
  }
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(503).json({ ok: false, error: 'ANTHROPIC_API_KEY not set' });
  }
  const MODEL = process.env.ADDRESS_PARSE_MODEL || 'claude-haiku-4-5-20251001';
  const systemPrompt = 'Jestes parserem adresow odbiorcow paczek. Zwracasz TYLKO JSON, bez komentarzy ani markdownu, bez ``` wokol.';
  const userPrompt = `Wyciagnij dane odbiorcy z ponizszego tekstu. Zwroc JSON w formacie:
{"name": string|null, "street": string|null, "houseNumber": string|null, "postCode": string|null, "city": string|null, "country": string|null, "phone": string|null, "email": string|null}

Zasady:
- Jak to TYLKO nazwa firmy/osoby bez adresu (krotki tekst): zwroc tylko {"name": "..."} reszta null.
- Jak pelny adres: wypelnij wszystko co da sie wywnioskowac.
- country: ISO-2 (PL/ES/DE/FR/IT/PT/NL/GB/...). Jak nie da sie ustalic, daj null.
- postCode: format docelowy (bez spacji w PL/ES, ze spacja w GB jak jest).
- houseNumber: oddziel od ulicy jak rozpoznasz (np. "Mayor 12" -> street:"Mayor", houseNumber:"12").
- Jak ulica + numer wspolnie ("Calle Mayor 12, planta 3"): street="Calle Mayor", houseNumber="12, planta 3".
- phone: cyfry + ewentualny + na poczatku.
- email: tylko jak jest jawnie podany.

Tekst:
---
${text}
---`;

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const result = await new Promise((resolve, reject) => {
    const r = https.request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, response => {
      const chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => {
        const txt = Buffer.concat(chunks).toString();
        if (response.statusCode >= 400) return reject(new Error('Anthropic ' + response.statusCode + ': ' + txt.slice(0, 300)));
        try {
          const j = JSON.parse(txt);
          const t = j.content && j.content[0] && j.content[0].text;
          if (!t) return reject(new Error('Anthropic empty: ' + txt.slice(0, 300)));
          resolve(t.trim());
        } catch (e) {
          reject(new Error('Anthropic invalid JSON: ' + txt.slice(0, 300)));
        }
      });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });

  // Try to parse JSON z output. Czasem Claude zwroci z dodatkowym tekstem
  // mimo "TYLKO JSON" - probujemy wyciagnac pierwszy obiekt {...}.
  let parsed = null;
  try {
    parsed = JSON.parse(result);
  } catch (_) {
    const match = result.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch (_) {}
    }
  }
  if (!parsed) {
    return res.json({ ok: false, error: 'parse error', raw: result.slice(0, 500) });
  }

  // Czysci: usun puste stringi
  const cleaned = {};
  for (const k of ['name', 'street', 'houseNumber', 'postCode', 'city', 'country', 'phone', 'email']) {
    const v = parsed[k];
    if (v != null && String(v).trim()) cleaned[k] = String(v).trim();
    else cleaned[k] = null;
  }

  res.json({ ok: true, parsed: cleaned });
});

module.exports = router;
// Eksport pomocniczy do startowego self-heal w index.js.
module.exports.syncCountriesFromApi = syncCountriesFromApi;
