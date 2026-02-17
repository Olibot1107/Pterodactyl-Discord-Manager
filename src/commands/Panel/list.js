const User = require("../../models/User");
const api = require("../../structures/Ptero");
const {
  buildServerCard,
  buildServerCooldownCard,
  consumeServerCooldown,
} = require("../../structures/serverCommandUi");

module.exports = {
  name: "list",
  description: "List your servers",

  run: async ({ context }) => {
    const discordId = context.user.id;
    const cooldownRemaining = consumeServerCooldown(discordId);

    if (cooldownRemaining) {
      return context.createMessage(buildServerCooldownCard(cooldownRemaining));
    }

    const user = await User.findOne({ discordId });
    if (!user) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Not Registered",
          description: "You are not registered. Use `/register` first.",
        })
      );
    }

    try {
      const allServers = [];
      for (let page = 1; ; page++) {
        const res = await api.get(`/servers?page=${page}&per_page=100`);
        const servers = res.data.data || [];
        allServers.push(...servers);
        if (servers.length < 100) break;
      }

      const ownedServers = allServers.filter((s) => s.attributes.user === user.pteroId);

      if (ownedServers.length === 0) {
        return context.createMessage(
          buildServerCard({
            title: "✕ No Servers",
            description: "You do not currently own any servers.",
          })
        );
      }

      const lines = ownedServers.slice(0, 12).map((server, index) => {
        const status = server.attributes.suspended ? "Suspended" : "Active";
        return `├─ **${index + 1}.** ${server.attributes.name} (\`${server.attributes.identifier}\`) - ${status}`;
      });
      lines[lines.length - 1] = lines[lines.length - 1].replace("├─", "└─");

      return context.createMessage(
        buildServerCard({
          title: "✔ Server List",
          description: `You currently own **${ownedServers.length}** server(s).`,
          details: lines,
        })
      );
    } catch (err) {
      console.error("Pterodactyl Error:", err.response?.data || err);
      return context.createMessage(
        buildServerCard({
          title: "✕ List Failed",
          description: "Failed to load your servers. Please try again later.",
        })
      );
    }
  },
};
