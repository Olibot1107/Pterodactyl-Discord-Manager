const {
  ApplicationCommandOptionType,
  PermissionFlagsBits,
} = require("discord.js");
const { adminid } = require("../../../settings");
const StickyMessage = require("../../models/StickyMessage");
const { buildServerCard } = require("../../structures/serverCommandUi");
const {
  buildStickyPayload,
  isComponentsV2Enabled,
} = require("../../structures/stickyMessagePayload");

const DEFAULT_COOLDOWN_SECONDS = 5;

function truncateText(text, maxLength = 200) {
  if (!text || text.length <= maxLength) return text || "";
  return `${text.slice(0, maxLength - 3)}...`;
}

function isAdminContext(context) {
  return (
    context.user.id === adminid ||
    context.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );
}

function getTargetChannel(context) {
  return context.options.getChannel("channel") || context.channel;
}

function isValidTextChannel(channel) {
  return Boolean(channel?.isTextBased?.() && !channel.isDMBased?.());
}

function getStickyModeLabel(useComponentsV2) {
  return isComponentsV2Enabled(useComponentsV2) ? "Components V2" : "Plain Text";
}

function getStickyPreviewLines(stickies) {
  const maxShown = 10;
  const shown = stickies.slice(0, maxShown);
  const hasMore = stickies.length > shown.length;

  const lines = shown.map((sticky, index) => {
    const isLastVisible = index === shown.length - 1 && !hasMore;
    const prefix = isLastVisible ? "└─" : "├─";
    return `${prefix} **#${sticky.id}** | ${getStickyModeLabel(sticky.useComponentsV2)} | ${sticky.cooldownSeconds}s | ${truncateText(sticky.content, 80)}`;
  });

  if (hasMore) {
    lines.push(`...and **${stickies.length - shown.length}** more sticky message(s).`);
  }

  return lines;
}

function getStickyListLines(stickies) {
  return stickies.map((sticky, index) => {
    const isLast = index === stickies.length - 1;
    const prefix = isLast ? "└─" : "├─";
    return `${prefix} **#${sticky.id}** | cooldown: ${sticky.cooldownSeconds}s | mode: ${getStickyModeLabel(sticky.useComponentsV2)} | msg: ${truncateText(sticky.content, 220)}`;
  });
}

async function deleteExistingStickyMessage(channel, messageId) {
  if (!messageId || !channel?.messages?.fetch) return;
  try {
    const message = await channel.messages.fetch(messageId);
    if (message?.deletable) {
      await message.delete();
    }
  } catch {
    // Ignore missing/deleted message errors.
  }
}

