'use strict';

/* BOT TELEGRAM W KODZIE (04.10.2026) — zastępuje „Master Agent v7" (PL) i
 * „Master kanary" z n8n.
 *
 * Dlaczego: master w n8n miał własny routing i własną pamięć tekstową, nie
 * przekazywał sub-agentom historii (każde wywołanie było bezkontekstowe),
 * a każdą odpowiedź 400 z naszego backendu (np. „Nic do potwierdzenia" z
 * czytelną podpowiedzią) zamieniał w „Bad request - please check your
 * parameters" i wywracał całą turę. Tu Telegram woła TEN SAM silnik co panel
 * CRM (`uruchomAsystenta` w routes/agent.js): router → sub-agent z
 * previousTurns z tabeli Memory, „tak/ok" kontynuuje u ostatniego agenta,
 * błąd backendu wraca do usera dosłownie.
 *
 * Trasy (POZA /api — Telegram nie zna naszego x-api-key; auth = sekret
 * webhooka w nagłówku X-Telegram-Bot-Api-Secret-Token, env TELEGRAM_WEBHOOK_SECRET):
 *   POST /telegram/webhook/:scope           ← Telegram (scope: pl | kanary)
 *   GET  /telegram/webhook/:scope?secret=X  → getWebhookInfo (diagnostyka)
 *   GET  /telegram/webhook/:scope/ustaw?secret=X   → setWebhook na ten backend
 *   GET  /telegram/webhook/:scope/zdejmij?secret=X → deleteWebhook (powrót do n8n:
 *        wystarczy potem aktywować workflow w n8n — sam zarejestruje swój webhook)
 *
 * Głosówki: OpenAI Whisper (env OPENAI_API_KEY, TRANSCRIBE_MODEL). Zdjęcia i
 * PDF-y idą jako attachments do asystenta (vision / pdf-parse — jak w panelu).
 * Guziki (callback_query) → istniejący /api/telegram/callback przez selfCall.
 */

const https = require('https');
const router = require('express').Router();
const { resolveToken } = require('../services/telegram-helper');
const { sendTelegram, tgApi } = require('../telegram-utils');
const { selfCall } = require('../services/agent-runtime');
const { processSudoQuery } = require('../services/sudo-agent');

const SEKRET = () => (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const LIMIT_WIADOMOSCI_TG = 4000; // Telegram: 4096 zn. na wiadomość
const PAMIEC_TUR = 12;

// Telegram ponawia update, dopóki nie dostanie 200 — odpowiadamy od razu,
// a tu pilnujemy, żeby ten sam update_id nie poszedł do agenta dwa razy.
const widziane = new Set();
function juzBylo(id) {
  if (id == null) return false;
  if (widziane.has(id)) return true;
  widziane.add(id);
  if (widziane.size > 2000) { const first = widziane.values().next().value; widziane.delete(first); }
  return false;
}

const zakresZ = (s) => (s === 'kanary' || s === 'es') ? 'kanary' : 'pl';

function sekretOk(req) {
  const s = SEKRET();
  if (!s) return false;
  const h = String(req.headers['x-telegram-bot-api-secret-token'] || req.query.secret || '');
  return h === s;
}

// --- Telegram: pobranie pliku (getFile → file_path → download) ---
function pobierzUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} przy pobieraniu pliku`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}
async function pobierzPlikTg(token, fileId) {
  const info = await tgApi(token, 'getFile', { file_id: fileId });
  const sciezka = info && info.result && info.result.file_path;
  if (!sciezka) throw new Error('Telegram nie oddał file_path');
  const buf = await pobierzUrl(`https://api.telegram.org/file/bot${token}/${sciezka}`);
  return { buf, sciezka };
}

