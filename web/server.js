const http = require("http");
const fs = require("fs");
const path = require("path");
const https = require("https");
const sqlite3 = require("sqlite3").verbose();
const axios = require("axios");
const api = require("../src/structures/Ptero");

const STATUS_PORT = Number(process.env.STATUS_PORT) || 3000;
const SAMPLE_INTERVAL_MS = 4_000;
const PROBE_TIMEOUT_MS = 5_000;
const IN_MEMORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_VIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
const DB_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAY_OFFSET = 6;

const RANGE_MAP = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

function resolveRangeWindow(rawRange) {
  if (!rawRange) return DEFAULT_VIEW_WINDOW_MS;
  return RANGE_MAP[String(rawRange).toLowerCase()] || DEFAULT_VIEW_WINDOW_MS;
}

function getRangeLabel(windowMs) {
  if (windowMs >= RANGE_MAP["7d"]) return "7d";
  return "24h";
}

function clampDayOffset(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(MAX_DAY_OFFSET, Math.trunc(parsed)));
}

function getDayWindow(dayOffset = 0, nowTs = Date.now()) {
  const offset = clampDayOffset(dayOffset);
  const now = new Date(nowTs);
  const utcStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = utcStart - offset * DAY_MS;
  return { start, end: start + DAY_MS, offset };
}

function getDayLabel(startTs) {
  const date = new Date(startTs);
  return date.toISOString().slice(0, 10);
}

const HISTORY_DB_DIR = path.join(__dirname, "data");
const HISTORY_DB_PATH = path.join(HISTORY_DB_DIR, "status-history.sqlite");

const nodeMonitor = {
  nodes: new Map(),
  lastError: null,
  lastUpdated: null,
  running: false,
  persistenceEnabled: false,
  lastDbPruneAt: 0,
};

let historyDb = null;

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!historyDb) return resolve({ changes: 0, lastID: null });
    historyDb.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      return resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!historyDb) return resolve([]);
    historyDb.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      return resolve(rows || []);
    });
  });
}

async function pruneOldHistory(nowTs = Date.now()) {
  if (!historyDb) return;
  const cutoff = nowTs - MAX_HISTORY_WINDOW_MS;
  await dbRun("DELETE FROM node_ping_history WHERE ts < ?", [cutoff]);
  nodeMonitor.lastDbPruneAt = nowTs;
}

function hydrateHistoryRow(row) {
  return {
    ts: Number(row.ts),
    at: row.at,
    online: !!row.online,
    maintenance: !!row.maintenance,
    latencyMs: Number.isFinite(Number(row.latencyMs)) ? Number(row.latencyMs) : null,
    statusCode: Number.isFinite(Number(row.statusCode)) ? Number(row.statusCode) : null,
    probeUrl: row.probeUrl || null,
    error: row.error || null,
  };
}

async function loadHistoryFromDb() {
  if (!historyDb) return;
  const cutoff = Date.now() - IN_MEMORY_WINDOW_MS;
  const rows = await dbAll(
    `
      SELECT nodeId, nodeName, fqdn, memoryMb, diskMb, ts, at, online, maintenance, latencyMs, statusCode, probeUrl, error
      FROM node_ping_history
      WHERE ts >= ?
      ORDER BY ts ASC
    `,
    [cutoff]
  );

  nodeMonitor.nodes.clear();

  for (const row of rows) {
    const nodeId = Number(row.nodeId);
    const sample = hydrateHistoryRow(row);
    const existing = nodeMonitor.nodes.get(nodeId) || {
      id: nodeId,
      name: row.nodeName || `Node #${nodeId}`,
      fqdn: row.fqdn || "",
      panel: {
        id: nodeId,
        uuid: null,
        name: row.nodeName || `Node #${nodeId}`,
        description: null,
        locationId: null,
        public: null,
        fqdn: row.fqdn || null,
        scheme: "http",
        behindProxy: false,
        maintenanceMode: sample.maintenance,
        daemonListen: null,
        daemonSftp: null,
        daemonBase: null,
        memoryMb: Number(row.memoryMb) || 0,
        memoryOverallocate: null,
        diskMb: Number(row.diskMb) || 0,
        diskOverallocate: null,
        uploadSizeMb: null,
        createdAt: null,
        updatedAt: null,
      },
      memoryMb: Number(row.memoryMb) || 0,
      diskMb: Number(row.diskMb) || 0,
      maintenance: sample.maintenance,
      online: sample.online,
      latencyMs: sample.latencyMs,
      statusCode: sample.statusCode,
      probeUrl: sample.probeUrl,
      probeTarget: null,
      lastCheckedAt: sample.at,
      history: [],
    };

    existing.name = row.nodeName || existing.name;
    existing.fqdn = row.fqdn || existing.fqdn;
    existing.memoryMb = Number(row.memoryMb) || existing.memoryMb;
    existing.diskMb = Number(row.diskMb) || existing.diskMb;
    if (existing.panel) {
      existing.panel.name = row.nodeName || existing.panel.name;
      existing.panel.fqdn = row.fqdn || existing.panel.fqdn;
      existing.panel.maintenanceMode = sample.maintenance;
      existing.panel.memoryMb = Number(row.memoryMb) || existing.panel.memoryMb;
      existing.panel.diskMb = Number(row.diskMb) || existing.panel.diskMb;
    }
    existing.maintenance = sample.maintenance;
    existing.online = sample.online;
    existing.latencyMs = sample.latencyMs;
    existing.statusCode = sample.statusCode;
    existing.probeUrl = sample.probeUrl;
    existing.lastCheckedAt = sample.at;
    existing.history.push(sample);
    nodeMonitor.nodes.set(nodeId, existing);
  }

  if (rows.length) {
    nodeMonitor.lastUpdated = rows[rows.length - 1].at;
  }
}

