
const fs = require("fs/promises");
const path = require("path");
const api = require("../structures/Ptero");

const STATE_PATH = path.join(__dirname, "../data/purge_state.json");
const COUNTDOWN_CHANNEL_ID = "1478053823783112887";
const COUNTDOWN_UPDATE_INTERVAL_MS = 30_000;
const MAX_DIRECTORY_VISITS = 30;
const MAX_LISTED_DELETIONS = 8;
const SYSTEM_FILE_NAMES = new Set(["server.log", "server.err.log", ".ptero", ".pterodactyl"]);
const DEFAULT_STATE = {
  countdownMessageId: null,
  lastDeletedServers: [],
  lastDeletedCount: 0,
  lastRunAt: null,
  nextRunAt: null,
  pingRoleEnabled: true,
};

let state = null;
let countdownInterval = null;
let nextRunTimer = null;
let running = false;
let started = false;
let channelWarningLogged = false;

function isFileEntry(entry) {
  if (!entry) return false;
  if (entry.is_file === true) return true;
  if (typeof entry.type === "string" && entry.type.toLowerCase() === "file") return true;
  if (typeof entry.mode === "string" && entry.mode[0] === "-") return true;
  return false;
}

function isDirectoryEntry(entry) {
  if (!entry) return false;
  if (entry.is_dir === true) return true;
  if (typeof entry.type === "string" && entry.type.toLowerCase() === "dir") return true;
  if (typeof entry.mode === "string" && entry.mode[0] === "d") return true;
  return false;
}

function entryName(entry) {
  return (entry?.name || entry?.filename || entry?.file || "").toString();
}

function normalizeChildPath(base, child) {
  if (!child) return null;
  const normalizedChild = child.replace(/^\/+/, "");
  if (!normalizedChild) return base;
  if (base === "/") return `/${normalizedChild}`;
  return `${base}/${normalizedChild}`.replace(/\/+/g, "/");
}

function computeNextRun(reference = new Date()) {
  const base = new Date(reference);
  base.setHours(17, 30, 0, 0);
  if (base.getTime() <= reference.getTime()) {
    base.setDate(base.getDate() + 1);
  }
  return base;
}

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, "0")}h ${minutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
}

async function readState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_STATE,
      ...parsed,
      lastDeletedServers: Array.isArray(parsed?.lastDeletedServers)
        ? parsed.lastDeletedServers
        : DEFAULT_STATE.lastDeletedServers,
      lastDeletedCount: Number.isFinite(parsed?.lastDeletedCount)
        ? parsed.lastDeletedCount
        : DEFAULT_STATE.lastDeletedCount,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

async function persistState() {
  if (!state) return;
  try {
    await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
    await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn("[Purge] Failed to persist purge state:", err.message || err);
  }
}

async function fetchAllServers() {
  const servers = [];
  for (let page = 1; ; page += 1) {
    const response = await api.get(`/servers?page=${page}&per_page=100`);
    const payload = response.data?.data || [];
    servers.push(...payload);
    if (payload.length < 100) break;
  }
  return servers;
}

async function listDirectory(serverId, directory = "/") {
  const response = await api.get(`/servers/${serverId}/files/list`, {
    params: {
      directory,
    },
  });
  const data = response.data?.data || response.data?.attributes?.data || [];
  if (!Array.isArray(data)) return [];
  return data;
}

async function serverHasFiles(server) {
  const serverId = server?.attributes?.id || server?.id;
  if (!serverId) return true;
  const queue = ["/"];
  const queuedPaths = new Set(queue);
  const visited = new Set();
  let visits = 0;

  while (queue.length && visits < MAX_DIRECTORY_VISITS) {
    const currentDir = queue.shift();
    queuedPaths.delete(currentDir);
    if (!currentDir || visited.has(currentDir)) continue;
    visited.add(currentDir);
    visits += 1;

    let entries;
    try {
      entries = await listDirectory(serverId, currentDir);
    } catch (err) {
      console.warn(
        `[Purge] Unable to inspect ${currentDir} for server ${server.attributes?.identifier || serverId}:`,
        err.message || err
      );
      return true;
    }

    for (const entry of entries) {
      const name = entryName(entry).toLowerCase();
      if (isFileEntry(entry)) {
        if (!SYSTEM_FILE_NAMES.has(name)) {
          return true;
        }
      } else if (isDirectoryEntry(entry)) {
        const nextPath = normalizeChildPath(currentDir, entryName(entry));
        if (nextPath && !visited.has(nextPath) && !queuedPaths.has(nextPath)) {
          queue.push(nextPath);
          queuedPaths.add(nextPath);
        }
      }
    }
  }

  return false;
}

async function deleteEmptyServers() {
  const allServers = await fetchAllServers();
  const candidates = [];

  for (const server of allServers) {
    let hasFiles;
    try {
      hasFiles = await serverHasFiles(server);
    } catch (err) {
      console.warn(
        `[Purge] Error inspecting files for ${server.attributes?.identifier || server.id}:`,
        err.message || err
      );
      hasFiles = true;
    }

    if (!hasFiles) {
      candidates.push(server);
    }
  }

  const deleted = [];
  for (const server of candidates) {
    const serverId = server?.attributes?.id || server?.id;
    try {
      await api.delete(`/servers/${serverId}`);
      deleted.push(server);
    } catch (err) {
      console.warn(
        `[Purge] Failed to delete ${server.attributes?.identifier || serverId}:`,
        err.response?.data || err.message || err
      );
    }
  }

  return deleted;
}