// --- Głosówka → tekst (OpenAI Whisper, multipart ręcznie — bez zależności) ---
function transkrybuj(buf, nazwa) {
  const key = (process.env.OPENAI_API_KEY || '').trim();
  if (!key) return Promise.reject(new Error('Brak OPENAI_API_KEY — głosówki wyłączone. Napisz tekstem.'));
  const model = process.env.TRANSCRIBE_MODEL || 'whisper-1';
  const granica = '----SsbTg' + Date.now();
  const pole = (n, v) => `--${granica}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  const naglowek = `--${granica}\r\nContent-Disposition: form-data; name="file"; filename="${nazwa}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const body = Buffer.concat([
    Buffer.from(pole('model', model) + pole('language', 'pl') + naglowek),
    buf,
    Buffer.from(`\r\n--${granica}--\r\n`),
  ]);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/audio/transcriptions', method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': `multipart/form-data; boundary=${granica}`, 'Content-Length': body.length },
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString();
        let j = null; try { j = JSON.parse(txt); } catch (_) { /* nie-JSON */ }
        if (res.statusCode >= 400 || !j) return reject(new Error(`Transkrypcja: HTTP ${res.statusCode} ${(j && j.error && j.error.message) || txt.slice(0, 160)}`));
        resolve(String(j.text || '').trim());
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Transkrypcja: timeout 60 s')); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// Długie odpowiedzi tniemy po akapitach, żeby Telegram nie odrzucił >4096 zn.
function potnij(text) {
  const out = [];
  let reszta = String(text || '');
  while (reszta.length > LIMIT_WIADOMOSCI_TG) {
    let cut = reszta.lastIndexOf('\n', LIMIT_WIADOMOSCI_TG);
    if (cut < LIMIT_WIADOMOSCI_TG / 2) cut = LIMIT_WIADOMOSCI_TG;
    out.push(reszta.slice(0, cut));
    reszta = reszta.slice(cut).replace(/^\n+/, '');
  }
  if (reszta) out.push(reszta);
  return out;
}
async function odpowiedz(token, chatId, text) {
  for (const kawalek of potnij(text || 'OK')) await sendTelegram(token, chatId, kawalek);
}

/* --- Jedna wiadomość od usera → asystent → odpowiedź --- */
async function obsluzWiadomosc(prisma, scope, msg) {
  const chatId = String((msg.chat && msg.chat.id) || (msg.from && msg.from.id) || '');
  if (!chatId) return;
  const { token } = await resolveToken(prisma, scope);
  if (!token) { console.error(`[telegram-bot] brak tokenu bota dla scope=${scope}`); return; }
  const kto = (msg.from && (msg.from.first_name || msg.from.username)) || 'User';

  try {
    tgApi(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => null);

    let text = String(msg.text || msg.caption || '').trim();
    const attachments = [];
    const opisPliku = [];

    const glos = msg.voice || msg.audio;
    if (glos && glos.file_id) {
      const { buf, sciezka } = await pobierzPlikTg(token, glos.file_id);
      const t = await transkrybuj(buf, sciezka.split('/').pop() || 'glos.ogg');
      text = `[Głosówka] ${t || '[nie udało się transkrybować]'}${text ? `\n${text}` : ''}`;
    }
    if (Array.isArray(msg.photo) && msg.photo.length) {
      const najwieksze = msg.photo[msg.photo.length - 1];
      const { buf } = await pobierzPlikTg(token, najwieksze.file_id);
      attachments.push({ filename: 'zdjecie.jpg', contentType: 'image/jpeg', contentBase64: buf.toString('base64') });
      opisPliku.push('zdjęcie');
    }
    if (msg.document && msg.document.file_id) {
      const d = msg.document;
      const { buf } = await pobierzPlikTg(token, d.file_id);
      attachments.push({ filename: d.file_name || 'plik', contentType: d.mime_type || 'application/octet-stream', contentBase64: buf.toString('base64') });
      opisPliku.push(d.file_name || 'plik');
    }
    if (!text && !attachments.length) return; // naklejka, lokalizacja itp.

    // Tryb „sudo" (jak w n8n: wiadomość zaczynająca się od xxx) — bez routera.
    if (/^xxx\b/i.test(text)) {
      const r = await processSudoQuery(text.replace(/^xxx\s*/i, ''), { chatId });
      await odpowiedz(token, chatId, (r && r.text) || JSON.stringify(r).slice(0, 1500));
      return;
    }

    // Pamięć rozmowy — ta sama tabela, z której korzystał n8n (zachowujemy
    // ciągłość historii po przełączeniu).
    const pamiec = (await prisma.memory.findMany({
      where: { chatId, scope }, orderBy: { createdAt: 'desc' }, take: PAMIEC_TUR,
    })).reverse();
    const previousTurns = pamiec.filter(m => m.role && m.content).map(m => ({ role: m.role, text: m.content }));
    const ostatniAsystent = [...pamiec].reverse().find(m => m.role === 'assistant' && m.agent);
    const lastAgent = ostatniAsystent ? ostatniAsystent.agent : null;

    const { uruchomAsystenta } = require('./agent');
    const r = await uruchomAsystenta(prisma, {
      query: text || `Przeanalizuj przesłany plik (${opisPliku.join(', ')}) i powiedz, co z nim zrobić.`,
      context: { userName: kto },
      previousTurns, lastAgent, attachments,
      chatId, source: 'telegram', scope,
    });
    const body = r.body || {};
    const tekst = body.text || (body.error ? `⚠️ ${body.error}` : 'OK');
    const agent = Array.isArray(body.agents) && body.agents.length ? body.agents[body.agents.length - 1] : null;

    await prisma.memory.create({ data: { chatId, scope, role: 'user', content: [text, opisPliku.length ? `[plik: ${opisPliku.join(', ')}]` : ''].filter(Boolean).join(' ') } });
    await prisma.memory.create({ data: { chatId, scope, role: 'assistant', content: String(tekst).slice(0, 8000), agent } });
    await odpowiedz(token, chatId, tekst);
  } catch (e) {
    console.error(`[telegram-bot] scope=${scope} chat=${chatId}:`, e.message);
    await sendTelegram(token, chatId, `⚠️ Błąd: ${String(e.message).slice(0, 600)}`);
  }
}

