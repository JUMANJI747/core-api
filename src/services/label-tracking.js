'use strict';

// Wyciąga numer trackingu KURIERA z PDF listu przewozowego GlobKurier
// (getOrderLabels). Numer bywa nadrukowany na etykiecie ZANIM GK API zacznie
// go zwracać w /orders czy /order/tracking — więc gdy "no carrier tracking
// number assigned yet", a etykieta istnieje, bierzemy numer z niej.
// Ta sama heurystyka co dotąd w glob-quote (post-order): najdłuższy token
// A-Z0-9 10-30 znaków z cyframi, z pominięciem numerów GK (GK...) i dat.
const { getOrderLabels } = require('../glob-client');

async function extractTrackingFromLabel(orderHash) {
  if (!orderHash) return null;
  try {
    const labelResp = await getOrderLabels(orderHash, 'A4');
    if (!labelResp || !labelResp.body || labelResp.body.length <= 100) return null;
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
    return tracking || null;
  } catch (e) {
    console.log('[label-tracking] PDF tracking extract failed:', e.message);
    return null;
  }
}

module.exports = { extractTrackingFromLabel };
