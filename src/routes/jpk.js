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

function stripCompanySuffix(str) {
  return normalize(str)
    .replace(/\b(unipessoal|lda|slu|s\.?l\.?u?|s\.?a\.?|sarl|gmbh|sp\.?\s*z\.?\s*o\.?\s*o\.?|limited|ltd|inc|e\.?u\.?|eireli|srl|snc|comercio e distribuicao)\b/gi, '')
    .replace(/[,.\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeSpaces(str) {
  return normalize(str).replace(/\s+/g, '');
}

function getWords(str) {
  return normalize(str).split(' ').filter(w => w.length >= 2);
}

function countCommonWords(a, b) {
  const wordsA = getWords(a);
  const wordsB = getWords(b);
  return wordsA.filter(w => wordsB.includes(w)).length;
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
    console.log('[jpk] GlobKurier raw response (first 500 chars):', JSON.stringify(ordersData).substring(0, 500));

    const allOrders = (ordersData && ordersData.results) ? ordersData.results
      : (ordersData && ordersData.items) ? ordersData.items
      : (ordersData && ordersData.data) ? ordersData.data
      : Array.isArray(ordersData) ? ordersData
      : [];

    // Filter: date range (invoice month + next month) and non-Poland receiver
    const filterFrom = dataOd;
    const nextMonthEnd = new Date(y, m + 1, 0, 23, 59, 59, 999); // last day of next month
    const filteredOrders = allOrders.filter(order => {
      const creationDate = new Date(order.creationDate || order.created_at || order.createdAt || 0);
      if (creationDate < filterFrom || creationDate > nextMonthEnd) return false;
      const receiver = order.receiverAddress || order.receiver || {};
      if (receiver.countryId === 1 || receiver.country_id === 1) return false; // skip Poland
      return true;
    });

    // 3. MATCHING
    const availableOrders = [...filteredOrders];
    const matched = [];
    const unmatchedInvoices = [];

    for (const inv of invoiceItems) {
      let bestMatch = null;
      let bestMatchBy = null;
      let bestIdx = -1;

      // Priority order for match quality
      const MATCH_PRIORITY = ['exact_name', 'fuzzy_name', 'compound_name', 'stripped_name', 'substring_name', 'fuzzy_stripped', 'address', 'postal_code'];

      function isBetterMatch(newMatchBy, currentMatchBy) {
        if (!currentMatchBy) return true;
        return MATCH_PRIORITY.indexOf(newMatchBy) < MATCH_PRIORITY.indexOf(currentMatchBy);
      }

      for (let i = 0; i < availableOrders.length; i++) {
        const order = availableOrders[i];
        const receiver = order.receiverAddress || order.receiver || {};
        const receiverName = receiver.name || '';
        const contactPerson = receiver.contactPerson || receiver.contact_person || '';
        const receiverStreet = receiver.street || '';
        const receiverPostal = receiver.postalCode || receiver.postal_code || receiver.zipCode || '';

        const normContractor = normalize(inv.contractor);
        const normRecvName = normalize(receiverName);
        const normContact = normalize(contactPerson);

        // 1) EXACT name match
        if (normContractor && (normContractor === normRecvName || normContractor === normContact)) {
          bestMatch = order; bestMatchBy = 'exact_name'; bestIdx = i;
          break;
        }

        // 2) FUZZY: >= 2 common words
        const commonName = Math.max(countCommonWords(inv.contractor, receiverName), countCommonWords(inv.contractor, contactPerson));
        if (commonName >= 2 && isBetterMatch('fuzzy_name', bestMatchBy)) {
          bestMatch = order; bestMatchBy = 'fuzzy_name'; bestIdx = i;
          continue;
        }

        // 3) COMPOUND: "HONESTMOLECULE" === "honest molecule" after removeSpaces
        const compContractor = removeSpaces(stripCompanySuffix(inv.contractor));
        const compRecv = removeSpaces(stripCompanySuffix(receiverName));
        const compContact = removeSpaces(stripCompanySuffix(contactPerson));
        if (compContractor.length >= 5 && (compContractor === compRecv || compContractor === compContact)) {
          if (isBetterMatch('compound_name', bestMatchBy)) {
            bestMatch = order; bestMatchBy = 'compound_name'; bestIdx = i;
            continue;
          }
        }

        // 4) STRIPPED: exact match after removing company suffixes
        const strContractor = stripCompanySuffix(inv.contractor);
        const strRecv = stripCompanySuffix(receiverName);
        const strContact = stripCompanySuffix(contactPerson);
        if (strContractor.length >= 5 && (strContractor === strRecv || strContractor === strContact)) {
          if (isBetterMatch('stripped_name', bestMatchBy)) {
            bestMatch = order; bestMatchBy = 'stripped_name'; bestIdx = i;
            continue;
          }
        }

        // 5) SUBSTRING: one stripped name contains the other (min 5 chars)
        if (strContractor.length >= 5 && strRecv.length >= 5) {
          if (strContractor.includes(strRecv) || strRecv.includes(strContractor)) {
            if (isBetterMatch('substring_name', bestMatchBy)) {
              bestMatch = order; bestMatchBy = 'substring_name'; bestIdx = i;
              continue;
            }
          }
        }
        if (strContractor.length >= 5 && strContact.length >= 5) {
          if (strContractor.includes(strContact) || strContact.includes(strContractor)) {
            if (isBetterMatch('substring_name', bestMatchBy)) {
              bestMatch = order; bestMatchBy = 'substring_name'; bestIdx = i;
              continue;
            }
          }
        }

        // 6) FUZZY STRIPPED: >= 2 common words after stripping suffixes
        const commonStripped = Math.max(countCommonWords(strContractor, strRecv), countCommonWords(strContractor, strContact));
        if (commonStripped >= 2 && isBetterMatch('fuzzy_stripped', bestMatchBy)) {
          bestMatch = order; bestMatchBy = 'fuzzy_stripped'; bestIdx = i;
          continue;
        }

        // 7) ADDRESS match
        if (inv.contractorAddress && receiverStreet) {
          const normAddr = normalize(inv.contractorAddress);
          const normRecv2 = normalize(receiverStreet);
          if (normAddr && normRecv2 && (normAddr.includes(normRecv2) || normRecv2.includes(normAddr))) {
            if (isBetterMatch('address', bestMatchBy)) {
              bestMatch = order; bestMatchBy = 'address'; bestIdx = i;
              continue;
            }
          }
        }

        // 8) POSTAL CODE match
        if (inv.contractorPostCode && receiverPostal) {
          const normPost = inv.contractorPostCode.replace(/\s/g, '');
          const normRecvPost = receiverPostal.replace(/\s/g, '');
          if (normPost && normRecvPost && normPost === normRecvPost) {
            if (isBetterMatch('postal_code', bestMatchBy)) {
              bestMatch = order; bestMatchBy = 'postal_code'; bestIdx = i;
            }
          }
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
          matchedBy: bestMatchBy,
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

    const period = `${y}-${String(m).padStart(2, '0')}`;
    console.log(`[jpk] WDT invoices: ${invoiceItems.length}, GlobKurier orders: ${filteredOrders.length}, Matched: ${matched.length}`);

    res.json({
      ok: true,
      period,
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
