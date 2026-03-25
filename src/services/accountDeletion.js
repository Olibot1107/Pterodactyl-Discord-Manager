const api = require("../structures/Ptero");
const User = require("../models/User");
const PendingAccountDeletion = require("../models/PendingAccountDeletion");
const userRegistry = require("./userRegistry");

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

async function fetchAllPages(endpoint) {
  const results = [];
  for (let page = 1; ; page++) {
    const { data } = await api.get(`${endpoint}?page=${page}&per_page=100`);
    const items = data?.data ?? [];
    results.push(...items);
    if (items.length < 100) break;
  }
  return results;
}

async function scheduleAccountDeletion(discordId) {
  const user = await userRegistry.getVerifiedUser(discordId);
  if (!user) return null;

  const now = Date.now();
  const deletion = await PendingAccountDeletion.upsert({
    discordId,
    email: user.email,
    pteroId: user.pteroId,
    deleteAfter: now + SEVEN_DAYS_MS,
    createdAt: now,
    updatedAt: now,
  });

  return deletion;
}

async function cancelAccountDeletion(discordId) {
  const existing = await PendingAccountDeletion.findOne({ discordId });
  if (!existing) return false;
  await PendingAccountDeletion.deleteOne({ discordId });
  return true;
}

async function deletePanelAccountAndServers(pending) {
  const discordId = pending.discordId;
  const pteroId = Number(pending.pteroId);

  if (!pteroId) {
    await PendingAccountDeletion.deleteOne({ discordId });
    return;
  }

  let remoteUser = null;
  try {
    const { data } = await api.get(`/users/${pteroId}`);
    remoteUser = data?.attributes || null;
  } catch (err) {
    if (err.response?.status === 404) {
      await User.deleteOne({ discordId });
      userRegistry.clearCachedUser(discordId);
      await PendingAccountDeletion.deleteOne({ discordId });
      return;
    }
    throw err;
  }

  const allServers = await fetchAllPages("/servers");
  const ownedServers = allServers.filter(
    (s) => Number(s?.attributes?.user) === pteroId
  );

  for (const srv of ownedServers) {
    const serverId = srv?.attributes?.id;
    const name = srv?.attributes?.name || srv?.attributes?.identifier || "unknown";
    if (!serverId) continue;
    try {
      await api.delete(`/servers/${serverId}`);
      console.log(`[AccountDeletion] Deleted server: ${name} (ID: ${serverId})`);
    } catch (err) {
      if (err.response?.status === 404) continue;
      console.warn(
        `[AccountDeletion] Failed to delete server ${name} (ID: ${serverId}):`,
        err.message
      );
    }
  }

  try {
    await api.delete(`/users/${pteroId}`);
  } catch (err) {
    if (err.response?.status !== 404) throw err;
  }

  await User.deleteOne({ discordId });
  userRegistry.clearCachedUser(discordId);
  await PendingAccountDeletion.deleteOne({ discordId });

  console.log(
    `[AccountDeletion] Deleted panel user ${remoteUser?.email || pending.email} (Ptero ID: ${pteroId}) for Discord ID ${discordId}`
  );
}

async function processExpiredAccountDeletions(client, guildId, options = {}) {
  const now = Date.now();
  const limit = Number(options.limit ?? 25);

  const expired = await PendingAccountDeletion.findExpired(now, limit);
  if (!expired.length) return 0;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    console.warn("[AccountDeletion] Guild not found; skipping account deletion run.");
    return 0;
  }

  let processed = 0;
  for (const pending of expired) {
    const discordId = pending.discordId;
    if (!discordId) continue;

    const member = await guild.members.fetch(discordId).catch(() => null);
    if (member) {
      await PendingAccountDeletion.deleteOne({ discordId });
      console.log(
        `[AccountDeletion] ${member.user.tag} rejoined; canceled pending deletion.`
      );
      continue;
    }

    try {
      await deletePanelAccountAndServers(pending);
      processed += 1;
    } catch (err) {
      console.error(
        `[AccountDeletion] Failed to delete Discord ID ${discordId}:`,
        err.message,
        err.response?.data || err
      );
    }
  }

  return processed;
}

module.exports = {
  scheduleAccountDeletion,
  cancelAccountDeletion,
  processExpiredAccountDeletions,
  SEVEN_DAYS_MS,
};