function buildDeletedListing() {
  const list = Array.isArray(state?.lastDeletedServers) ? state.lastDeletedServers : [];
  if (!list.length) {
    return ["└─ None yet."];
  }

  return list.slice(0, MAX_LISTED_DELETIONS).map((server, index, array) => {
    const prefix = index === array.length - 1 ? "└" : "├";
    const name = server.name || "Unnamed server";
    const identifier = server.identifier || "unknown";
    return `${prefix} ${name} (\`${identifier}\`)`;
  });
}

async function ensureCountdownChannel(client) {
  try {
    return (
      client.channels.cache.get(COUNTDOWN_CHANNEL_ID) ||
      (await client.channels.fetch(COUNTDOWN_CHANNEL_ID))
    );
  } catch {
    return null;
  }
}

function getNextRunFromState() {
  const nextRun = new Date(state?.nextRunAt);
  if (Number.isNaN(nextRun.getTime())) {
    return computeNextRun(new Date());
  }
  if (nextRun.getTime() <= Date.now()) {
    return computeNextRun(new Date());
  }
  return nextRun;
}

async function updateCountdownMessage(client) {
  if (!state) return;
  const channel = await ensureCountdownChannel(client);
  if (!channel?.isTextBased?.()) {
    if (!channelWarningLogged) {
      console.warn(`[Purge] Countdown channel ${COUNTDOWN_CHANNEL_ID} is unavailable.`);
      channelWarningLogged = true;
    }
    return;
  }

  const nextRun = getNextRunFromState();
  const countdown = formatCountdown(nextRun.getTime() - Date.now());
  const lastRun = state.lastRunAt ? new Date(state.lastRunAt) : null;
  const lastRunLine = lastRun
    ? `<t:${Math.floor(lastRun.getTime() / 1000)}:F>`
    : "Pending";

  const lines = [
    "**Scheduled server cleanup**",
    `• Next run: <t:${Math.floor(nextRun.getTime() / 1000)}:F>`,
    `• Countdown: ${countdown}`,
    `• Last run: ${lastRunLine}`,
    `• Deleted this run: ${state.lastDeletedCount ?? 0} server(s)`,
    "",
    "**Last deleted servers**",
    ...buildDeletedListing(),
  ];

  const content = lines.join("\n");
  let countdownMessage = null;

  if (state.countdownMessageId) {
    countdownMessage = await channel.messages
      .fetch(state.countdownMessageId)
      .catch(() => null);
  }

  if (countdownMessage) {
    try {
      await countdownMessage.edit({ content });
      return;
    } catch (err) {
      console.warn("[Purge] Editing countdown message failed:", err.message || err);
      state.countdownMessageId = null;
      await persistState();
      countdownMessage = null;
    }
  }

  const sent = await channel.send({ content }).catch((err) => {
    console.warn("[Purge] Failed to send countdown message:", err.message || err);
    return null;
  });

  if (sent) {
    state.countdownMessageId = sent.id;
    await persistState();
  }
}

function scheduleNextRun(client, target) {
  if (nextRunTimer) {
    clearTimeout(nextRunTimer);
  }
  const delay = Math.max(0, target.getTime() - Date.now());
  nextRunTimer = setTimeout(async () => {
    await runCleanupCycle(client);
    const next = computeNextRun(new Date());
    state.nextRunAt = next.toISOString();
    await persistState();
    scheduleNextRun(client, next);
  }, Math.max(delay, 1000));
}

async function runCleanupCycle(client) {
  if (running) return;
  running = true;
  console.log(`[Purge] Starting cleanup at ${new Date().toISOString()}`);
  try {
    const deleted = await deleteEmptyServers();
    state.lastRunAt = new Date().toISOString();
    state.lastDeletedCount = deleted.length;
    state.lastDeletedServers = deleted.map((server) => ({
      name: server.attributes?.name || server.name || "Unnamed server",
      identifier: server.attributes?.identifier || server.id,
      deletedAt: new Date().toISOString(),
    }));
    await persistState();
    console.log(`[Purge] Deleted ${deleted.length} server(s).`);
  } catch (err) {
    console.error("[Purge] Cleanup failed:", err);
  } finally {
    running = false;
    await updateCountdownMessage(client);
  }
}

async function start(client) {
  if (started) return;
  started = true;
  state = await readState();
  const parsedNext = getNextRunFromState();
  state.nextRunAt = parsedNext.toISOString();
  await persistState();
  await updateCountdownMessage(client);
  countdownInterval = setInterval(() => updateCountdownMessage(client).catch(() => null), COUNTDOWN_UPDATE_INTERVAL_MS);
  scheduleNextRun(client, parsedNext);
}

module.exports = {
  start,
};
