const { ApplicationCommandOptionType } = require("discord.js");
const api = require("../../structures/Ptero");
const User = require("../../models/User");
const {
  buildServerCard,
  buildServerCooldownCard,
  consumeServerCooldown,
} = require("../../structures/serverCommandUi");

module.exports = {
  name: "delete",
  description: "Delete one of your servers",
  options: [
    {
      name: "serverid",
      description: "The short server ID (e.g. b6655c17 from your panel URL)",
      type: ApplicationCommandOptionType.String,
      autocomplete: true,
      required: true,
    },
  ],

  autocomplete: async ({ interaction }) => {
    const discordId = interaction.user.id;
    const focused = interaction.options.getFocused().toLowerCase();

    try {
      const user = await User.findOne({ discordId });
      if (!user) return interaction.respond([]);

      const serversRes = await api.get("/servers?per_page=1000");
      const servers = serversRes.data.data || [];

      const choices = servers
        .filter((s) => s.attributes.user === user.pteroId)
        .map((s) => ({
          name: `${s.attributes.name} (${s.attributes.identifier})${s.attributes.suspended ? " [suspended]" : ""}`,
          value: s.attributes.identifier,
        }))
        .filter((c) => c.name.toLowerCase().includes(focused) || c.value.toLowerCase().includes(focused))
        .slice(0, 25);

      return interaction.respond(choices);
    } catch (err) {
      console.error("Autocomplete error:", err.response?.data || err);
      return interaction.respond([]);
    }
  },

  /**
   * @param {{ client: import("../../structures/Client"), context: import("discord.js").ChatInputCommandInteraction }}
   */
  run: async ({ client, context }) => {
    const discordId = context.user.id;
    const inputIdentifier = context.options.getString("serverid");
    const cooldownRemaining = consumeServerCooldown(discordId);

    if (cooldownRemaining) {
      return context.createMessage(buildServerCooldownCard(cooldownRemaining));
    }

    const user = await User.findOne({ discordId });
    if (!user) {
      return await context.createMessage(
        buildServerCard({
          title: "✕ Not Registered",
          description: "You are not registered. Use `/register` first.",
        })
      );
    }

    try {
      // Fetch all servers (consider paging if >1000)
      const serversRes = await api.get("/servers?per_page=1000");
      const servers = serversRes.data.data;

      // Find the server with the matching identifier
      const target = servers.find(
        (s) => s.attributes.identifier === inputIdentifier
      );

      if (!target) {
        return await context.createMessage(
          buildServerCard({
            title: "✕ Server Not Found",
            description: "Please check the server ID.",
          })
        );
      }

      // Check if server is suspended (assuming attribute 'suspended' is boolean or number)
      if (target.attributes.suspended) {
        return await context.createMessage(
          buildServerCard({
            title: "✕ Action Blocked",
            description: "This server is suspended and cannot be deleted via this command.",
          })
        );
      }

      // Check ownership
      if (target.attributes.user !== user.pteroId) {
        return await context.createMessage(
          buildServerCard({
            title: "✕ Permission Denied",
            description: "You do not own this server.",
          })
        );
      }

      // Delete server using internal numeric ID
      await api.delete(`/servers/${target.attributes.id}`);

      return await context.createMessage(
        buildServerCard({
          title: "✔ Server Deleted",
          description: `The server **${target.attributes.name}** has been permanently removed.`,
          details: [
            `├─ **Server ID:** ${target.attributes.id}`,
            `├─ **Server Name:** ${target.attributes.name}`,
            `└─ **Deleted By:** ${context.user.username}.`,
          ],
        })
      );
    } catch (err) {
      console.error("Pterodactyl Error:", err.response?.data || err);
      return await context.createMessage(
        buildServerCard({
          title: "✕ Delete Failed",
          description: "Failed to delete server. Please try again later.",
        })
      );
    }
  },
};
