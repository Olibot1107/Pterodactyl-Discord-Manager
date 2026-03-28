const express = require("express");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { db } = require("../src/database/database");

const PORT = Number(process.env.AI_PORT || process.env.PORT || 3006);
const HOST = process.env.AI_HOST || process.env.HOST || "0.0.0.0";

const app = express();

app.disable("x-powered-by");
app.set("etag", false);

const publicDir = path.join(__dirname, "public");
app.use("/public", express.static(publicDir, { fallthrough: true }));

app.use(express.json({ limit: "1mb" }));

function loadSettings() {
  try {
    // Root `settings.js` is already gitignored in this repo.
    return require(path.join(__dirname, "..", "settings"));
  } catch {
    return null;
  }
}

const settings = loadSettings();

const PROVIDER_BASE_URL =
  (settings &&
    (settings.AI_BASE_URL ||
      settings.ai?.baseUrl ||
      settings.GROQ_BASE_URL ||
      settings.groq?.baseUrl)) ||
  process.env.AI_BASE_URL ||
  process.env.GROQ_BASE_URL ||
  "https://api.groq.com/openai/v1";

function parseProviderKeys() {
  const fromSettings =
    (settings &&
      (settings.AI_API_KEYS ||
        settings.AI_API_KEY ||
        settings.ai?.apiKeys ||
        settings.ai?.apiKey ||
        settings.GROQ_API_KEYS ||
        settings.GROQ_API_KEY ||
        settings.groq?.apiKeys ||
        settings.groq?.apiKey)) ||
    "";

  const raw =
    fromSettings ||
    process.env.AI_API_KEYS ||
    process.env.AI_API_KEY ||
    process.env.GROQ_API_KEYS ||
    process.env.GROQ_API_KEY ||
    "";
  const normalized =
    Array.isArray(raw) ? raw.join(",") : typeof raw === "string" ? raw : String(raw || "");
  const keys = normalized
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const unique = [...new Set(keys)];
  return unique;
}

const providerKeys = parseProviderKeys();
let providerKeyIndex = 0;

function nextProviderKey() {
  if (!providerKeys.length) return null;
  const key = providerKeys[providerKeyIndex % providerKeys.length];
  providerKeyIndex = (providerKeyIndex + 1) % providerKeys.length;
  return key;
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function extractBearerToken(req) {
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) return "";
  return auth.slice("Bearer ".length).trim();
}

async function requireUserApiKey(req, res, next) {
  const token = extractBearerToken(req);
  if (!token) {
    return res.status(401).json({
      error: { message: "Missing API key. Send: Authorization: Bearer <key>", type: "auth_error" },
    });
  }

  try {
    const record = await dbGet("SELECT discordId, apiKey FROM aiApiKeys WHERE apiKey = ?", [token]);
    if (!record) {
      return res.status(401).json({
        error: { message: "Invalid API key.", type: "auth_error" },
      });
    }
    req.aiAuth = { discordId: record.discordId, apiKey: record.apiKey };
    return next();
  } catch (err) {
    const message = err && err.message ? err.message : "Database error";
    return res.status(500).json({ error: { message, type: "server_error" } });
  }
}

