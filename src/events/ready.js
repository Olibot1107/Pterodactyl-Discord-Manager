const {
  REST,
  Routes,
  ApplicationCommandType,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");
const axios = require("axios");
const path = require("path");
const fs = require("fs/promises");
const api = require("../structures/Ptero");
const { discord, ptero } = require("../../settings");
const { ensurePersistentVoiceConnection } = require("../structures/voiceKeeper");

const NO_SERVER_ROLE_ID = discord.noServerRoleId;
const SERVER_ROLE_ID = discord.ServerRoleId;
const GUILD_ID = discord.guildId;
const WHITELISTED_UUIDS = []; // Add your whitelisted server UUIDs here

const ROLE_SYNC_INTERVAL_MS = 10 * 1000; // 15 minutes
const STATUS_BOARD_INTERVAL_MS = 10 * 1000;
const STATUS_REQUEST_CONCURRENCY = 5;
const SERVER_STATUS_CHANNEL_ID = "1473827081853861928";
const STATUS_BOARD_FOOTER_MARKER = "Voidium status board";
const STATUS_BOARD_STATE_FILE = path.join(__dirname, "..", "data", "statusBoardMessage.json");
const STATUS_EMOJIS = {
  offline: "<:offline:1473830166932492419>",
  idle: "<:idle:1473830160389378195>",
  online: "<:online:1473830150583095530>",
  cpu: "<:wizard_cpu:1473829526839759014>",
  ram: "<:wizard_ram:1473829520996962592>",
  ssd: "<:wizard_ssd:1473829536838717584>",
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
let statusBoardMessageIds = [];
let statusBoardMessageIdsLoaded = false;
let statusBoardUpdateInProgress = false;

// === HELPERS ===

async function fetchAllPages(endpoint) {
  const results = [];
  for (let page = 1; ; page++) {
    const { data } = await api.get(`${endpoint}?page=${page}&per_page=100`);
    const items = data.data ?? [];
    results.push(...items);
    if (items.length < 100) break; // no more pages
  }
  return results;
}

function getClientApiKeys() {
  const keys = [ptero?.clientApiKey, ptero?.apiKey].filter(Boolean);
  return [...new Set(keys)];
}

async function clientApiRequest(method, path, data) {
  const keys = getClientApiKeys();
  let lastError;

  for (const key of keys) {
    try {
      return await axios({
        method,
        url: `${ptero.url}/api/client${path}`,
        data,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });
    } catch (err) {
      lastError = err;
      const message = String(err.response?.data?.errors?.[0]?.detail || "");
      const isWrongKeyType =
        err.response?.status === 403 &&
        message.includes("requires a client API key");

      if (!isWrongKeyType) break;
    }
  }

  throw lastError;
}

async function mapWithConcurrency(items, limit, mapper) {
  const running = new Set();

  for (const item of items) {
    const task = Promise.resolve().then(() => mapper(item));
    running.add(task);
    task.finally(() => running.delete(task));

    if (running.size >= limit) {
      await Promise.race(running);
    }
  }

  await Promise.all(running);
}

function formatBytesToMB(bytes) {
  const value = Number(bytes) || 0;
  return `${Math.max(0, Math.round(value / (1024 * 1024)))}MB`;
}

function formatPercent(value) {
  const numeric = Number(value) || 0;
  return numeric.toFixed(1);
}

function formatUptime(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  if (minutes || hours || days) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(" ");
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

async function loadStatusBoardMessageIds() {
  try {
    const raw = await fs.readFile(STATUS_BOARD_STATE_FILE, "utf8");
    const data = JSON.parse(raw);

    if (data?.channelId !== SERVER_STATUS_CHANNEL_ID) return [];

    if (Array.isArray(data?.messageIds)) {
      return data.messageIds.filter((id) => typeof id === "string" && id);
    }

    // Backward compatibility for old single-message format.
    if (typeof data?.messageId === "string" && data.messageId) {
      return [data.messageId];
    }

    return [];
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[StatusBoard] Failed to load state file: ${err.message}`);
    }
    return [];
  }
}

async function saveStatusBoardMessageIds(messageIds) {
  try {
    await fs.mkdir(path.dirname(STATUS_BOARD_STATE_FILE), { recursive: true });
    await fs.writeFile(
      STATUS_BOARD_STATE_FILE,
      JSON.stringify(
        {
          channelId: SERVER_STATUS_CHANNEL_ID,
          messageIds,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
  } catch (err) {
    console.warn(`[StatusBoard] Failed to save state file: ${err.message}`);
  }
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function hasStatusBoardMarker(message) {
  if (message.content?.includes(STATUS_BOARD_FOOTER_MARKER)) return true;

  if (
    message.embeds.some((embed) =>
      embed.footer?.text?.includes(STATUS_BOARD_FOOTER_MARKER)
    )
  ) {
    return true;
  }

  return message.components.some((component) => {
    try {
      const json = typeof component.toJSON === "function" ? component.toJSON() : component;
      return JSON.stringify(json).includes(STATUS_BOARD_FOOTER_MARKER);
    } catch {
      return false;
    }
  });
}

function getStateDetails(currentState) {
  const state = String(currentState || "offline").toLowerCase();

  if (state === "running") {
    return { bucket: "online", emoji: STATUS_EMOJIS.online, label: "running" };
  }

  if (state === "starting") {
    return { bucket: "online", emoji: STATUS_EMOJIS.online, label: "starting" };
  }

  if (state === "offline" || state === "stopped") {
    return { bucket: "offline", emoji: STATUS_EMOJIS.offline, label: "offline" };
  }

  return { bucket: "idle", emoji: STATUS_EMOJIS.idle, label: state };
}

function buildBoardMessage(container) {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  };
}

function buildStatusMessages(serverStatuses, totalServers, failedServers) {
  const nowUnix = Math.floor(Date.now() / 1000);
  const statusRank = { online: 0, idle: 1, offline: 2 };
  const sorted = [...serverStatuses].sort((a, b) => {
    if (a.nodeName !== b.nodeName) return a.nodeName.localeCompare(b.nodeName);
    const aRank = statusRank[a.stateMeta.bucket] ?? 1;
    const bRank = statusRank[b.stateMeta.bucket] ?? 1;
    if (aRank !== bRank) return aRank - bRank;
    return b.cpu - a.cpu;
  });

  const globalCounts = { online: 0, idle: 0, offline: 0 };
  for (const server of sorted) {
    globalCounts[server.stateMeta.bucket] += 1;
  }

  const byNode = new Map();
  for (const server of sorted) {
    if (!byNode.has(server.nodeName)) byNode.set(server.nodeName, []);
    byNode.get(server.nodeName).push(server);
  }

  const messages = [];
  const overview = new ContainerBuilder().setAccentColor(0x2b8a3e);
  const overviewLines = [
    "## Voidium Live Load",
    `${STATUS_EMOJIS.online} Online: **${globalCounts.online}**  ` +
      `${STATUS_EMOJIS.idle} Idle: **${globalCounts.idle}**  ` +
      `${STATUS_EMOJIS.offline} Offline: **${globalCounts.offline}**`,
    `Total servers: **${totalServers}**`,
    `Nodes: **${byNode.size}**`,
  ];

  if (failedServers > 0) {
    overviewLines.push(`Resource lookups failed: **${failedServers}**`);
  }

  overviewLines.push(`Updated: <t:${nowUnix}:R>`);
  overviewLines.push(`*${STATUS_BOARD_FOOTER_MARKER}*`);

  overview.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(overviewLines.join("\n"))
  );
  messages.push(buildBoardMessage(overview));

  if (byNode.size === 0) {
    const noData = new ContainerBuilder().setAccentColor(0x2b8a3e);
    noData.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## Node: none\nNo server data available yet.\n*${STATUS_BOARD_FOOTER_MARKER}*`
      )
    );
    messages.push(buildBoardMessage(noData));
    return messages;
  }

  for (const [nodeName, nodeServers] of byNode.entries()) {
    const nodeCounts = { online: 0, idle: 0, offline: 0 };
    for (const server of nodeServers) {
      nodeCounts[server.stateMeta.bucket] += 1;
    }

    const lines = nodeServers.map((server) =>
      `${server.stateMeta.emoji} **${truncate(server.name, 40)}** (\`${server.identifier}\`) ` +
      `\`${server.stateMeta.label}\` | ${STATUS_EMOJIS.cpu} ${formatPercent(server.cpu)}% | ` +
      `${STATUS_EMOJIS.ram} ${formatBytesToMB(server.memory)} | ` +
      `${STATUS_EMOJIS.ssd} ${formatBytesToMB(server.disk)} | Uptime: ${formatUptime(server.uptime)}`
    );

    const linePages = chunk(lines, 16);
    linePages.forEach((pageLines, pageIndex) => {
      const container = new ContainerBuilder().setAccentColor(0x2b8a3e);
      const header = pageIndex === 0
        ? `## Node: ${nodeName}`
        : `## Node: ${nodeName} (Page ${pageIndex + 1}/${linePages.length})`;
      const summary = [
        header,
        `${STATUS_EMOJIS.online} ${nodeCounts.online}  ${STATUS_EMOJIS.idle} ${nodeCounts.idle}  ${STATUS_EMOJIS.offline} ${nodeCounts.offline}`,
        `Updated: <t:${nowUnix}:R>`,
        `*${STATUS_BOARD_FOOTER_MARKER}*`,
      ];

      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(summary.join("\n"))
      );
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(pageLines.join("\n"))
      );

      messages.push(buildBoardMessage(container));
    });
  }

  return messages;
}

