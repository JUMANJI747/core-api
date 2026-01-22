import http from "http";

const PORT = process.env.PORT || 3000;

// Ustaw w Railway:
// API_KEY = długi_losowy_klucz
// (opcjonalnie) ADMIN_TELEGRAM_USER_ID = TwojTelegramUserId (np. "123456789")
const API_KEY = (process.env.API_KEY || "").trim();
const ADMIN_TELEGRAM_USER_ID = (process.env.ADMIN_TELEGRAM_USER_ID || "").trim();

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function getHeader(req, name) {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function authOk(req) {
  // Jeśli nie ustawisz API_KEY w env, to endpoint będzie otwarty.
  // Ale zalecam ustawić API_KEY od razu.
  if (!API_KEY) return true;

  const provided = String(getHeader(req, "x-api-key") || "").trim();
  return provided && provided === API_KEY;
}

const server = http.createServer(async (req, res) => {
  // GET /health
  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, { ok: true });
  }

  // POST /telegram/inbox  (wywołuje to n8n)
  if (req.method === "POST" && req.url === "/telegram/inbox") {
    // 1) API key auth
    if (!authOk(req)) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }

    // 2) JSON body
    const raw = await readBody(req);
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON" });
    }

    const text = String(body.text ?? "").trim();
    const telegramUserId = String(body.telegramUserId ?? "").trim();

    if (!telegramUserId) return sendJson(res, 400, { error: "telegramUserId required" });
    if (!text) return sendJson(res, 400, { error: "text required" });

    // 3) (opcjonalnie) allowlist – tylko Ty możesz używać
    if (ADMIN_TELEGRAM_USER_ID && telegramUserId !== ADMIN_TELEGRAM_USER_ID) {
      return sendJson(res, 403, { error: "Forbidden" });
    }

    // 4) odpowiedź (na razie echo)
    return sendJson(res, 200, { replyText: `✅ Działa. Napisałeś: ${text}` });
  }

  // default
  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
