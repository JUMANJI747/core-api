'use strict';

// Wspólny runtime sub-agentów. Wcześniej każdy z 6 agentów (accounting,
// accounting-es, communication, communication-es, logistics, operations) miał
// 30+ identycznych linii selfCall + executeTool — zmiana w jednym wymuszała
// kopiowanie do wszystkich. Tu jeden moduł, każdy agent dostaje swoją
// instancję przez buildExecuteTool().
//
// Różnice między agentami zachowane:
// - communication-agent-es wstrzykuje DEFAULT_FROM dla send_email/send_offer
//   (przekazane przez opcjonalny transformBody).
// - logistics/operations używają :param w path-template — auto-rozwijane.
// - communication-agent ma 'POST_PATH' alias z :emailId — tu traktowane jak
//   zwykły POST z path-templatem.

const http = require('http');

function selfCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const port = process.env.PORT || 3000;
    const apiKey = (process.env.API_KEY || '').trim();
    const m = method === 'POST_PATH' ? 'POST' : method;
    const data = body && m !== 'GET' ? JSON.stringify(body) : '';
    let finalPath = path;
    if (m === 'GET' && body && Object.keys(body).length) {
      const params = Object.entries(body)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => [k, String(v)]);
      if (params.length) finalPath = `${path}?${new URLSearchParams(params).toString()}`;
    }
    const options = {
      hostname: '127.0.0.1',
      port,
      path: finalPath,
      method: m,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
    };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch (_) { resolve({ status: res.statusCode, body: text }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Rozwija :param w path-template używając kluczy z body. Zwraca {path, body}
// gdzie body ma usunięte klucze zużyte na path. Gdy brak :param — bez zmian.
function expandPath(template, body) {
  if (!template.includes(':')) return { path: template, body };
  const rest = { ...body };
  const path = template.replace(/:([a-zA-Z]+)/g, (_, key) => {
    const val = rest[key];
    delete rest[key];
    return encodeURIComponent(val == null || val === '' ? '_' : val);
  });
  return { path, body: rest };
}

// Factory: zwraca executeTool z domknięciem na ENDPOINT_MAP + log prefix +
// opcjonalny body transformer (per-agent kwiat).
function buildExecuteTool({ endpointMap, logPrefix, transformBody }) {
  return async function executeTool(name, input, ctx = {}) {
    const ep = endpointMap[name];
    if (!ep) return { error: `Unknown tool: ${name}` };
    const [method, pathTemplate] = ep;
    let body = { ...(input || {}) };
    if (typeof transformBody === 'function') {
      const out = transformBody(name, body, ctx);
      if (out && typeof out === 'object') body = out;
    }
    // Propagacja chatId z konwersacji żeby endpointy które wysyłają Telegram
    // (PDF, potwierdzenia, notyfikacje) trafiały do tego kto pisał, nie do
    // statycznego telegram_chat_id z Config.
    if (ctx.chatId && body.chatId == null) body.chatId = ctx.chatId;
    const expanded = expandPath(pathTemplate, body);
    try {
      const resp = await selfCall(method, expanded.path, expanded.body);
      return resp.body;
    } catch (err) {
      console.error(`${logPrefix} tool ${name} error:`, err.message);
      return { error: err.message };
    }
  };
}

module.exports = { selfCall, expandPath, buildExecuteTool };
