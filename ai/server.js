const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const axios = require("axios");
const { db } = require("../src/database/database");

const DB_PATH = path.join(__dirname, "..", "src", "data", "database.sqlite");

const LOG_LEVEL = String(process.env.AI_LOG_LEVEL || "info").toLowerCase();
const LOG_PROMPTS = String(process.env.AI_LOG_PROMPTS || "").toLowerCase() === "true";
const LOG_DISCORD_IDS = String(process.env.AI_LOG_DISCORD_IDS || "").toLowerCase() === "true";

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function shouldLog(level) {
  const want = LOG_LEVELS[LOG_LEVEL] ?? LOG_LEVELS.info;
  const have = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  return have <= want;
}

function log(level, message, meta = {}) {
  if (!shouldLog(level)) return;
  const entry = { ts: new Date().toISOString(), level, message, ...meta };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

function safeKeyId(rawKey) {
  try {
    return crypto.createHash("sha256").update(String(rawKey)).digest("hex").slice(0, 10);
  } catch {
    return "unknown";
  }
}

const PORT = Number(process.env.AI_PORT || process.env.PORT || 3006);
const HOST = process.env.AI_HOST || process.env.HOST || "0.0.0.0";

const app = express();

app.disable("x-powered-by");
app.set("etag", false);

const publicDir = path.join(__dirname, "public");
app.use("/public", express.static(publicDir, { fallthrough: true }));

app.use((req, res, next) => {
  const reqId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  req.reqId = reqId;
  res.setHeader("X-Request-Id", reqId);

  const startedAt = Date.now();
  const ip = req.headers["cf-connecting-ip"] || req.ip;
  const ua = req.headers["user-agent"];

  log("debug", "http_start", {
    reqId,
    method: req.method,
    path: req.originalUrl,
    ip,
    ua,
    contentType: req.headers["content-type"],
    contentLength: req.headers["content-length"],
  });

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    const meta = {
      reqId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs,
      ip,
    };

    if (req.aiAuth?.apiKey) {
      meta.aiKeyId = safeKeyId(req.aiAuth.apiKey);
      if (LOG_DISCORD_IDS) meta.discordId = req.aiAuth.discordId;
    }

    if (req.aiUpstreamPath) meta.upstreamPath = req.aiUpstreamPath;
    if (req.aiUpstreamAttempts != null) meta.upstreamAttempts = req.aiUpstreamAttempts;
    if (req.aiUpstreamStatus != null) meta.upstreamStatus = req.aiUpstreamStatus;
    if (req.aiRateLimited) meta.rateLimited = true;

    log(
      res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
      "http_end",
      meta
    );
  });

  return next();
});

app.use(express.json({ limit: "1mb" }));

