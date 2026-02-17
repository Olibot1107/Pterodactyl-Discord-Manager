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
      name: "minutes",
      description: "Timeout duration in minutes (1-40320)",
      type: ApplicationCommandOptionType.Integer,
      required: true,
      min_value: 1,
      max_value: 40320,
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
    const minutes = context.options.getInteger("minutes");
    const reason = context.options.getString("reason") || "No reason provided";

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
      await member.timeout(minutes * 60 * 1000, reason);
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
          `├─ **Duration:** ${minutes} minute(s)`,
          `└─ **Reason:** ${reason}`,
        ],
      })
    );
  },
};