async function findStatusBoardMessages(channel, botUserId) {
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return [];

  return [...recent.values()]
    .filter(
      (message) =>
        message.author?.id === botUserId &&
        hasStatusBoardMarker(message)
    )
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function updateServerStatusBoard(client) {
  if (statusBoardUpdateInProgress) return;
  statusBoardUpdateInProgress = true;

  try {
    if (!statusBoardMessageIdsLoaded) {
      statusBoardMessageIds = await loadStatusBoardMessageIds();
      statusBoardMessageIdsLoaded = true;
    }

    const channel = await client.channels.fetch(SERVER_STATUS_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      console.warn(`[StatusBoard] Channel ${SERVER_STATUS_CHANNEL_ID} is missing or not text-based.`);
      return;
    }

    let nodeMap = new Map();
    try {
      const allNodes = await fetchAllPages("/nodes");
      nodeMap = new Map(
        allNodes
          .map((node) => node?.attributes)
          .filter(Boolean)
          .map((node) => [node.id, node.name || `Node ${node.id}`])
      );
    } catch (err) {
      console.warn("[StatusBoard] Failed to fetch node list, falling back to node IDs.");
    }

    const allServers = await fetchAllPages("/servers");
    const serverStatuses = [];
    let failedServers = 0;

    await mapWithConcurrency(allServers, STATUS_REQUEST_CONCURRENCY, async ({ attributes: server }) => {
      if (!server || server.suspended) return;

      try {
        const resources = await clientApiRequest("GET", `/servers/${server.identifier}/resources`);
        const attrs = resources.data?.attributes || {};
        const currentState = attrs.current_state || "offline";
        const stateMeta = getStateDetails(currentState);

        serverStatuses.push({
          name: server.name,
          identifier: server.identifier,
          nodeName: nodeMap.get(server.node) || `Node ${server.node ?? "unknown"}`,
          state: currentState,
          stateMeta,
          cpu: attrs.resources?.cpu_absolute ?? 0,
          memory: attrs.resources?.memory_bytes ?? 0,
          disk: attrs.resources?.disk_bytes ?? 0,
          uptime: attrs.resources?.uptime ?? 0,
        });
      } catch (err) {
        failedServers += 1;
      }
    });

    const nextMessages = buildStatusMessages(serverStatuses, allServers.length, failedServers);
    let boardMessages = [];

    if (statusBoardMessageIds.length > 0) {
      const loaded = await Promise.all(
        statusBoardMessageIds.map((messageId) =>
          channel.messages.fetch(messageId).catch(() => null)
        )
      );
      boardMessages = loaded.filter(Boolean);
    }

    if (boardMessages.length === 0) {
      boardMessages = await findStatusBoardMessages(channel, client.user.id);
    }

    const activeMessages = [];
    for (let i = 0; i < nextMessages.length; i += 1) {
      if (boardMessages[i]) {
        const edited = await boardMessages[i].edit({
          ...nextMessages[i],
          content: null,
          embeds: [],
        });
        activeMessages.push(edited);
      } else {
        const created = await channel.send(nextMessages[i]);
        activeMessages.push(created);
      }
    }

    if (boardMessages.length > nextMessages.length) {
      const staleMessages = boardMessages.slice(nextMessages.length);
      await Promise.all(staleMessages.map((message) => message.delete().catch(() => null)));
    }

    const nextMessageIds = activeMessages.map((message) => message.id);
    if (!arraysEqual(statusBoardMessageIds, nextMessageIds)) {
      statusBoardMessageIds = nextMessageIds;
      await saveStatusBoardMessageIds(statusBoardMessageIds);
    }
  } catch (err) {
    console.error("[StatusBoard] Failed to refresh board:", err.response?.data || err.message);
  } finally {
    statusBoardUpdateInProgress = false;
  }
}

// === ROLE ASSIGNMENT ===

async function assignRolesAndAnnounce(client) {
  console.log("[RoleSync] Starting role assignment task...");

  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    console.warn("[RoleSync] Guild not found, skipping.");
    return;
  }

  // 1) Build map of panelUserID (number) → discordId (string)
  let panelUsers;
  let allServers;
  try {
    const rawUsers = await fetchAllPages("/users");
    panelUsers = new Map(
      rawUsers
        .filter(u => /^\d{17,20}$/.test(u.attributes.username))
        .map(u => [u.attributes.id, u.attributes.username])
    );

    allServers = await fetchAllPages("/servers");
  } catch (err) {
    console.error("[RoleSync] Failed to fetch panel data:", err.message);
    return;
  }

  console.log(`[RoleSync] Found ${panelUsers.size} linked panel users, ${allServers.length} total servers.`);

  // 2) Collect Discord IDs of users who own at least one non-whitelisted server
  const owners = new Set();
  for (const { attributes: s } of allServers) {
    if (WHITELISTED_UUIDS.includes(s.uuid)) continue;
    const discordId = panelUsers.get(s.user);
    if (discordId) owners.add(discordId);
  }

  // 3) Sync roles for every linked panel user
  for (const discordId of panelUsers.values()) {
    let member;
    try {
      member = await guild.members.fetch(discordId);
    } catch {
      continue; // user not in guild
    }

    const ownsServer = owners.has(discordId);
    const hasNoServerRole = member.roles.cache.has(NO_SERVER_ROLE_ID);
    const hasServerRole = member.roles.cache.has(SERVER_ROLE_ID);

    console.log(
      `[RoleSync] ${member.user.tag}: ownsServer=${ownsServer}, hasServerRole=${hasServerRole}, hasNoServerRole=${hasNoServerRole}`
    );

    // Build the desired final role list in one shot to avoid cache desync
    const alreadyHasCorrectRoles =
      ownsServer ? (hasServerRole && !hasNoServerRole)
                 : (!hasServerRole && hasNoServerRole);

    if (alreadyHasCorrectRoles) continue;

    try {
      // Start from current roles, then swap out only the two managed roles
      const newRoles = member.roles.cache
        .filter(r => r.id !== SERVER_ROLE_ID && r.id !== NO_SERVER_ROLE_ID)
        .map(r => r.id);

      if (ownsServer) {
        newRoles.push(SERVER_ROLE_ID);
        console.log(`[RoleSync] → ${member.user.tag}: grant Server, remove No-Server`);
      } else {
        newRoles.push(NO_SERVER_ROLE_ID);
        console.log(`[RoleSync] → ${member.user.tag}: grant No-Server, remove Server`);
      }

      await member.roles.set(newRoles);
      await sleep(2000);
    } catch (err) {
      console.warn(`[RoleSync] Failed to update roles for ${member.user.tag}:`, err.message);
    }
  }

  console.log("[RoleSync] Role sync complete.");
}

