const { REST, Routes, ApplicationCommandType } = require("discord.js");

module.exports = async (client) => {
  console.log(`Cluster #${client.cluster.id} is Online`);

  if (client.cluster.id === 0) {
    const rest = new REST({ version: "10" }).setToken(client.token);
    const commands = client.commands
      .filter((cmd) => cmd.category !== "Owner")
      .map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        options: cmd.options || [],
        type: ApplicationCommandType.ChatInput,
        dmPermission: false,
      }));

    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });
    client.rest = rest;
  }
};