app.use((err, req, res, next) => {
  const isJsonParseError =
    err &&
    (err.type === "entity.parse.failed" ||
      (err instanceof SyntaxError && typeof err.message === "string" && err.message.toLowerCase().includes("json")));

  if (!isJsonParseError) return next(err);

  log("warn", "invalid_json", {
    reqId: req.reqId,
    method: req.method,
    path: req.originalUrl,
    ip: req.headers["cf-connecting-ip"] || req.ip,
    contentType: req.headers["content-type"],
    contentLength: req.headers["content-length"],
    error: String(err.message || err),
  });

  return res.status(400).json({
    error: {
      message: "Invalid JSON body. Send valid JSON with Content-Type: application/json.",
      type: "invalid_request_error",
    },
  });
});

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
  function toKeyList(raw) {
    if (!raw) return [];
    const normalized = Array.isArray(raw)
      ? raw.join(",")
      : typeof raw === "string"
        ? raw
        : String(raw || "");
    return normalized
      .split(/[,\s]+/g)
      .map((k) => k.trim())
      .filter(Boolean);
  }

  // Prefer plural fields first, but merge all discovered keys. This avoids
  // accidentally selecting a single-key field (e.g. `settings.ai.apiKey`)
  // when a multi-key field (e.g. `settings.GROQ_API_KEYS`) is also present.
  const settingsSources = settings
    ? [
        ["AI_API_KEYS", settings.AI_API_KEYS],
        ["ai.apiKeys", settings.ai?.apiKeys],
        ["GROQ_API_KEYS", settings.GROQ_API_KEYS],
        ["groq.apiKeys", settings.groq?.apiKeys],
        ["AI_API_KEY", settings.AI_API_KEY],
        ["ai.apiKey", settings.ai?.apiKey],
        ["GROQ_API_KEY", settings.GROQ_API_KEY],
        ["groq.apiKey", settings.groq?.apiKey],
      ]
    : [];

  const envSources = [
    ["AI_API_KEYS", process.env.AI_API_KEYS],
    ["GROQ_API_KEYS", process.env.GROQ_API_KEYS],
    ["AI_API_KEY", process.env.AI_API_KEY],
    ["GROQ_API_KEY", process.env.GROQ_API_KEY],
  ];

  const settingsKeys = [];
  const settingsFieldsUsed = [];
  for (const [name, value] of settingsSources) {
    const list = toKeyList(value);
    if (list.length) settingsFieldsUsed.push({ name, count: list.length });
    settingsKeys.push(...list);
  }

  const envKeys = [];
  const envVarsUsed = [];
  for (const [name, value] of envSources) {
    const list = toKeyList(value);
    if (list.length) envVarsUsed.push({ name, count: list.length });
    envKeys.push(...list);
  }

  const merged = [...settingsKeys, ...envKeys];
  const unique = [...new Set(merged)];
  const source =
    settingsKeys.length && envKeys.length
      ? "settings+env"
      : settingsKeys.length
        ? "settings"
        : envKeys.length
          ? "env"
          : "none";

  return {
    keys: unique,
    source,
    detail: {
      settings: { count: settingsKeys.length, fieldsUsed: settingsFieldsUsed },
      env: { count: envKeys.length, varsUsed: envVarsUsed },
    },
  };
}

const providerKeyConfig = parseProviderKeys();
const providerKeys = providerKeyConfig.keys;
let providerKeyIndex = 0;

function nextProviderKey() {
  if (!providerKeys.length) return null;
  const key = providerKeys[providerKeyIndex % providerKeys.length];
  providerKeyIndex = (providerKeyIndex + 1) % providerKeys.length;
  return key;
}

log("info", "upstream_configured", {
  upstreamKeys: providerKeys.length,
  keySource: providerKeyConfig.source,
  settingsKeys: providerKeyConfig.detail?.settings?.count || 0,
  envKeys: providerKeyConfig.detail?.env?.count || 0,
});

if (shouldLog("debug")) {
  log("debug", "upstream_details", {
    upstreamBaseUrl: PROVIDER_BASE_URL,
    keyPrefixes: providerKeys.map((k) => String(k).slice(0, 4)),
    keyIds: providerKeys.map((k) => safeKeyId(k)),
    settingsFieldsUsed: providerKeyConfig.detail?.settings?.fieldsUsed || [],
    envVarsUsed: providerKeyConfig.detail?.env?.varsUsed || [],
  });
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
    log("warn", "auth_missing", { reqId: req.reqId, path: req.originalUrl });
    return res.status(401).json({
      error: { message: "Missing API key. Send: Authorization: Bearer <key>", type: "auth_error" },
    });
  }

  try {
    const record = await dbGet("SELECT discordId, apiKey FROM aiApiKeys WHERE apiKey = ?", [token]);
    if (!record) {
      log("warn", "auth_invalid", { reqId: req.reqId, path: req.originalUrl, aiKeyId: safeKeyId(token) });
      return res.status(401).json({
        error: { message: "Invalid API key.", type: "auth_error" },
      });
    }
    req.aiAuth = { discordId: record.discordId, apiKey: record.apiKey };
    log("debug", "auth_ok", { reqId: req.reqId, path: req.originalUrl, aiKeyId: safeKeyId(record.apiKey) });
    return next();
  } catch (err) {
    const message = err && err.message ? err.message : "Database error";
    log("error", "auth_db_error", { reqId: req.reqId, path: req.originalUrl, error: String(message) });
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
      req.aiRateLimited = true;
      log("warn", "rate_limited", {
        reqId: req.reqId,
        aiKeyId: safeKeyId(apiKey),
        count,
        windowStart,
        retryAfterSeconds,
      });
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

    log("debug", "rate_ok", {
      reqId: req.reqId,
      aiKeyId: safeKeyId(apiKey),
      count: nextCount,
      remaining: Math.max(0, RATE_LIMIT_MAX - nextCount),
      windowStart,
    });

    return next();
  } catch (err) {
    const message = err && err.message ? err.message : "Database error";
    log("error", "rate_db_error", { reqId: req.reqId, aiKeyId: safeKeyId(apiKey), error: String(message) });
    return res.status(500).json({ error: { message, type: "server_error" } });
  }
}

