'use strict';
/**
 * tasks.js — ZADANIA / KALENDARZ.
 *
 * Powód (18.09.2026): klienci coraz częściej piszą „wyślijcie za półtora
 * miesiąca" albo „odezwijcie się w połowie listopada". Po kilku tygodniach nie
 * da się odkopać ani tego maila, ani adresu, ani tego, co chcieli. Zadanie
 * trzyma to wszystko w jednym miejscu: termin, link do maila źródłowego, adres
 * nadawcy, kontrahenta i opis.
 *
 *   GET    /api/tasks?status=open|done|all&from=&to=   lista (patrz sortowanie)
 *   POST   /api/tasks                                   nowe zadanie (ręcznie / z AI)
 *   PATCH  /api/tasks/:id                               edycja; status DONE ustawia completedAt
 *   DELETE /api/tasks/:id
 *   POST   /api/tasks/from-email { emailId }            PROPOZYCJA zadania z maila (AI)
 *
 * Sortowanie listy otwartych: zadania BEZ terminu na samej górze (najnowsze
 * pierwsze), potem terminowe chronologicznie. Tak chciał użytkownik: bez daty
 * = „do ogarnięcia kiedyś", ma być widoczne, nie zakopane na końcu.
 *
 * Termin trzymamy jako DATĘ DNIA. Wejście „2026-11-15" zapisujemy jako
 * południe UTC, żeby ani przeglądarka w Polsce, ani serwer w innej strefie nie
 * przesunęły dnia o jeden.
 *
 * /from-email NICZEGO nie zapisuje — zwraca propozycję, którą użytkownik widzi
 * w formularzu i zatwierdza. Model potrafi źle policzyć „za półtora miesiąca",
 * a zapisane po cichu złe zadanie jest gorsze niż jedno kliknięcie więcej.
 */

const router = require('express').Router();
const asyncHandler = require('../asyncHandler');

const MODEL = process.env.TASK_MODEL || 'claude-haiku-4-5-20251001';

/** „2026-11-15" → Date w południe UTC; pełne ISO → jak jest; śmieci → null. */
function parseDueDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T12:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function toPublic(t) {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null,
    status: t.status,
    contractorId: t.contractorId,
    contractorName: t.contractor ? t.contractor.name : null,
    emailId: t.emailId,
    emailAddress: t.emailAddress,
    contactName: t.contactName,
    source: t.source,
    extras: t.extras || {},
    createdAt: t.createdAt,
    completedAt: t.completedAt,
  };
}

const INCLUDE = { contractor: { select: { id: true, name: true } } };

router.get('/', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const status = String(req.query.status || 'open').toLowerCase();
  const where = {};
  if (status === 'open') where.status = 'OPEN';
  else if (status === 'done') where.status = 'DONE';
  const from = parseDueDate(req.query.from);
  const to = parseDueDate(req.query.to);
  if (from || to) {
    where.dueDate = {};
    if (from) where.dueDate.gte = from;
    if (to) where.dueDate.lte = to;
  }
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 500));
  const rows = await prisma.task.findMany({ where, include: INCLUDE, take: limit });

  // Sortowanie w JS, nie w SQL: chodzi o „NULL na górze", a to w Prisma zależy
  // od bazy i wersji. Wolumen to dziesiątki wierszy, nie tysiące.
  rows.sort((a, b) => {
    if (status === 'done') return (b.completedAt || b.updatedAt) - (a.completedAt || a.updatedAt);
    const ad = a.dueDate ? a.dueDate.getTime() : null;
    const bd = b.dueDate ? b.dueDate.getTime() : null;
    if (ad == null && bd == null) return b.createdAt - a.createdAt; // bez terminu: najnowsze pierwsze
    if (ad == null) return -1;                                       // bez terminu przed terminowymi
    if (bd == null) return 1;
    return ad - bd;                                                  // terminowe chronologicznie
  });
  res.json({ ok: true, tasks: rows.map(toPublic) });
}));

router.post('/', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ ok: false, error: 'title required' });
  const data = {
    title: title.slice(0, 200),
    description: b.description ? String(b.description).slice(0, 4000) : null,
    dueDate: parseDueDate(b.dueDate),
    contractorId: b.contractorId ? String(b.contractorId) : null,
    emailId: b.emailId ? String(b.emailId) : null,
    emailAddress: b.emailAddress ? String(b.emailAddress).trim().toLowerCase().slice(0, 200) : null,
    contactName: b.contactName ? String(b.contactName).slice(0, 200) : null,
    source: ['manual', 'ai', 'agent'].includes(b.source) ? b.source : 'manual',
    extras: (b.extras && typeof b.extras === 'object') ? b.extras : {},
  };
  // Kontrahent musi istnieć — zły id z LLM nie może wywrócić zapisu zadania.
  if (data.contractorId) {
    const c = await prisma.contractor.findUnique({ where: { id: data.contractorId }, select: { id: true } }).catch(() => null);
    if (!c) data.contractorId = null;
  }
  const t = await prisma.task.create({ data, include: INCLUDE });
  res.json({ ok: true, task: toPublic(t) });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const b = req.body || {};
  const data = {};
  if (b.title != null) {
    const t = String(b.title).trim();
    if (!t) return res.status(400).json({ ok: false, error: 'title cannot be empty' });
    data.title = t.slice(0, 200);
  }
  if ('description' in b) data.description = b.description ? String(b.description).slice(0, 4000) : null;
  if ('dueDate' in b) data.dueDate = parseDueDate(b.dueDate);
  if ('emailAddress' in b) data.emailAddress = b.emailAddress ? String(b.emailAddress).trim().toLowerCase().slice(0, 200) : null;
  if ('contactName' in b) data.contactName = b.contactName ? String(b.contactName).slice(0, 200) : null;
  if ('contractorId' in b) data.contractorId = b.contractorId ? String(b.contractorId) : null;
  if (b.status === 'DONE' || b.status === 'OPEN') {
    data.status = b.status;
    data.completedAt = b.status === 'DONE' ? new Date() : null;
  }
  if (b.extras && typeof b.extras === 'object') data.extras = b.extras;
  const t = await prisma.task.update({ where: { id: req.params.id }, data, include: INCLUDE });
  res.json({ ok: true, task: toPublic(t) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  await prisma.task.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
}));