async function persistNodeSample(node, probe, nowTs) {
  if (!historyDb) return;
  const at = new Date(nowTs).toISOString();
  await dbRun(
    `
      INSERT INTO node_ping_history (
        nodeId, nodeName, fqdn, memoryMb, diskMb, ts, at, online, maintenance, latencyMs, statusCode, probeUrl, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      Number(node.id),
      node.name || `Node #${node.id}`,
      node.fqdn || "",
      Number(node.memory) || 0,
      Number(node.disk) || 0,
      nowTs,
      at,
      probe.online ? 1 : 0,
      node.maintenance_mode ? 1 : 0,
      Number.isFinite(Number(probe.latencyMs)) ? Number(probe.latencyMs) : null,
      Number.isFinite(Number(probe.statusCode)) ? Number(probe.statusCode) : null,
      probe.probeUrl || null,
      probe.error || null,
    ]
  );
}

async function ensureHistorySchema() {
  if (!historyDb) return;
  const cols = await dbAll("PRAGMA table_info(node_ping_history)");
  const existing = new Set((cols || []).map((c) => c.name));

  if (!existing.has("statusCode")) {
    await dbRun("ALTER TABLE node_ping_history ADD COLUMN statusCode INTEGER");
  }
  if (!existing.has("probeUrl")) {
    await dbRun("ALTER TABLE node_ping_history ADD COLUMN probeUrl TEXT");
  }
}

async function initHistoryStorage() {
  fs.mkdirSync(HISTORY_DB_DIR, { recursive: true });
  historyDb = new sqlite3.Database(HISTORY_DB_PATH);

  await dbRun("PRAGMA journal_mode = WAL");
  await dbRun(
    `
      CREATE TABLE IF NOT EXISTS node_ping_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeId INTEGER NOT NULL,
        nodeName TEXT NOT NULL,
        fqdn TEXT,
        memoryMb INTEGER,
        diskMb INTEGER,
        ts INTEGER NOT NULL,
        at TEXT NOT NULL,
        online INTEGER NOT NULL,
        maintenance INTEGER NOT NULL,
        latencyMs INTEGER,
        statusCode INTEGER,
        probeUrl TEXT,
        error TEXT
      )
    `
  );
  await dbRun(
    `
      CREATE INDEX IF NOT EXISTS idx_node_ping_history_node_ts
      ON node_ping_history (nodeId, ts)
    `
  );
  await dbRun(
    `
      CREATE INDEX IF NOT EXISTS idx_node_ping_history_ts
      ON node_ping_history (ts)
    `
  );

  await ensureHistorySchema();
  await pruneOldHistory();
  await loadHistoryFromDb();
  nodeMonitor.persistenceEnabled = true;
}