// === MODULE INIT ===

module.exports = async (client) => {
  console.log(`Cluster #${client.cluster.id} ready.`);

  // Only run setup tasks on the primary cluster
  if (client.cluster.id !== 0) return;

  // Register slash commands
  try {
    const rest = new REST({ version: "10" }).setToken(client.token);
    const cmds = client.commands
      .filter(c => c.category !== "Owner")
      .map(c => ({
        name: c.name,
        description: c.description,
        options: c.options || [],
        type: ApplicationCommandType.ChatInput,
        dmPermission: false,
      }));
    await rest.put(Routes.applicationCommands(client.user.id), { body: cmds });
    console.log(`[Commands] Registered ${cmds.length} slash commands.`);
  } catch (err) {
    console.error("[Commands] Failed to register slash commands:", err.message);
  }

  // Run role sync immediately, then on a fixed interval
  assignRolesAndAnnounce(client);
  setInterval(() => assignRolesAndAnnounce(client), ROLE_SYNC_INTERVAL_MS);

  // Run server status board immediately, then refresh every 10 seconds
  updateServerStatusBoard(client);
  setInterval(() => updateServerStatusBoard(client), STATUS_BOARD_INTERVAL_MS);

  // Keep bot in the configured voice channel
  ensurePersistentVoiceConnection(client);
  setInterval(() => ensurePersistentVoiceConnection(client), 30_000);
};
