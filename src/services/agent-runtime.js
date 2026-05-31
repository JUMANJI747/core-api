'use strict';

// Wspólny runtime sub-agentów. Per-agent różnice (transformBody hook dla
// communication-agent-es który wstrzykuje DEFAULT_FROM; :param expansion w
// path-templatach dla logistics/operations/parse_attachments) zachowane.

const http = require('http');

function selfCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const port = process.env.PORT || 3000;
    const apiKey = (process.env.API_KEY || '').trim();
    const data = body && method !== 'GET' ? JSON.stringify(body) : '';
    let finalPath = path;
    if (method === 'GET' && body && Object.keys(body).length) {
      const params = Object.entries(body)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => [k, String(v)]);
      if (params.length) finalPath = `${path}?${new URLSearchParams(params).toString()}`;
    }
    const options = {
      hostname: '127.0.0.1',
      port,
      path: finalPath,
      method,
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
    // Propagacja chatId żeby endpointy wysyłające Telegram trafiały do
    // tego kto pisał, nie do statycznego telegram_chat_id z Config.
    if (ctx.chatId && body.chatId == null) body.chatId = ctx.chatId;
    const expanded = expandPath(pathTemplate, body);
    const t0 = Date.now();
    try {
      const resp = await selfCall(method, expanded.path, expanded.body);
      console.log(`${logPrefix} [timing] tool ${name} ${method} ${expanded.path.split('?')[0]} → ${Date.now() - t0}ms (status ${resp.status})`);
      return resp.body;
    } catch (err) {
      console.error(`${logPrefix} tool ${name} error (${Date.now() - t0}ms):`, err.message);
      return { error: err.message };
    }
  };
}

// Anthropic API rzuca 400 "text content blocks must be non-empty" jak w
// historii pojawi sie text-block z pustym .text. Model czasem emituje
// {type:'text', text:''} obok tool_use — odfiltrujmy zanim pchniemy
// response.content z powrotem do messages.
function sanitizeAssistantContent(content) {
  if (!Array.isArray(content)) return content;
  return content.filter(b => {
    if (b && b.type === 'text') return typeof b.text === 'string' && b.text.trim().length > 0;
    return true;
  });
}

module.exports = { selfCall, expandPath, buildExecuteTool, sanitizeAssistantContent };