function getServiceStats() {
  return {
    status: nodeMonitor.lastError ? "degraded" : "ok",
    service: "web-monitor",
    uptimeSeconds: Math.floor(process.uptime()),
    pid: process.pid,
    persistenceEnabled: nodeMonitor.persistenceEnabled,
    timestamp: new Date().toISOString(),
  };
}

async function fetchAllNodes() {
  const nodes = [];
  for (let page = 1; ; page++) {
    const res = await api.get(`/nodes?page=${page}&per_page=100`);
    const pageNodes = res.data?.data || [];
    nodes.push(...pageNodes.map((n) => n.attributes));
    if (pageNodes.length < 100) break;
  }
  return nodes;
}

function normalizePanelNode(node) {
  const memoryMb = Number(node?.memory) || 0;
  const diskMb = Number(node?.disk) || 0;
  const uploadSizeMb = node?.upload_size == null ? null : Number(node.upload_size);

  return {
    id: Number(node?.id),
    uuid: node?.uuid || null,
    name: node?.name || `Node #${node?.id ?? "?"}`,
    description: node?.description || null,
    locationId: node?.location_id == null ? null : Number(node.location_id),
    public: node?.public == null ? null : !!node.public,
    fqdn: node?.fqdn || null,
    scheme: node?.scheme === "https" ? "https" : "http",
    behindProxy: !!node?.behind_proxy,
    maintenanceMode: !!node?.maintenance_mode,
    daemonListen: node?.daemon_listen == null ? null : Number(node.daemon_listen),
    daemonSftp: node?.daemon_sftp == null ? null : Number(node.daemon_sftp),
    daemonBase: node?.daemon_base || null,
    memoryMb,
    memoryOverallocate: node?.memory_overallocate == null ? null : Number(node.memory_overallocate),
    diskMb,
    diskOverallocate: node?.disk_overallocate == null ? null : Number(node.disk_overallocate),
    uploadSizeMb: Number.isFinite(uploadSizeMb) ? uploadSizeMb : null,
    createdAt: node?.created_at || null,
    updatedAt: node?.updated_at || null,
  };
}

function resolveProbeTarget(node) {
  const raw = String(node.fqdn || "").trim();
  if (!raw) return null;
  let host = raw;
  let explicitPort = null;
  const scheme = node.scheme === "https" ? "https" : "http";
  const behindProxy = !!node.behind_proxy;

  try {
    const hasScheme = raw.includes("://");
    const parsed = new URL(hasScheme ? raw : `${scheme}://${raw}`);
    host = parsed.hostname;
    if (parsed.port) explicitPort = Number(parsed.port);
  } catch {
    const [h, p] = raw.split(":");
    host = h || raw;
    if (p) explicitPort = Number(p);
  }

  const daemonPort = Number(node.daemon_listen);
  let port = explicitPort;
  if (!port || Number.isNaN(port)) {
    if (behindProxy) {
      port = scheme === "https" ? 443 : 80;
    } else if (Number.isFinite(daemonPort) && daemonPort > 0) {
      port = daemonPort;
    } else {
      port = scheme === "https" ? 443 : 80;
    }
  }
  return { host, port, scheme };
}

async function probeNodeHttp(node, timeoutMs = PROBE_TIMEOUT_MS) {
  const target = resolveProbeTarget(node);
  if (!target) {
    return { online: false, latencyMs: null, error: "missing fqdn", statusCode: null, probeUrl: null, target: null };
  }

  const url = `${target.scheme}://${target.host}:${target.port}/api/system`;
  const startedAt = Date.now();

  try {
    const response = await axios.get(url, {
      timeout: timeoutMs,
      validateStatus: () => true,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      headers: {
        Accept: "application/json",
        "User-Agent": "ptero-status-monitor/1.0",
      },
    });

    const latencyMs = Date.now() - startedAt;
    const statusCode = Number(response.status) || null;
    const online = [200, 204, 401, 403].includes(statusCode);

    return {
      online,
      latencyMs,
      error: online ? null : `http_${statusCode}`,
      statusCode,
      probeUrl: url,
      target,
    };
  } catch (err) {
    return {
      online: false,
      latencyMs: null,
      error: String(err.code || err.message || "request_failed"),
      statusCode: null,
      probeUrl: url,
      target,
    };
  }
}