app.use("/v1", enforceRateLimit);
app.use("/api", enforceRateLimit);

function isUpstreamInvalidKeyResponse(upstream) {
  const upstreamError = upstream?.data?.error;
  return (
    upstream?.status === 401 &&
    upstreamError &&
    (String(upstreamError.code || "").toLowerCase() === "invalid_api_key" ||
      String(upstreamError.message || "").toLowerCase().includes("invalid api key"))
  );
}

function respondUpstreamMisconfigured(res) {
  return res.status(502).json({
    error: {
      message: "AI backend is temporarily unavailable. Please try again later.",
      type: "upstream_error",
    },
  });
}

async function proxyToUpstream(req, res, upstreamPath) {
  req.aiUpstreamPath = upstreamPath;
  if (!providerKeys.length) {
    return res.status(500).json({
      error: {
        message:
          "Missing upstream AI provider key(s). Set AI_API_KEY / AI_API_KEYS in settings.js (preferred) or environment variables.",
        type: "config_error",
      },
    });
  }

  if (req.body && typeof req.body === "object") {
    const bodyMeta = {
      reqId: req.reqId,
      upstreamPath,
      model: req.body.model,
      stream: !!req.body.stream,
      messages: Array.isArray(req.body.messages) ? req.body.messages.length : undefined,
    };
    if (LOG_PROMPTS && Array.isArray(req.body.messages)) {
      bodyMeta.promptPreview = req.body.messages
        .map((m) => `${m?.role || "?"}:${String(m?.content || "").slice(0, 80)}`)
        .slice(0, 6);
    }
    log("debug", "upstream_request", bodyMeta);
  }

  const url = `${PROVIDER_BASE_URL}${upstreamPath}`;
  try {
    const wantsStream = !!(req.body && req.body.stream);
    for (let attempt = 0; attempt < providerKeys.length; attempt += 1) {
      const apiKey = nextProviderKey();
      if (!apiKey) break;
      req.aiUpstreamAttempts = attempt + 1;

      const headers = {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      };

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

        if (isUpstreamInvalidKeyResponse(upstream)) {
          log("warn", "upstream_invalid_key", { reqId: req.reqId, attempt: attempt + 1 });
          upstream.data?.resume?.();
          continue;
        }

        req.aiUpstreamStatus = upstream.status;
        log("debug", "upstream_stream_start", { reqId: req.reqId, status: upstream.status, attempt: attempt + 1 });
        res.status(upstream.status);
        res.setHeader(
          "content-type",
          upstream.headers["content-type"] || "text/event-stream; charset=utf-8"
        );
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

      if (isUpstreamInvalidKeyResponse(upstream)) {
        log("warn", "upstream_invalid_key", { reqId: req.reqId, attempt: attempt + 1 });
        continue;
      }

      req.aiUpstreamStatus = upstream.status;
      log("debug", "upstream_response", { reqId: req.reqId, status: upstream.status, attempt: attempt + 1 });
      if (typeof upstream.data === "object") return res.status(upstream.status).json(upstream.data);
      return res.status(upstream.status).type("text").send(String(upstream.data));
    }

    log("error", "upstream_all_keys_invalid", { reqId: req.reqId, attempts: providerKeys.length });
    return respondUpstreamMisconfigured(res);
  } catch (err) {
    const message = err && err.message ? err.message : "Upstream request failed";
    log("error", "upstream_error", { reqId: req.reqId, upstreamPath, error: String(message) });
    return res.status(502).json({ error: { message, type: "upstream_error" } });
  }
}

