'use strict';

const router = require('express').Router();
const https = require('https');
const { getOrders, getOrderTracking, getOrderLabels, getReceivers } = require('../glob-client');
const { buildTrackingUrl } = require('../services/tracking-urls');
const { normalizeText } = require('./glob-helpers');

// ============ ORDERS ============

// GK /v1/orders sometimes wraps the page in `[{offset, total, limit, results}]`
// (one-element array containing a paging object) and sometimes returns the
// flat object. Accept both observed shapes — earlier we treated the wrapper
// as a 1-element list and silently dropped 100 records.
function extractOrdersResults(data) {
  if (!data) return [];
  if (Array.isArray(data) && data.length === 1 && data[0] && Array.isArray(data[0].results)) {
    return data[0].results;
  }
  if (Array.isArray(data)) return data;
  return data.results || data.items || data.data || [];
}

async function handleSearchOrders(req, res) {
  try {
    const params = { ...req.query, ...(req.body || {}) };
    const { search, status, limit = 50, offset = 0 } = params;
    const data = await getOrders({ limit: Math.min(parseInt(limit) || 50, 100), offset: parseInt(offset) || 0, status });
    let orders = extractOrdersResults(data);

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
      const trackingNumber = o.trackingNumber || o.tracking;
      const carrierName = typeof carrier === 'object' ? (carrier.name || '') : carrier;
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
        tracking: trackingNumber,
        trackingUrl: buildTrackingUrl(carrierName, trackingNumber),
        product: o.productName || (o.product && o.product.name),
        carrier: carrierName,
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
    const { hash: hashOrNumber, chatId, caption } = req.body || {};
    if (!hashOrNumber) return res.status(400).json({ ok: false, error: 'Brak hash / numeru zamówienia' });

    const tgToken = process.env.TELEGRAM_BOT_TOKEN || '8359714766:AAHHE2bStorakXZRSaxtxZl69EqJWA_GlC4';
    const tgChat = chatId || process.env.TELEGRAM_CHAT_ID || '8164528644';
    if (!tgToken || !tgChat) return res.status(500).json({ ok: false, error: 'Brak konfiguracji Telegram' });

    // Resolve hash from order number if needed. Real GK hashes are long
    // alphanumeric strings (~64 chars); human-readable numbers like
    // "GK260430978072" are short and prefixed. The agent often passes the
    // number it just got from order_shipping — translate it here.
    const looksLikeNumber = /^GK\d+$/i.test(hashOrNumber) || hashOrNumber.length < 30;
    let hash = hashOrNumber;
    if (looksLikeNumber) {
      console.log(`[glob/send-label] Looking up hash for number ${hashOrNumber}`);
      const ordersResp = await getOrders({ limit: 50 });
      const list = extractOrdersResults(ordersResp);
      const match = list.find(o => String(o.number || '').toLowerCase() === hashOrNumber.toLowerCase());
      if (match && (match.hash || match.orderHash)) {
        hash = match.hash || match.orderHash;
        console.log(`[glob/send-label] Resolved ${hashOrNumber} → ${hash.slice(0, 12)}...`);
      } else {
        console.log(`[glob/send-label] Could not resolve number ${hashOrNumber} from last ${list.length} orders`);
        return res.status(404).json({ ok: false, error: `Nie znaleziono zamówienia ${hashOrNumber} w historii GK (sprawdzono ostatnich ${list.length}).` });
      }
    }

    const result = await getOrderLabels(hash, 'A4');
    if (result.status !== 200 || !result.body || result.body.length === 0) {
      return res.status(404).json({ ok: false, error: 'Nie udało się pobrać etykiety', status: result.status });
    }
    const pdfBuffer = result.body;
    const filename = `CMR-${hash.slice(0, 16)}.pdf`;
    const captionText = caption || `List przewozowy ${hash.slice(0, 12)}...`;

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
    const items = extractOrdersResults(data);
    res.json({ ok: true, firstItemKeys: items[0] ? Object.keys(items[0]) : [], sample: items[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/glob/debug/raw-order', async (req, res) => {
  try {
    const data = await getOrders({ limit: 1 });
    const items = extractOrdersResults(data);
    res.json({ ok: true, firstItemKeys: items[0] ? Object.keys(items[0]) : [], sample: items[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