function updateNodeHistory(node, probe, nowTs = Date.now()) {
  const panel = normalizePanelNode(node);
  const existing = nodeMonitor.nodes.get(panel.id) || { history: [] };
  const history = Array.isArray(existing.history) ? existing.history.slice() : [];
  const at = new Date(nowTs).toISOString();

  history.push({
    ts: nowTs,
    at,
    online: !!probe.online,
    maintenance: !!panel.maintenanceMode,
    latencyMs: probe.latencyMs,
    statusCode: Number.isFinite(Number(probe.statusCode)) ? Number(probe.statusCode) : null,
    probeUrl: probe.probeUrl || null,
    error: probe.error || null,
  });
  while (history.length && nowTs - history[0].ts > IN_MEMORY_WINDOW_MS) history.shift();

  nodeMonitor.nodes.set(panel.id, {
    id: panel.id,
    name: panel.name,
    fqdn: panel.fqdn,
    panel,
    memoryMb: panel.memoryMb,
    diskMb: panel.diskMb,
    maintenance: !!panel.maintenanceMode,
    online: !!probe.online,
    latencyMs: probe.latencyMs,
    statusCode: Number.isFinite(Number(probe.statusCode)) ? Number(probe.statusCode) : null,
    probeUrl: probe.probeUrl || null,
    probeTarget: probe.target || null,
    lastCheckedAt: history[history.length - 1]?.at || null,
    history,
  });
}

function getMaxSamplesForWindow(windowMs) {
  if (windowMs >= RANGE_MAP["7d"]) return 360;
  return 260;
}

function downsampleHistory(history, maxPoints = 260) {
  if (!Array.isArray(history) || history.length <= maxPoints) return history || [];

  const bucketSize = Math.ceil(history.length / maxPoints);
  const reduced = [];

  for (let i = 0; i < history.length; i += bucketSize) {
    const chunk = history.slice(i, i + bucketSize);
    if (!chunk.length) continue;

    const last = chunk[chunk.length - 1];
    const onlineLatencies = chunk
      .filter((s) => s.online && !s.maintenance && Number.isFinite(s.latencyMs))
      .map((s) => Number(s.latencyMs));

    const downCount = chunk.filter((s) => !s.online).length;
    const onlineCount = chunk.length - downCount;
    const chunkOnline = onlineCount >= downCount;

    let latencyMs = null;
    if (chunkOnline && onlineLatencies.length) {
      const avg = onlineLatencies.reduce((sum, v) => sum + v, 0) / onlineLatencies.length;
      latencyMs = Math.round(avg);
    }

    reduced.push({
      ts: Number(last.ts),
      at: last.at,
      online: chunkOnline,
      maintenance: !!last.maintenance,
      latencyMs,
      statusCode: last.statusCode ?? null,
      probeUrl: last.probeUrl ?? null,
      error: chunkOnline ? null : (last.error || "downsampled_down"),
    });
  }

  return reduced;
}

function computeUptimeBars(samples, windowMs) {
  const now = Date.now();
  const windowStart = now - windowMs;

  const uptimeSamples = (samples || []).filter((s) => !s.maintenance);
  const uptimeBuckets = Math.max(48, Math.min(180, Math.round(windowMs / (4 * 60 * 60 * 1000))));
  const bucketSizeMs = windowMs / uptimeBuckets;
  const buckets = Array.from({ length: uptimeBuckets }, () => ({ total: 0, up: 0, down: 0 }));

  for (const sample of uptimeSamples) {
    if (!sample.ts || sample.ts < windowStart) continue;
    const idx = Math.max(0, Math.min(uptimeBuckets - 1, Math.floor((sample.ts - windowStart) / bucketSizeMs)));
    const b = buckets[idx];
    b.total++;
    if (sample.online) b.up++;
    else b.down++;
  }

  return buckets.map((b) => {
    if (b.total === 0) return { level: "none", uptime: null, downRatio: 0, label: "No data" };
    const uptime = b.up / b.total;
    const downRatio = b.down / b.total;
    let level = "mixed";
    if (downRatio === 0) level = "up";
    else if (downRatio === 1) level = "down";
    const label = level === "mixed"
      ? "Intermittent (up/down in this period)"
      : `${Math.round(uptime * 100)}% up / ${Math.round(downRatio * 100)}% down`;
    return { level, uptime, downRatio, label };
  });
}

function getSampleState(sample) {
  if (!sample) return "unknown";
  if (sample.maintenance) return "maintenance";
  if (sample.online) return "operational";
  return "offline";
}

