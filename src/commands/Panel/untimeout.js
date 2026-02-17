const { ApplicationCommandOptionType, PermissionFlagsBits } = require("discord.js");
const { adminid } = require("../../../settings");
const { buildServerCard } = require("../../structures/serverCommandUi");

module.exports = {
  name: "untimeout",
  description: "Remove timeout from a user in Discord",
  options: [
    {
      name: "user",
      description: "User to remove timeout from",
      type: ApplicationCommandOptionType.User,
      required: true,
    },
    {
      name: "reason",
      description: "Reason for removing timeout",
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
          description: "Only admins can use `/untimeout`.",
        })
      );
    }

    const targetUser = context.options.getUser("user");
    const reason = context.options.getString("reason") || "No reason provided";

    if (!targetUser) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Missing User",
          description: "Please provide a valid user.",
        })
      );
    }

    if (targetUser.id === context.client.user.id) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Invalid Target",
          description: "I cannot modify my own timeout state.",
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
          title: "✕ Cannot Modify Timeout",
          description: "I cannot remove timeout due to role hierarchy or missing permissions.",
        })
      );
    }

    if (!member.isCommunicationDisabled()) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Not Timed Out",
          description: "That user is not currently timed out.",
        })
      );
    }

    try {
      await member.timeout(null, reason);
    } catch (err) {
      console.error("[Untimeout] Failed to remove timeout:", err);
      return context.createMessage(
        buildServerCard({
          title: "✕ Untimeout Failed",
          description: "Failed to remove timeout from that user.",
        })
      );
    }

    return context.createMessage(
      buildServerCard({
        title: "✔ Timeout Removed",
        details: [
          `├─ **User:** <@${targetUser.id}>`,
          `└─ **Reason:** ${reason}`,
        ],
      })
    );
  },
};