/* --- Webhook --- */
router.post('/telegram/webhook/:scope', (req, res) => {
  if (!SEKRET()) return res.status(503).json({ ok: false, error: 'TELEGRAM_WEBHOOK_SECRET nie ustawiony' });
  if (!sekretOk(req)) return res.status(403).json({ ok: false, error: 'zły sekret webhooka' });
  const scope = zakresZ(req.params.scope);
  const upd = req.body || {};
  res.json({ ok: true }); // Telegram ma dostać 200 od razu; robota leci w tle
  if (juzBylo(upd.update_id)) return;
  const prisma = req.app.locals.prisma;
  if (upd.callback_query) {
    selfCall('POST', '/api/telegram/callback', { callback_query: upd.callback_query })
      .catch(e => console.error('[telegram-bot] callback:', e.message));
    return;
  }
  const msg = upd.message || upd.edited_message;
  if (msg) obsluzWiadomosc(prisma, scope, msg).catch(e => console.error('[telegram-bot] fatal:', e.message));
});

// Diagnostyka i przełączanie webhooka — z przeglądarki, ?secret=…
function bazaUrl(req) {
  const env = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (env) return env;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `https://${host}`;
}
router.get('/telegram/webhook/:scope', async (req, res) => {
  if (!sekretOk(req)) return res.status(403).json({ ok: false, error: 'zły sekret' });
  const scope = zakresZ(req.params.scope);
  const { token, source } = await resolveToken(req.app.locals.prisma, scope);
  if (!token) return res.status(503).json({ ok: false, error: `brak tokenu bota (${scope})` });
  const info = await tgApi(token, 'getWebhookInfo', {}).catch(e => ({ error: e.message }));
  res.json({ ok: true, scope, tokenSource: source, oczekiwanyUrl: `${bazaUrl(req)}/telegram/webhook/${scope}`, webhook: info && info.result ? info.result : info });
});
router.get('/telegram/webhook/:scope/ustaw', async (req, res) => {
  if (!sekretOk(req)) return res.status(403).json({ ok: false, error: 'zły sekret' });
  const scope = zakresZ(req.params.scope);
  const { token } = await resolveToken(req.app.locals.prisma, scope);
  if (!token) return res.status(503).json({ ok: false, error: `brak tokenu bota (${scope})` });
  const url = `${bazaUrl(req)}/telegram/webhook/${scope}`;
  const r = await tgApi(token, 'setWebhook', { url, secret_token: SEKRET(), allowed_updates: ['message', 'callback_query'], drop_pending_updates: false }).catch(e => ({ ok: false, error: e.message }));
  res.json({ ok: !!(r && r.ok), scope, url, telegram: r });
});
router.get('/telegram/webhook/:scope/zdejmij', async (req, res) => {
  if (!sekretOk(req)) return res.status(403).json({ ok: false, error: 'zły sekret' });
  const scope = zakresZ(req.params.scope);
  const { token } = await resolveToken(req.app.locals.prisma, scope);
  if (!token) return res.status(503).json({ ok: false, error: `brak tokenu bota (${scope})` });
  const r = await tgApi(token, 'deleteWebhook', { drop_pending_updates: false }).catch(e => ({ ok: false, error: e.message }));
  res.json({ ok: !!(r && r.ok), scope, telegram: r, uwaga: 'Żeby wrócić do n8n: aktywuj tam workflow — sam zarejestruje swój webhook.' });
});

module.exports = router;
