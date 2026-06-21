'use strict';

const router = require('express').Router();
const asyncHandler = require('../asyncHandler');

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

// ===== ODCZYT FAKTURY KOSZTOWEJ (Anthropic) =====
// Strategia: PDF z warstwą tekstową → tekst wyciąga LOKALNIE pdf-parse (tanio,
// dokładnie), do LLM idzie sam tekst. PDF-skan (brak tekstu) → cały PDF do LLM
// (blok document). Obraz (JPG/PNG) → cały do LLM (blok image).
const COST_MODEL = () => process.env.COST_PARSE_MODEL || 'claude-sonnet-4-5-20250929';

function getAnthropic() {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey });
}

function costInstruction(region) {
  const langHint = region === 'es'
    ? 'To faktura hiszpańska (Kanary, IGIC zamiast VAT). NIP sprzedawcy to NIF/CIF.'
    : 'To faktura polska. NIP sprzedawcy to polski NIP.';
  return `Z faktury KOSZTOWEJ (jesteśmy NABYWCĄ) wyciągnij dane SPRZEDAWCY (wystawcy) i kwoty.
${langHint}

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
}

function parseJsonOut(msg) {
  const out = (msg.content && msg.content[0] && msg.content[0].text) || '';
  const clean = out.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(clean);
}

// Tekst → JSON (PDF z tekstem, pliki .txt).
async function parseCostInvoice(text, region) {
  const client = getAnthropic();
  const msg = await client.messages.create({
    model: COST_MODEL(), max_tokens: 1024,
    messages: [{ role: 'user', content: `${costInstruction(region)}\n\nTEKST FAKTURY:\n${String(text).slice(0, 12000)}` }],
  });
  return parseJsonOut(msg);
}

// Cały dokument (PDF-skan / obraz) → JSON (multimodalnie).
async function parseCostInvoiceFromMedia(buffer, mediaType, region) {
  const client = getAnthropic();
  const block = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } };
  const msg = await client.messages.create({
    model: COST_MODEL(), max_tokens: 1024,
    messages: [{ role: 'user', content: [block, { type: 'text', text: costInstruction(region) }] }],
  });
  return parseJsonOut(msg);
}

// Lokalne wyciągnięcie tekstu z PDF (pdf-parse). Zwraca '' gdy skan/brak tekstu.
async function extractPdfText(buffer) {
  try {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    return (result.text || '').trim();
  } catch (e) {
    console.log('[costs] pdf-parse failed:', e.message);
    return '';
  }
}

// Główne wejście: buffer → pola faktury. Wybiera tekst-LLM vs cały-dokument-LLM.
async function parseCostDocument(buffer, fileName, mimeType, region) {
  const mime = guessMime(fileName, mimeType);
  if (mime === 'application/pdf') {
    const text = await extractPdfText(buffer);
    if (text.length >= 30) return { data: await parseCostInvoice(text, region), via: 'pdf-text' };
    return { data: await parseCostInvoiceFromMedia(buffer, 'application/pdf', region), via: 'pdf-scan' };
  }
  if (mime.startsWith('image/')) {
    return { data: await parseCostInvoiceFromMedia(buffer, mime, region), via: 'image' };
  }
  if (mime === 'text/plain') {
    return { data: await parseCostInvoice(buffer.toString('utf-8'), region), via: 'text' };
  }
  throw new Error(`Nieobsługiwany typ pliku: ${mime} (obsługiwane: PDF, JPG, PNG).`);
}

// ===== DEDUPLIKACJA =====
// Klucz: numer faktury + sprzedawca. Numery faktur różnych firm mogą się
// powtarzać, więc rozróżniamy po NIP (a gdy brak — po nazwie). Sprawdzamy
// OBYDWA źródła: KSeF (KsefCostInvoice) i ręczne (CostInvoice).
const normNum = (v) => String(v || '').toLowerCase().replace(/[\s\-_/.]/g, '');
const normNip = (v) => String(v || '').replace(/\D/g, '');
const normName = (v) => String(v || '').toLowerCase().replace(/[^a-ząćęłńóśźż0-9]/gi, '');

async function findDuplicate(prisma, region, { invoiceNumber, sellerNip, sellerName }) {
  const nNum = normNum(invoiceNumber);
  if (!nNum) return null; // bez numeru nie da się rzetelnie deduplikować
  const nNip = normNip(sellerNip);
  const nName = normName(sellerName);
  const isMatch = (cand) => {
    if (normNum(cand.invoiceNumber) !== nNum) return false;
    const cNip = normNip(cand.sellerNip);
    if (nNip && cNip) return cNip === nNip;            // oba mają NIP → po NIP
    if (nName && normName(cand.sellerName)) return normName(cand.sellerName) === nName; // inaczej po nazwie
    return true; // ten sam numer, brak danych do rozróżnienia → ostrożnie: duplikat
  };
  const manual = await prisma.costInvoice.findMany({
    where: { region }, select: { id: true, invoiceNumber: true, sellerNip: true, sellerName: true },
  });
  for (const c of manual) if (isMatch(c)) return { source: 'manual', id: c.id, invoiceNumber: c.invoiceNumber, sellerName: c.sellerName };
  if (region === 'pl') {
    const ks = await prisma.ksefCostInvoice.findMany({
      select: { id: true, invoiceNumber: true, sellerNip: true, sellerName: true },
    });
    for (const c of ks) if (isMatch(c)) return { source: 'ksef', id: c.id, invoiceNumber: c.invoiceNumber, sellerName: c.sellerName };
  }
  return null;
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
    const { data, via } = await parseCostDocument(buffer, fileName, mimeType, region === 'es' ? 'es' : 'pl');
    res.json({ ok: true, data, via });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message });
  }
}));

// Zapis pojedynczego kosztu (współdzielone przez /costs i /costs/upload).
async function createCostRecord(prisma, region, fields, file) {
  let source = 'manual'; let fileName = null; let fileMime = null; let fileData = null;
  if (file && file.base64) {
    fileData = Buffer.from(stripDataUrl(file.base64), 'base64');
    fileName = str(file.fileName) || 'dokument';
    fileMime = guessMime(fileName, file.mimeType);
    source = 'document';
  }
  return prisma.costInvoice.create({
    data: {
      region, source,
      invoiceNumber: str(fields.invoiceNumber),
      issueDate: fields.issueDate ? new Date(fields.issueDate) : null,
      sellerName: str(fields.sellerName),
      sellerNip: str(fields.sellerNip),
      netAmount: num(fields.netAmount), vatAmount: num(fields.vatAmount), grossAmount: num(fields.grossAmount),
      currency: defCurrency(region, fields.currency),
      note: str(fields.note),
      fileName, fileMime, fileData,
    },
    select: { id: true },
  });
}

// Utworzenie kosztu — ręcznie lub z dołączonym plikiem (file: {base64,fileName,mimeType}).
// Sprawdza duplikat (numer + sprzedawca) w KSeF i ręcznych; force=true pomija kontrolę.
router.post('/costs', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const b = req.body || {};
  const region = b.region === 'es' ? 'es' : 'pl';
  if (!b.force) {
    const dup = await findDuplicate(prisma, region, { invoiceNumber: b.invoiceNumber, sellerNip: b.sellerNip, sellerName: b.sellerName });
    if (dup) return res.json({ ok: false, duplicate: true, existing: dup, error: `Faktura ${str(b.invoiceNumber) || ''} od „${dup.sellerName || '—'}" już istnieje (${dup.source === 'ksef' ? 'KSeF' : 'ręczna'}).` });
  }
  const created = await createCostRecord(prisma, region, b, b.file);
  res.json({ ok: true, id: created.id });
}));

// MASOWY upload jednego pliku: odczyt (Anthropic) → dedup → zapis. Front woła
// to w pętli po wielu plikach. Zwraca status: saved | duplicate | error.
router.post('/costs/upload', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { base64, fileName, mimeType, region: r, force } = req.body || {};
  const region = r === 'es' ? 'es' : 'pl';
  if (!base64) return res.json({ ok: false, status: 'error', error: 'Brak pliku.' });
  let data;
  try {
    const buffer = Buffer.from(stripDataUrl(base64), 'base64');
    ({ data } = await parseCostDocument(buffer, fileName, mimeType, region));
  } catch (e) {
    return res.json({ ok: false, status: 'error', error: e.message });
  }
  if (!force) {
    const dup = await findDuplicate(prisma, region, { invoiceNumber: data.invoiceNumber, sellerNip: data.sellerNip, sellerName: data.sellerName });
    if (dup) return res.json({ ok: true, status: 'duplicate', existing: dup, data });
  }
  try {
    const created = await createCostRecord(prisma, region, data, { base64, fileName, mimeType });
    res.json({ ok: true, status: 'saved', id: created.id, data });
  } catch (e) {
    res.json({ ok: false, status: 'error', error: e.message, data });
  }
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