function computeNodeWindowStats(samples, windowMs, nowTs = Date.now()) {
  const ordered = Array.isArray(samples) ? samples.slice().sort((a, b) => Number(a.ts) - Number(b.ts)) : [];
  const cutoff = nowTs - windowMs;
  const inWindow = ordered.filter((s) => Number(s.ts) >= cutoff);
  const last = inWindow[inWindow.length - 1] || null;

  const uptimeSamples = inWindow.filter((s) => !s.maintenance);
  const checks = uptimeSamples.length;
  const up = uptimeSamples.filter((s) => s.online).length;
  const down = checks - up;
  const uptimePercent = checks ? Number(((up / checks) * 100).toFixed(2)) : null;
  const downDurationMs = down * SAMPLE_INTERVAL_MS;

  let downIncidents = 0;
  let longestDownMs = 0;
  let currentDownStartTs = null;

  for (const sample of uptimeSamples) {
    if (!sample.online) {
      if (currentDownStartTs == null) {
        currentDownStartTs = sample.ts;
        downIncidents++;
      }
    } else if (currentDownStartTs != null) {
      longestDownMs = Math.max(longestDownMs, sample.ts - currentDownStartTs);
      currentDownStartTs = null;
    }
  }
  if (currentDownStartTs != null) {
    longestDownMs = Math.max(longestDownMs, nowTs - currentDownStartTs);
  }

  const recentPings = inWindow
    .slice(-30)
    .filter((s) => s.online && !s.maintenance && Number.isFinite(s.latencyMs))
    .map((s) => s.latencyMs);
  const avgLatencyMs = recentPings.length
    ? Math.round(recentPings.reduce((a, b) => a + b, 0) / recentPings.length)
    : null;

  const state = getSampleState(last);
  let stateSinceAt = last?.at || null;
  if (last) {
    for (let i = inWindow.length - 2; i >= 0; i--) {
      if (getSampleState(inWindow[i]) !== state) break;
      stateSinceAt = inWindow[i].at;
    }
  }

  let lastOnlineAt = null;
  for (let i = inWindow.length - 1; i >= 0; i--) {
    const s = inWindow[i];
    if (s.online && !s.maintenance) {
      lastOnlineAt = s.at;
      break;
    }
  }

  let lastOfflineAt = null;
  for (let i = inWindow.length - 1; i >= 0; i--) {
    const s = inWindow[i];
    if (!s.online && !s.maintenance) {
      lastOfflineAt = s.at;
      break;
    }
  }

  return {
    windowMs,
    checks,
    up,
    down,
    uptimePercent,
    downDurationMs,
    downIncidents,
    longestDownMs,
    avgLatencyMs,
    state,
    stateSinceAt,
    lastOnlineAt,
    lastOfflineAt,
    lastSample: last,
    samplesInWindow: inWindow.length,
  };
}

async function runNodeProbeCycle() {
  if (nodeMonitor.running) return;
  nodeMonitor.running = true;
  try {
    const cycleTs = Date.now();
    const nodes = await fetchAllNodes();
    const nodeIds = new Set(nodes.map((n) => n.id));
    const probes = await Promise.all(nodes.map(async (node) => {
      return { node, probe: await probeNodeHttp(node) };
    }));

    for (const { node, probe } of probes) {
      updateNodeHistory(node, probe, cycleTs);
      await persistNodeSample(node, probe, cycleTs);
    }

    if (historyDb && cycleTs - nodeMonitor.lastDbPruneAt > DB_PRUNE_INTERVAL_MS) {
      await pruneOldHistory(cycleTs);
    }

    for (const id of [...nodeMonitor.nodes.keys()]) if (!nodeIds.has(id)) nodeMonitor.nodes.delete(id);
    nodeMonitor.lastError = null;
    nodeMonitor.lastUpdated = new Date().toISOString();
  } catch (err) {
    nodeMonitor.lastError = err.response?.data?.errors?.[0]?.detail || err.message || "Unknown error";
  } finally {
    nodeMonitor.running = false;
  }
}

