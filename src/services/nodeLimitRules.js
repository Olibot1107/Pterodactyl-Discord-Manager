const { serverCreation } = require("../../settings");
const api = require("../structures/Ptero");
const { updateServerBuild } = require("../structures/pteroBuild");

const SUPPORTED_LIMIT_KEYS = ["memory", "swap", "disk", "io", "cpu"];

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeNodeRules() {
  const rules = Array.isArray(serverCreation?.nodeRules) ? serverCreation.nodeRules : [];

  return rules
    .map((rule) => {
      if (!rule || typeof rule !== "object") return null;

      const match = String(rule.match || rule.nodeName || rule.name || "").trim();
      if (!match) return null;

      const mode = String(rule.matchMode || rule.mode || "includes").toLowerCase();
      const minimumLimits = rule.minimumLimits || rule.limits || {};
      const normalizedMinimums = {};

      for (const key of SUPPORTED_LIMIT_KEYS) {
        const limit = toFiniteNumber(minimumLimits[key]);
        if (limit !== null) {
          normalizedMinimums[key] = Math.max(0, Math.floor(limit));
        }
      }

      if (!Object.keys(normalizedMinimums).length) return null;

      return {
        match,
        mode,
        minimumLimits: normalizedMinimums,
      };
    })
    .filter(Boolean);
}

function nodeMatchesRule(nodeName, rule) {
  const value = String(nodeName || "").trim().toLowerCase();
  const target = String(rule.match || "").trim().toLowerCase();
  if (!value || !target) return false;

  if (rule.mode === "exact") return value === target;
  if (rule.mode === "regex") {
    try {
      return new RegExp(rule.match, "i").test(String(nodeName || ""));
    } catch {
      return false;
    }
  }

  return value.includes(target);
}

function getNodeMinimumLimits(nodeName) {
  const matchedRules = normalizeNodeRules().filter((rule) => nodeMatchesRule(nodeName, rule));
  if (!matchedRules.length) return null;

  const merged = {};
  for (const rule of matchedRules) {
    for (const [key, value] of Object.entries(rule.minimumLimits)) {
      const current = merged[key];
      merged[key] = current === undefined ? value : Math.max(current, value);
    }
  }

  return merged;
}

function applyMinimumLimits(currentLimits = {}, minimumLimits = {}) {
  const nextLimits = { ...currentLimits };
  let changed = false;

  for (const [key, minimum] of Object.entries(minimumLimits)) {
    if (!SUPPORTED_LIMIT_KEYS.includes(key)) continue;

    const currentValue = toFiniteNumber(currentLimits[key]);
    const nextValue = currentValue === null ? minimum : Math.max(currentValue, minimum);

    if (currentValue !== nextValue) {
      nextLimits[key] = nextValue;
      changed = true;
    }
  }

  return { nextLimits, changed };
}

async function fetchAllPages(endpoint) {
  const results = [];
  for (let page = 1; ; page++) {
    const { data } = await api.get(`${endpoint}?page=${page}&per_page=100`);
    const items = data.data ?? [];
    results.push(...items);
    if (items.length < 100) break;
  }
  return results;
}

async function getNodeNameByServerId(serverId) {
  const server = await api.get(`/servers/${serverId}`);
  const attrs = server.data?.attributes || {};
  const nodeId = toFiniteNumber(attrs.node ?? attrs.node_id ?? attrs.nodeId);

  if (nodeId === null) return null;

  const nodes = await fetchAllPages("/nodes");
  const node = nodes.find((entry) => toFiniteNumber(entry?.attributes?.id) === nodeId);
  return node?.attributes?.name || attrs.nodeName || attrs.node_name || null;
}

async function applyNodeMinimumLimitsToServer(serverId, nodeNameOverride = null) {
  const nodeName = nodeNameOverride || (await getNodeNameByServerId(serverId));
  if (!nodeName) return { matched: false, changed: false, nodeName: null };

  const minimumLimits = getNodeMinimumLimits(nodeName);
  if (!minimumLimits) return { matched: false, changed: false, nodeName };

  const attrs = await api.get(`/servers/${serverId}`);
  const serverAttrs = attrs.data?.attributes || {};
  const currentLimits = serverAttrs.limits || {};
  const { nextLimits, changed } = applyMinimumLimits(currentLimits, minimumLimits);

  if (!changed) {
    return { matched: true, changed: false, nodeName, minimumLimits };
  }

  await updateServerBuild(serverId, nextLimits);
  return { matched: true, changed: true, nodeName, minimumLimits, nextLimits };
}

async function getNodeLimitBackfillCandidates() {
  const nodes = await fetchAllPages("/nodes");
  const nodesById = new Map(
    nodes
      .map((node) => node?.attributes)
      .filter(Boolean)
      .map((node) => [toFiniteNumber(node.id), node.name || `Node ${node.id}`])
      .filter(([id]) => Number.isFinite(id))
  );

  const servers = await fetchAllPages("/servers");
  const candidates = [];

  for (const entry of servers) {
    const server = entry?.attributes;
    if (!server?.id) continue;

    const nodeName =
      nodesById.get(toFiniteNumber(server.node ?? server.node_id ?? server.nodeId)) ||
      server.nodeName ||
      server.node_name ||
      null;
    const minimumLimits = getNodeMinimumLimits(nodeName);
    if (!minimumLimits) continue;

    const currentDisk = toFiniteNumber(server.limits?.disk) ?? 0;
    const minimumDisk = toFiniteNumber(minimumLimits.disk);
    if (minimumDisk === null) continue;
    if (currentDisk >= minimumDisk) continue;

    candidates.push({
      id: server.id,
      identifier: server.identifier || server.uuid || String(server.id),
      nodeName,
      minimumLimits,
      currentLimits: server.limits || {},
    });
  }

  return candidates;
}

async function syncNodeMinimumLimits() {
  const rules = normalizeNodeRules();
  if (!rules.length) return { scanned: 0, updated: 0 };

  const candidates = await getNodeLimitBackfillCandidates();
  let updated = 0;

  for (const server of candidates) {
    const { nextLimits, changed } = applyMinimumLimits(server.currentLimits, server.minimumLimits);
    if (!changed) continue;

    try {
      await updateServerBuild(server.id, nextLimits);
      updated += 1;
      console.log(
        `[NodeRules] Updated ${server.identifier} on ${server.nodeName || "unknown node"} to meet configured minimums.`
      );
    } catch (err) {
      console.warn(
        `[NodeRules] Failed to update ${server.identifier} on ${server.nodeName || "unknown node"}:`,
        err.response?.data || err.message || err
      );
    }
  }

  return { scanned: candidates.length, updated };
}

module.exports = {
  applyMinimumLimits,
  applyNodeMinimumLimitsToServer,
  getNodeMinimumLimits,
  syncNodeMinimumLimits,
};
