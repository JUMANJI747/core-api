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

    const allOrders = Array.isArray(ordersResp.body) ? ordersResp.body
      : (ordersResp.body && ordersResp.body.items) ? ordersResp.body.items
      : (ordersResp.body && ordersResp.body.data) ? ordersResp.body.data
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

      for (let i = 0; i < availableOrders.length; i++) {
        const order = availableOrders[i];
        const receiver = order.receiverAddress || order.receiver || {};
        const receiverName = receiver.name || '';
        const contactPerson = receiver.contactPerson || receiver.contact_person || '';
        const receiverStreet = receiver.street || '';
        const receiverPostal = receiver.postalCode || receiver.postal_code || receiver.zipCode || '';

        // a) EXACT name match
        const normContractor = normalize(inv.contractor);
        if (normContractor && (normContractor === normalize(receiverName) || normContractor === normalize(contactPerson))) {
          bestMatch = order;
          bestMatchBy = 'exact_name';
          bestIdx = i;
          break;
        }

        // b) FUZZY: >= 2 common words
        const commonName = Math.max(countCommonWords(inv.contractor, receiverName), countCommonWords(inv.contractor, contactPerson));
        if (commonName >= 2 && !bestMatch) {
          bestMatch = order;
          bestMatchBy = 'fuzzy_name';
          bestIdx = i;
          continue;
        }

        // c) ADDRESS match
        if (inv.contractorAddress && receiverStreet) {
          const normAddr = normalize(inv.contractorAddress);
          const normRecv = normalize(receiverStreet);
          if (normAddr && normRecv && (normAddr.includes(normRecv) || normRecv.includes(normAddr))) {
            if (!bestMatch || bestMatchBy === 'postal_code') {
              bestMatch = order;
              bestMatchBy = 'address';
              bestIdx = i;
              continue;
            }
          }
        }

        // d) POSTAL CODE match
        if (inv.contractorPostCode && receiverPostal) {
          const normPost = inv.contractorPostCode.replace(/\s/g, '');
          const normRecvPost = receiverPostal.replace(/\s/g, '');
          if (normPost && normRecvPost && normPost === normRecvPost) {
            if (!bestMatch) {
              bestMatch = order;
              bestMatchBy = 'postal_code';
              bestIdx = i;
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