function setCorsHeaders(req, res) {
  const origin = process.env.CORS_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

app.use((req, res, next) => {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
});

app.get("/healthz", (req, res) => {
  res.type("application/json").send(JSON.stringify({ ok: true }));
});

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 4 * 60 * 1000;

app.use("/v1", requireUserApiKey);
app.use("/api", requireUserApiKey);

async function enforceRateLimit(req, res, next) {
  const apiKey = req.aiAuth?.apiKey;
  if (!apiKey) {
    return res.status(500).json({ error: { message: "Missing auth context.", type: "server_error" } });
  }

  const now = Date.now();

  try {
    const existing = await dbGet(
      "SELECT apiKey, windowStart, count FROM aiRateLimits WHERE apiKey = ?",
      [apiKey]
    );

    let windowStart = existing ? Number(existing.windowStart) : now;
    let count = existing ? Number(existing.count) : 0;

    if (!existing || !Number.isFinite(windowStart) || now - windowStart >= RATE_LIMIT_WINDOW_MS) {
      windowStart = now;
      count = 0;
    }

    if (count >= RATE_LIMIT_MAX) {
      const retryAfterMs = Math.max(0, RATE_LIMIT_WINDOW_MS - (now - windowStart));
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        error: {
          message: "Rate limit exceeded.",
          type: "rate_limit_error",
          limit: RATE_LIMIT_MAX,
          windowMs: RATE_LIMIT_WINDOW_MS,
          retryAfterSeconds,
        },
      });
    }

    const nextCount = count + 1;
    await dbRun(
      `
        INSERT INTO aiRateLimits (apiKey, windowStart, count, updatedAt)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(apiKey)
        DO UPDATE SET
          windowStart = excluded.windowStart,
          count = excluded.count,
          updatedAt = excluded.updatedAt
      `,
      [apiKey, windowStart, nextCount, now]
    );

    res.setHeader("X-RateLimit-Limit", String(RATE_LIMIT_MAX));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, RATE_LIMIT_MAX - nextCount)));
    res.setHeader("X-RateLimit-Window", String(RATE_LIMIT_WINDOW_MS));

    return next();
  } catch (err) {
    const message = err && err.message ? err.message : "Database error";
    return res.status(500).json({ error: { message, type: "server_error" } });
  }
}

app.use("/v1", enforceRateLimit);
app.use("/api", enforceRateLimit);

async function proxyToGroq(req, res, upstreamPath) {
  const apiKey = nextProviderKey();
  if (!apiKey) {
    return res.status(500).json({
      error: {
        message:
          "Missing upstream AI provider key(s). Set AI_API_KEY / AI_API_KEYS in settings.js (preferred) or environment variables.",
        type: "config_error",
      },
    });
  }

  const url = `${PROVIDER_BASE_URL}${upstreamPath}`;
  const headers = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };

  try {
    const wantsStream = !!(req.body && req.body.stream);
    if (wantsStream) {
      const upstream = await axios({
        method: "post",
        url,
        headers,
        data: req.body,
        responseType: "stream",
        timeout: 0,
        validateStatus: () => true,
      });

      res.status(upstream.status);
      res.setHeader("content-type", upstream.headers["content-type"] || "text/event-stream; charset=utf-8");
      if (upstream.headers["cache-control"]) res.setHeader("cache-control", upstream.headers["cache-control"]);
      if (upstream.headers["x-request-id"]) res.setHeader("x-request-id", upstream.headers["x-request-id"]);
      if (upstream.headers["date"]) res.setHeader("date", upstream.headers["date"]);

      upstream.data.pipe(res);
      return;
    }

    const upstream = await axios({
      method: "post",
      url,
      headers,
      data: req.body,
      timeout: 60_000,
      validateStatus: () => true,
    });

    if (typeof upstream.data === "object") return res.status(upstream.status).json(upstream.data);
    return res.status(upstream.status).type("text").send(String(upstream.data));
  } catch (err) {
    const message = err && err.message ? err.message : "Upstream request failed";
    return res.status(502).json({ error: { message, type: "upstream_error" } });
  }
}

app.get("/v1/models", async (req, res) => {
  const apiKey = nextProviderKey();
  if (!apiKey) {
    return res.status(500).json({
      error: {
        message:
          "Missing upstream AI provider key(s). Set AI_API_KEY / AI_API_KEYS in settings.js (preferred) or environment variables.",
        type: "config_error",
      },
    });
  }

  try {
    const upstream = await axios({
      method: "get",
      url: `${PROVIDER_BASE_URL}/models`,
      headers: { authorization: `Bearer ${apiKey}` },
      timeout: 30_000,
      validateStatus: () => true,
    });
    return res.status(upstream.status).json(upstream.data);
  } catch (err) {
    const message = err && err.message ? err.message : "Upstream request failed";
    return res.status(502).json({ error: { message, type: "upstream_error" } });
  }
});

