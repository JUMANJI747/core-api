'use strict';

const router = require('express').Router();
const https = require('https');
const { deleteInvoice, fetchInvoiceDetails } = require('../ifirma-client');
const { sendTelegram } = require('../telegram-utils');

// ============ HELPERS ============

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch (e) { resolve({ status: res.statusCode, body: text }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers };
    https.get(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch (e) { resolve({ status: res.statusCode, body: text }); }
      });
    }).on('error', reject);
  });
}

function normalize(str) {
  return (str || '').toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

// ============ FALLBACK MATCHING (regex-based) ============

function fallbackMatching(invoiceItems, filteredOrders) {
  const availableOrders = [...filteredOrders];
  const matched = [];
  const unmatchedInvoices = [];

  for (const inv of invoiceItems) {
    let bestMatch = null;
    let bestIdx = -1;

    for (let i = 0; i < availableOrders.length; i++) {
      const order = availableOrders[i];
      const receiver = order.receiverAddress || order.receiver || {};
      const receiverName = receiver.name || '';
      const contactPerson = receiver.contactPerson || receiver.contact_person || '';

      const normContractor = normalize(inv.contractor);
      if (normContractor && (normContractor === normalize(receiverName) || normContractor === normalize(contactPerson))) {
        bestMatch = order; bestIdx = i;
        break;
      }
    }

    if (bestMatch) {
      const receiver = bestMatch.receiverAddress || bestMatch.receiver || {};
      matched.push({
        invoice: { number: inv.number, contractor: inv.contractor, grossAmount: inv.grossAmount, currency: inv.currency },
        order: {
          number: bestMatch.number || bestMatch.orderNumber || bestMatch.id,
          hash: bestMatch.hash || bestMatch.id,
          carrier: bestMatch.carrierName || bestMatch.carrier || (bestMatch.service && bestMatch.service.carrier) || '',
          receiverName: receiver.name || '',
          creationDate: bestMatch.creationDate || bestMatch.created_at || bestMatch.createdAt,
        },
        matchedBy: 'exact_name',
      });
      availableOrders.splice(bestIdx, 1);
    } else {
      unmatchedInvoices.push({ number: inv.number, contractor: inv.contractor, grossAmount: inv.grossAmount, currency: inv.currency });
    }
  }

  const unmatchedOrders = availableOrders.map(order => {
    const receiver = order.receiverAddress || order.receiver || {};
    return {
      number: order.number || order.orderNumber || order.id,
      hash: order.hash || order.id,
      receiverName: receiver.name || '',
      creationDate: order.creationDate || order.created_at || order.createdAt,
    };
  });

  return { matched, unmatchedInvoices, unmatchedOrders };
}

// ============ LLM MATCHING (Claude Sonnet) ============

async function llmMatching(invoiceItems, filteredOrders) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const invoicesForLLM = invoiceItems.map(inv => ({
    number: inv.number,
    contractor: inv.contractor,
    tradeName: inv.tradeName || '',
    locations: inv.locations && inv.locations.length ? inv.locations : undefined,
    city: inv.contractorCity || '',
    street: inv.contractorAddress || '',
    postCode: inv.contractorPostCode || '',
    country: inv.contractorCountry || '',
    nip: inv.contractorNip || '',
    grossAmount: inv.grossAmount,
    currency: inv.currency,
  }));

  const ordersForLLM = filteredOrders.map(ord => {
    const receiver = ord.receiverAddress || ord.receiver || {};
    return {
      number: ord.number || ord.orderNumber || ord.id,
      hash: ord.hash || ord.id,
      receiverName: receiver.name || '',
      contactPerson: receiver.contactPerson || receiver.contact_person || '',
      city: receiver.city || '',
      street: ((receiver.street || '') + ' ' + (receiver.houseNumber || '')).trim(),
      postCode: receiver.postCode || '',
      countryId: receiver.countryId || '',
      phone: receiver.phone || '',
      email: receiver.email || '',
      creationDate: ord.creationDate || ord.created_at || ord.createdAt,
    };
  });

  const prompt = `Sparuj faktury WDT z listami przewozowymi GlobKurier.

Każda faktura WDT powinna mieć MAKSYMALNIE jeden list przewozowy. Każdy list może być użyty tylko raz.

Paruj po nazwie kontrahenta/odbiorcy — to ta sama firma, ale nazwy mogą się różnić:
- Inna wielkość liter, polskie/portugalskie znaki
- Suffixy firmowe (LDA, SL, SLU, SA, Unipessoal) na fakturze ale nie na liście lub odwrotnie
- Złączone słowa (np. "HONESTMOLECULE" = "Honest Molecule")
- Skrócone nazwy (np. "Farmácia Braga" to skrót od "FARMÁCIA S. VICENTE DE BRAGA, LDA")
- Nazwy mogą być w polu receiverName LUB contactPerson

Niektórzy kontrahenci mają pole 'tradeName' i 'locations' — to nazwy handlowe farmácias i ich adresy. Farmácia na fakturze może mieć nazwę prawną (np. FOZFARMA UNIPESSOAL LDA) ale w GlobKurier występuje pod nazwą handlową (np. Farmácia Gomes). Paruj po tradeName i adresach z locations.

WAŻNE: Jeden kontrahent (np. FOZFARMA) może mieć WIELE lokalizacji (locations). Każda lokalizacja ma swoją tradeName. Paruj każdą fakturę z zamówieniem które pasuje do JEDNEJ z lokalizacji — po tradeName LUB po adresie (miasto + kod pocztowy + ulica).

Masz teraz pełne adresy obu stron. Dla farmacji i firm o podobnych nazwach — paruj po ADRESIE (miasto + kod pocztowy + ulica). Jeśli faktura ma miasto 'Braga' i zamówienie ma miasto 'Braga' z tym samym kodem pocztowym — to para.

Jeśli po nazwie nie da się sparować, sprawdź czy pasuje adres (miasto + kod pocztowy).

NIE paruj na siłę — jeśli nie ma pewności, zostaw jako nieparowane.

FAKTURY WDT:
${JSON.stringify(invoicesForLLM, null, 2)}

ZAMÓWIENIA GLOBKURIER:
${JSON.stringify(ordersForLLM, null, 2)}

Odpowiedz TYLKO czystym JSON (bez markdown, bez komentarzy):
{
  "matched": [
    { "invoiceNumber": "25/2026", "orderNumber": "GK123", "reason": "krótki opis dlaczego pasuje" }
  ],
  "unmatchedInvoices": ["30/2026", "31/2026"],
  "unmatchedOrders": ["GK456", "GK789"]
}`;

  console.log('[jpk] Using LLM matching (Claude Sonnet)');

  const response = await httpsPost('https://api.anthropic.com/v1/messages', {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }, {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  if (response.status !== 200) {
    throw new Error(`Anthropic API error: ${response.status} ${JSON.stringify(response.body).slice(0, 300)}`);
  }

  const llmText = response.body.content[0].text;
  const cleanJson = llmText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const llmResult = JSON.parse(cleanJson);

  // Build lookup maps
  const invoiceMap = new Map(invoiceItems.map(inv => [inv.number, inv]));
  const orderMap = new Map();
  for (const ord of filteredOrders) {
    const num = ord.number || ord.orderNumber || ord.id;
    orderMap.set(num, ord);
  }

  // Build matched array
  const matched = [];
  const usedOrders = new Set();
  for (const pair of (llmResult.matched || [])) {
    const inv = invoiceMap.get(pair.invoiceNumber);
    const ord = orderMap.get(pair.orderNumber);
    if (!inv || !ord || usedOrders.has(pair.orderNumber)) continue;
    usedOrders.add(pair.orderNumber);

    const receiver = ord.receiverAddress || ord.receiver || {};
    matched.push({
      invoice: { number: inv.number, contractor: inv.contractor, grossAmount: inv.grossAmount, currency: inv.currency },
      order: {
        number: pair.orderNumber,
        hash: ord.hash || ord.id,
        carrier: ord.carrierName || ord.carrier || (ord.service && ord.service.carrier) || '',
        receiverName: receiver.name || '',
        creationDate: ord.creationDate || ord.created_at || ord.createdAt,
      },
      matchedBy: pair.reason || 'llm',
    });
  }

  // Build unmatched
  const matchedInvNumbers = new Set(matched.map(m => m.invoice.number));
  const matchedOrdNumbers = new Set(matched.map(m => m.order.number));

  const unmatchedInvoices = invoiceItems
    .filter(inv => !matchedInvNumbers.has(inv.number))
    .map(inv => ({ number: inv.number, contractor: inv.contractor, grossAmount: inv.grossAmount, currency: inv.currency }));

  const unmatchedOrders = filteredOrders
    .filter(ord => !matchedOrdNumbers.has(ord.number || ord.orderNumber || ord.id))
    .map(ord => {
      const receiver = ord.receiverAddress || ord.receiver || {};
      return {
        number: ord.number || ord.orderNumber || ord.id,
        hash: ord.hash || ord.id,
        receiverName: receiver.name || '',
        creationDate: ord.creationDate || ord.created_at || ord.createdAt,
      };
    });

  return { matched, unmatchedInvoices, unmatchedOrders };
}

// ============ WDT MATCHING (shared logic) ============

async function performWdtMatching(prisma, y, m) {
  const dataOd = new Date(y, m - 1, 1);
  const lastDay = new Date(y, m, 0).getDate();
  const dataDo = new Date(y, m - 1, lastDay, 23, 59, 59, 999);

  // 1. FETCH WDT INVOICES
  const wdtInvoices = await prisma.invoice.findMany({
    where: {
      issueDate: { gte: dataOd, lte: dataDo },
      OR: [
        { type: { contains: 'dostawa_ue', mode: 'insensitive' } },
        { type: { contains: 'wdt', mode: 'insensitive' } },
        { ifirmaType: { contains: 'dostawa_ue', mode: 'insensitive' } },
        { ifirmaType: { contains: 'wdt', mode: 'insensitive' } },
      ],
    },
    include: { contractor: true },
  });

  // Enrich invoices with address data from iFirma
  const invoiceItems = [];
  for (const inv of wdtInvoices) {
    const contractorName = (inv.contractor && inv.contractor.name)
      || (inv.extras && inv.extras.kontrahentNazwa)
      || '';
    const contractorAddress = inv.contractor && inv.contractor.address || '';
    const contractorCity = inv.contractor && inv.contractor.city || '';
    const contractorExtras = inv.contractor && inv.contractor.extras || {};

    let ifirmaCity = '';
    let ifirmaStreet = '';
    let ifirmaPostCode = '';
    let ifirmaCountry = '';
    let ifirmaNip = '';

    if (inv.ifirmaId) {
      try {
        const rodzaj = inv.ifirmaType || inv.type || 'wdt';
        console.log('[jpk] Fetching invoice details from iFirma:', inv.number);
        const details = await fetchInvoiceDetails(inv.ifirmaId, rodzaj);
        const k = details && details.Kontrahent;
        if (k) {
          ifirmaCity = k.Miejscowosc || '';
          ifirmaStreet = ((k.Ulica || '') + ' ' + (k.NumerDomu || '')).trim();
          ifirmaPostCode = k.KodPocztowy || '';
          ifirmaCountry = k.Kraj || k.KrajKod || '';
          ifirmaNip = k.NIP || '';
        }
      } catch (e) {
        console.error(`[jpk] Failed to fetch details for ${inv.number}:`, e.message);
      }
    }

    invoiceItems.push({
      id: inv.id,
      number: inv.number,
      contractor: contractorName,
      contractorAddress: contractorAddress || ifirmaStreet,
      contractorCity: contractorCity || ifirmaCity,
      contractorPostCode: contractorExtras.postCode || ifirmaPostCode,
      contractorCountry: (inv.contractor && inv.contractor.country) || ifirmaCountry,
      contractorNip: ifirmaNip,
      tradeName: contractorExtras.tradeName || '',
      locations: contractorExtras.locations || [],
      grossAmount: inv.grossAmount,
      currency: inv.currency,
      issueDate: inv.issueDate,
      ifirmaId: inv.ifirmaId,
    });
  }

  // 2. FETCH GLOBKURIER ORDERS
  const gkEmail = (process.env.GLOBKURIER_EMAIL || '').trim();
  const gkPassword = (process.env.GLOBKURIER_PASSWORD || '').trim();
  if (!gkEmail || !gkPassword) {
    throw new Error('GLOBKURIER_EMAIL or GLOBKURIER_PASSWORD not set');
  }

  const loginResp = await httpsPost('https://api.globkurier.pl/v1/auth/login', {}, {
    email: gkEmail,
    password: gkPassword,
  });
  console.log('[jpk] GlobKurier token:', loginResp.body && loginResp.body.token ? loginResp.body.token.substring(0, 20) + '...' : 'NO TOKEN');
  if (loginResp.status !== 200 || !loginResp.body.token) {
    throw new Error('GlobKurier login failed');
  }
  const token = loginResp.body.token;

  const ordersResp = await httpsGet('https://api.globkurier.pl/v1/orders?limit=100', {
    'X-Auth-Token': token,
    'Accept-Language': 'pl',
    'Accept': 'application/json',
  });
  if (ordersResp.status !== 200) {
    throw new Error('GlobKurier orders fetch failed');
  }

  const ordersData = ordersResp.body;
  const allOrders = (ordersData && ordersData.results) ? ordersData.results
    : (ordersData && ordersData.items) ? ordersData.items
    : (ordersData && ordersData.data) ? ordersData.data
    : Array.isArray(ordersData) ? ordersData
    : [];

  const filterFrom = dataOd;
  const nextMonthEnd = new Date(y, m + 1, 0, 23, 59, 59, 999);
  const filteredOrders = allOrders.filter(order => {
    const creationDate = new Date(order.creationDate || order.created_at || order.createdAt || 0);
    if (creationDate < filterFrom || creationDate > nextMonthEnd) return false;
    const receiver = order.receiverAddress || order.receiver || {};
    if (receiver.countryId === 1 || receiver.country_id === 1) return false;
    return true;
  });

  // 3. MATCHING — try LLM first, fallback to regex
  let matchResult;
  let matchingMethod = 'llm';
  try {
    matchResult = await llmMatching(invoiceItems, filteredOrders);
  } catch (e) {
    console.error('[jpk] LLM matching failed:', e.message);
    console.log('[jpk] LLM failed, using fallback matching');
    matchResult = fallbackMatching(invoiceItems, filteredOrders);
    matchingMethod = 'fallback';
  }

  const { matched, unmatchedInvoices, unmatchedOrders } = matchResult;
  const period = `${y}-${String(m).padStart(2, '0')}`;
  console.log(`[jpk] WDT invoices: ${invoiceItems.length}, GlobKurier orders: ${filteredOrders.length}, Matched: ${matched.length} (${matchingMethod})`);

  return {
    period,
    matchingMethod,
    summary: {
      wdtInvoices: invoiceItems.length,
      globOrders: filteredOrders.length,
      matched: matched.length,
      unmatchedInvoices: unmatchedInvoices.length,
      unmatchedOrders: unmatchedOrders.length,
    },
    matched,
    unmatchedInvoices,
    unmatchedOrders,
  };
}

router.get('/wdt-matching', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = parseInt(req.query.year) || prevMonth.getFullYear();
    const m = parseInt(req.query.month) || (prevMonth.getMonth() + 1);

    const result = await performWdtMatching(prisma, y, m);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[jpk] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ UNPAID REVIEW ============

async function getUnpaidInvoices(prisma, year, month) {
  const startOfMonth = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0).getDate();
  const endOfMonth = new Date(year, month - 1, lastDay, 23, 59, 59, 999);
  const today = new Date();

  const unpaid = await prisma.invoice.findMany({
    where: {
      issueDate: { gte: startOfMonth, lte: endOfMonth },
      status: { not: 'paid' },
    },
    include: { contractor: true },
    orderBy: { issueDate: 'asc' },
  });

  const invoices = unpaid.map(inv => {
    const contractor = (inv.contractor && inv.contractor.name)
      || (inv.extras && inv.extras.kontrahentNazwa)
      || '';
    return {
      id: inv.id,
      number: inv.number,
      ifirmaId: inv.ifirmaId,
      contractor,
      grossAmount: inv.grossAmount,
      currency: inv.currency,
      status: inv.status,
      paidAmount: inv.paidAmount,
      issueDate: inv.issueDate,
      dueDate: inv.dueDate,
      isOverdue: inv.dueDate ? new Date(inv.dueDate) < today : false,
      type: inv.ifirmaType || inv.type || null,
    };
  });

  // Sort: overdue first, then the rest
  invoices.sort((a, b) => (b.isOverdue ? 1 : 0) - (a.isOverdue ? 1 : 0));

  const totalUnpaid = Math.round(invoices.reduce((s, i) => s + i.grossAmount, 0) * 100) / 100;
  const period = `${year}-${String(month).padStart(2, '0')}`;

  const lines = invoices.map((inv, idx) => {
    const overdue = inv.isOverdue ? ' ⚠️' : '';
    return `${idx + 1}. ${inv.number} — ${inv.contractor} — ${inv.grossAmount.toFixed(2)} ${inv.currency}${overdue}`;
  });
  const telegramMessage = `📋 Nieopłacone za ${period}:\n\n${lines.join('\n')}`;

  return { period, invoices, totalUnpaid, telegramMessage };
}

router.get('/unpaid-review', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = parseInt(req.query.year) || prevMonth.getFullYear();
    const m = parseInt(req.query.month) || (prevMonth.getMonth() + 1);

    const { period, invoices, totalUnpaid, telegramMessage } = await getUnpaidInvoices(prisma, y, m);
    res.json({ ok: true, period, unpaidCount: invoices.length, totalUnpaid, invoices, telegramMessage });
  } catch (e) {
    console.error('[jpk] unpaid-review error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ START MONTHLY REVIEW ============

router.post('/start-monthly-review', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = parseInt(req.query.year) || prevMonth.getFullYear();
    const m = parseInt(req.query.month) || (prevMonth.getMonth() + 1);

    const tgToken = process.env.TELEGRAM_BOT_TOKEN || '8359714766:AAHHE2bStorakXZRSaxtxZl69EqJWA_GlC4';
    const tgChat = process.env.TELEGRAM_CHAT_ID || '8164528644';

    const { period, invoices, totalUnpaid, telegramMessage } = await getUnpaidInvoices(prisma, y, m);

    if (invoices.length === 0) {
      // All paid — proceed with sync + matching
      await sendTelegram(tgToken, tgChat, `✅ Wszystkie faktury za ${period} opłacone. Przechodzę do synca i parowania WDT.`);
      const runResult = await runSyncAndMatching(prisma, y, m, tgToken, tgChat);
      return res.json({ ok: true, step: 'completed', period, ...runResult });
    }

    // Has unpaid invoices — send review to Telegram and wait
    const lines = invoices.map((inv, idx) => {
      const overdue = inv.isOverdue ? ' ⚠️' : '';
      return `${idx + 1}. ${inv.number} — ${inv.contractor} — ${inv.grossAmount.toFixed(2)} ${inv.currency}${overdue}`;
    });

    const tgMsg = `📋 Nieopłacone faktury za ${period}:\n\n${lines.join('\n')}\n\nRazem: ${invoices.length} faktur\n\nOdpowiedz:\n• 'zostaw' — idziemy dalej ze wszystkimi\n• 'usuń 46/2026, 47/2026' — skasuje wskazane i idziemy dalej`;

    await sendTelegram(tgToken, tgChat, tgMsg);
    console.log(`[jpk] start-monthly-review: ${invoices.length} unpaid for ${period}, Telegram sent`);

    return res.json({
      ok: true,
      step: 'waiting_for_response',
      period,
      unpaidCount: invoices.length,
      totalUnpaid,
      telegramSent: true,
    });
  } catch (e) {
    console.error('[jpk] start-monthly-review error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ SYNC + MATCHING (shared logic) ============

async function runSyncAndMatching(prisma, y, m, tgToken, tgChat) {
  const { fetchInvoices: fetchIfirmaInvoices } = require('../ifirma-client');
  const { processIfirmaInvoices } = require('./contractors');

  // 1. Sync
  const dataOd = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const dataDo = `${y}-${String(m).padStart(2, '0')}-${lastDay}`;
  const ifirmaInvoices = await fetchIfirmaInvoices({ dataOd, dataDo });
  const syncResult = await processIfirmaInvoices(ifirmaInvoices, prisma, { dataOd, dataDo, dryRun: false });

  // 2. WDT Matching
  const matchResult = await performWdtMatching(prisma, y, m);

  // 3. Telegram report
  const period = `${y}-${String(m).padStart(2, '0')}`;
  const s = matchResult.summary;
  const matchedLines = matchResult.matched.map((p, i) =>
    `${i + 1}. ${p.invoice.number} (${p.invoice.contractor}) ↔ ${p.order.number} (${p.order.receiverName})`
  );
  const unmatchedInvLines = matchResult.unmatchedInvoices.map(i => `• ${i.number} — ${i.contractor} — ${i.grossAmount} ${i.currency}`);
  const unmatchedOrdLines = matchResult.unmatchedOrders.map(o => `• ${o.number} → ${o.receiverName}`);

  let tgReport = `📊 Rozliczenie za ${period}:\n\n`;
  tgReport += `Sync: ${syncResult.invoices.created} nowe, ${syncResult.invoices.updated} zaktualizowane, ${syncResult.deletedCount || 0} usunięte\n\n`;
  tgReport += `WDT: ${s.matched}/${s.wdtInvoices} sparowanych z listami\n\n`;
  if (matchedLines.length) tgReport += `✅ Sparowane:\n${matchedLines.join('\n')}\n\n`;
  if (unmatchedInvLines.length) tgReport += `❌ Brak listu:\n${unmatchedInvLines.join('\n')}\n\n`;
  if (unmatchedOrdLines.length) tgReport += `📦 Nieparowane zamówienia:\n${unmatchedOrdLines.join('\n')}`;

  if (tgToken && tgChat) {
    await sendTelegram(tgToken, tgChat, tgReport);
  }

  return {
    sync: { fetched: ifirmaInvoices.length, created: syncResult.invoices.created, updated: syncResult.invoices.updated, deleted: syncResult.deletedCount || 0 },
    matching: { summary: s, matched: matchResult.matched, unmatchedInvoices: matchResult.unmatchedInvoices, unmatchedOrders: matchResult.unmatchedOrders },
  };
}

// ============ RUN MONTHLY ============

router.post('/run-monthly', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = (req.body && req.body.year) || prevMonth.getFullYear();
    const m = (req.body && req.body.month) || (prevMonth.getMonth() + 1);
    const period = `${y}-${String(m).padStart(2, '0')}`;

    const tgToken = process.env.TELEGRAM_BOT_TOKEN || '8359714766:AAHHE2bStorakXZRSaxtxZl69EqJWA_GlC4';
    const tgChat = process.env.TELEGRAM_CHAT_ID || '8164528644';

    const result = await runSyncAndMatching(prisma, y, m, tgToken, tgChat);

    res.json({ ok: true, period, ...result });
  } catch (e) {
    console.error('[jpk] run-monthly error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ DELETE INVOICES ============

router.post('/delete-invoices', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { invoiceIds, invoiceNumbers } = req.body;
    if ((!invoiceIds || !invoiceIds.length) && (!invoiceNumbers || !invoiceNumbers.length)) {
      return res.status(400).json({ error: 'invoiceIds or invoiceNumbers required' });
    }

    // Resolve invoices
    let invoices = [];
    if (invoiceIds && invoiceIds.length) {
      invoices = await prisma.invoice.findMany({ where: { id: { in: invoiceIds } } });
    } else if (invoiceNumbers && invoiceNumbers.length) {
      invoices = await prisma.invoice.findMany({ where: { number: { in: invoiceNumbers } } });
    }

    const deleted = [];
    const errors = [];

    for (const inv of invoices) {
      console.log('[jpk] Deleting invoice', inv.number, 'ifirmaId:', inv.ifirmaId);

      // Delete from iFirma if has ifirmaId
      if (inv.ifirmaId) {
        try {
          const rodzaj = inv.ifirmaType || inv.type || 'krajowa';
          await deleteInvoice(inv.ifirmaId, rodzaj);
        } catch (e) {
          console.error(`[jpk] iFirma delete failed for ${inv.number}:`, e.message);
          errors.push({ number: inv.number, ifirmaId: inv.ifirmaId, error: e.message });
        }
      }

      // Delete from local DB
      try {
        await prisma.invoice.delete({ where: { id: inv.id } });
        deleted.push({ id: inv.id, number: inv.number, ifirmaId: inv.ifirmaId, grossAmount: inv.grossAmount });
      } catch (e) {
        console.error(`[jpk] DB delete failed for ${inv.number}:`, e.message);
        errors.push({ number: inv.number, error: e.message });
      }
    }

    res.json({ ok: true, deleted, errors });
  } catch (e) {
    console.error('[jpk] delete-invoices error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ SEED SOFARMA ============

router.post('/seed-sofarma', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const sofarmaPharmacies = [
      { legalName: 'FARMACIA BIRRA UNIPESSOAL LDA', tradeName: 'Farmácia Birra', nip: '513410619', street: 'Praça da Liberdade 124', postCode: '4000-322', city: 'Porto', country: 'PT' },
      { legalName: 'FOZFARMA UNIPESSOAL LDA', tradeName: 'Farmácia Gomes', nip: '510714846', street: 'Avenida São Miguel 269', postCode: '4575-302', city: 'Paredes - Penafiel', country: 'PT' },
      { legalName: 'FOZFARMA UNIPESSOAL LDA', tradeName: 'Farmácia Santo Ovídio', nip: '510714846', street: 'Rua Soares dos Reis 650', postCode: '4400-314', city: 'Vila Nova de Gaia', country: 'PT', secondLocation: true },
      { legalName: 'FARMÁCIA S. VICENTE DE BRAGA, LDA', tradeName: 'Farmácia Santos', nip: '505372339', street: 'Rua Conselheiro Januário 95-99', postCode: '4700-373', city: 'Braga', country: 'PT' },
      { legalName: 'LOPES BARATA UNIPESSOAL LDA', tradeName: 'Farmácia Guifões', nip: '510463894', street: 'Largo Padre Joaquim Pereira Santos 376', postCode: '4460-033', city: 'Guifões - Matosinhos', country: 'PT' },
      { legalName: 'LOPES BARATA UNIPESSOAL LDA', tradeName: 'Farmácia Braga', nip: '510463894', street: 'Avenida Frei Bartolomeu dos Mártires s/n', postCode: '4715-384', city: 'Braga', country: 'PT', secondLocation: true },
      { legalName: 'LBFARMA, LDA', tradeName: 'Farmácia Monte da Virgem', nip: '508400074', street: 'Rua Conceição Fernandes 1170', postCode: '4430-062', city: 'Vila Nova de Gaia', country: 'PT' },
      { legalName: 'SOC COMERCIAL FARMACEUTICA LDA', tradeName: 'Farmácia Vitália', nip: '500264724', street: 'Praça da Liberdade 37', postCode: '4200-322', city: 'Porto', country: 'PT' },
    ];

    const results = [];
    for (const entry of sofarmaPharmacies) {
      const found = await prisma.contractor.findFirst({ where: { nip: entry.nip } });
      const location = { tradeName: entry.tradeName, street: entry.street, postCode: entry.postCode, city: entry.city };

      if (found) {
        const existingLocations = (found.extras && found.extras.locations) || [];
        const alreadyHas = existingLocations.some(l => l.tradeName === entry.tradeName);
        if (!alreadyHas) {
          existingLocations.push(location);
        }
        await prisma.contractor.update({
          where: { id: found.id },
          data: {
            extras: { ...found.extras, tradeName: entry.tradeName, street: entry.street, postCode: entry.postCode, city: entry.city, locations: existingLocations },
            country: entry.country,
          },
        });
        results.push({ nip: entry.nip, name: found.name, tradeName: entry.tradeName, action: alreadyHas ? 'already_exists' : 'updated' });
      } else {
        await prisma.contractor.create({
          data: {
            name: entry.legalName,
            nip: entry.nip,
            type: 'BUSINESS',
            country: entry.country,
            source: 'manual',
            tags: ['sofarma', 'pharmacy'],
            extras: { tradeName: entry.tradeName, street: entry.street, postCode: entry.postCode, city: entry.city, locations: [location] },
          },
        });
        results.push({ nip: entry.nip, name: entry.legalName, tradeName: entry.tradeName, action: 'created' });
      }
    }

    res.json({ ok: true, results });
  } catch (e) {
    console.error('[jpk] seed-sofarma error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
