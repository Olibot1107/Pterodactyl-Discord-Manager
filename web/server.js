const http = require("http");
const fs = require("fs");
const path = require("path");
const https = require("https");
const sqlite3 = require("sqlite3").verbose();
const axios = require("axios");
const api = require("../src/structures/Ptero");

const STATUS_PORT = 3000;
const SAMPLE_INTERVAL_MS = 4_000;
const PROBE_TIMEOUT_MS = 5_000;
const IN_MEMORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_VIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
const DB_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

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
    error: row.error || null,
  };
}

async function loadHistoryFromDb() {
  if (!historyDb) return;
  const cutoff = Date.now() - IN_MEMORY_WINDOW_MS;
  const rows = await dbAll(
    `
      SELECT nodeId, nodeName, fqdn, memoryMb, diskMb, ts, at, online, maintenance, latencyMs, error
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
      memoryMb: Number(row.memoryMb) || 0,
      diskMb: Number(row.diskMb) || 0,
      maintenance: sample.maintenance,
      online: sample.online,
      latencyMs: sample.latencyMs,
      lastCheckedAt: sample.at,
      history: [],
    };

    existing.name = row.nodeName || existing.name;
    existing.fqdn = row.fqdn || existing.fqdn;
    existing.memoryMb = Number(row.memoryMb) || existing.memoryMb;
    existing.diskMb = Number(row.diskMb) || existing.diskMb;
    existing.maintenance = sample.maintenance;
    existing.online = sample.online;
    existing.latencyMs = sample.latencyMs;
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
        nodeId, nodeName, fqdn, memoryMb, diskMb, ts, at, online, maintenance, latencyMs, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      probe.error || null,
    ]
  );
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

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    return { online: false, latencyMs: null, error: "missing fqdn", statusCode: null };
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
    };
  } catch (err) {
    return {
      online: false,
      latencyMs: null,
      error: String(err.code || err.message || "request_failed"),
      statusCode: null,
    };
  }
}

function updateNodeHistory(node, probe, nowTs = Date.now()) {
  const existing = nodeMonitor.nodes.get(node.id) || { history: [] };
  const history = Array.isArray(existing.history) ? existing.history.slice() : [];
  history.push({ ts: nowTs, at: new Date(nowTs).toISOString(), online: !!probe.online, maintenance: !!node.maintenance_mode, latencyMs: probe.latencyMs, error: probe.error });
  while (history.length && nowTs - history[0].ts > IN_MEMORY_WINDOW_MS) history.shift();
  nodeMonitor.nodes.set(node.id, {
    id: node.id, name: node.name, fqdn: node.fqdn,
    memoryMb: node.memory, diskMb: node.disk,
    maintenance: !!node.maintenance_mode,
    online: !!probe.online, latencyMs: probe.latencyMs,
    lastCheckedAt: history[history.length - 1]?.at || null,
    history,
  });
}

function formatDuration(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600),
    m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function computeNodeView(nodeEntry, windowMs = DEFAULT_VIEW_WINDOW_MS) {
  const samples = nodeEntry.history || [];
  const uptimeSamples = samples.filter((s) => !s.maintenance);
  const total = uptimeSamples.length;
  const upCount = uptimeSamples.filter((s) => s.online).length;
  const uptimePercent = total ? ((upCount / total) * 100).toFixed(2) : "0.00";
  const downCount = total - upCount;
  const downDurationMs = downCount * SAMPLE_INTERVAL_MS;
  let downIncidents = 0, longestDownMs = 0, currentDownStartTs = null;

  for (const sample of uptimeSamples) {
    if (!sample.online) {
      if (currentDownStartTs == null) { currentDownStartTs = sample.ts; downIncidents++; }
    } else if (currentDownStartTs != null) {
      longestDownMs = Math.max(longestDownMs, sample.ts - currentDownStartTs);
      currentDownStartTs = null;
    }
  }
  if (currentDownStartTs != null) longestDownMs = Math.max(longestDownMs, Date.now() - currentDownStartTs);

  const uptimeBuckets = Math.max(48, Math.min(180, Math.round(windowMs / (4 * 60 * 60 * 1000))));
  const now = Date.now(), windowStart = now - windowMs, bucketSizeMs = windowMs / uptimeBuckets;
  const buckets = Array.from({ length: uptimeBuckets }, () => ({ total: 0, up: 0, down: 0 }));
  for (const sample of uptimeSamples) {
    if (!sample.ts || sample.ts < windowStart) continue;
    const idx = Math.max(0, Math.min(uptimeBuckets - 1, Math.floor((sample.ts - windowStart) / bucketSizeMs)));
    const b = buckets[idx];
    b.total++;
    if (sample.online) b.up++; else b.down++;
  }

  const uptimeBars = buckets.map((b) => {
    if (b.total === 0) return { level: "none", uptime: null, downRatio: 0, label: "No data" };
    const uptime = b.up / b.total, downRatio = b.down / b.total;
    let level = "mixed";
    if (downRatio === 0) level = "up";
    else if (downRatio === 1) level = "down";
    const label = level === "mixed"
      ? "Intermittent (up/down in this period)"
      : `${Math.round(uptime * 100)}% up / ${Math.round(downRatio * 100)}% down`;
    return { level, uptime, downRatio, label };
  });

  let statusLabel = "Offline";
  if (nodeEntry.maintenance) statusLabel = "Maintenance";
  else if (nodeEntry.online) statusLabel = "Operational";

  // avg ping from last 30 samples
  const recentPings = samples.slice(-30).filter((s) => s.online && !s.maintenance && Number.isFinite(s.latencyMs)).map((s) => s.latencyMs);
  const avgLatencyMs = recentPings.length ? Math.round(recentPings.reduce((a, b) => a + b, 0) / recentPings.length) : null;

  return { ...nodeEntry, statusLabel, uptimePercent, checks: total, downDurationMs, downIncidents, longestDownMs, uptimeBars, avgLatencyMs };
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

// ─── Render helpers ──────────────────────────────────────────────────────────

function renderTimelineBars(barsData) {
  if (!barsData.length) return '<div class="muted">No checks yet.</div>';
  const bars = barsData.map((s, i) => {
    const h0 = ((i * 24) / barsData.length).toFixed(1);
    const h1 = (((i + 1) * 24) / barsData.length).toFixed(1);
    const tip = escapeHtml(`${h0}h–${h1}h · ${s.label}`);
    if (s.level === "mixed") {
      const pct = Math.round((s.downRatio || 0) * 100);
      return `<span class="bar bar-mixed" style="background:linear-gradient(to top,var(--red) ${pct}%,var(--green) ${pct}%);" title="${tip}"></span>`;
    }
    return `<span class="bar bar-${s.level}" title="${tip}"></span>`;
  }).join("");
  return `<div class="timeline">${bars}</div>`;
}

function downsampleHistoryForGraph(history, maxPoints = 260) {
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
      error: chunkOnline ? null : (last.error || "downsampled_down"),
    });
  }

  return reduced;
}

function getWindowAxisLabels(windowMs) {
  const formatAgo = (ms) => {
    const days = ms / (24 * 60 * 60 * 1000);
    if (days >= 60) return `${Math.round(days / 30)}mo ago`;
    if (days >= 2) return `${Math.round(days)}d ago`;
    return `${Math.round(ms / (60 * 60 * 1000))}h ago`;
  };
  return {
    start: formatAgo(windowMs),
    mid: formatAgo(windowMs / 2),
  };
}

function renderPingGraph(history, windowMs = DEFAULT_VIEW_WINDOW_MS) {
  if (!history.length) return '<div class="muted small">No ping data yet.</div>';
  const viewHistory = downsampleHistoryForGraph(history, 260);
  const W = 760, H = 110, P = 12;
  const latencies = viewHistory.filter((s) => s.online && !s.maintenance && Number.isFinite(s.latencyMs)).map((s) => s.latencyMs);
  const maxLat = Math.max(150, ...(latencies.length ? latencies : [150]));
  const uw = W - P * 2, uh = H - P * 2;
  const stepX = viewHistory.length > 1 ? uw / (viewHistory.length - 1) : 0;

  const points = viewHistory.map((s, i) => {
    const x = P + i * stepX;
    if (!s.online || s.maintenance || !Number.isFinite(s.latencyMs)) return { x, y: null };
    const norm = s.latencyMs / Math.max(1, maxLat);
    return { x, y: H - P - norm * uh };
  });

  let pathStr = "", paths = [];
  for (const pt of points) {
    if (pt.y == null) { if (pathStr) { paths.push(pathStr); pathStr = ""; } continue; }
    pathStr += `${pathStr ? " L" : "M"}${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
  }
  if (pathStr) paths.push(pathStr);

  // fill area under line
  const fillPaths = paths.map((d) => {
    const first = d.match(/M([\d.]+) ([\d.]+)/);
    const last = d.match(/.*L([\d.]+) ([\d.]+)$/) || first;
    if (!first || !last) return "";
    return `<path d="${d} L${last[1]} ${H - P} L${first[1]} ${H - P} Z" class="ping-fill"/>`;
  });

  // maintenance bands
  let maintenanceBands = [], maintStart = null;
  for (let i = 0; i < viewHistory.length; i++) {
    if (viewHistory[i].maintenance) { if (maintStart == null) maintStart = i; }
    else if (maintStart != null) { maintenanceBands.push({ s: maintStart, e: i - 1 }); maintStart = null; }
  }
  if (maintStart != null) maintenanceBands.push({ s: maintStart, e: viewHistory.length - 1 });

  const maintenanceRects = maintenanceBands.map((b) => {
    const half = Math.max(2, stepX / 2);
    const sx = Math.max(P, P + b.s * stepX - half);
    const ex = Math.min(W - P, P + b.e * stepX + half);
    const maintDurationMs = Math.max(SAMPLE_INTERVAL_MS, Number(viewHistory[b.e].ts || 0) - Number(viewHistory[b.s].ts || 0));
    const tip = escapeHtml(`${viewHistory[b.s].at} → ${viewHistory[b.e].at} · maintenance ${formatDuration(maintDurationMs)}`);
    return `<rect x="${sx.toFixed(1)}" y="${P}" width="${Math.max(2, ex - sx).toFixed(1)}" height="${uh}" class="maintenance-band"><title>${tip}</title></rect>`;
  }).join("");

  // outage bands
  let bands = [], outStart = null;
  for (let i = 0; i < viewHistory.length; i++) {
    if (!viewHistory[i].online) { if (outStart == null) outStart = i; }
    else if (outStart != null) { bands.push({ s: outStart, e: i - 1 }); outStart = null; }
  }
  if (outStart != null) bands.push({ s: outStart, e: viewHistory.length - 1 });

  const oRects = bands.map((b) => {
    const half = Math.max(2, stepX / 2);
    const sx = Math.max(P, P + b.s * stepX - half);
    const ex = Math.min(W - P, P + b.e * stepX + half);
    const downDurationMs = Math.max(SAMPLE_INTERVAL_MS, Number(viewHistory[b.e].ts || 0) - Number(viewHistory[b.s].ts || 0));
    const tip = escapeHtml(`${viewHistory[b.s].at} → ${viewHistory[b.e].at} · down ${formatDuration(downDurationMs)}`);
    return `<rect x="${sx.toFixed(1)}" y="${P}" width="${Math.max(2, ex - sx).toFixed(1)}" height="${uh}" class="outage-band"><title>${tip}</title></rect>`;
  }).join("");

  const pingDots = (viewHistory.length <= 180 ? points.filter((p) => p.y != null) : [])
    .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2" class="ping-dot"/>`)
    .join("");

  const hitW = Math.max(4, stepX || 4);
  const hits = viewHistory.map((s, i) => {
    const x = P + i * stepX - hitW / 2;
    let tip = `${s.at} · offline${s.error ? ` (${s.error})` : ""}`;
    if (s.maintenance) tip = `${s.at} · maintenance`;
    else if (s.online && Number.isFinite(s.latencyMs)) tip = `${s.at} · ${s.latencyMs}ms`;
    return `<rect x="${x.toFixed(1)}" y="${P}" width="${hitW.toFixed(1)}" height="${uh}" fill="transparent"><title>${escapeHtml(tip)}</title></rect>`;
  }).join("");

  const gridY = [P, H / 2, H - P];
  const gridLabels = [maxLat, Math.round(maxLat / 2), 0].map((v, i) =>
    `<text x="${W - P - 2}" y="${gridY[i] + 4}" class="axis-lbl">${v}ms</text>`
  ).join("");

  const gridLines = gridY.map((y) => `<line x1="${P}" y1="${y}" x2="${W - P}" y2="${y}" class="grid-line"/>`).join("");

  return `<div class="graph-wrap">
    <svg class="ping-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="fillGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#5a7dff" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#5a7dff" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      ${gridLines}${maintenanceRects}${oRects}
      ${fillPaths.join("")}
      ${paths.map((d) => `<path d="${d}" class="ping-line"/>`).join("")}
      ${pingDots}${gridLabels}${hits}
    </svg>
    <div class="graph-scale"><span>${getWindowAxisLabels(windowMs).start}</span><span>${getWindowAxisLabels(windowMs).mid}</span><span>Now</span></div>
  </div>`;
}

function statusBadge(label) {
  const cls = label === "Operational" ? "badge-ok" : label === "Maintenance" ? "badge-warn" : "badge-bad";
  const dot = label === "Operational" ? "dot-ok" : label === "Maintenance" ? "dot-warn" : "dot-bad";
  return `<span class="badge ${cls}"><span class="dot ${dot}"></span>${label}</span>`;
}

function renderNodeCard(node, windowMs = DEFAULT_VIEW_WINDOW_MS, rangeLabel = "24h") {
  const timeline = renderTimelineBars(node.uptimeBars || []);
  const graph = renderPingGraph(node.history || [], windowMs);
  const pingDisplay = node.latencyMs != null ? `${node.latencyMs}ms` : "—";
  const avgPingDisplay = node.avgLatencyMs != null ? `${node.avgLatencyMs}ms` : "—";
  const checkedAtDisplay = node.lastCheckedAt ? new Date(node.lastCheckedAt).toLocaleTimeString() : "—";
  const axis = getWindowAxisLabels(windowMs);

  return `<div class="node-card">
    <div class="node-head">
      <div class="node-title">
        <span class="node-name">${escapeHtml(node.name)}</span>
        <span class="node-id">#${node.id}</span>
      </div>
      ${statusBadge(node.statusLabel)}
    </div>
    <div class="node-fqdn">${escapeHtml(node.fqdn || "No FQDN")}</div>
    <div class="node-stats">
      <div class="stat-chip"><span class="chip-label">RAM</span><span class="chip-val">${(node.memoryMb / 1024).toFixed(1)} GB</span></div>
      <div class="stat-chip"><span class="chip-label">Disk</span><span class="chip-val">${(node.diskMb / 1024).toFixed(0)} GB</span></div>
      <div class="stat-chip"><span class="chip-label">Ping</span><span class="chip-val">${pingDisplay}</span></div>
      <div class="stat-chip"><span class="chip-label">Avg Ping</span><span class="chip-val">${avgPingDisplay}</span></div>
      <div class="stat-chip"><span class="chip-label">Uptime ${rangeLabel}</span><span class="chip-val">${node.uptimePercent}%</span></div>
      <div class="stat-chip"><span class="chip-label">Checks</span><span class="chip-val">${node.checks}</span></div>
      <div class="stat-chip"><span class="chip-label">Incidents</span><span class="chip-val">${node.downIncidents}</span></div>
      <div class="stat-chip"><span class="chip-label">Downtime</span><span class="chip-val">${formatDuration(node.downDurationMs)}</span></div>
      <div class="stat-chip"><span class="chip-label">Longest Outage</span><span class="chip-val">${formatDuration(node.longestDownMs)}</span></div>
      <div class="stat-chip"><span class="chip-label">Last Check</span><span class="chip-val">${checkedAtDisplay}</span></div>
    </div>
    ${graph}
    <div class="timeline-wrap">
      ${timeline}
      <div class="timeline-meta"><span>${axis.start}</span><span class="uptime-pct">${node.uptimePercent}% uptime</span><span>Now</span></div>
    </div>
  </div>`;
}

function renderStatusPage(stats, nodes, nodeError, lastNodeUpdate) {
  const rangeLabel = getRangeLabel(DEFAULT_VIEW_WINDOW_MS);
  const allOnline = nodes.every((n) => n.statusLabel === "Operational" || n.statusLabel === "Maintenance");
  const anyDown = nodes.some((n) => n.statusLabel === "Offline");
  const overallLabel = anyDown ? "Partial Outage" : allOnline ? "All Systems Operational" : "Checking…";
  const overallClass = anyDown ? "overall-bad" : "overall-ok";
  const operationalNodes = nodes.filter((n) => n.statusLabel === "Operational").length;
  const maintenanceNodes = nodes.filter((n) => n.statusLabel === "Maintenance").length;
  const offlineNodes = nodes.filter((n) => n.statusLabel === "Offline").length;
  const onlineNodes = operationalNodes + maintenanceNodes;
  const nodeAvailabilityPct = nodes.length ? Math.round((onlineNodes / nodes.length) * 100) : 0;
  const fleetAvgUptime = nodes.length
    ? (nodes.reduce((sum, n) => sum + Number(n.uptimePercent || 0), 0) / nodes.length).toFixed(2)
    : "0.00";
  const fleetAvgPingValues = nodes.map((n) => n.avgLatencyMs).filter((v) => Number.isFinite(v));
  const fleetAvgPing = fleetAvgPingValues.length
    ? `${Math.round(fleetAvgPingValues.reduce((sum, v) => sum + v, 0) / fleetAvgPingValues.length)}ms`
    : "—";
  const initialPayload = JSON.stringify({
    ...stats,
    monitor: {
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      rangeWindowMs: DEFAULT_VIEW_WINDOW_MS,
      rangeLabel,
      maxRangeWindowMs: MAX_HISTORY_WINDOW_MS,
      lastUpdated: lastNodeUpdate,
      lastError: nodeError || null,
      persistenceEnabled: nodeMonitor.persistenceEnabled,
    },
    nodes,
  }).replace(/</g, "\\u003c");
  const nodeCards = nodeError
    ? `<div class="error-box">⚠ Failed to load node data: ${escapeHtml(nodeError)}</div>`
    : (nodes.length ? nodes.map((node) => renderNodeCard(node, DEFAULT_VIEW_WINDOW_MS, rangeLabel)).join("") : '<div class="muted">No nodes found.</div>');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Status — Discord Bot</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #06090f;
      --surface: #0d1420;
      --surface-2: #111b2c;
      --border: #1e2d44;
      --border-2: #28394f;
      --text: #dde8f8;
      --muted: #7a90b4;
      --muted-2: #4a5f80;
      --green: #2ee87a;
      --green-glow: rgba(46,232,122,0.18);
      --red: #ff5757;
      --amber: #ffb347;
      --blue: #4f8eff;
      --blue-glow: rgba(79,142,255,0.2);
      --radius: 14px;
      --radius-sm: 8px;
    }
    body {
      font-family: "Inter", "Segoe UI", system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 32px 20px 64px;
      min-height: 100vh;
    }
    .wrap { max-width: 960px; margin: 0 auto; display: grid; gap: 20px; }

    /* Overall status banner */
    .overall-banner {
      padding: 20px 24px;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      display: flex; align-items: center; gap: 16px;
    }
    .overall-ok { background: linear-gradient(135deg, #06160e 0%, #091220 100%); border-color: rgba(46,232,122,0.3); }
    .overall-bad { background: linear-gradient(135deg, #160808 0%, #0d1220 100%); border-color: rgba(255,87,87,0.3); }
    .overall-icon { font-size: 28px; }
    .overall-text h2 { font-size: 20px; font-weight: 700; }
    .overall-ok .overall-text h2 { color: var(--green); }
    .overall-bad .overall-text h2 { color: var(--red); }
    .overall-text p { color: var(--muted); font-size: 13px; margin-top: 3px; }

    /* Cards */
    .card {
      background: linear-gradient(160deg, var(--surface) 0%, var(--surface-2) 100%);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 24px;
    }
    .card-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 16px; }

    /* Bot stats grid */
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
    .stat-block { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px 16px; }
    .stat-block .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .07em; margin-bottom: 6px; }
    .stat-block .value { font-size: 22px; font-weight: 700; }
    .value-ok { color: var(--green); }
    .value-warn { color: var(--amber); }
    .value-muted { color: var(--muted); font-size: 14px !important; font-weight: 500 !important; }

    /* Cluster bar */
    .cluster-bar-wrap { margin-top: 14px; }
    .cluster-bar-label { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
    .cluster-bar-track { height: 6px; background: var(--border); border-radius: 99px; overflow: hidden; }
    .cluster-bar-fill { height: 100%; background: linear-gradient(90deg, var(--blue), var(--green)); border-radius: 99px; transition: width .4s ease; }

    /* Fleet quick summary */
    .fleet-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px;
      margin-top: 14px;
    }
    .fleet-pill {
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: #08101c;
      padding: 10px 12px;
    }
    .fleet-pill .k { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .07em; margin-bottom: 4px; }
    .fleet-pill .v { font-size: 18px; font-weight: 700; color: var(--text); }
    .fleet-pill .v.ok { color: var(--green); }
    .fleet-pill .v.warn { color: var(--amber); }
    .fleet-pill .v.bad { color: var(--red); }

    /* Badge */
    .badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 99px; font-size: 12px; font-weight: 600; }
    .badge-ok { background: rgba(46,232,122,0.12); color: var(--green); border: 1px solid rgba(46,232,122,0.25); }
    .badge-warn { background: rgba(255,179,71,0.12); color: var(--amber); border: 1px solid rgba(255,179,71,0.25); }
    .badge-bad { background: rgba(255,87,87,0.12); color: var(--red); border: 1px solid rgba(255,87,87,0.3); }
    .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .dot-ok { background: var(--green); box-shadow: 0 0 6px var(--green); animation: pulse 2s infinite; }
    .dot-warn { background: var(--amber); }
    .dot-bad { background: var(--red); box-shadow: 0 0 6px var(--red); animation: pulse-red 1.4s infinite; }
    @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:0.4;} }
    @keyframes pulse-red { 0%,100%{opacity:1;box-shadow:0 0 6px var(--red);} 50%{opacity:0.6;box-shadow:0 0 12px var(--red);} }

    /* Node cards */
    .nodes-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
    .nodes-section h2 { font-size: 16px; font-weight: 700; margin-bottom: 0; }
    .range-control { display: inline-flex; align-items: center; gap: 8px; }
    .range-label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
    .range-select {
      background: #091221;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 7px;
      font-size: 12px;
      padding: 6px 8px;
    }
    .legend { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 14px; }
    .legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
    .legend-dot { width: 10px; height: 10px; border-radius: 2px; }

    .node-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
      margin-bottom: 12px;
      transition: border-color .2s;
    }
    .node-card:last-child { margin-bottom: 0; }
    .node-card:hover { border-color: var(--border-2); }
    .node-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px; }
    .node-title { display: flex; align-items: baseline; gap: 8px; }
    .node-name { font-size: 15px; font-weight: 700; }
    .node-id { font-size: 11px; color: var(--muted-2); background: var(--surface); border: 1px solid var(--border); padding: 1px 6px; border-radius: 4px; }
    .node-fqdn { font-size: 12px; color: var(--muted); margin-bottom: 10px; font-family: "SF Mono", "Fira Code", monospace; }

    /* Stat chips */
    .node-stats { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
    .stat-chip { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 5px 10px; font-size: 12px; display: flex; gap: 6px; align-items: center; }
    .chip-label { color: var(--muted); }
    .chip-val { font-weight: 600; color: var(--text); }

    /* Graph */
    .graph-wrap { margin-bottom: 12px; }
    .ping-svg { width: 100%; height: 110px; display: block; border: 1px solid var(--border); border-radius: var(--radius-sm); background: #050a14; }
    .grid-line { stroke: #1a2740; stroke-width: 1; }
    .outage-band { fill: rgba(255,87,87,0.18); stroke: rgba(255,87,87,0.4); stroke-width: .8; }
    .maintenance-band { fill: rgba(255,179,71,0.18); stroke: rgba(255,179,71,0.45); stroke-width: .8; }
    .ping-fill { fill: url(#fillGrad); }
    .ping-line { fill: none; stroke: var(--blue); stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; }
    .ping-dot { fill: #c6d8ff; opacity: 0.2; }
    .axis-lbl { fill: var(--muted-2); font-size: 9px; text-anchor: end; font-family: monospace; }
    .graph-scale { display: flex; justify-content: space-between; margin-top: 5px; font-size: 11px; color: var(--muted-2); }

    /* Timeline */
    .timeline-wrap { margin-top: 8px; }
    .timeline { display: flex; gap: 3px; height: 56px; border-radius: 6px; overflow: hidden; align-items: stretch; }
    .bar { flex: 1 1 0; min-width: 6px; display: block; border-radius: 3px; transition: opacity .1s; }
    .bar:hover { opacity: .75; filter: brightness(1.3); }
    .bar-up { background: linear-gradient(to bottom, #3eff8b, var(--green)); opacity: .9; }
    .bar-down { background: linear-gradient(to bottom, #ff7070, var(--red)); }
    .bar-maint { background: linear-gradient(to bottom, #ffd080, var(--amber)); }
    .bar-mixed { }
    .bar-none { background: #131e2e; }
    .timeline-meta { display: flex; justify-content: space-between; margin-top: 6px; font-size: 11px; color: var(--muted-2); }
    .uptime-pct { color: var(--text); font-weight: 700; font-size: 12px; }

    /* Error box */
    .error-box { background: rgba(255,87,87,0.08); border: 1px solid rgba(255,87,87,0.3); border-radius: var(--radius-sm); padding: 14px 16px; color: #ff8888; font-size: 13px; }

    .muted { color: var(--muted); }
    .small { font-size: 12px; }

    /* Auto-refresh indicator */
    .refresh-bar { height: 2px; background: var(--border); border-radius: 99px; overflow: hidden; margin-top: 16px; }
    .refresh-fill { height: 100%; background: var(--blue); border-radius: 99px; animation: shrink ${SAMPLE_INTERVAL_MS}ms linear infinite; transform-origin: left; }
    @keyframes shrink { from{width:100%} to{width:0%} }

    @media(max-width:600px) {
      .stats-grid { grid-template-columns: 1fr 1fr; }
      .node-stats { gap: 5px; }
    }
  </style>
</head>
<body>
<div class="wrap">

  <div id="overall-banner" class="overall-banner ${overallClass}">
    <div id="overall-icon" class="overall-icon">${anyDown ? "⚠️" : "✅"}</div>
    <div class="overall-text">
      <h2 id="overall-label">${overallLabel}</h2>
      <p id="overall-sub">Last checked ${lastNodeUpdate ? new Date(lastNodeUpdate).toLocaleTimeString() : "—"} &nbsp;·&nbsp; Auto-updating every ${SAMPLE_INTERVAL_MS / 1000}s</p>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Web Monitor Health</div>
    <div class="stats-grid">
      <div class="stat-block">
        <div class="label">Status</div>
        <div id="metric-status" class="value ${stats.status === "ok" ? "value-ok" : "value-warn"}">${stats.status === "ok" ? "Online" : "Degraded"}</div>
      </div>
      <div class="stat-block">
        <div class="label">Monitor Uptime</div>
        <div id="metric-uptime" class="value value-ok">${formatUptime(stats.uptimeSeconds)}</div>
      </div>
      <div class="stat-block">
        <div class="label">Nodes Online</div>
        <div id="metric-nodes-online" class="value">${onlineNodes}<span style="font-size:14px;color:var(--muted)">/${nodes.length}</span></div>
      </div>
    </div>
    <div class="fleet-grid">
      <div class="fleet-pill"><span class="k">Operational</span><span id="metric-operational" class="v ok">${operationalNodes}</span></div>
      <div class="fleet-pill"><span class="k">Maintenance</span><span id="metric-maintenance" class="v warn">${maintenanceNodes}</span></div>
      <div class="fleet-pill"><span class="k">Offline</span><span id="metric-offline" class="v bad">${offlineNodes}</span></div>
      <div class="fleet-pill"><span class="k">Fleet Avg Uptime</span><span id="metric-fleet-uptime" class="v">${fleetAvgUptime}%</span></div>
      <div class="fleet-pill"><span class="k">Fleet Avg Ping</span><span id="metric-fleet-ping" class="v">${fleetAvgPing}</span></div>
    </div>
    <div class="cluster-bar-wrap">
      <div class="cluster-bar-label"><span>Node availability</span><span id="metric-availability">${nodeAvailabilityPct}%</span></div>
      <div class="cluster-bar-track"><div id="metric-availability-bar" class="cluster-bar-fill" style="width:${nodeAvailabilityPct}%"></div></div>
    </div>
    <div class="refresh-bar"><div class="refresh-fill"></div></div>
  </div>

  <div class="card nodes-section">
    <div class="nodes-head">
      <h2>Node Status</h2>
      <div class="range-control">
        <span class="range-label">Range</span>
        <select id="range-select" class="range-select">
          <option value="24h" selected>24h</option>
          <option value="7d">7d</option>
        </select>
      </div>
    </div>
    <div class="legend">
      <span class="legend-item"><span class="legend-dot" style="background:var(--green);"></span>Operational</span>
      <span class="legend-item"><span class="legend-dot" style="background:var(--red);"></span>Down</span>
      <span class="legend-item"><span class="legend-dot" style="background:var(--amber);"></span>Maintenance</span>
      <span class="legend-item"><span class="legend-dot" style="background:#8866ff;"></span>Intermittent</span>
      <span class="legend-item"><span class="legend-dot" style="background:#1a2535;"></span>No data</span>
    </div>
    <div id="nodes-root">${nodeCards}</div>
  </div>

</div>
<script>
  window.__STATUS_INITIAL__ = ${initialPayload};
</script>
<script src="/client.js"></script>
</body>
</html>`;
}

function getMaxSamplesForWindow(windowMs) {
  if (windowMs >= RANGE_MAP["7d"]) return 360;
  return 260;
}

async function loadNodeHistoryWindow(nodeId, fallbackHistory, windowMs) {
  const cutoff = Date.now() - windowMs;

  if (!historyDb || windowMs <= IN_MEMORY_WINDOW_MS) {
    const local = (fallbackHistory || []).filter((s) => Number(s.ts) >= cutoff);
    return downsampleHistoryForGraph(local, getMaxSamplesForWindow(windowMs));
  }

  const rows = await dbAll(
    `
      SELECT ts, at, online, maintenance, latencyMs, error
      FROM node_ping_history
      WHERE nodeId = ? AND ts >= ?
      ORDER BY ts ASC
    `,
    [nodeId, cutoff]
  );

  const hydrated = rows.map(hydrateHistoryRow);
  return downsampleHistoryForGraph(hydrated, getMaxSamplesForWindow(windowMs));
}

async function buildNodePayload(windowMs = DEFAULT_VIEW_WINDOW_MS) {
  const baseNodes = [...nodeMonitor.nodes.values()];
  const hydrated = await Promise.all(baseNodes.map(async (entry) => {
    const history = await loadNodeHistoryWindow(entry.id, entry.history || [], windowMs);
    return computeNodeView({ ...entry, history }, windowMs);
  }));

  return hydrated.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

const statusServer = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || `localhost:${STATUS_PORT}`}`);
    const stats = getServiceStats();
    const rangeWindowMs = resolveRangeWindow(requestUrl.searchParams.get("range"));
    const rangeLabel = getRangeLabel(rangeWindowMs);

    if (requestUrl.pathname === "/client.js") {
      const clientScriptPath = path.join(__dirname, "client.js");
      const script = fs.readFileSync(clientScriptPath, "utf8");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
      res.end(script);
      return;
    }

    if (requestUrl.pathname === "/api/status") {
      const nodes = await buildNodePayload(rangeWindowMs);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...stats,
        monitor: {
          sampleIntervalMs: SAMPLE_INTERVAL_MS,
          rangeWindowMs,
          rangeLabel,
          maxRangeWindowMs: MAX_HISTORY_WINDOW_MS,
          lastUpdated: nodeMonitor.lastUpdated,
          lastError: nodeMonitor.lastError,
          persistenceEnabled: nodeMonitor.persistenceEnabled,
        },
        nodes,
      }));
      return;
    }

    if (requestUrl.pathname === "/" || requestUrl.pathname === "/status") {
      const nodes = await buildNodePayload(DEFAULT_VIEW_WINDOW_MS);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderStatusPage(stats, nodes, nodeMonitor.lastError, nodeMonitor.lastUpdated));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: err.message || "Internal error" }));
  }
});

statusServer.listen(STATUS_PORT, () => console.log(`Status page → http://localhost:${STATUS_PORT}`));

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