async function loadNodeHistoryWindow(nodeId, fallbackHistory, windowMs) {
  const cutoff = Date.now() - windowMs;

  if (!historyDb || windowMs <= IN_MEMORY_WINDOW_MS) {
    const local = (fallbackHistory || []).filter((s) => Number(s.ts) >= cutoff);
    const raw = local.slice().sort((a, b) => Number(a.ts) - Number(b.ts));
    const graph = downsampleHistory(raw, getMaxSamplesForWindow(windowMs));
    return { raw, graph, source: "memory" };
  }

  const rows = await dbAll(
    `
      SELECT ts, at, online, maintenance, latencyMs, statusCode, probeUrl, error
      FROM node_ping_history
      WHERE nodeId = ? AND ts >= ?
      ORDER BY ts ASC
    `,
    [nodeId, cutoff]
  );

  const raw = rows.map(hydrateHistoryRow);
  const graph = downsampleHistory(raw, getMaxSamplesForWindow(windowMs));
  return { raw, graph, source: "db" };
}

function parseIncludes(searchParams) {
  const set = new Set();

  const include = String(searchParams.get("include") || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const i of include) set.add(i);

  const history = String(searchParams.get("history") || "").toLowerCase();
  if (history === "1" || history === "true") set.add("history");

  const rawHistory = String(searchParams.get("historyRaw") || "").toLowerCase();
  if (rawHistory === "1" || rawHistory === "true") set.add("historyraw");

  const bars = String(searchParams.get("uptimeBars") || "").toLowerCase();
  if (bars === "1" || bars === "true") set.add("uptimebars");

  return set;
}

