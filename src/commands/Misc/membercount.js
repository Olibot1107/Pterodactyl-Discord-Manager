const { buildServerCard } = require("../../structures/serverCommandUi");

module.exports = {
  name: "membercount",
  description: "get the member count",

  run: async ({ client, context }) => {
    const memberCount = client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0);

    await context.createMessage(
      buildServerCard({
        title: "✔ Member Count",
        description: "Current member count.",
        details: [`└─ **Member Count:** ${memberCount}`, `└─ **Guild Count:** ${client.guilds.cache.size}`],
      })
    );
  },
};
