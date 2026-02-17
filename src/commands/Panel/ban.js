const { ApplicationCommandOptionType, PermissionFlagsBits } = require("discord.js");
const { adminid } = require("../../../settings");
const { buildServerCard } = require("../../structures/serverCommandUi");

module.exports = {
  name: "ban",
  description: "Ban a user from the Discord server",
  options: [
    {
      name: "user",
      description: "User to ban",
      type: ApplicationCommandOptionType.User,
      required: true,
    },
    {
      name: "reason",
      description: "Reason for ban",
      type: ApplicationCommandOptionType.String,
      required: false,
      max_length: 512,
    },
    {
      name: "prune_hours",
      description: "Delete message history from the last N hours (0-168)",
      type: ApplicationCommandOptionType.Integer,
      required: false,
      min_value: 0,
      max_value: 168,
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
          description: "Only admins can use `/ban`.",
        })
      );
    }

    const targetUser = context.options.getUser("user");
    const reason = context.options.getString("reason") || "No reason provided";
    const pruneHours = context.options.getInteger("prune_hours") ?? 0;

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
          description: "You cannot ban yourself.",
        })
      );
    }

    if (targetUser.id === context.client.user.id) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Invalid Target",
          description: "I cannot ban myself.",
        })
      );
    }

    const member = await context.guild.members.fetch(targetUser.id).catch(() => null);
    if (member && !member.bannable) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Cannot Ban",
          description: "I cannot ban that user due to role hierarchy or missing permissions.",
        })
      );
    }

    try {
      await context.guild.members.ban(targetUser.id, {
        reason,
        deleteMessageSeconds: pruneHours * 3600,
      });
    } catch (err) {
      console.error("[Ban] Failed to ban user:", err);
      return context.createMessage(
        buildServerCard({
          title: "✕ Ban Failed",
          description: "Failed to ban that user.",
        })
      );
    }

    return context.createMessage(
      buildServerCard({
        title: "✔ User Banned",
        details: [
          `├─ **User:** <@${targetUser.id}>`,
          `├─ **Reason:** ${reason}`,
          `└─ **Prune:** ${pruneHours} hour(s)`,
        ],
      })
    );
  },
};
