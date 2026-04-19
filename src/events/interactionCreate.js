const {
  EmbedBuilder,
  PermissionFlagsBits,
  InteractionType,
  MessageFlags
} = require("discord.js");
const { logAction, logError, logWarn } = require("../structures/logger");

module.exports = async (client, interaction) => {
  if (!client.isReady()) return;
  if (interaction.inGuild?.() && !interaction.guild?.available) return;

  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (!command?.autocomplete) return;

    try {
      await command.autocomplete({ client, interaction });
    } catch (err) {
      logError(`Autocomplete handling failed for /${interaction.commandName}: ${err.message}`);
      if (!interaction.responded) {
        await interaction.respond([]);
      }
    }
    return;
  }

  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    const inGuild = interaction.inGuild?.() ?? Boolean(interaction.guildId);

    if (inGuild) {
      // Check permissions BEFORE deferring
      const botPerms = interaction.channel?.permissionsFor?.(client.user);

      if (botPerms && !botPerms.has(PermissionFlagsBits.SendMessages)) {
        const user = await interaction.guild.members.fetch(interaction.user.id);
        return await user.send({
          embeds: [
            new EmbedBuilder().setDescription(
              `Please give me Send Messages permission in <#${interaction.channelId}>`
            ),
          ],
        }).catch(() => {});
      }

      if (botPerms && !botPerms.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ])) return;

      if (botPerms && !botPerms.has(PermissionFlagsBits.EmbedLinks)) {
        return interaction.reply("I need Embed Links permission!");
      }

      if (command.permission &&
        !interaction.member?.permissions?.has(PermissionFlagsBits[command.permission]) &&
        !client.owners?.includes(interaction.user.id)) {
        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor("Red")
              .setDescription(`You need ${command.permission} permission!`),
          ],
        });
      }
    } else if (command.permission) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor("Red")
            .setDescription("This command can only be used in a server."),
        ],
        flags: MessageFlags.Ephemeral
      });
    }

    // Defer based on command preference
    const ephemeralCommands = ['register', 'webhook', 'aikey'];
    const shouldDeferEphemeral = inGuild && ephemeralCommands.includes(command.name);
    
    try {
      await interaction.deferReply({ 
        flags: shouldDeferEphemeral ? MessageFlags.Ephemeral : undefined 
      });
    } catch (err) {
      logWarn(`Defer failed for /${interaction.commandName}: ${err.message}`);
      return;
    }

    try {
      logAction(
        "Command",
        `/${interaction.commandName} by ${interaction.user.tag}${inGuild ? ` in #${interaction.channel?.name || interaction.channelId}` : " in DM"}`
      );

      // Create context with properly bound methods and preserved references
      if (shouldDeferEphemeral) {
        interaction.createMessage = (opts) => {
          const baseFlags = typeof opts?.flags === "number" ? opts.flags : 0;
          return interaction.followUp({
            ...opts,
            flags: baseFlags | MessageFlags.Ephemeral,
          });
        };
      } else {
        interaction.createMessage = (opts) => interaction.followUp(opts);
      }
      await command.run({ client, context: interaction });
      logAction("Command Complete", `/${interaction.commandName} by ${interaction.user.tag}`);
    } catch (error) {
      logError(`Command error for /${interaction.commandName} by ${interaction.user.tag}: ${error.message}`);
      logAction(
        "Command Failed",
        `/${interaction.commandName} by ${interaction.user.tag}`
      );
      
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
        logWarn(`Failed to send error message for /${interaction.commandName}: ${replyErr.message}`);
      }
    }
  } else if (interaction.isButton() || interaction.isModalSubmit()) {
    // These interactions will be handled by the command-specific listeners
    // that are added when the command is run
    return;
  }
};
