'use strict';

const router = require('express').Router();
const https = require('https');

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
    city: inv.contractorCity || '',
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
      postCode: receiver.postalCode || receiver.postal_code || receiver.zipCode || '',
      street: receiver.street || '',
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

Jeśli po nazwie nie da się sparować, sprawdź czy pasuje miasto + kraj.

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

// ============ WDT MATCHING ============

router.get('/wdt-matching', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    // Default to PREVIOUS month
    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = parseInt(req.query.year) || prevMonth.getFullYear();
    const m = parseInt(req.query.month) || (prevMonth.getMonth() + 1);

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

    const invoiceItems = wdtInvoices.map(inv => {
      const contractorName = (inv.contractor && inv.contractor.name)
        || (inv.extras && inv.extras.kontrahentNazwa)
        || '';
      const contractorAddress = inv.contractor && inv.contractor.address || '';
      const contractorCity = inv.contractor && inv.contractor.city || '';
      const contractorExtras = inv.contractor && inv.contractor.extras || {};
      return {
        id: inv.id,
        number: inv.number,
        contractor: contractorName,
        contractorAddress,
        contractorCity,
        contractorPostCode: contractorExtras.postCode || '',
        grossAmount: inv.grossAmount,
        currency: inv.currency,
        issueDate: inv.issueDate,
        ifirmaId: inv.ifirmaId,
      };
    });

    // 2. FETCH GLOBKURIER ORDERS
    const gkEmail = (process.env.GLOBKURIER_EMAIL || '').trim();
    const gkPassword = (process.env.GLOBKURIER_PASSWORD || '').trim();
    if (!gkEmail || !gkPassword) {
      return res.json({ ok: false, error: 'GLOBKURIER_EMAIL or GLOBKURIER_PASSWORD not set' });
    }

    // Login
    const loginResp = await httpsPost('https://api.globkurier.pl/v1/auth/login', {}, {
      email: gkEmail,
      password: gkPassword,
    });
    console.log('[jpk] GlobKurier login response keys:', Object.keys(loginResp.body || {}));
    console.log('[jpk] GlobKurier token:', loginResp.body && loginResp.body.token ? loginResp.body.token.substring(0, 20) + '...' : 'NO TOKEN');
    if (loginResp.status !== 200 || !loginResp.body.token) {
      return res.status(500).json({ ok: false, error: 'GlobKurier login failed', details: loginResp.body });
    }
    const token = loginResp.body.token;

    // Fetch orders
    const ordersResp = await httpsGet('https://api.globkurier.pl/v1/orders?limit=100', {
      'X-Auth-Token': token,
      'Accept-Language': 'pl',
      'Accept': 'application/json',
    });
    if (ordersResp.status !== 200) {
      return res.status(500).json({ ok: false, error: 'GlobKurier orders fetch failed', details: ordersResp.body });
    }

    const ordersData = ordersResp.body;
    console.log('[jpk] GlobKurier raw response keys:', Object.keys(ordersData || {}));

    const allOrders = (ordersData && ordersData.results) ? ordersData.results
      : (ordersData && ordersData.items) ? ordersData.items
      : (ordersData && ordersData.data) ? ordersData.data
      : Array.isArray(ordersData) ? ordersData
      : [];

    // Filter: date range (invoice month + next month) and non-Poland receiver
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

    res.json({
      ok: true,
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
    });
  } catch (e) {
    console.error('[jpk] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
