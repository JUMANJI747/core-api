'use strict';

const router = require('express').Router();

const API_KEY = (process.env.API_KEY || '').trim();

function isAuthed(req) {
  if (!API_KEY) return true;
  const k = String(req.query.key || '').trim();
  return k === API_KEY;
}

// 300m random jitter on a disk around (lat,lng). New value every request —
// the goal is anonymisation, not stability.
function jitter300m(lat, lng) {
  const r = 300; // meters
  const angle = Math.random() * 2 * Math.PI;
  const dist = Math.sqrt(Math.random()) * r; // uniform on disk
  const dLat = (dist * Math.cos(angle)) / 111111;
  const dLng = (dist * Math.sin(angle)) / (111111 * Math.cos((lat * Math.PI) / 180));
  return [lat + dLat, lng + dLng];
}

router.get('/map-data', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const authed = isAuthed(req);
  try {
    const contractors = await prisma.contractor.findMany({
      where: { lat: { not: null }, lng: { not: null }, geocodingStatus: 'ok' },
      select: {
        id: true, name: true, lat: true, lng: true,
        ...(authed ? { address: true, city: true, country: true, phone: true, email: true } : {}),
      },
    });

    let invoiceById = new Map();
    let openTxById = new Map();
    if (authed) {
      const ids = contractors.map(c => c.id);
      const lastInvoices = await prisma.$queryRaw`
        SELECT DISTINCT ON ("contractorId") "contractorId", "number", "issueDate", "grossAmount", "currency"
        FROM "Invoice"
        WHERE "contractorId" = ANY(${ids})
        ORDER BY "contractorId", "issueDate" DESC
      `;
      lastInvoices.forEach(r => invoiceById.set(r.contractorId, r));

      const openCounts = await prisma.transaction.groupBy({
        by: ['contractorId'],
        where: { contractorId: { in: ids }, OR: [{ hasPayment: false }, { hasDelivered: false }] },
        _count: { _all: true },
      });
      openCounts.forEach(r => openTxById.set(r.contractorId, r._count._all));
    }

    const features = contractors.map(c => {
      const [lat, lng] = authed ? [c.lat, c.lng] : jitter300m(c.lat, c.lng);
      const props = authed
        ? {
            id: c.id,
            name: c.name,
            address: c.address || null,
            city: c.city || null,
            country: c.country || null,
            phone: c.phone || null,
            email: c.email || null,
            lastInvoice: invoiceById.has(c.id) ? {
              number: invoiceById.get(c.id).number,
              date: invoiceById.get(c.id).issueDate,
              amount: invoiceById.get(c.id).grossAmount,
              currency: invoiceById.get(c.id).currency,
            } : null,
            openTransactions: openTxById.get(c.id) || 0,
          }
        : {};
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props };
    });

    res.json({ type: 'FeatureCollection', features, mode: authed ? 'private' : 'public' });
  } catch (e) {
    console.error('[map-data] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/map', (req, res) => {
  res.type('html').send(MAP_HTML);
});

const MAP_HTML = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Klienci — mapa</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css">
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css">
<style>
  html, body, #map { height: 100%; margin: 0; padding: 0; }
  .popup { font: 14px -apple-system, sans-serif; line-height: 1.4; }
  .popup b { display: block; margin-bottom: 4px; }
  .popup a { color: #06c; text-decoration: none; }
  .popup .badge { display: inline-block; padding: 1px 6px; margin-right: 6px;
                  border-radius: 10px; background: #eee; font-size: 12px; }
  .popup .open { background: #fde68a; }
</style>
</head>
<body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
<script>
(async function () {
  const params = new URLSearchParams(window.location.search);
  const key = params.get('key');
  const dataUrl = '/map-data' + (key ? ('?key=' + encodeURIComponent(key)) : '');

  const map = L.map('map').setView([47, 10], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  const cluster = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 60 });

  let data;
  try { data = await (await fetch(dataUrl)).json(); }
  catch (e) { alert('Błąd ładowania danych: ' + e.message); return; }

  const isPrivate = data.mode === 'private';

  (data.features || []).forEach(f => {
    const [lng, lat] = f.geometry.coordinates;
    const m = L.marker([lat, lng]);
    if (isPrivate) {
      const p = f.properties;
      const addr = [p.address, p.city, p.country].filter(Boolean).join(', ');
      const gmaps = addr ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr) : null;
      let html = '<div class="popup"><b>' + escapeHtml(p.name) + '</b>';
      if (addr) html += escapeHtml(addr) + '<br>';
      if (p.phone) html += '☎ ' + escapeHtml(p.phone) + '<br>';
      if (p.email) html += '✉ ' + escapeHtml(p.email) + '<br>';
      if (p.lastInvoice) {
        const li = p.lastInvoice;
        const d = li.date ? new Date(li.date).toISOString().slice(0,10) : '';
        html += '<span class="badge">FV ' + escapeHtml(li.number) + ' · ' + d + ' · ' + li.amount + ' ' + li.currency + '</span>';
      }
      if (p.openTransactions > 0) {
        html += '<span class="badge open">' + p.openTransactions + ' otwartych</span>';
      }
      if (gmaps) html += '<br><a href="' + gmaps + '" target="_blank">→ Otwórz w Google Maps</a>';
      html += '</div>';
      m.bindPopup(html);
    }
    cluster.addLayer(m);
  });

  map.addLayer(cluster);

  if (cluster.getLayers().length > 0) {
    try { map.fitBounds(cluster.getBounds(), { padding: [40, 40] }); }
    catch (_) { /* single point or empty */ }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
})();
</script>
</body>
</html>`;

module.exports = router;
