const { ApplicationCommandOptionType, PermissionFlagsBits } = require("discord.js");
const api = require("../../structures/Ptero");
const User = require("../../models/User");
const { adminid } = require("../../../settings");
const { buildServerCard } = require("../../structures/serverCommandUi");

async function fetchAllServers() {
  const allServers = [];
  for (let page = 1; ; page++) {
    const res = await api.get(`/servers?page=${page}&per_page=100`);
    const servers = res.data.data || [];
    allServers.push(...servers);
    if (servers.length < 100) break;
  }
  return allServers;
}

async function unsuspendAllUserServers(discordId) {
  const user = await User.findOne({ discordId });
  if (!user) {
    return { unsuspended: 0, failed: 0, totalOwned: 0, notRegistered: true };
  }

  const allServers = await fetchAllServers();
  const owned = allServers.filter((s) => s.attributes.user === user.pteroId);
  const suspendedOwned = owned.filter((s) => !!s.attributes.suspended);

  let unsuspended = 0;
  let failed = 0;

  for (const server of suspendedOwned) {
    try {
      await api.post(`/servers/${server.attributes.id}/unsuspend`);
      unsuspended++;
    } catch (err) {
      failed++;
      console.error(
        `[Unsuspend] Failed to unsuspend server ${server.attributes.id}:`,
        err.response?.data || err.message || err
      );
    }
  }

  return { unsuspended, failed, totalOwned: owned.length, notRegistered: false };
}

module.exports = {
  name: "unsuspend",
  description: "Unsuspend all suspended servers owned by a user",
  options: [
    {
      name: "user",
      description: "User whose servers should be unsuspended",
      type: ApplicationCommandOptionType.User,
      required: true,
    },
  ],

  run: async ({ context }) => {
    const isAdmin =
      context.user.id === adminid ||
      context.memberPermissions?.has(PermissionFlagsBits.Administrator);

    if (!isAdmin) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Permission Denied",
          description: "Only admins can use `/unsuspend`.",
        })
      );
    }

    const targetUser = context.options.getUser("user");
    if (!targetUser) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Missing User",
          description: "Please provide a valid user.",
        })
      );
    }

    let result;
    try {
      result = await unsuspendAllUserServers(targetUser.id);
    } catch (err) {
      console.error("[Unsuspend] Failed to process servers:", err.response?.data || err.message || err);
      return context.createMessage(
        buildServerCard({
          title: "✕ Unsuspend Failed",
          description: "Failed to process server unsuspension.",
        })
      );
    }

    if (result.notRegistered) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Not Registered",
          description: "No linked panel account found for that user.",
        })
      );
    }

    return context.createMessage(
      buildServerCard({
        title: "✔ Unsuspend Complete",
        details: [
          `├─ **User:** <@${targetUser.id}>`,
          `├─ **Unsuspended:** ${result.unsuspended}/${result.totalOwned} server(s)`,
          `└─ **Failed:** ${result.failed}`,
        ],
      })
    );
  },
};
