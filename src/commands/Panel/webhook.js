const { ApplicationCommandOptionType, PermissionFlagsBits } = require("discord.js");
const api = require("../../structures/Ptero");
const User = require("../../models/User");
const ServerWebhook = require("../../models/ServerWebhook");
const { buildServerCard } = require("../../structures/serverCommandUi");

const WEBHOOK_URL_RE = /^https?:\/\/(canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/i;

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

function hasAdminAccess(actor) {
  return actor.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

async function getUserAndOwnedServers(discordId) {
  const user = await User.findOne({ discordId });
  if (!user) return { user: null, ownedServers: [] };

  const allServers = await fetchAllServers();
  const ownedServers = allServers.filter((s) => s.attributes.user === user.pteroId);
  return { user, ownedServers };
}

module.exports = {
  name: "webhook",
  description: "Send server status changes to a Discord webhook",
  options: [
    {
      name: "set",
      description: "Attach a webhook to a server you own",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "server",
          description: "Choose one of your servers",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "url",
          description: "Discord webhook URL",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "remove",
      description: "Remove a webhook from a server you own",
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
    {
      name: "list",
      description: "Show your current webhook subscriptions",
      type: ApplicationCommandOptionType.Subcommand,
    },
  ],

  autocomplete: async ({ interaction }) => {
    const discordId = interaction.user.id;
    const focusedOption = interaction.options.getFocused(true);
    const focused = String(focusedOption.value || "").toLowerCase();

    try {
      let serverPool = [];
      if (hasAdminAccess(interaction)) {
        serverPool = await fetchAllServers();
      } else {
        const { user, ownedServers } = await getUserAndOwnedServers(discordId);
        if (!user) return interaction.respond([]);
        serverPool = ownedServers;
      }

      const choices = serverPool
        .map((s) => ({
          name: `${s.attributes.name} (${s.attributes.identifier})`,
          value: s.attributes.identifier,
        }))
        .filter((c) => c.name.toLowerCase().includes(focused) || c.value.toLowerCase().includes(focused))
        .slice(0, 25);

      return interaction.respond(choices);
    } catch (err) {
      console.error("Webhook autocomplete error:", err.response?.data || err);
      return interaction.respond([]);
    }
  },

  run: async ({ context }) => {
    const discordId = context.user.id;
    const subcommand = context.options.getSubcommand();
    const identifier = context.options.getString("server");

    try {
      let serverPool = [];
      if (hasAdminAccess(context)) {
        serverPool = await fetchAllServers();
      } else {
        const { user, ownedServers } = await getUserAndOwnedServers(discordId);
        if (!user) {
          return context.createMessage(
            buildServerCard({
              title: "Not registered",
              description: "You need to register first using `/register`.",
            })
          );
        }
        serverPool = ownedServers;
      }

      if (subcommand === "list") {
        const subs = await ServerWebhook.findMany({ discordId }, { orderBy: "updatedAt DESC" });
        if (!subs.length) {
          return context.createMessage(
            buildServerCard({
              title: "No webhooks yet",
              description: "Use `/webhook set` to attach a webhook to one of your servers.",
            })
          );
        }

        const lines = subs.slice(0, 20).map((sub) => `• \`${sub.serverIdentifier}\` → ${sub.webhookUrl}`);
        const extra = subs.length > 20 ? `\n…and ${subs.length - 20} more.` : "";
        return context.createMessage(
          buildServerCard({
            title: "Your webhooks",
            description: `${lines.join("\n")}${extra}`,
          })
        );
      }

      const owned = serverPool.find((s) => s.attributes.identifier === identifier);
      if (!owned) {
        return context.createMessage(
          buildServerCard({
            title: "Server not found",
            description: hasAdminAccess(context)
              ? "Pick a valid server from autocomplete."
              : "Please choose one of your own servers.",
          })
        );
      }

      if (subcommand === "set") {
        const url = String(context.options.getString("url") || "").trim();
        if (!WEBHOOK_URL_RE.test(url)) {
          return context.createMessage(
            buildServerCard({
              title: "Invalid webhook URL",
              description: "Paste a real Discord webhook URL like `https://discord.com/api/webhooks/...`.",
            })
          );
        }

        await ServerWebhook.upsert({
          discordId,
          serverIdentifier: identifier,
          webhookUrl: url,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        return context.createMessage(
          buildServerCard({
            title: "Webhook set",
            description:
              `We'll notify this webhook when **${owned.attributes.name}** changes state.`,
          })
        );
      }

      if (subcommand === "remove") {
        const result = await ServerWebhook.deleteOne({
          discordId,
          serverIdentifier: identifier,
        });

        if (!result?.affectedRows) {
          return context.createMessage(
            buildServerCard({
              title: "Nothing to remove",
              description: "No webhook was set for that server.",
            })
          );
        }

        return context.createMessage(
          buildServerCard({
            title: "Webhook removed",
            description: `Removed webhook notifications for **${owned.attributes.name}**.`,
          })
        );
      }

      return context.createMessage(
        buildServerCard({
          title: "Unknown action",
          description: "That subcommand is not supported.",
        })
      );
    } catch (err) {
      console.error("Webhook command error:", err.response?.data || err);
      return context.createMessage(
        buildServerCard({
          title: "Webhook failed",
          description: "Something went wrong while saving your webhook.",
        })
      );
    }
  },
};
