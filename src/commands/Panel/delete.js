const { EmbedBuilder, ApplicationCommandOptionType } = require("discord.js");
const api = require("../../structures/Ptero");
const User = require("../../models/User");

module.exports = {
  name: "delete",
  description: "Delete one of your servers",
  options: [
    {
      name: "serverid",
      description: "The short server ID (e.g. b6655c17 from your panel URL)",
      type: ApplicationCommandOptionType.String,
      required: true,
    },
  ],

  /**
   * @param {{ client: import("../../structures/Client"), context: import("discord.js").ChatInputCommandInteraction }}
   */
  run: async ({ client, context }) => {
    const discordId = context.user.id;
    const inputIdentifier = context.options.getString("serverid");

    const user = await User.findOne({ discordId });
    if (!user) {
      return await context.createMessage({
        content: "❌ You are not registered. Use `/register` first.",
        ephemeral: true,
      });
    }

    try {
      // Fetch all servers
      const serversRes = await api.get("/servers?per_page=1000");
      const servers = serversRes.data.data;

      // Find the server with the matching identifier
      const target = servers.find(
        (s) => s.attributes.identifier === inputIdentifier
      );

      if (!target) {
        return await context.createMessage({
          content: "❌ Server not found. Please check the ID.",
          ephemeral: true,
        });
      }

      // Check ownership
      if (target.attributes.user !== user.pteroId) {
        return await context.createMessage({
          content: "❌ You do not own this server.",
          ephemeral: true,
        });
      }

      // Delete using internal numeric ID
      await api.delete(`/servers/${target.attributes.id}`);

      return await context.createMessage({
        embeds: [
          new EmbedBuilder()
            .setColor("Red")
            .setTitle("🗑️ Server Deleted")
            .setDescription(`Server \`${target.attributes.name}\` has been successfully deleted.`),
        ],
        ephemeral: true,
      });
    } catch (err) {
      console.error("Pterodactyl Error:", err.response?.data || err);
      return await context.createMessage({
        content: "❌ Failed to delete server. Please try again later.",
        ephemeral: true,
      });
    }
  },
};
