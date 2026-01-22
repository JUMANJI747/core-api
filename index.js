import http from "http";

const PORT = process.env.PORT || 3000;

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

const server = http.createServer(async (req, res) => {
  // GET /health
  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, { ok: true });
  }

  // POST /telegram/inbox
  if (req.method === "POST" && req.url === "/telegram/inbox") {
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

    return sendJson(res, 200, { replyText: `✅ Działa. Napisałeś: ${text}` });
  }

  // default
  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
