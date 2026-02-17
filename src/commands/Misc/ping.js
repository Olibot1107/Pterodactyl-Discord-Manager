const { buildServerCard } = require("../../structures/serverCommandUi");

module.exports = {
  name: "ping",
  description: "Check the bot's latency",

  run: async ({ client, context }) => {
    const websocketPing = Math.trunc(client.ws.ping);
    const interactionLatency = Math.max(0, Date.now() - context.createdTimestamp);

    await context.createMessage(
      buildServerCard({
        title: "✔ Pong",
        description: "Current bot latency metrics.",
        details: [
          `├─ **WebSocket Ping:** ${websocketPing}ms`,
          `└─ **Interaction Latency:** ${interactionLatency}ms`,
        ],
      })
    );
  },
};
