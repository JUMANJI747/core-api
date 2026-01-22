import http from "http";

const PORT = process.env.PORT || 3000;
const API_KEY = (process.env.API_KEY || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();

// ---------- helpers ----------
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
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function header(req, name) {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function authOk(req) {
  if (!API_KEY) return true; // dev fallback
  return String(header(req, "x-api-key") || "").trim() === API_KEY;
}

// ---------- OpenAI ----------
async function askLLM(userText) {
  if (!OPENAI_API_KEY) {
    return "❌ Brak klucza OPENAI_API_KEY w Railway.";
  }

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",

      messages: [
        {
          role: "system",
          content:
            "Jesteś pomocnym asystentem do obsługi firmy. Odpowiadasz krótko, konkretnie i po polsku.",
        },
        { role: "user", content: userText },
      ],
      temperature: 0.3,
    }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    return `❌ Błąd AI: ${resp.status} ${t}`;
  }

  const json = await resp.json();
  return json.choices?.[0]?.message?.content || "❌ Brak odpowiedzi AI.";
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  // health
  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, { ok: true });
  }

  // telegram inbox
  if (req.method === "POST" && req.url === "/telegram/inbox") {
    if (!authOk(req)) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON" });
    }

    const text = String(body.text || "").trim();
    const telegramUserId = String(body.telegramUserId || "").trim();

    if (!telegramUserId || !text) {
      return sendJson(res, 400, { error: "telegramUserId and text required" });
    }

    const reply = await askLLM(text);
    return sendJson(res, 200, { replyText: reply });
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
