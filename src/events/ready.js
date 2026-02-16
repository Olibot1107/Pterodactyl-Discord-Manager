const { REST, Routes, ApplicationCommandType } = require("discord.js");
const api = require("../structures/Ptero");
const clientApi = require("../structures/ClientPtero");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { discord } = require("../../settings");

const NO_SERVER_ROLE_ID = discord.noServerRoleId;
const SERVER_ROLE_ID = discord.ServerRoleId;
const GUILD_ID = discord.guildId;
const WHITELISTED_UUIDS = []; // Add your whitelisted server UUIDs here

// === HELPERS ===
const sleep = ms => new Promise(r => setTimeout(r, ms));


// === ROLE ASSIGNMENT & SLOT ANNOUNCEMENT ===
async function assignRolesAndAnnounce(client) {
  console.log("Running role assignment and announcement task...");
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  // 1) Build map of panelUserID → DiscordID
  const panelUsers = new Map();
  for (let page = 1;; page++) {
    const users = (await api.get(`/users?page=${page}&per_page=100`)).data.data;
    if (!users.length) break;
    for (const u of users) {
      const id = u.attributes.username;
      if (/^\d{17,20}$/.test(id)) panelUsers.set(u.attributes.id, id);
    }
  }

  console.log(`Found ${panelUsers.size} panel users`);

  // 2) Count non-whitelisted servers & collect owners
  const owners = new Set();
  let totalNonWL = 0;
  for (let page = 1;; page++) {
    const servers = (await api.get(`/servers?page=${page}&per_page=100`)).data.data;
    if (!servers.length) break;
    for (const sItem of servers) {
      const s = sItem.attributes;
      if (!WHITELISTED_UUIDS.includes(s.uuid)) totalNonWL++;
      const discordId = panelUsers.get(s.user);
      if (discordId) owners.add(discordId);
    }
  }

  // 3) Sync roles
  for (const discordId of new Set(panelUsers.values())) {
    try {
      const member = await guild.members.fetch(discordId);
      const hasNoServerRole = member.roles.cache.has(NO_SERVER_ROLE_ID);
      const hasServerRole = member.roles.cache.has(SERVER_ROLE_ID);
      const ownsServer = owners.has(discordId);
      console.log(`Syncing ${member.user.tag}: ownsServer=${ownsServer}, hasNoServerRole=${hasNoServerRole}, hasServerRole=${hasServerRole}`);
      // Sync NO_SERVER_ROLE_ID
      if (!ownsServer && !hasNoServerRole) {
        await member.roles.add(NO_SERVER_ROLE_ID);
        console.log(`→ No Server role added to ${member.user.tag}`);
        await sleep(2000);
      }
      if (ownsServer && hasNoServerRole) {
        await member.roles.remove(NO_SERVER_ROLE_ID);
        console.log(`→ No Server role removed from ${member.user.tag}`);
        await sleep(2000);
      }

      // Sync SERVER_ROLE_ID
      if (ownsServer && !hasServerRole) {
        await member.roles.add(SERVER_ROLE_ID);
        console.log(`→ Server role added to ${member.user.tag}`);
        await sleep(2000);
      }
      if (!ownsServer && hasServerRole) {
        await member.roles.remove(SERVER_ROLE_ID);
        console.log(`→ Server role removed from ${member.user.tag}`);
        await sleep(2000);
      }
    } catch {
      // member might not be in guild
    }
  }
}

// === MODULE INIT ===
module.exports = async (client) => {
  console.log(`Cluster #${client.cluster.id} ready.`);

  if (client.cluster.id !== 0) return;

  // register slash commands
  const rest = new REST({ version: "10" }).setToken(client.token);
  const cmds = client.commands
    .filter(c => c.category !== "Owner")
    .map(c => ({
      name: c.name,
      description: c.description,
      options: c.options || [],
      type: ApplicationCommandType.ChatInput,
      dmPermission: false
    }));
  await rest.put(Routes.applicationCommands(client.user.id), { body: cmds });

  // schedule loops (run every 15 minutes)
  setInterval(() => assignRolesAndAnnounce(client), 10000);
  assignRolesAndAnnounce(client); // run immediately on startup
};
