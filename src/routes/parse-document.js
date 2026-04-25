'use strict';

const router = require('express').Router();
const multer = require('multer');
const https = require('https');

const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

// ============ HELPERS ============

function httpsRequest(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: { ...headers },
    };
    if (body && !headers['Content-Length']) {
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpsGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : require('http');
    const follow = (u, redirects) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      mod.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location, redirects + 1);
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    };
    follow(url, 0);
  });
}

// ============ TEXT EXTRACTION ============

async function extractTextFromPdf(buffer, filename) {
  // Try pdf-parse first (local, free)
  try {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    if (result.text && result.text.trim().length > 10) {
      console.log(`[parse-doc] pdf-parse OK: ${filename}, ${result.pages || result.numpages} pages, ${result.text.length} chars`);
      return result.text;
    }
  } catch (e) {
    console.log('[parse-doc] pdf-parse failed:', e.message);
  }

  // Fallback: PDF.co API
  const pdfcoKey = (process.env.PDFCO_API_KEY || '').trim();
  if (!pdfcoKey) {
    // Fallback: Claude vision on PDF rendered as image — not ideal, return what we have
    console.log('[parse-doc] No PDFCO_API_KEY, returning raw pdf-parse result');
    return '[PDF text extraction failed — no PDFCO_API_KEY set]';
  }

  console.log(`[parse-doc] Using PDF.co for: ${filename}`);

  // Upload file
  const uploadResp = await httpsRequest(
    `https://api.pdf.co/v1/file/upload/base64`,
    'POST',
    { 'x-api-key': pdfcoKey, 'Content-Type': 'application/json' },
    JSON.stringify({ file: buffer.toString('base64'), name: filename })
  );

  if (uploadResp.status !== 200 || !uploadResp.body.url) {
    throw new Error('PDF.co upload failed: ' + JSON.stringify(uploadResp.body).slice(0, 300));
  }

  // Convert to text
  const convertResp = await httpsRequest(
    'https://api.pdf.co/v1/pdf/convert/to/text',
    'POST',
    { 'x-api-key': pdfcoKey, 'Content-Type': 'application/json' },
    JSON.stringify({ url: uploadResp.body.url, inline: true, async: false })
  );

  if (convertResp.status !== 200 || convertResp.body.error) {
    throw new Error('PDF.co convert failed: ' + JSON.stringify(convertResp.body).slice(0, 300));
  }

  const text = typeof convertResp.body.body === 'string' ? convertResp.body.body : (convertResp.body.text || '');
  console.log(`[parse-doc] PDF.co OK: ${text.length} chars`);
  return text;
}

async function extractTextFromImage(buffer, mimeType, filename) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!validTypes.includes(mimeType)) {
    throw new Error(`Unsupported image type: ${mimeType}. Supported: ${validTypes.join(', ')}`);
  }

  console.log(`[parse-doc] Using Claude Vision for: ${filename} (${mimeType})`);

  const resp = await httpsRequest(
    'https://api.anthropic.com/v1/messages',
    'POST',
    { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } },
          { type: 'text', text: 'Wyciągnij cały tekst z tego obrazu. Zwróć TYLKO tekst, bez komentarzy.' },
        ],
      }],
    })
  );

  if (resp.status !== 200) {
    throw new Error('Claude Vision failed: ' + JSON.stringify(resp.body).slice(0, 300));
  }

  const text = resp.body.content && resp.body.content[0] && resp.body.content[0].text || '';
  console.log(`[parse-doc] Claude Vision OK: ${text.length} chars`);
  return text;
}

// ============ ORDER PARSING ============

async function parseOrder(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const prompt = `Z poniższego tekstu zamówienia wyciągnij strukturę w JSON:

${text}

Odpowiedz TYLKO czystym JSON (bez markdown, bez komentarzy):
{
  "customer": { "name": null, "nip": null, "address": null, "city": null, "postCode": null, "country": null, "email": null },
  "items": [{ "name": "stick", "variant": "blue", "qty": 10, "priceNetto": null }],
  "notes": null
}

Dla produktów surfstickbell rozpoznaj: surf stick + kolor (blue/pink/purple/mint/white/skin), mascara + kolor (blue/mint/pink/black), gel, daily, care, lips.
Jeśli pole nie występuje — null. Ilości jako liczby. Ceny jako liczby (bez walut).`;

  const resp = await httpsRequest(
    'https://api.anthropic.com/v1/messages',
    'POST',
    { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    })
  );

  if (resp.status !== 200) {
    throw new Error('Claude parse failed: ' + JSON.stringify(resp.body).slice(0, 300));
  }

  const llmText = resp.body.content && resp.body.content[0] && resp.body.content[0].text || '';
  const cleanJson = llmText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleanJson);
}

// ============ MAIN ENDPOINT ============

router.post('/parse-document', upload.single('file'), async (req, res) => {
  try {
    let buffer, filename, mimeType;

    // Source 1: multipart file upload
    if (req.file) {
      buffer = req.file.buffer;
      filename = req.file.originalname;
      mimeType = req.file.mimetype;
    }
    // Source 2: JSON with URL
    else if (req.body && req.body.url) {
      console.log('[parse-doc] Fetching from URL:', req.body.url);
      buffer = await httpsGetBuffer(req.body.url);
      filename = req.body.filename || 'download';
      mimeType = req.body.mimeType || (filename.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
    }
    // Source 3: JSON with base64
    else if (req.body && req.body.base64) {
      buffer = Buffer.from(req.body.base64, 'base64');
      filename = req.body.filename || 'upload';
      mimeType = req.body.mimeType || (filename.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
    }
    else {
      return res.status(400).json({ error: 'Provide file (multipart), url, or base64' });
    }

    console.log(`[parse-doc] Processing: ${filename} (${mimeType}, ${Math.round(buffer.length / 1024)} KB)`);

    // Detect mime from extension if generic
    if (mimeType === 'application/octet-stream') {
      const ext = (filename.split('.').pop() || '').toLowerCase();
      const mimeMap = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain', csv: 'text/plain' };
      mimeType = mimeMap[ext] || mimeType;
    }

    // Extract text
    let extractedText = '';
    if (mimeType === 'application/pdf') {
      extractedText = await extractTextFromPdf(buffer, filename);
    } else if (mimeType.startsWith('image/')) {
      extractedText = await extractTextFromImage(buffer, mimeType, filename);
    } else if (mimeType === 'text/plain') {
      extractedText = buffer.toString('utf-8');
    } else {
      return res.status(400).json({ error: `Unsupported file type: ${mimeType}. Supported: PDF, images (jpg/png/gif/webp), text.` });
    }

    // Parse as order if requested
    const parseAs = req.query.parseAs || (req.body && req.body.parseAs);
    let parsedData = null;
    if (parseAs === 'order' && extractedText && extractedText.length > 10) {
      try {
        parsedData = await parseOrder(extractedText);
        console.log('[parse-doc] Order parsed:', JSON.stringify(parsedData).slice(0, 200));
      } catch (e) {
        console.error('[parse-doc] Order parse failed:', e.message);
        parsedData = { error: e.message };
      }
    }

    res.json({
      ok: true,
      filename,
      mimeType,
      size: buffer.length,
      text: extractedText,
      data: parsedData,
    });
  } catch (e) {
    console.error('[parse-doc] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
