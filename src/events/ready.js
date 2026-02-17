const { REST, Routes, ApplicationCommandType } = require("discord.js");
const api = require("../structures/Ptero");
const { discord } = require("../../settings");
const { ensurePersistentVoiceConnection } = require("../structures/voiceKeeper");

const NO_SERVER_ROLE_ID = discord.noServerRoleId;
const SERVER_ROLE_ID = discord.ServerRoleId;
const GUILD_ID = discord.guildId;
const WHITELISTED_UUIDS = []; // Add your whitelisted server UUIDs here

const ROLE_SYNC_INTERVAL_MS = 10 * 1000; // 15 minutes
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  // Keep bot in the configured voice channel
  ensurePersistentVoiceConnection(client);
  setInterval(() => ensurePersistentVoiceConnection(client), 30_000);
};
