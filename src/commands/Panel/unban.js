const { ApplicationCommandOptionType, PermissionFlagsBits } = require("discord.js");
const { adminid } = require("../../../settings");
const { buildServerCard } = require("../../structures/serverCommandUi");

module.exports = {
  name: "unban",
  description: "Unban a user from the Discord server",
  options: [
    {
      name: "user_id",
      description: "Discord user ID to unban",
      type: ApplicationCommandOptionType.String,
      required: true,
      min_length: 17,
      max_length: 20,
    },
    {
      name: "reason",
      description: "Reason for unban",
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
          description: "Only admins can use `/unban`.",
        })
      );
    }

    const userId = context.options.getString("user_id");
    const reason = context.options.getString("reason") || "No reason provided";

    if (!/^\d{17,20}$/.test(userId || "")) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Invalid User ID",
          description: "Please provide a valid Discord user ID.",
        })
      );
    }

    try {
      await context.guild.bans.fetch(userId);
    } catch {
      return context.createMessage(
        buildServerCard({
          title: "✕ Not Banned",
          description: "That user is not currently banned.",
        })
      );
    }

    try {
      await context.guild.members.unban(userId, reason);
    } catch (err) {
      console.error("[Unban] Failed to unban user:", err);
      return context.createMessage(
        buildServerCard({
          title: "✕ Unban Failed",
          description: "Failed to unban that user.",
        })
      );
    }

    return context.createMessage(
      buildServerCard({
        title: "✔ User Unbanned",
        details: [
          `├─ **User ID:** ${userId}`,
          `└─ **Reason:** ${reason}`,
        ],
      })
    );
  },
};