async function buildNodePayload(windowMs = DEFAULT_VIEW_WINDOW_MS, options = {}) {
  const includeHistory = !!options.includeHistory;
  const includeHistoryRaw = !!options.includeHistoryRaw;
  const includeUptimeBars = !!options.includeUptimeBars;
  const nodeIdSet = Array.isArray(options.nodeIds) ? new Set(options.nodeIds.map((v) => Number(v))) : null;

  const baseNodes = [...nodeMonitor.nodes.values()].filter((n) => {
    if (!nodeIdSet) return true;
    return nodeIdSet.has(Number(n.id));
  });

  const hydrated = await Promise.all(baseNodes.map(async (entry) => {
    const { raw, graph, source } = await loadNodeHistoryWindow(entry.id, entry.history || [], windowMs);
    const stats = computeNodeWindowStats(raw, windowMs);

    const last = stats.lastSample;
    const probeUrl = entry.probeUrl || last?.probeUrl || null;

    const payload = {
      id: entry.id,
      name: entry.name,
      fqdn: entry.fqdn,
      panel: entry.panel || null,
      resources: {
        memoryMb: Number(entry.memoryMb) || 0,
        memoryGb: Number.isFinite(Number(entry.memoryMb)) ? Number((Number(entry.memoryMb) / 1024).toFixed(2)) : null,
        diskMb: Number(entry.diskMb) || 0,
        diskGb: Number.isFinite(Number(entry.diskMb)) ? Number((Number(entry.diskMb) / 1024).toFixed(2)) : null,
      },
      probe: {
        target: entry.probeTarget || null,
        url: probeUrl,
        source,
      },
      status: {
        state: stats.state,
        sinceAt: stats.stateSinceAt,
        checkedAt: last?.at || entry.lastCheckedAt || null,
        online: last ? !!last.online : null,
        maintenance: last ? !!last.maintenance : !!entry.maintenance,
        latencyMs: last?.latencyMs ?? null,
        avgLatencyMs: stats.avgLatencyMs,
        statusCode: last?.statusCode ?? entry.statusCode ?? null,
        error: last?.error ?? null,
        lastOnlineAt: stats.lastOnlineAt,
        lastOfflineAt: stats.lastOfflineAt,
      },
      metrics: {
        windowMs,
        range: getRangeLabel(windowMs),
        samples: stats.samplesInWindow,
        checks: stats.checks,
        up: stats.up,
        down: stats.down,
        uptimePercent: stats.uptimePercent,
        downDurationMs: stats.downDurationMs,
        downIncidents: stats.downIncidents,
        longestDownMs: stats.longestDownMs,
      },
    };

    if (includeUptimeBars) {
      payload.uptimeBars = computeUptimeBars(raw, windowMs);
    }

    if (includeHistoryRaw) {
      payload.historyRaw = raw;
    } else if (includeHistory) {
      payload.history = graph;
    }

    payload.historyMeta = {
      rawSamples: raw.length,
      returnedSamples: includeHistoryRaw ? raw.length : includeHistory ? graph.length : 0,
      downsampled: includeHistory && !includeHistoryRaw,
      windowMs,
    };

    return payload;
  }));

  return hydrated.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function buildNodeInfo(entry) {
  return {
    id: entry.id,
    name: entry.name,
    fqdn: entry.fqdn,
    maintenance: !!entry.maintenance,
  };
}

async function buildNodeHistoryPayload(entry, nodeId, rangeWindowMs, includeHistory, includeHistoryRaw) {
  const { raw, graph, source } = await loadNodeHistoryWindow(nodeId, entry.history || [], rangeWindowMs);
  const stats = computeNodeWindowStats(raw, rangeWindowMs);
  const uptimeBars = computeUptimeBars(raw, rangeWindowMs);
  const payload = {
    node: buildNodeInfo(entry),
    nodeId,
    rangeWindowMs,
    rangeLabel: getRangeLabel(rangeWindowMs),
    stats,
    uptimeBars,
    historyMeta: {
      rawSamples: raw.length,
      returnedSamples: includeHistoryRaw ? raw.length : includeHistory ? graph.length : 0,
      downsampled: includeHistory && !includeHistoryRaw,
      windowMs: rangeWindowMs,
      source,
    },
  };

  if (includeHistory) {
    payload.history = graph;
  }
  if (includeHistoryRaw) {
    payload.historyRaw = raw;
  }

  return payload;
}

async function buildNodeDayUptimePayload(entry, nodeId, dayOffset) {
  const { raw } = await loadNodeHistoryWindow(nodeId, entry.history || [], MAX_HISTORY_WINDOW_MS);
  const { start, end, offset } = getDayWindow(dayOffset);
  const daySamples = raw.filter((sample) => Number(sample.ts) >= start && Number(sample.ts) < end);
  const windowMs = end - start;
  const stats = computeNodeWindowStats(daySamples, windowMs, end);
  const throughput = computeUptimeBars(daySamples, windowMs);

  return {
    node: buildNodeInfo(entry),
    nodeId,
    dayOffset: offset,
    dayLabel: getDayLabel(start),
    windowMs,
    stats,
    uptimeBars: throughput,
    sampleCount: daySamples.length,
  };
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  setCorsHeaders(res);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function buildMonitorMeta(windowMs) {
  return {
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    rangeWindowMs: windowMs,
    rangeLabel: getRangeLabel(windowMs),
    maxRangeWindowMs: MAX_HISTORY_WINDOW_MS,
    lastUpdated: nodeMonitor.lastUpdated,
    lastError: nodeMonitor.lastError,
    persistenceEnabled: nodeMonitor.persistenceEnabled,
  };
}

function computeFleetSummary(nodes) {
  const summary = {
    total: Array.isArray(nodes) ? nodes.length : 0,
    operational: 0,
    offline: 0,
    maintenance: 0,
    unknown: 0,
    avgUptimePercent: null,
    avgLatencyMs: null,
  };

  const uptimeVals = [];
  const latencyVals = [];

  for (const n of nodes || []) {
    const state = n?.status?.state || "unknown";
    if (state === "operational") summary.operational++;
    else if (state === "maintenance") summary.maintenance++;
    else if (state === "offline") summary.offline++;
    else summary.unknown++;

    const up = n?.metrics?.uptimePercent;
    if (Number.isFinite(up)) uptimeVals.push(Number(up));

    const lat = n?.status?.avgLatencyMs;
    if (Number.isFinite(lat)) latencyVals.push(Number(lat));
  }

  if (uptimeVals.length) {
    summary.avgUptimePercent = Number((uptimeVals.reduce((a, b) => a + b, 0) / uptimeVals.length).toFixed(2));
  }
  if (latencyVals.length) {
    summary.avgLatencyMs = Math.round(latencyVals.reduce((a, b) => a + b, 0) / latencyVals.length);
  }

  return summary;
}

const statusServer = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || `localhost:${STATUS_PORT}`}`);
    const segments = requestUrl.pathname.split("/").filter(Boolean);

    if (req.method === "OPTIONS") {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET, OPTIONS" });
      return;
    }

    const stats = getServiceStats();
    const rangeWindowMs = resolveRangeWindow(requestUrl.searchParams.get("range"));
    const includes = parseIncludes(requestUrl.searchParams);

    const includeHistory = includes.has("history");
    const includeHistoryRaw = includes.has("historyraw");
    const includeUptimeBars = includes.has("uptimebars");

    if (requestUrl.pathname === "/api/health") {
      sendJson(res, 200, {
        ...stats,
        monitor: buildMonitorMeta(rangeWindowMs),
      });
      return;
    }

    if (requestUrl.pathname === "/api/nodes") {
      const nodes = await buildNodePayload(rangeWindowMs, { includeHistory, includeHistoryRaw, includeUptimeBars });
      sendJson(res, 200, {
        monitor: buildMonitorMeta(rangeWindowMs),
        summary: computeFleetSummary(nodes),
        nodes,
      });
      return;
    }

    if (
      segments[0] === "api" &&
      segments[1] === "nodes" &&
      Number.isFinite(Number(segments[2]))
    ) {
      const nodeId = Number(segments[2]);
      const tail = segments[3] || null;
      const entry = nodeMonitor.nodes.get(nodeId);

      if (!entry) {
        sendJson(res, 404, { error: "not_found", message: `Node ${nodeId} not monitored` });
        return;
      }

      if (tail === "ping-history") {
        const payload = await buildNodeHistoryPayload(entry, nodeId, rangeWindowMs, includeHistory, includeHistoryRaw);
        sendJson(res, 200, {
          monitor: buildMonitorMeta(rangeWindowMs),
          ...payload,
        });
        return;
      }

      if (tail === "uptime-bar") {
        const dayOffset = clampDayOffset(requestUrl.searchParams.get("day"));
        const payload = await buildNodeDayUptimePayload(entry, nodeId, dayOffset);
        sendJson(res, 200, {
          monitor: buildMonitorMeta(DAY_MS),
          ...payload,
        });
        return;
      }

      if (!tail) {
        const nodes = await buildNodePayload(rangeWindowMs, {
          includeHistory: true,
          includeHistoryRaw,
          includeUptimeBars,
          nodeIds: [nodeId],
        });
        if (!nodes.length) {
          sendJson(res, 404, { error: "not_found", message: `Node ${nodeId} not found` });
          return;
        }
        sendJson(res, 200, {
          monitor: buildMonitorMeta(rangeWindowMs),
          node: nodes[0],
        });
        return;
      }

      sendJson(res, 404, { error: "not_found", message: `Unknown node sub-route ${tail}` });
      return;
    }

    if (requestUrl.pathname === "/api/status") {
      const nodes = await buildNodePayload(rangeWindowMs, { includeHistory, includeHistoryRaw, includeUptimeBars });
      sendJson(res, 200, {
        ...stats,
        monitor: buildMonitorMeta(rangeWindowMs),
        summary: computeFleetSummary(nodes),
        nodes,
      });
      return;
    }

    if (requestUrl.pathname === "/" || requestUrl.pathname === "/status") {
      sendJson(res, 200, {
        ...stats,
        monitor: buildMonitorMeta(rangeWindowMs),
        endpoints: {
          health: "/api/health",
          nodes: "/api/nodes",
          node: "/api/nodes/:id",
          status: "/api/status",
        },
        note: "This service is API-only (no HTML dashboard).",
      });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    sendJson(res, 500, { error: "internal_error", message: err.message || "Internal error" });
  }
});

statusServer.listen(STATUS_PORT, () => console.log(`Status API → http://localhost:${STATUS_PORT}`));

async function bootstrap() {
  try {
    await initHistoryStorage();
    console.log(`[WebDB] History persistence enabled at ${HISTORY_DB_PATH}`);
  } catch (err) {
    nodeMonitor.persistenceEnabled = false;
    nodeMonitor.lastError = err.message || "History DB init failed";
    console.warn("[WebDB] Failed to initialize history DB, using in-memory history only:", err.message || err);
  }

  runNodeProbeCycle().catch((err) => {
    nodeMonitor.lastError = err.message || "Failed initial node probe";
  });

  const interval = setInterval(() => {
    runNodeProbeCycle().catch((err) => {
      nodeMonitor.lastError = err.message || "Node probe failed";
    });
  }, SAMPLE_INTERVAL_MS);
  interval.unref();
}

bootstrap();

process.on("SIGINT", () => {
  if (historyDb) {
    historyDb.close();
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  if (historyDb) {
    historyDb.close();
  }
  process.exit(0);
});