module.exports = {
  name: "stick",
  description: "Manage sticky messages in channels",
  options: [
    {
      name: "add",
      description: "Create a sticky message in a channel",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "message",
          description: "Sticky message content",
          type: ApplicationCommandOptionType.String,
          required: true,
          min_length: 1,
          max_length: 1800,
        },
        {
          name: "channel",
          description: "Channel to apply sticky message to (defaults to current channel)",
          type: ApplicationCommandOptionType.Channel,
          required: false,
        },
        {
          name: "cooldown",
          description: "Seconds to wait before resticking after chat activity (0 = immediate)",
          type: ApplicationCommandOptionType.Integer,
          required: false,
          min_value: 0,
          max_value: 300,
        },
        {
          name: "components_v2",
          description: "Send sticky as a Components V2 card",
          type: ApplicationCommandOptionType.Boolean,
          required: false,
        },
      ],
    },
    {
      name: "edit",
      description: "Edit an existing sticky message",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "sticky_id",
          description: "Sticky ID to edit (required when channel has multiple stickies)",
          type: ApplicationCommandOptionType.Integer,
          required: false,
          min_value: 1,
        },
        {
          name: "message",
          description: "New sticky message content",
          type: ApplicationCommandOptionType.String,
          required: false,
          min_length: 1,
          max_length: 1800,
        },
        {
          name: "cooldown",
          description: "New cooldown in seconds (0 = immediate)",
          type: ApplicationCommandOptionType.Integer,
          required: false,
          min_value: 0,
          max_value: 300,
        },
        {
          name: "components_v2",
          description: "Set Components V2 mode for this sticky",
          type: ApplicationCommandOptionType.Boolean,
          required: false,
        },
        {
          name: "channel",
          description: "Channel containing the sticky (defaults to current channel)",
          type: ApplicationCommandOptionType.Channel,
          required: false,
        },
      ],
    },
    {
      name: "remove",
      description: "Remove one or all sticky messages from a channel",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "sticky_id",
          description: "Sticky ID to remove (omit to remove all in the channel)",
          type: ApplicationCommandOptionType.Integer,
          required: false,
          min_value: 1,
        },
        {
          name: "channel",
          description: "Channel to remove sticky from (defaults to current channel)",
          type: ApplicationCommandOptionType.Channel,
          required: false,
        },
      ],
    },
    {
      name: "remove_from_list",
      description: "Remove a sticky by list position in the channel",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "index",
          description: "Position from `/stick config` list (1 = first)",
          type: ApplicationCommandOptionType.Integer,
          required: true,
          min_value: 1,
        },
        {
          name: "channel",
          description: "Channel to remove sticky from (defaults to current channel)",
          type: ApplicationCommandOptionType.Channel,
          required: false,
        },
      ],
    },
    {
      name: "list",
      description: "List all sticky messages in a channel",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "channel",
          description: "Channel to inspect (defaults to current channel)",
          type: ApplicationCommandOptionType.Channel,
          required: false,
        },
      ],
    },
    {
      name: "config",
      description: "Show sticky configuration for a channel",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "sticky_id",
          description: "Specific sticky ID to inspect",
          type: ApplicationCommandOptionType.Integer,
          required: false,
          min_value: 1,
        },
        {
          name: "channel",
          description: "Channel to inspect (defaults to current channel)",
          type: ApplicationCommandOptionType.Channel,
          required: false,
        },
      ],
    },
    {
      name: "toggle",
      description: "Toggle sticky between plain text and Components V2 card",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "components_v2",
          description: "Enable Components V2 mode",
          type: ApplicationCommandOptionType.Boolean,
          required: true,
        },
        {
          name: "sticky_id",
          description: "Sticky ID to update (required when channel has multiple stickies)",
          type: ApplicationCommandOptionType.Integer,
          required: false,
          min_value: 1,
        },
        {
          name: "channel",
          description: "Channel to update (defaults to current channel)",
          type: ApplicationCommandOptionType.Channel,
          required: false,
        },
      ],
    },
  ],

  run: async ({ context }) => {
    if (!isAdminContext(context)) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Permission Denied",
          description: "Only admins can use `/stick`.",
        })
      );
    }

    const subcommand = context.options.getSubcommand();
    const targetChannel = getTargetChannel(context);
    const guildId = context.guild.id;
    const channelId = targetChannel?.id;

    if (!isValidTextChannel(targetChannel)) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Invalid Channel",
          description: "Please select a server text channel.",
        })
      );
    }

    const botPerms = targetChannel.permissionsFor(context.client.user);
    if (!botPerms?.has(PermissionFlagsBits.SendMessages)) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Missing Permission",
          description: `I need **Send Messages** in <#${targetChannel.id}>.`,
        })
      );
    }

    if (subcommand === "config") {
      const stickies = await StickyMessage.findMany(
        { guildId, channelId },
        { orderBy: "id ASC" }
      );

      if (!stickies.length) {
        return context.createMessage(
          buildServerCard({
            title: "✕ No Sticky Config",
            description: `No sticky message is configured for <#${targetChannel.id}>.`,
          })
        );
      }

      const requestedStickyId = context.options.getInteger("sticky_id");

      if (requestedStickyId !== null) {
        const sticky = stickies.find((row) => Number(row.id) === requestedStickyId);
        if (!sticky) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Sticky Not Found",
              description: `Sticky **#${requestedStickyId}** is not configured in <#${targetChannel.id}>.`,
            })
          );
        }

        const updatedAt = sticky.updatedAt
          ? `<t:${Math.floor(Number(sticky.updatedAt) / 1000)}:R>`
          : "Unknown";

        return context.createMessage(
          buildServerCard({
            title: "✔ Sticky Config",
            description: `Sticky **#${sticky.id}** in <#${targetChannel.id}>.`,
            details: [
              `├─ **Cooldown:** ${sticky.cooldownSeconds}s`,
              `├─ **Mode:** ${getStickyModeLabel(sticky.useComponentsV2)}`,
              `├─ **Updated:** ${updatedAt}`,
              `├─ **Updated By:** ${sticky.updatedBy ? `<@${sticky.updatedBy}>` : "Unknown"}`,
              `└─ **Message:** ${truncateText(sticky.content, 280)}`,
            ],
          })
        );
      }

      return context.createMessage(
        buildServerCard({
          title: "✔ Sticky Config List",
          description: `Found **${stickies.length}** sticky message(s) in <#${targetChannel.id}>.`,
          details: getStickyPreviewLines(stickies),
        })
      );
    }

    if (subcommand === "list") {
      const stickies = await StickyMessage.findMany(
        { guildId, channelId },
        { orderBy: "id ASC" }
      );

      if (!stickies.length) {
        return context.createMessage(
          buildServerCard({
            title: "✕ No Sticky Config",
            description: `No sticky message is configured for <#${targetChannel.id}>.`,
          })
        );
      }

      return context.createMessage(
        buildServerCard({
          title: "✔ Sticky List",
          description: `Found **${stickies.length}** sticky message(s) in <#${targetChannel.id}>.`,
          details: getStickyListLines(stickies),
        })
      );
    }

    if (subcommand === "edit") {
      const stickies = await StickyMessage.findMany(
        { guildId, channelId },
        { orderBy: "id ASC" }
      );

      if (!stickies.length) {
        return context.createMessage(
          buildServerCard({
            title: "✕ No Sticky Config",
            description: `No sticky message is configured for <#${targetChannel.id}>.`,
          })
        );
      }

      const requestedStickyId = context.options.getInteger("sticky_id");
      const messageInput = context.options.getString("message");
      const cooldownInput = context.options.getInteger("cooldown");
      const componentsInput = context.options.getBoolean("components_v2");

      if (
        messageInput === null
        && cooldownInput === null
        && componentsInput === null
      ) {
        return context.createMessage(
          buildServerCard({
            title: "✕ Nothing To Edit",
            description: "Provide at least one field: `message`, `cooldown`, or `components_v2`.",
          })
        );
      }

      let sticky = null;
      if (requestedStickyId !== null) {
        sticky = stickies.find((row) => Number(row.id) === requestedStickyId) || null;
      } else if (stickies.length === 1) {
        sticky = stickies[0];
      }

      if (!sticky) {
        if (requestedStickyId === null) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Sticky ID Required",
              description: `This channel has multiple sticky messages. Use \`sticky_id\` with \`/stick edit\`.`,
              details: getStickyPreviewLines(stickies),
            })
          );
        }

        return context.createMessage(
          buildServerCard({
            title: "✕ Sticky Not Found",
            description: `Sticky **#${requestedStickyId}** is not configured in <#${targetChannel.id}>.`,
          })
        );
      }

      let nextContent = sticky.content;
      if (messageInput !== null) {
        const trimmedMessage = messageInput.trim();
        if (!trimmedMessage) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Invalid Message",
              description: "Sticky message content cannot be empty.",
            })
          );
        }
        nextContent = trimmedMessage;
      }

      const nextCooldown = cooldownInput ?? sticky.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;
      const nextUseComponentsV2 =
        componentsInput === null
          ? (isComponentsV2Enabled(sticky.useComponentsV2) ? 1 : 0)
          : (componentsInput ? 1 : 0);

      let postedMessage;
      try {
        postedMessage = await targetChannel.send(
          buildStickyPayload(nextContent, nextUseComponentsV2)
        );
      } catch (err) {
        console.error("[Sticky] Failed to post edited sticky message:", err);
        return context.createMessage(
          buildServerCard({
            title: "✕ Sticky Post Failed",
            description: `Couldn't post edited sticky **#${sticky.id}** in <#${targetChannel.id}>.`,
          })
        );
      }

      await deleteExistingStickyMessage(targetChannel, sticky.lastStickyMessageId);

      await StickyMessage.updateOne(
        { id: sticky.id, guildId, channelId },
        {
          content: nextContent,
          cooldownSeconds: nextCooldown,
          useComponentsV2: nextUseComponentsV2,
          lastStickyMessageId: postedMessage.id,
          updatedBy: context.user.id,
          updatedAt: Date.now(),
        }
      );

      return context.createMessage(
        buildServerCard({
          title: "✔ Sticky Edited",
          description: `Updated sticky **#${sticky.id}** in <#${targetChannel.id}>.`,
          details: [
            `├─ **Cooldown:** ${nextCooldown}s`,
            `├─ **Mode:** ${getStickyModeLabel(nextUseComponentsV2)}`,
            `└─ **Message:** ${truncateText(nextContent, 280)}`,
          ],
        })
      );
    }

    if (subcommand === "remove") {
      const stickies = await StickyMessage.findMany(
        { guildId, channelId },
        { orderBy: "id ASC" }
      );

      if (!stickies.length) {
        return context.createMessage(
          buildServerCard({
            title: "✕ Nothing To Remove",
            description: `No sticky message is configured for <#${targetChannel.id}>.`,
          })
        );
      }

      const requestedStickyId = context.options.getInteger("sticky_id");

      if (requestedStickyId !== null) {
        const sticky = stickies.find((row) => Number(row.id) === requestedStickyId);
        if (!sticky) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Sticky Not Found",
              description: `Sticky **#${requestedStickyId}** is not configured in <#${targetChannel.id}>.`,
            })
          );
        }

        await StickyMessage.deleteOne({ id: sticky.id, guildId, channelId });
        await deleteExistingStickyMessage(targetChannel, sticky.lastStickyMessageId);

        return context.createMessage(
          buildServerCard({
            title: "✔ Sticky Removed",
            description: `Removed sticky **#${sticky.id}** from <#${targetChannel.id}>.`,
          })
        );
      }

      await StickyMessage.deleteMany({ guildId, channelId });
      await Promise.all(
        stickies.map((sticky) =>
          deleteExistingStickyMessage(targetChannel, sticky.lastStickyMessageId)
        )
      );

      return context.createMessage(
        buildServerCard({
          title: "✔ Stickies Removed",
          description: `Removed **${stickies.length}** sticky message(s) from <#${targetChannel.id}>.`,
        })
      );
    }

    if (subcommand === "remove_from_list") {
      const stickies = await StickyMessage.findMany(
        { guildId, channelId },
        { orderBy: "id ASC" }
      );

      if (!stickies.length) {
        return context.createMessage(
          buildServerCard({
            title: "✕ Nothing To Remove",
            description: `No sticky message is configured for <#${targetChannel.id}>.`,
          })
        );
      }

      const listIndex = context.options.getInteger("index");
      if (listIndex > stickies.length) {
        return context.createMessage(
          buildServerCard({
            title: "✕ Invalid List Index",
            description: `That list index does not exist. Channel has **${stickies.length}** sticky message(s).`,
          })
        );
      }

      const sticky = stickies[listIndex - 1];
      await StickyMessage.deleteOne({ id: sticky.id, guildId, channelId });
      await deleteExistingStickyMessage(targetChannel, sticky.lastStickyMessageId);

      return context.createMessage(
        buildServerCard({
          title: "✔ Sticky Removed",
          description: `Removed list item **#${listIndex}** (sticky **#${sticky.id}**) from <#${targetChannel.id}>.`,
        })
      );
    }

    if (subcommand === "toggle") {
      const stickies = await StickyMessage.findMany(
        { guildId, channelId },
        { orderBy: "id ASC" }
      );

      if (!stickies.length) {
        return context.createMessage(
          buildServerCard({
            title: "✕ No Sticky Config",
            description: `No sticky message is configured for <#${targetChannel.id}>.`,
          })
        );
      }

      const useComponentsV2 = context.options.getBoolean("components_v2") ? 1 : 0;
      const requestedStickyId = context.options.getInteger("sticky_id");

      let sticky = null;
      if (requestedStickyId !== null) {
        sticky = stickies.find((row) => Number(row.id) === requestedStickyId) || null;
      } else if (stickies.length === 1) {
        sticky = stickies[0];
      }

      if (!sticky) {
        if (requestedStickyId === null) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Sticky ID Required",
              description: `This channel has multiple sticky messages. Use \`sticky_id\` with \`/stick toggle\`.`,
              details: getStickyPreviewLines(stickies),
            })
          );
        }

        return context.createMessage(
          buildServerCard({
            title: "✕ Sticky Not Found",
            description: `Sticky **#${requestedStickyId}** is not configured in <#${targetChannel.id}>.`,
          })
        );
      }

      let postedMessage;
      try {
        postedMessage = await targetChannel.send(
          buildStickyPayload(sticky.content, useComponentsV2)
        );
      } catch (err) {
        console.error("[Sticky] Failed to post toggled sticky message:", err);
        return context.createMessage(
          buildServerCard({
            title: "✕ Sticky Post Failed",
            description: `Couldn't post sticky **#${sticky.id}** in <#${targetChannel.id}>.`,
          })
        );
      }

      await deleteExistingStickyMessage(targetChannel, sticky.lastStickyMessageId);

      await StickyMessage.updateOne(
        { id: sticky.id, guildId, channelId },
        {
          useComponentsV2,
          lastStickyMessageId: postedMessage.id,
          updatedBy: context.user.id,
          updatedAt: Date.now(),
        }
      );

      return context.createMessage(
        buildServerCard({
          title: "✔ Sticky Mode Updated",
          description: `Sticky **#${sticky.id}** in <#${targetChannel.id}> is now **${getStickyModeLabel(useComponentsV2)}**.`,
        })
      );
    }

    if (subcommand === "add") {
      const content = (context.options.getString("message") || "").trim();
      if (!content) {
        return context.createMessage(
          buildServerCard({
            title: "✕ Invalid Message",
            description: "Sticky message content cannot be empty.",
          })
        );
      }

      const cooldownSeconds =
        context.options.getInteger("cooldown") ?? DEFAULT_COOLDOWN_SECONDS;
      const useComponentsV2 = context.options.getBoolean("components_v2") ? 1 : 0;

      let postedMessage;
      try {
        postedMessage = await targetChannel.send(
          buildStickyPayload(content, useComponentsV2)
        );
      } catch (err) {
        console.error("[Sticky] Failed to post sticky message:", err);
        return context.createMessage(
          buildServerCard({
            title: "✕ Sticky Post Failed",
            description: `Couldn't post sticky message in <#${targetChannel.id}>.`,
          })
        );
      }

      let createdSticky;
      try {
        createdSticky = await StickyMessage.create({
          guildId,
          channelId,
          content,
          cooldownSeconds,
          useComponentsV2,
          lastStickyMessageId: postedMessage.id,
          updatedBy: context.user.id,
          updatedAt: Date.now(),
        });
      } catch (err) {
        console.error("[Sticky] Failed to save sticky config:", err);
        await deleteExistingStickyMessage(targetChannel, postedMessage.id);
        return context.createMessage(
          buildServerCard({
            title: "✕ Sticky Save Failed",
            description: "Failed to save sticky configuration.",
          })
        );
      }

      return context.createMessage(
        buildServerCard({
          title: "✔ Sticky Added",
          description: `Created sticky **#${createdSticky.id}** in <#${targetChannel.id}>.`,
          details: [
            `├─ **Cooldown:** ${cooldownSeconds}s`,
            `├─ **Mode:** ${getStickyModeLabel(useComponentsV2)}`,
            `└─ **Message:** ${truncateText(content, 280)}`,
          ],
        })
      );
    }

    return context.createMessage(
      buildServerCard({
        title: "✕ Invalid Subcommand",
        description: "Use `/stick add`, `/stick edit`, `/stick remove`, `/stick remove_from_list`, `/stick list`, `/stick config`, or `/stick toggle`.",
      })
    );
  },
};
