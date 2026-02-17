const { ApplicationCommandOptionType, PermissionFlagsBits } = require("discord.js");
const axios = require("axios");
const api = require("../../structures/Ptero");
const User = require("../../models/User");
const {
  buildServerCard,
  buildServerCooldownCard,
  consumeServerCooldown,
} = require("../../structures/serverCommandUi");
const { ptero, adminid } = require("../../../settings");

const POWER_SUBCOMMANDS = ["start", "stop", "restart", "kill"];
const ACTION_LABELS = {
  start: "Started",
  stop: "Stopped",
  restart: "Restarted",
  kill: "Killed",
};

function formatBytesToMB(bytes) {
  const value = Number(bytes) || 0;
  return `${Math.max(0, Math.round(value / (1024 * 1024)))}MB`;
}

function getClientApiKeys() {
  const keys = [ptero?.clientApiKey, ptero?.apiKey].filter(Boolean);
  return [...new Set(keys)];
}

async function clientApiRequest(method, path, data) {
  const keys = getClientApiKeys();
  let lastError;

  for (const key of keys) {
    try {
      return await axios({
        method,
        url: `${ptero.url}/api/client${path}`,
        data,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });
    } catch (err) {
      lastError = err;
      const message = String(err.response?.data?.errors?.[0]?.detail || "");
      const isWrongKeyType =
        err.response?.status === 403 &&
        message.includes("requires a client API key");

      if (!isWrongKeyType) break;
    }
  }

  throw lastError;
}

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

async function getUserAndOwnedServers(discordId) {
  const user = await User.findOne({ discordId });
  if (!user) return { user: null, ownedServers: [] };

  const allServers = await fetchAllServers();
  const ownedServers = allServers.filter((s) => s.attributes.user === user.pteroId);
  return { user, ownedServers };
}

function buildCommandOptions() {
  const baseSubcommands = [...POWER_SUBCOMMANDS, "status"].map((name) => ({
    name,
    description: `${name[0].toUpperCase()}${name.slice(1)} one of your servers`,
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
  }));

  baseSubcommands.push({
    name: "suspend",
    description: "Suspend one of a user's servers",
    type: ApplicationCommandOptionType.Subcommand,
    options: [
      {
        name: "user",
        description: "User whose server you want to suspend",
        type: ApplicationCommandOptionType.User,
        required: true,
      },
      {
        name: "server",
        description: "Choose one of that user's servers",
        type: ApplicationCommandOptionType.String,
        required: true,
        autocomplete: true,
      },
    ],
  });

  baseSubcommands.push({
    name: "unsuspend",
    description: "Unsuspend one of a user's servers",
    type: ApplicationCommandOptionType.Subcommand,
    options: [
      {
        name: "user",
        description: "User whose server you want to unsuspend",
        type: ApplicationCommandOptionType.User,
        required: true,
      },
      {
        name: "server",
        description: "Choose one of that user's servers",
        type: ApplicationCommandOptionType.String,
        required: true,
        autocomplete: true,
      },
    ],
  });

  return baseSubcommands;
}

