'use strict';

const router = require('express').Router();
const asyncHandler = require('../asyncHandler');
const { extractTextFromPdf, extractTextFromImage } = require('./parse-document');

// Faktury kosztowe RĘCZNE / z UPLOADU (model CostInvoice) + KSeF (KsefCostInvoice).
// PL: KSeF (auto) + ręczne. Kanary (ES): tylko ręczne / z dokumentu.

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}
function defCurrency(region, given) {
  return str(given) || (region === 'es' ? 'EUR' : 'PLN');
}
function stripDataUrl(b64) {
  if (!b64) return '';
  const i = b64.indexOf('base64,');
  return i >= 0 ? b64.slice(i + 7) : b64;
}
function guessMime(fileName, mimeType) {
  if (mimeType && mimeType !== 'application/octet-stream') return mimeType;
  const ext = (String(fileName || '').split('.').pop() || '').toLowerCase();
  const map = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
  return map[ext] || mimeType || 'application/octet-stream';
}

// Odczyt faktury kosztowej przez Anthropic — z tekstu (PDF/obraz) → JSON pól.
async function parseCostInvoice(text, region) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const langHint = region === 'es'
    ? 'To faktura hiszpańska (Kanary, IGIC zamiast VAT). NIP sprzedawcy to NIF/CIF.'
    : 'To faktura polska. NIP sprzedawcy to polski NIP.';
  const prompt = `Z poniższego tekstu faktury KOSZTOWEJ (jesteśmy NABYWCĄ) wyciągnij dane sprzedawcy i kwoty.
${langHint}

TEKST FAKTURY:
${text.slice(0, 12000)}

Odpowiedz TYLKO czystym JSON (bez markdown, bez komentarzy):
{
  "invoiceNumber": null,
  "issueDate": null,
  "sellerName": null,
  "sellerNip": null,
  "netAmount": null,
  "vatAmount": null,
  "grossAmount": null,
  "currency": null
}

Zasady: issueDate w formacie YYYY-MM-DD. Kwoty jako liczby (kropka dziesiętna, bez waluty i spacji).
sellerName = nazwa wystawcy faktury (sprzedawcy), NIE nabywcy. currency np. PLN albo EUR.
Jeśli pole nie występuje — null.`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  const out = (msg.content && msg.content[0] && msg.content[0].text) || '';
  const clean = out.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(clean);
}

async function extractText(buffer, fileName, mimeType) {
  const mime = guessMime(fileName, mimeType);
  if (mime === 'application/pdf') return extractTextFromPdf(buffer, fileName);
  if (mime.startsWith('image/')) return extractTextFromImage(buffer, mime, fileName);
  if (mime === 'text/plain') return buffer.toString('utf-8');
  throw new Error(`Nieobsługiwany typ pliku: ${mime} (obsługiwane: PDF, JPG, PNG).`);
}

// Lista kosztów dla regionu: PL = ręczne + KSeF, ES = ręczne. Znormalizowane.
router.get('/costs', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const region = req.query.region === 'es' ? 'es' : 'pl';
  const search = str(req.query.search);
  const items = [];

  const manualWhere = { region };
  if (search) manualWhere.OR = [
    { sellerName: { contains: search, mode: 'insensitive' } },
    { sellerNip: { contains: search } },
    { invoiceNumber: { contains: search, mode: 'insensitive' } },
  ];
  const manual = await prisma.costInvoice.findMany({
    where: manualWhere, orderBy: { issueDate: 'desc' }, take: 5000,
    select: { id: true, source: true, invoiceNumber: true, issueDate: true, sellerName: true, sellerNip: true, netAmount: true, vatAmount: true, grossAmount: true, currency: true, note: true, fileName: true },
  });
  for (const m of manual) items.push({
    kind: 'manual', id: m.id, source: m.source,
    invoiceNumber: m.invoiceNumber, issueDate: m.issueDate, sellerName: m.sellerName, sellerNip: m.sellerNip,
    netAmount: m.netAmount, vatAmount: m.vatAmount, grossAmount: m.grossAmount, currency: m.currency || 'PLN',
    note: m.note, hasFile: !!m.fileName,
  });

  if (region === 'pl') {
    const kw = {};
    if (search) kw.OR = [
      { sellerName: { contains: search, mode: 'insensitive' } },
      { sellerNip: { contains: search } },
      { invoiceNumber: { contains: search, mode: 'insensitive' } },
    ];
    const ks = await prisma.ksefCostInvoice.findMany({
      where: kw, orderBy: { issueDate: 'desc' }, take: 5000,
      select: { id: true, invoiceNumber: true, issueDate: true, sellerName: true, sellerNip: true, netAmount: true, vatAmount: true, grossAmount: true, currency: true },
    });
    for (const k of ks) items.push({
      kind: 'ksef', id: k.id, source: 'ksef',
      invoiceNumber: k.invoiceNumber, issueDate: k.issueDate, sellerName: k.sellerName, sellerNip: k.sellerNip,
      netAmount: k.netAmount, vatAmount: k.vatAmount, grossAmount: k.grossAmount, currency: k.currency || 'PLN',
      note: null, hasFile: false,
    });
  }

  items.sort((a, b) => new Date(b.issueDate || 0).getTime() - new Date(a.issueDate || 0).getTime());
  res.json({ count: items.length, data: items });
}));

