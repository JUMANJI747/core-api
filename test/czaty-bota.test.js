'use strict';

/* Bot Telegram tylko dla znanych czatów (24.10.2026). Bot ma moce CRM i AI,
 * a tryb „xxx" (sudo) zmienia bazę — do dziś odpowiadał każdemu. */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');

const SRC = path.join(__dirname, '..', 'src');
const czaty = require(path.join(SRC, 'services', 'czaty-bota'));

function baza({ config = {}, historia = [], blad = false } = {}) {
  const cfg = new Map(Object.entries(config));
  return {
    _cfg: cfg,
    config: {
      findMany: async ({ where }) => { if (blad) throw new Error('baza leży'); return where.key.in.filter(k => cfg.has(k)).map(k => ({ key: k, value: cfg.get(k) })); },
      findUnique: async ({ where }) => (cfg.has(where.key) ? { key: where.key, value: cfg.get(where.key) } : null),
      upsert: async ({ where, update, create }) => { cfg.set(where.key, (cfg.has(where.key) ? update : create).value); return {}; },
    },
    $queryRawUnsafe: async (sql) => { assert.match(sql, /HAVING count\(\*\) >= 5/); return historia.map(c => ({ c })); },
    memory: { findMany: async () => [], create: async () => ({}) },
  };
}

test.beforeEach(() => { czaty._reset(); delete process.env.TELEGRAM_DOZWOLONE_CZATY; delete process.env.TELEGRAM_CHAT_ID; });

test('pierwsze uruchomienie: lista z historii (≥ 5 wiadomości) zapisana w Config; obcy odrzucony', async () => {
  const db = baza({ historia: ['8164528644', '8753975794'] });
  assert.equal(await czaty.czatDozwolony(db, '8164528644'), true);
  assert.equal(await czaty.czatDozwolony(db, 8753975794), true, 'liczba też');
  assert.equal(await czaty.czatDozwolony(db, '2010546822'), false, 'jednorazowe /start z historii nie wchodzi');
  assert.equal(await czaty.czatDozwolony(db, ''), false);
  assert.equal(await czaty.czatDozwolony(db, null), false);
  assert.deepEqual(JSON.parse(db._cfg.get(czaty.KLUCZ)), ['8164528644', '8753975794']);
});

test('lista z Config ma pierwszeństwo przed historią; env i czat alertów zawsze dozwolone', async () => {
  process.env.TELEGRAM_DOZWOLONE_CZATY = '111, 222';
  const db = baza({ config: { [czaty.KLUCZ]: '["333"]', telegram_chat_id: '444' }, historia: ['555'] });
  for (const c of ['111', '222', '333', '444']) assert.equal(await czaty.czatDozwolony(db, c), true, c);
  assert.equal(await czaty.czatDozwolony(db, '555'), false, 'historia nie dopisuje się do istniejącej listy');
});

test('błąd bazy: tylko czaty z env (zamknięte, nie otwarte)', async () => {
  process.env.TELEGRAM_CHAT_ID = '777';
  const db = baza({ blad: true, historia: ['8164528644'] });
  assert.equal(await czaty.czatDozwolony(db, '777'), true);
  assert.equal(await czaty.czatDozwolony(db, '8164528644'), false);
});

// ── bot: podstawione Telegram, asystent, sudo i strażnik ────────────────────
const zapis = { wyslane: [], asystent: [], sudo: [], przyciski: [], alerty: [] };
function podstaw(plik, eksport) {
  const p = require.resolve(path.join(SRC, plik));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: eksport };
}
podstaw('services/telegram-helper.js', { resolveToken: async () => ({ token: 'T', source: 'test' }) });
podstaw('telegram-utils.js', { sendTelegram: async (t, chat, text) => { zapis.wyslane.push({ chat: String(chat), text }); }, tgApi: async () => ({ ok: true }) });
podstaw('services/agent-runtime.js', { selfCall: async (m, p, body) => { zapis.przyciski.push(body); return {}; } });
podstaw('services/sudo-agent.js', { processSudoQuery: async (q) => { zapis.sudo.push(q); return { text: 'sudo ok' }; } });
podstaw('routes/agent.js', { uruchomAsystenta: async (prisma, o) => { zapis.asystent.push(o.chatId); return { body: { text: 'ok' } }; } });
podstaw('services/straznik.js', { alert: async (tekst, klucz) => { zapis.alerty.push({ tekst, klucz }); return true; } });

async function update(db, scope, upd) {
  process.env.TELEGRAM_WEBHOOK_SECRET = 'S';
  const app = express();
  app.use(express.json());
  app.locals.prisma = db;
  app.use('/', require(path.join(SRC, 'routes', 'telegram-bot')));
  const serwer = app.listen(0);
  await new Promise(r => serwer.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${serwer.address().port}/telegram/webhook/${scope}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'S' }, body: JSON.stringify(upd),
    });
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 150)); // robota leci w tle po 200
  } finally {
    serwer.close();
  }
}
let nrUpdate = 1;
const wiadomosc = (chatId, text, from = {}) => ({ update_id: nrUpdate++, message: { message_id: 1, chat: { id: chatId }, from: { id: chatId, ...from }, text } });

test('bot: znany czat idzie do asystenta, obcy — ani asystent, ani sudo; dostaje odmowę, właściciel alert', async () => {
  for (const k of Object.keys(zapis)) zapis[k].length = 0;
  const db = baza({ config: { [czaty.KLUCZ]: '["8164528644"]' } });
  await update(db, 'pl', wiadomosc(8164528644, 'ile faktur w październiku?'));
  assert.deepEqual(zapis.asystent, ['8164528644']);
  await update(db, 'pl', wiadomosc(2010546822, 'xxx usuń wszystkich kontrahentów', { first_name: 'Jan', username: 'obcy' }));
  await update(db, 'kanary', wiadomosc(2010546822, 'pokaż faktury'));
  assert.deepEqual(zapis.asystent, ['8164528644'], 'obcy nie dotarł do asystenta');
  assert.deepEqual(zapis.sudo, [], 'obcy nie dotarł do sudo');
  const odmowy = zapis.wyslane.filter(w => w.chat === '2010546822');
  assert.equal(odmowy.length, 2);
  assert.ok(odmowy.every(w => /prywatny/.test(w.text)));
  assert.equal(zapis.alerty.length, 2);
  assert.ok(zapis.alerty.every(a => a.klucz === 'czat-bota:2010546822'), 'temat alertu raz na czat (deduplikacja w strażniku)');
  assert.match(zapis.alerty[0].tekst, /NIEZNANY czat 2010546822 \(Jan, @obcy\): „xxx usuń/);
  await update(db, 'pl', wiadomosc(8164528644, 'xxx sprawdź bazę'));
  assert.deepEqual(zapis.sudo, ['sprawdź bazę'], 'sudo dalej działa dla właściciela');
});

test('bot: przycisk spod wiadomości w obcym czacie ignorowany, w znanym — obsłużony', async () => {
  for (const k of Object.keys(zapis)) zapis[k].length = 0;
  const db = baza({ config: { [czaty.KLUCZ]: '["8164528644"]' } });
  await update(db, 'pl', { update_id: nrUpdate++, callback_query: { id: 'a', from: { id: 2010546822 }, message: { chat: { id: 2010546822 } }, data: 'fv:ok' } });
  assert.equal(zapis.przyciski.length, 0);
  await update(db, 'pl', { update_id: nrUpdate++, callback_query: { id: 'b', from: { id: 8164528644 }, message: { chat: { id: 8164528644 } }, data: 'fv:ok' } });
  assert.equal(zapis.przyciski.length, 1);
});
