const { EmbedBuilder } = require("discord.js");
const User = require("../../models/User");
const { ptero } = require("../../../settings");

module.exports = {
  name: "login",
  description: "Get your panel login details",

  /**
   * @param {{ client: import("../../structures/Client"), context: import("discord.js").ChatInputCommandInteraction }}
   */
  run: async ({ client, context }) => {
    const discordId = context.user.id;

    const user = await User.findOne({ discordId });
    if (!user) {
      return await context.createMessage({
        content: "❌ You don't have a registered account. Use `/register` first.",
        ephemeral: true,
      });
    }

    return await context.createMessage({
      embeds: [
        new EmbedBuilder()
          .setColor("Blue")
          .setTitle("🔐 Panel Login")
          .setDescription(
            `📧 **Email:** \`${user.email}\`\n🧾 **Username:** \`${discordId}\`\n\nLogin at [Panel](${ptero.url})`
          ),
      ],
      ephemeral: true,
    });
  },
};
