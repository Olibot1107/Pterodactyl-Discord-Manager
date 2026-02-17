const { ApplicationCommandOptionType, PermissionFlagsBits } = require("discord.js");
const { adminid } = require("../../../settings");
const { buildServerCard } = require("../../structures/serverCommandUi");

module.exports = {
  name: "timeout",
  description: "Timeout a user in Discord",
  options: [
    {
      name: "user",
      description: "User to timeout",
      type: ApplicationCommandOptionType.User,
      required: true,
    },
    {
      name: "duration",
      description: "Timeout duration (e.g. 30s, 5m, 2h, 3d)",
      type: ApplicationCommandOptionType.String,
      required: true,
      min_length: 2,
      max_length: 10,
    },
    {
      name: "reason",
      description: "Reason for timeout",
      type: ApplicationCommandOptionType.String,
      required: false,
      max_length: 512,
    },
  ],

  run: async ({ context }) => {
    const isAdmin =
      context.user.id === adminid ||
      context.memberPermissions?.has(PermissionFlagsBits.Administrator);

    if (!isAdmin) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Permission Denied",
          description: "Only admins can use `/timeout`.",
        })
      );
    }

    const targetUser = context.options.getUser("user");
    const durationInput = (context.options.getString("duration") || "").trim().toLowerCase();
    const reason = context.options.getString("reason") || "No reason provided";

    const match = durationInput.match(/^(\d+)\s*([smhd])$/i);
    if (!match) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Invalid Duration",
          description: "Use formats like `30s`, `5m`, `2h`, or `3d`.",
        })
      );
    }

    const amount = Number(match[1]);
    const unit = match[2];
    const multiplier = {
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    }[unit];
    const durationMs = amount * multiplier;
    const maxTimeoutMs = 28 * 24 * 60 * 60 * 1000; // Discord max: 28 days

    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > maxTimeoutMs) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Duration Out Of Range",
          description: "Duration must be greater than 0 and at most `28d`.",
        })
      );
    }

    if (!targetUser) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Missing User",
          description: "Please provide a valid user.",
        })
      );
    }

    if (targetUser.id === context.user.id) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Invalid Target",
          description: "You cannot timeout yourself.",
        })
      );
    }

    if (targetUser.id === context.client.user.id) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Invalid Target",
          description: "I cannot timeout myself.",
        })
      );
    }

    const member = await context.guild.members.fetch(targetUser.id).catch(() => null);
    if (!member) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Member Not Found",
          description: "That user is not in this server.",
        })
      );
    }

    if (!member.moderatable) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Cannot Timeout",
          description: "I cannot timeout that user due to role hierarchy or missing permissions.",
        })
      );
    }

    try {
      await member.timeout(durationMs, reason);
    } catch (err) {
      console.error("[Timeout] Failed to apply timeout:", err);
      return context.createMessage(
        buildServerCard({
          title: "✕ Timeout Failed",
          description: "Failed to apply timeout on Discord.",
        })
      );
    }

    return context.createMessage(
      buildServerCard({
        title: "✔ User Timed Out",
        description: "Timeout completed.",
        details: [
          `├─ **User:** <@${targetUser.id}>`,
          `├─ **Duration:** ${durationInput}`,
          `└─ **Reason:** ${reason}`,
        ],
      })
    );
  },
};