app.post("/v1/chat/completions", (req, res) => proxyToGroq(req, res, "/chat/completions"));

app.post("/api/chat", async (req, res) => {
  const defaultModel =
    (settings &&
      (settings.AI_MODEL ||
        settings.ai?.model ||
        settings.GROQ_MODEL ||
        settings.groq?.model)) ||
    process.env.AI_MODEL ||
    process.env.GROQ_MODEL;
  const model = req.body && req.body.model ? req.body.model : defaultModel;
  const messages = req.body && req.body.messages ? req.body.messages : null;
  const content = req.body && typeof req.body.content === "string" ? req.body.content : null;

  const finalMessages =
    Array.isArray(messages) && messages.length
      ? messages
      : content
        ? [{ role: "user", content }]
        : null;

  if (!finalMessages) {
    return res.status(400).json({
      error: {
        message: "Provide `messages` (array) or `content` (string).",
        type: "invalid_request_error",
      },
    });
  }

  req.body = {
    model: model || "llama-3.1-8b-instant",
    messages: finalMessages,
    temperature: req.body && typeof req.body.temperature === "number" ? req.body.temperature : undefined,
    max_tokens: req.body && typeof req.body.max_tokens === "number" ? req.body.max_tokens : undefined,
    stream: !!(req.body && req.body.stream),
  };

  return proxyToGroq(req, res, "/chat/completions");
});

app.get("/", (req, res) => {
  const indexHtmlPath = path.join(publicDir, "index.html");
  if (fs.existsSync(indexHtmlPath)) return res.sendFile(indexHtmlPath);

  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AI API Server</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background: #0b1220; color: #e5e7eb; }
      .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      .card { width: 100%; max-width: 720px; border: 1px solid rgba(255,255,255,.08); background: rgba(255,255,255,.03); border-radius: 16px; padding: 24px; }
      h1 { margin: 0 0 10px; font-size: 22px; }
      p { margin: 0 0 14px; opacity: .9; line-height: 1.5; }
      code { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.08); padding: 2px 6px; border-radius: 8px; }
      a { color: #93c5fd; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .muted { opacity: .7; font-size: 13px; margin-top: 18px; }
      ul { margin: 0 0 14px; padding-left: 18px; }
      li { margin: 8px 0; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>AI API is running</h1>
        <p>Open <code>http://localhost:${PORT}</code> in your browser.</p>
        <p class="muted">Bound to <code>${HOST}:${PORT}</code>.</p>
        <p>API endpoints:</p>
        <ul>
          <li><code>GET /v1/models</code> (OpenAI-compatible)</li>
          <li><code>POST /v1/chat/completions</code> (OpenAI-compatible)</li>
          <li><code>POST /api/chat</code> (simple wrapper)</li>
        </ul>
        <p>Docs: <code>https://ai-api.voidium.uk/</code></p>
        <p class="muted">Get your key from the Discord bot using <code>/aikey</code>, then send <code>Authorization: Bearer &lt;your_key&gt;</code> (10 requests / 4 minutes).</p>
        <p>Add a real site by creating <code>ai/public/index.html</code> (served at <code>/</code>) and any assets under <code>ai/public</code> (served at <code>/public</code>).</p>
        <p class="muted">Health check: <a href="/healthz">/healthz</a></p>
      </div>
    </div>
  </body>
</html>`);
});

app.use((req, res) => {
  res.status(404).type("text").send("Not found");
});

const server = app.listen(PORT, HOST, () => {
  console.log(`AI website listening on http://localhost:${PORT} (bound to ${HOST}:${PORT})`);
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