module.exports = {
  name: "server",
  description: "Manage your servers",
  options: buildCommandOptions(),

  autocomplete: async ({ interaction }) => {
    const discordId = interaction.user.id;
    const subcommand = interaction.options.getSubcommand();
    const targetUser =
      (subcommand === "suspend" || subcommand === "unsuspend")
        ? interaction.options.getUser("user")
        : null;
    const lookupDiscordId = targetUser?.id || discordId;
    const focused = interaction.options.getFocused().toLowerCase();

    try {
      const { user, ownedServers } = await getUserAndOwnedServers(lookupDiscordId);
      if (!user) return interaction.respond([]);

      const filteredServers = ownedServers.filter((s) => {
        if (subcommand === "suspend") return !s.attributes.suspended;
        if (subcommand === "unsuspend") return !!s.attributes.suspended;
        return true;
      });

      const choices = filteredServers
        .map((s) => ({
          name: `${s.attributes.name} (${s.attributes.identifier})${s.attributes.suspended ? " [suspended]" : ""}`,
          value: s.attributes.identifier,
        }))
        .filter((c) => c.name.toLowerCase().includes(focused) || c.value.toLowerCase().includes(focused))
        .slice(0, 25);

      return interaction.respond(choices);
    } catch (err) {
      console.error("Server autocomplete error:", err.response?.data || err);
      return interaction.respond([]);
    }
  },

  run: async ({ context }) => {
    const discordId = context.user.id;
    const cooldownRemaining = consumeServerCooldown(discordId);
    if (cooldownRemaining) {
      return context.createMessage(buildServerCooldownCard(cooldownRemaining));
    }

    const subcommand = context.options.getSubcommand();
    const identifier = context.options.getString("server");

    try {
      if (subcommand === "suspend" || subcommand === "unsuspend") {
        const isAdmin =
          context.user.id === adminid ||
          context.memberPermissions?.has(PermissionFlagsBits.Administrator);

        if (!isAdmin) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Permission Denied",
              description: "Only admins can use `/server suspend` and `/server unsuspend`.",
            })
          );
        }

        const targetDiscordUser = context.options.getUser("user");
        if (!targetDiscordUser) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Missing User",
              description: "Please provide a target user.",
            })
          );
        }

        const { user: targetUser, ownedServers: targetServers } = await getUserAndOwnedServers(targetDiscordUser.id);
        if (!targetUser) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Not Registered",
              description: "That user is not registered.",
            })
          );
        }

        const target = targetServers.find((s) => s.attributes.identifier === identifier);
        if (!target) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Server Not Found",
              description: "That server was not found in the selected user's account.",
            })
          );
        }

        if (subcommand === "suspend" && target.attributes.suspended) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Already Suspended",
              description: `**${target.attributes.name}** is already suspended.`,
            })
          );
        }

        if (subcommand === "unsuspend" && !target.attributes.suspended) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Not Suspended",
              description: `**${target.attributes.name}** is not suspended.`,
            })
          );
        }

        await api.post(`/servers/${target.attributes.id}/${subcommand}`);

        return context.createMessage(
          buildServerCard({
            title: subcommand === "suspend" ? "✔ Server Suspended" : "✔ Server Unsuspended",
            description:
              subcommand === "suspend"
                ? `**${target.attributes.name}** has been suspended.`
                : `**${target.attributes.name}** has been unsuspended.`,
            details: [
              `├─ **User:** ${targetDiscordUser.tag}`,
              `├─ **Server:** ${target.attributes.name}`,
              `├─ **Identifier:** ${identifier}`,
              `└─ **Action By:** ${context.user.username}`,
            ],
          })
        );
      }

      const { user, ownedServers } = await getUserAndOwnedServers(discordId);
      if (!user) {
        return context.createMessage(
          buildServerCard({
            title: "✕ Not Registered",
            description: "You are not registered. Use `/register` first.",
          })
        );
      }

      const target = ownedServers.find((s) => s.attributes.identifier === identifier);
      if (!target) {
        return context.createMessage(
          buildServerCard({
            title: "✕ Server Not Found",
            description: "That server was not found in your account.",
          })
        );
      }

      if (subcommand === "status") {
        const resources = await clientApiRequest("GET", `/servers/${identifier}/resources`);
        const attrs = resources.data?.attributes || {};

        return context.createMessage(
          buildServerCard({
            title: "✔ Server Status",
            description: `Status for **${target.attributes.name}**.`,
            details: [
              `├─ **State:** ${attrs.current_state || "unknown"}`,
              `├─ **CPU:** ${attrs.resources?.cpu_absolute ?? 0}%`,
              `├─ **RAM:** ${formatBytesToMB(attrs.resources?.memory_bytes)}`,
              `└─ **Disk:** ${formatBytesToMB(attrs.resources?.disk_bytes)}`,
            ],
          })
        );
      }

      if (POWER_SUBCOMMANDS.includes(subcommand)) {
        if (target.attributes.suspended) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Action Blocked",
              description: "This server is suspended and cannot receive power actions.",
            })
          );
        }

        await clientApiRequest("POST", `/servers/${identifier}/power`, { signal: subcommand });

        return context.createMessage(
          buildServerCard({
            title: `✔ Server ${ACTION_LABELS[subcommand]}`,
            description: `Power action \`${subcommand}\` was sent to **${target.attributes.name}**.`,
            details: [
              `├─ **Server:** ${target.attributes.name}`,
              `├─ **Identifier:** ${identifier}`,
              `└─ **Requested By:** ${context.user.username}`,
            ],
          })
        );
      }

      return context.createMessage(
        buildServerCard({
          title: "✕ Invalid Action",
          description: "Unknown server action.",
        })
      );
    } catch (err) {
      console.error("Server command error:", err.response?.data || err);
      const detail = err.response?.data?.errors?.[0]?.detail;
      return context.createMessage(
        buildServerCard({
          title: "✕ Command Failed",
          description: detail || "Failed to run the server action. Please try again later.",
        })
      );
    }
  },
};
