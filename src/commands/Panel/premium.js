const { ApplicationCommandOptionType } = require("discord.js");
const api = require("../../structures/Ptero");
const User = require("../../models/User");
const BoosterPremium = require("../../models/BoosterPremium");
const { updateServerBuild, getServerAttributes } = require("../../structures/pteroBuild");
const {
  buildServerCard,
  buildServerCooldownCard,
  consumeServerCooldown,
} = require("../../structures/serverCommandUi");
const { discord } = require("../../../settings");

const BOOSTER_ROLE_ID = discord?.boosterRoleId || "1473717031202193408";
const PREMIUM_LIMITS = {
  memory: 1024,
  disk: 10240,
  cpu: 100,
};

async function fetchAllServers() {
  const allServers = [];
  for (let page = 1; ; page++) {
    const res = await api.get(`/servers?page=${page}&per_page=100`);
    const servers = res.data.data || [];
    allServers.push(...servers);
    if (servers.length < 100) break;
  }
  return allServers;
}

function hasBoosterRole(member) {
  if (!member) return false;
  if (member.premiumSince) return true;
  return member.roles?.cache?.has(BOOSTER_ROLE_ID);
}

module.exports = {
  name: "premium",
  description: "Upgrade one of your servers to premium while boosting",
  options: [
    {
      name: "upgrade",
      description: "Upgrade one of your servers to premium",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "server",
          description: "Choose one of your servers",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
  ],

  autocomplete: async ({ interaction }) => {
    const focusedOption = interaction.options.getFocused(true);
    if (focusedOption.name !== "server") {
      return interaction.respond([]);
    }

    try {
      const user = await User.findOne({ discordId: interaction.user.id });
      if (!user) return interaction.respond([]);

      const servers = await fetchAllServers();
      const owned = servers.filter((server) => server.attributes.user === user.pteroId);

      const focused = String(focusedOption.value || "").toLowerCase();
      const choices = owned
        .map((server) => ({
          name: `${server.attributes.name} (${server.attributes.identifier})`,
          value: server.attributes.identifier,
        }))
        .filter(
          (choice) =>
            choice.name.toLowerCase().includes(focused) ||
            choice.value.toLowerCase().includes(focused)
        )
        .slice(0, 25);

      return interaction.respond(choices);
    } catch (err) {
      console.error("Premium autocomplete error:", err.response?.data || err);
      return interaction.respond([]);
    }
  },

  run: async ({ context }) => {
    const discordId = context.user.id;
    const cooldownRemaining = consumeServerCooldown(discordId);

    if (cooldownRemaining) {
      return context.createMessage(buildServerCooldownCard(cooldownRemaining));
    }

    const member = context.member ?? await context.guild?.members.fetch(discordId).catch(() => null);
    if (!hasBoosterRole(member)) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Boost Required",
          description: "You need the booster role to use premium upgrades.",
        })
      );
    }

    const subcommand = context.options.getSubcommand();
    const identifier = context.options.getString("server");

    if (subcommand !== "upgrade") {
      return context.createMessage(
        buildServerCard({
          title: "✕ Invalid Action",
          description: "Unknown premium action.",
        })
      );
    }

    const user = await User.findOne({ discordId });
    if (!user) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Not Registered",
          description: "You are not registered. Use `/register` first.",
        })
      );
    }

    const existing = await BoosterPremium.findOne({ discordId });
    if (existing) {
      if (existing.serverIdentifier === identifier) {
        return context.createMessage(
          buildServerCard({
            title: "✕ Already Premium",
            description: "That server is already your premium server.",
          })
        );
      }

      return context.createMessage(
        buildServerCard({
          title: "✕ Premium Limit",
          description: "You can only have **one** premium server while boosting.",
          details: [
            `└─ **Current Premium:** ${existing.serverIdentifier}`,
          ],
        })
      );
    }

    try {
      const servers = await fetchAllServers();
      const target = servers.find(
        (server) =>
          server.attributes.user === user.pteroId &&
          server.attributes.identifier === identifier
      );

      if (!target) {
        return context.createMessage(
          buildServerCard({
            title: "✕ Server Not Found",
            description: "That server was not found in your account.",
          })
        );
      }

      const attrs = await getServerAttributes(target.attributes.id);
      const originalLimits = attrs.limits || {};

      const premiumLimits = {
        ...originalLimits,
        ...PREMIUM_LIMITS,
      };

      await updateServerBuild(target.attributes.id, premiumLimits);

      const now = Date.now();
      try {
        await BoosterPremium.create({
          discordId,
          serverId: target.attributes.id,
          serverIdentifier: target.attributes.identifier,
          originalLimits: JSON.stringify(originalLimits),
          createdAt: now,
          updatedAt: now,
        });
      } catch (dbErr) {
        try {
          await updateServerBuild(target.attributes.id, originalLimits);
        } catch (rollbackErr) {
          console.warn("[Premium] Failed to rollback limits after DB error:", rollbackErr.message);
        }
        throw dbErr;
      }

      return context.createMessage(
        buildServerCard({
          title: "✔ Premium Upgraded",
          description: `**${target.attributes.name}** is now premium while you keep boosting.`,
          details: [
            `├─ **RAM:** ${PREMIUM_LIMITS.memory}MB`,
            `├─ **Disk:** ${PREMIUM_LIMITS.disk}MB`,
            `└─ **CPU:** ${PREMIUM_LIMITS.cpu}%`,
          ],
        })
      );
    } catch (err) {
      console.error("Premium upgrade error:", err.response?.data || err);
      const detail = err.response?.data?.errors?.[0]?.detail;
      return context.createMessage(
        buildServerCard({
          title: "✕ Upgrade Failed",
          description: detail || "Failed to upgrade server. Please try again later.",
        })
      );
    }
  },
};
