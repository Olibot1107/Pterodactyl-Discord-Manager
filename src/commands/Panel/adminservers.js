const { ApplicationCommandOptionType, PermissionFlagsBits } = require("discord.js");
const { adminid } = require("../../../settings");
const api = require("../../structures/Ptero");
const User = require("../../models/User");
const { buildServerCard } = require("../../structures/serverCommandUi");

function hasAdminAccess(context) {
  return (
    context.user.id === adminid ||
    context.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );
}

async function fetchAllServers() {
  const allServers = [];
  for (let page = 1; ; page += 1) {
    const res = await api.get(`/servers?page=${page}&per_page=100`);
    const servers = res.data.data || [];
    allServers.push(...servers);
    if (servers.length < 100) break;
  }
  return allServers;
}

module.exports = {
  name: "adminservers",
  description: "Admin tools to list or purge a user's panel servers",
  options: [
    {
      name: "list",
      description: "List all panel servers owned by a Discord user",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "user",
          description: "Target Discord user",
          type: ApplicationCommandOptionType.User,
          required: true,
        },
      ],
    },
    {
      name: "purge",
      description: "Delete all panel servers owned by a Discord user",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "user",
          description: "Target Discord user",
          type: ApplicationCommandOptionType.User,
          required: true,
        },
        {
          name: "delete_account",
          description: "Also delete their panel account and local link",
          type: ApplicationCommandOptionType.Boolean,
          required: false,
        },
      ],
    },
  ],

  run: async ({ context }) => {
    if (!hasAdminAccess(context)) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Permission Denied",
          description: "Only admins can use `/adminservers`.",
          ephemeral: true,
        })
      );
    }

    const subcommand = context.options.getSubcommand();
    const targetUser = context.options.getUser("user");
    const deleteAccount = context.options.getBoolean("delete_account") || false;

    if (!targetUser) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Missing User",
          description: "Please provide a valid target user.",
          ephemeral: true,
        })
      );
    }

    try {
      const linked = await User.findOne({ discordId: targetUser.id });
      if (!linked) {
        return context.createMessage(
          buildServerCard({
            title: "✕ Not Linked",
            description: "That Discord user is not linked to a panel account.",
            details: [`└─ **User:** <@${targetUser.id}>`],
            ephemeral: true,
          })
        );
      }

      const allServers = await fetchAllServers();
      const ownedServers = allServers.filter(
        (server) => server.attributes.user === linked.pteroId
      );

      if (subcommand === "list") {
        if (ownedServers.length === 0) {
          return context.createMessage(
            buildServerCard({
              title: "✔ No Servers Found",
              description: "This user does not own any panel servers.",
              details: [
                `├─ **User:** <@${targetUser.id}>`,
                `└─ **Panel User ID:** ${linked.pteroId}`,
              ],
              ephemeral: true,
            })
          );
        }

        const shownServers = ownedServers.slice(0, 25);
        const lines = shownServers.map((server, index) => {
          const status = server.attributes.suspended ? "Suspended" : "Active";
          const prefix = index === shownServers.length - 1 ? "└─" : "├─";
          return `${prefix} **${server.attributes.name}** (\`${server.attributes.identifier}\`) - ${status}`;
        });

        if (ownedServers.length > shownServers.length) {
          lines.push(`...and **${ownedServers.length - shownServers.length}** more server(s).`);
        }

        return context.createMessage(
          buildServerCard({
            title: "✔ User Server List",
            description: `Found **${ownedServers.length}** server(s) for <@${targetUser.id}>.`,
            details: lines,
            ephemeral: true,
          })
        );
      }

      let deletedServers = 0;
      let failedServers = 0;
      for (const server of ownedServers) {
        try {
          await api.delete(`/servers/${server.attributes.id}`);
          deletedServers += 1;
        } catch {
          failedServers += 1;
        }
      }

      let accountDeleted = false;
      if (deleteAccount) {
        await api.delete(`/users/${linked.pteroId}`);
        await User.deleteOne({ discordId: targetUser.id });
        accountDeleted = true;
      }

      return context.createMessage(
        buildServerCard({
          title: "✔ Purge Complete",
          description: `Finished server purge for <@${targetUser.id}>.`,
          details: [
            `├─ **Deleted Servers:** ${deletedServers}`,
            `├─ **Failed Deletes:** ${failedServers}`,
            `├─ **Delete Account:** ${deleteAccount ? "Yes" : "No"}`,
            `├─ **Account Deleted:** ${accountDeleted ? "Yes" : "No"}`,
            `└─ **Action By:** ${context.user.username}`,
          ],
          ephemeral: true,
        })
      );
    } catch (err) {
      console.error("Adminservers command error:", err.response?.data || err);
      const detail = err.response?.data?.errors?.[0]?.detail;
      return context.createMessage(
        buildServerCard({
          title: "✕ Command Failed",
          description: detail || "Failed to complete admin server action.",
          ephemeral: true,
        })
      );
    }
  },
};
