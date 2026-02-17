const {
  EmbedBuilder,
  PermissionFlagsBits,
  InteractionType,
  MessageFlags
} = require("discord.js");

module.exports = async (client, interaction) => {
  if (!client.isReady() || !interaction.guild?.available) return;

  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    // Check permissions BEFORE deferring
    const botPerms = interaction.channel.permissionsFor(client.user);
    
    if (!botPerms.has(PermissionFlagsBits.SendMessages)) {
      const user = await interaction.guild.members.fetch(interaction.user.id);
      return await user.send({
        embeds: [
          new EmbedBuilder().setDescription(
            `Please give me Send Messages permission in <#${interaction.channelId}>`
          ),
        ],
      }).catch(() => {});
    }

    if (!botPerms.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
    ])) return;

    if (!botPerms.has(PermissionFlagsBits.EmbedLinks)) {
      return interaction.reply("I need Embed Links permission!");
    }

    if (command.permission &&
      !interaction.member.permissions.has(PermissionFlagsBits[command.permission]) &&
      !client.owners?.includes(interaction.user.id)) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor("Red")
            .setDescription(`You need ${command.permission} permission!`),
        ],
      });
    }

    // Defer based on command preference
    const ephemeralCommands = ['register'];
    const shouldDeferEphemeral = ephemeralCommands.includes(command.name);
    
    try {
      await interaction.deferReply({ 
        flags: shouldDeferEphemeral ? MessageFlags.Ephemeral : undefined 
      });
    } catch (err) {
      console.error("Defer failed:", err);
      return;
    }

    try {
      // Create context with properly bound methods and preserved references
      interaction.createMessage = (opts) => interaction.followUp(opts);
      await command.run({ client, context: interaction });
    } catch (error) {
      console.error("Command error:", error);
      
      try {
        if (interaction.deferred) {
          await interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setColor("Red")
                .setDescription("An error occurred while executing this command.")
            ]
          });
        } else {
          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor("Red")
                .setDescription("An error occurred while executing this command.")
            ],
            flags: MessageFlags.Ephemeral
          });
        }
      } catch (replyErr) {
        console.error("Failed to send error message:", replyErr);
      }
    }
  } else if (interaction.isButton() || interaction.isModalSubmit()) {
    // These interactions will be handled by the command-specific listeners
    // that are added when the command is run
    return;
  }
};