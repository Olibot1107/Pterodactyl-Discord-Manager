const { ApplicationCommandOptionType, PermissionFlagsBits } = require("discord.js");
const BoosterGrant = require("../../models/BoosterGrant");
const { revokeBoosterPerks } = require("../../structures/boosterPerks");
const { buildServerCard } = require("../../structures/serverCommandUi");
const { discord, adminid } = require("../../../settings");

const BOOSTER_ROLE_ID = discord?.boosterRoleId || "1473717031202193408";
const DEFAULT_GRANT_DAYS = 7;
const MAX_GRANT_DAYS = 365;

function hasAdminAccess(actor) {
  return (
    actor.user.id === adminid ||
    actor.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );
}

function clampDays(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_GRANT_DAYS;
  return Math.max(1, Math.min(MAX_GRANT_DAYS, Math.floor(numeric)));
}

module.exports = {
  name: "booster",
  description: "Manage temporary booster perks",
  options: [
    {
      name: "grant",
      description: "Grant the booster role for a limited time",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "user",
          description: "User to grant booster perks to",
          type: ApplicationCommandOptionType.User,
          required: true,
        },
        {
          name: "days",
          description: "How many days to grant (default: 7)",
          type: ApplicationCommandOptionType.Integer,
          required: false,
          min_value: 1,
          max_value: MAX_GRANT_DAYS,
        },
      ],
    },
    {
      name: "revoke",
      description: "Revoke a temporary booster grant",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "user",
          description: "User to revoke booster perks from",
          type: ApplicationCommandOptionType.User,
          required: true,
        },
      ],
    },
  ],

  run: async ({ context }) => {
    if (!hasAdminAccess(context)) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Permission Denied",
          description: "Only admins can manage temporary booster perks.",
        })
      );
    }

    const subcommand = context.options.getSubcommand();
    const targetUser = context.options.getUser("user");
    const guild = context.guild;

    if (!guild) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Guild Only",
          description: "This command can only be used in a server.",
        })
      );
    }

    const member = await guild.members.fetch(targetUser.id).catch(() => null);
    if (!member) {
      return context.createMessage(
        buildServerCard({
          title: "✕ User Not Found",
          description: "That user is not in this server.",
        })
      );
    }

    if (subcommand === "grant") {
      if (member.premiumSince) {
        return context.createMessage(
          buildServerCard({
            title: "✕ Already Boosting",
            description: "That user is already boosting and has the booster perks.",
          })
        );
      }

      const days = clampDays(context.options.getInteger("days"));
      const now = Date.now();
      const expiresAt = now + days * 24 * 60 * 60 * 1000;

      try {
        if (!member.roles.cache.has(BOOSTER_ROLE_ID)) {
          await member.roles.add(BOOSTER_ROLE_ID);
        }

        await BoosterGrant.upsert({
          discordId: targetUser.id,
          grantedBy: context.user.id,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        });

        const expiresUnix = Math.floor(expiresAt / 1000);

        return context.createMessage(
          buildServerCard({
            title: "✔ Booster Granted",
            description: `Temporary booster perks granted to **${targetUser.tag}**.`,
            details: [
              `├─ **Duration:** ${days} day(s)`,
              `└─ **Expires:** <t:${expiresUnix}:F>`,
            ],
          })
        );
      } catch (err) {
        console.error("Booster grant error:", err);
        return context.createMessage(
          buildServerCard({
            title: "✕ Grant Failed",
            description: "Failed to grant booster perks. Please try again.",
          })
        );
      }
    }

    if (subcommand === "revoke") {
      try {
        if (!member.premiumSince && member.roles.cache.has(BOOSTER_ROLE_ID)) {
          await member.roles.remove(BOOSTER_ROLE_ID);
        }

        await revokeBoosterPerks({
          userId: targetUser.id,
          userTag: targetUser.tag,
        });

        await BoosterGrant.deleteOne({ discordId: targetUser.id });

        return context.createMessage(
          buildServerCard({
            title: "✔ Booster Revoked",
            description: `Temporary booster perks revoked for **${targetUser.tag}**.`,
          })
        );
      } catch (err) {
        console.error("Booster revoke error:", err);
        return context.createMessage(
          buildServerCard({
            title: "✕ Revoke Failed",
            description: "Failed to revoke booster perks. Please try again.",
          })
        );
      }
    }

    return context.createMessage(
      buildServerCard({
        title: "✕ Invalid Action",
        description: "Unknown booster action.",
      })
    );
  },
};