app.get("/v1/models", async (req, res) => {
  req.aiUpstreamPath = "/models";
  if (!providerKeys.length) {
    return res.status(500).json({
      error: {
        message:
          "Missing upstream AI provider key(s). Set AI_API_KEY / AI_API_KEYS in settings.js (preferred) or environment variables.",
        type: "config_error",
      },
    });
  }

  try {
    for (let attempt = 0; attempt < providerKeys.length; attempt += 1) {
      const apiKey = nextProviderKey();
      if (!apiKey) break;
      req.aiUpstreamAttempts = attempt + 1;

      const upstream = await axios({
        method: "get",
        url: `${PROVIDER_BASE_URL}/models`,
        headers: { authorization: `Bearer ${apiKey}` },
        timeout: 30_000,
        validateStatus: () => true,
      });

      if (isUpstreamInvalidKeyResponse(upstream)) {
        log("warn", "upstream_invalid_key", { reqId: req.reqId, attempt: attempt + 1, path: "/models" });
        continue;
      }

      req.aiUpstreamStatus = upstream.status;
      log("debug", "upstream_response", { reqId: req.reqId, status: upstream.status, attempt: attempt + 1, path: "/models" });
      return res.status(upstream.status).json(upstream.data);
    }

    log("error", "upstream_all_keys_invalid", { reqId: req.reqId, attempts: providerKeys.length, path: "/models" });
    return respondUpstreamMisconfigured(res);
  } catch (err) {
    const message = err && err.message ? err.message : "Upstream request failed";
    log("error", "upstream_error", { reqId: req.reqId, path: "/models", error: String(message) });
    return res.status(502).json({ error: { message, type: "upstream_error" } });
  }
});

app.post("/v1/chat/completions", (req, res) => proxyToUpstream(req, res, "/chat/completions"));

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
    log("warn", "chat_invalid_body", { reqId: req.reqId });
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

  return proxyToUpstream(req, res, "/chat/completions");
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

app.use((err, req, res, next) => {
  log("error", "unhandled_error", {
    reqId: req.reqId,
    method: req.method,
    path: req.originalUrl,
    error: String(err?.message || err),
    stack: String(err?.stack || ""),
  });

  if (res.headersSent) return next(err);
  return res.status(500).json({ error: { message: "Internal server error", type: "server_error" } });
});

const server = app.listen(PORT, HOST, () => {
  log("info", "listening", { url: `http://localhost:${PORT}`, bind: `${HOST}:${PORT}` });

  // Startup DB sanity check: helps debug "Invalid API Key" issues without leaking keys.
  try {
    log("info", "db_path", { path: DB_PATH, exists: fs.existsSync(DB_PATH) });
  } catch (err) {
    log("warn", "db_path_error", { error: String(err?.message || err) });
  }

  db.get("SELECT COUNT(*) AS count FROM aiApiKeys", (err, row) => {
    if (err) {
      log("warn", "db_key_count_error", { error: String(err?.message || err) });
      return;
    }
    log("info", "db_key_count", { keys: Number(row?.count || 0) });
  });
});

function shutdown(signal) {
  log("info", "shutdown", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  log("error", "unhandled_rejection", { reason: String(reason?.stack || reason) });
});

process.on("uncaughtException", (err) => {
  log("error", "uncaught_exception", {
    error: String(err?.message || err),
    stack: String(err?.stack || ""),
  });
});
