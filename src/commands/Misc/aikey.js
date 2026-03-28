const { buildServerCard } = require("../../structures/serverCommandUi");
const { getOrCreateAiApiKey } = require("../../services/aiApiKeys");

module.exports = {
  name: "aikey",
  description: "Get your AI API key (1 per account)",

  run: async ({ context }) => {
    const discordId = context.user?.id;
    if (!discordId) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Error",
          description: "Missing Discord user id.",
          ephemeral: true,
        })
      );
    }

    const record = await getOrCreateAiApiKey(discordId);

    return context.createMessage(
      buildServerCard({
        title: "AI API Key",
        description: "Keep this key private. If you leave the Discord server, your key will be deleted.",
        ephemeral: true,
        details: [
          `**Your key:** \`${record.apiKey}\``,
          "",
          "**How to use:**",
          "Send it as a bearer token header:",
          "`Authorization: Bearer <your_key>`",
          "",
          "**Rate limit:** 10 requests per 4 minutes.",
          "**Docs:** https://ai-api.voidium.uk/",
        ],
      })
    );
  },
};