/* PROPOZYCJA ZADANIA Z MAILA.
 * Model dostaje mail + dzisiejszą datę + datę maila i ma ODDAĆ datę
 * BEZWZGLĘDNĄ (YYYY-MM-DD). „Za półtora miesiąca" liczy się od daty MAILA,
 * nie od dziś — klient pisał wtedy, nie teraz. „Połowa listopada" = 15.11
 * najbliższego listopada. Bez żadnej wzmianki o czasie → null (zadanie bez
 * terminu, ląduje na górze listy). */
router.post('/from-email', asyncHandler(async (req, res) => {
  const prisma = req.app.locals.prisma;
  const emailId = String((req.body || {}).emailId || '').trim();
  if (!emailId) return res.status(400).json({ ok: false, error: 'emailId required' });
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) return res.status(503).json({ ok: false, error: 'ANTHROPIC_API_KEY not set' });

  const email = await prisma.email.findUnique({
    where: { id: emailId },
    include: { contractor: { select: { id: true, name: true } } },
  });
  if (!email) return res.status(404).json({ ok: false, error: 'email not found' });

  const dzis = new Date().toISOString().slice(0, 10);
  const dataMaila = email.createdAt.toISOString().slice(0, 10);
  const tresc = String(email.bodyFull || email.bodyPreview || '').replace(/\s+/g, ' ').trim().slice(0, 5000);
  const nadawca = email.fromName ? `${email.fromName} <${email.fromEmail}>` : email.fromEmail;

  const userPrompt = `Z ponizszego maila zrob JEDNO zadanie do kalendarza handlowca. Zwroc TYLKO JSON:
{"title": string, "dueDate": "YYYY-MM-DD"|null, "dueDateReason": string|null, "description": string, "items": [{"name": string, "qty": number|null}]}

Zasady:
- title: krotko, po polsku, konkretnie, np. "Wyslac zamowienie: Surf Stick x40 — Pozo Winds". Max 100 znakow.
- dueDate: data BEZWZGLEDNA. Dzisiaj jest ${dzis}, mail przyszedl ${dataMaila}. Wzgledne okresy ("za 6 tygodni", "za poltora miesiaca") licz OD DATY MAILA. "Polowa listopada" = 15 dzien najblizszego listopada. "Poczatek grudnia" = 1 grudnia. "Koniec pazdziernika" = ostatni dzien. Gdy w mailu NIE MA zadnej wzmianki o czasie — null.
- dueDateReason: cytat lub parafraza fragmentu, z ktorego wzieta jest data (np. "prosi o wysylke za 1,5 miesiaca"), albo null.
- description: co klient chce (produkty, ilosci, warunki, na co czeka), 1-3 zdania po polsku. Bez powtarzania adresu.
- items: pozycje jesli sa; puste [] jesli brak.

Mail:
Od: ${nadawca}
Temat: ${email.subject || ''}
Data: ${dataMaila}
---
${tresc}
---`;

  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey, maxRetries: 3 });
  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: 'Jestes asystentem handlowca. Zwracasz TYLKO JSON, bez komentarzy ani markdownu.',
    messages: [{ role: 'user', content: userPrompt }],
  });
  const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
  }
  if (!parsed || typeof parsed !== 'object') {
    return res.json({ ok: false, error: 'model nie zwrocil poprawnego JSON', raw: text.slice(0, 300) });
  }

  const dueDate = parseDueDate(parsed.dueDate);
  const items = Array.isArray(parsed.items)
    ? parsed.items.filter(i => i && i.name).map(i => ({ name: String(i.name).slice(0, 120), qty: i.qty != null ? Number(i.qty) : null }))
    : [];
  res.json({
    ok: true,
    proposal: {
      title: String(parsed.title || email.subject || 'Zadanie z maila').slice(0, 200),
      description: String(parsed.description || '').slice(0, 4000),
      dueDate: dueDate ? dueDate.toISOString().slice(0, 10) : null,
      emailId: email.id,
      emailAddress: email.fromEmail || null,
      contactName: email.fromName || null,
      contractorId: email.contractor ? email.contractor.id : null,
      contractorName: email.contractor ? email.contractor.name : null,
      source: 'ai',
      extras: {
        subject: email.subject || null,
        dueDateReason: parsed.dueDateReason || null,
        items,
      },
    },
  });
}));

module.exports = router;