// Odczyt pliku (bez zapisu) — zwraca wyciągnięte pola do uzupełnienia formularza.
router.post('/costs/parse', asyncHandler(async (req, res) => {
  const { base64, fileName, mimeType, region } = req.body || {};
  if (!base64) return res.status(400).json({ ok: false, error: 'Brak pliku (base64).' });
  try {
    const buffer = Buffer.from(stripDataUrl(base64), 'base64');
    const text = await extractText(buffer, fileName, mimeType);
    if (!text || text.trim().length < 5) return res.json({ ok: false, error: 'Nie udało się odczytać tekstu z pliku.' });
    const data = await parseCostInvoice(text, region === 'es' ? 'es' : 'pl');
    res.json({ ok: true, data });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message });
  }
}));

// Utworzenie kosztu — ręcznie lub z dołączonym plikiem (file: {base64,fileName,mimeType}).
router.post('/costs', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const b = req.body || {};
  const region = b.region === 'es' ? 'es' : 'pl';
  let source = 'manual'; let fileName = null; let fileMime = null; let fileData = null;
  if (b.file && b.file.base64) {
    fileData = Buffer.from(stripDataUrl(b.file.base64), 'base64');
    fileName = str(b.file.fileName) || 'dokument';
    fileMime = guessMime(fileName, b.file.mimeType);
    source = 'document';
  }
  const created = await prisma.costInvoice.create({
    data: {
      region, source,
      invoiceNumber: str(b.invoiceNumber),
      issueDate: b.issueDate ? new Date(b.issueDate) : null,
      sellerName: str(b.sellerName),
      sellerNip: str(b.sellerNip),
      netAmount: num(b.netAmount), vatAmount: num(b.vatAmount), grossAmount: num(b.grossAmount),
      currency: defCurrency(region, b.currency),
      note: str(b.note),
      fileName, fileMime, fileData,
    },
    select: { id: true },
  });
  res.json({ ok: true, id: created.id });
}));

// Edycja kosztu (tylko ręczne/dokumentowe). Plik podmieniany gdy podany.
router.put('/costs/:id', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const b = req.body || {};
  const exists = await prisma.costInvoice.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!exists) return res.status(404).json({ ok: false, error: 'Nie znaleziono kosztu (KSeF-owych nie edytujemy).' });
  const data = {
    invoiceNumber: str(b.invoiceNumber),
    issueDate: b.issueDate ? new Date(b.issueDate) : null,
    sellerName: str(b.sellerName),
    sellerNip: str(b.sellerNip),
    netAmount: num(b.netAmount), vatAmount: num(b.vatAmount), grossAmount: num(b.grossAmount),
    note: str(b.note),
  };
  if (str(b.currency)) data.currency = str(b.currency);
  if (b.region === 'es' || b.region === 'pl') data.region = b.region;
  if (b.file && b.file.base64) {
    data.fileData = Buffer.from(stripDataUrl(b.file.base64), 'base64');
    data.fileName = str(b.file.fileName) || 'dokument';
    data.fileMime = guessMime(data.fileName, b.file.mimeType);
    data.source = 'document';
  }
  await prisma.costInvoice.update({ where: { id: req.params.id }, data });
  res.json({ ok: true });
}));

// Usunięcie kosztu.
router.delete('/costs/:id', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const exists = await prisma.costInvoice.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!exists) return res.status(404).json({ ok: false, error: 'Nie znaleziono kosztu.' });
  await prisma.costInvoice.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
}));

// Podgląd pliku źródłowego.
router.get('/costs/:id/file', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const c = await prisma.costInvoice.findUnique({ where: { id: req.params.id }, select: { fileData: true, fileMime: true, fileName: true } });
  if (!c || !c.fileData) return res.status(404).json({ ok: false, error: 'Brak pliku źródłowego.' });
  res.setHeader('Content-Type', c.fileMime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(c.fileName || 'dokument')}"`);
  res.send(Buffer.from(c.fileData));
}));

module.exports = router;
