const { ApplicationCommandOptionType } = require("discord.js");
const api = require("../../structures/Ptero");
const User = require("../../models/User");
const {
  buildServerCard,
  buildServerCooldownCard,
  consumeServerCooldown,
} = require("../../structures/serverCommandUi");

const RUNTIMES = {
  nodejs: {
    label: "Node.js",
    eggIds: new Set([15]),
    versions: {
      "18": "ghcr.io/parkervcp/yolks:nodejs_18",
      "20": "ghcr.io/parkervcp/yolks:nodejs_20",
      "21": "ghcr.io/parkervcp/yolks:nodejs_21",
      "22": "ghcr.io/parkervcp/yolks:nodejs_22",
    },
  },
  python: {
    label: "Python",
    eggIds: new Set([17]),
    versions: {
      "3.9": "ghcr.io/parkervcp/yolks:python_3.9",
      "3.10": "ghcr.io/parkervcp/yolks:python_3.10",
      "3.11": "ghcr.io/parkervcp/yolks:python_3.11",
      "3.12": "ghcr.io/parkervcp/yolks:python_3.12",
      "3.13": "ghcr.io/parkervcp/yolks:python_3.13",
    },
  },
};

function normalizeVersion(runtimeKey, value) {
  const cleaned = String(value || "").trim().toLowerCase().replace(/^v/, "");
  if (runtimeKey === "nodejs") {
    return cleaned.replace(/^node(?:js)?\s*/, "");
  }
  if (runtimeKey === "python") {
    return cleaned.replace(/^python\s*/, "");
  }
  return cleaned;
}

function getVersionChoices(runtimeKey) {
  return Object.keys(RUNTIMES[runtimeKey]?.versions || {}).map((version) => ({
    name: version,
    value: version,
  }));
}

async function fetchAllServers() {
  const allServers = [];
  for (let page = 1; ; page += 1) {
    const res = await api.get(`/servers?page=${page}&per_page=100`);
    const servers = res.data.data || [];
    allServers.push(...servers);
    if (servers.length < 100) break;
  }
  return allServers;
}

async function updateServerRuntimeImage(serverId, dockerImage) {
  try {
    await api.patch(`/servers/${serverId}/startup`, {
      image: dockerImage,
      docker_image: dockerImage,
    });
    return;
  } catch (initialErr) {
    const detailsRes = await api.get(`/servers/${serverId}`);
    const attrs = detailsRes.data?.attributes || {};
    const container = attrs.container || {};
    const payload = {
      startup: attrs.startup || container.startup_command || "",
      environment: container.environment || {},
      egg: attrs.egg,
      image: dockerImage,
      docker_image: dockerImage,
    };

    try {
      await api.patch(`/servers/${serverId}/startup`, payload);
      return;
    } catch (retryErr) {
      throw retryErr.response ? retryErr : initialErr;
    }
  }
}

module.exports = {
  name: "runtime",
  description: "Change your server Node.js/Python version",
  options: [
    {
      name: "nodejs",
      description: "Set Node.js runtime version",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "server",
          description: "Choose one of your servers",
          type: ApplicationCommandOptionType.String,
          autocomplete: true,
          required: true,
        },
        {
          name: "version",
          description: "Node.js version",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: getVersionChoices("nodejs"),
        },
      ],
    },
    {
      name: "python",
      description: "Set Python runtime version",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "server",
          description: "Choose one of your servers",
          type: ApplicationCommandOptionType.String,
          autocomplete: true,
          required: true,
        },
        {
          name: "version",
          description: "Python version",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: getVersionChoices("python"),
        },
      ],
    },
  ],

  autocomplete: async ({ interaction }) => {
    const focused = interaction.options.getFocused().toLowerCase();
    const subcommand = interaction.options.getSubcommand();
    const focusedOption = interaction.options.getFocused(true);

    if (focusedOption.name !== "server") {
      return interaction.respond([]);
    }

    try {
      const user = await User.findOne({ discordId: interaction.user.id });
      if (!user) return interaction.respond([]);

      const servers = await fetchAllServers();
      const owned = servers.filter((server) => server.attributes.user === user.pteroId);
      const runtime = RUNTIMES[subcommand];
      const filtered = owned.filter((server) => runtime.eggIds.has(Number(server.attributes.egg)));

      const choices = filtered
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
      console.error("Runtime autocomplete error:", err.response?.data || err);
      return interaction.respond([]);
    }
  },

  run: async ({ context }) => {
    const discordId = context.user.id;
    const cooldownRemaining = consumeServerCooldown(discordId);

    if (cooldownRemaining) {
      return context.createMessage(buildServerCooldownCard(cooldownRemaining));
    }

    const runtimeKey = context.options.getSubcommand();
    const runtime = RUNTIMES[runtimeKey];
    const identifier = context.options.getString("server");
    const requestedVersion = context.options.getString("version");
    const normalizedVersion = normalizeVersion(runtimeKey, requestedVersion);
    const dockerImage = runtime.versions[normalizedVersion];

    if (!dockerImage) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Invalid Version",
          description: `Supported ${runtime.label} versions: ${Object.keys(runtime.versions).join(", ")}.`,
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

      if (!runtime.eggIds.has(Number(target.attributes.egg))) {
        return context.createMessage(
          buildServerCard({
            title: "✕ Wrong Server Type",
            description: `That server is not a ${runtime.label} server.`,
          })
        );
      }

      const currentImage = target.attributes.container?.image;
      if (currentImage === dockerImage) {
        return context.createMessage(
          buildServerCard({
            title: "✕ Already Set",
            description: `**${target.attributes.name}** is already using \`${normalizedVersion}\`.`,
          })
        );
      }

      await updateServerRuntimeImage(target.attributes.id, dockerImage);

      return context.createMessage(
        buildServerCard({
          title: "✔ Runtime Updated",
          description: `Updated **${target.attributes.name}** to ${runtime.label} \`${normalizedVersion}\`.`,
          details: [
            `├─ **Server:** ${target.attributes.name}`,
            `├─ **Identifier:** ${identifier}`,
            `├─ **Image:** \`${dockerImage}\``,
            "└─ **Note:** Restart the server for changes to apply.",
          ],
        })
      );
    } catch (err) {
      console.error("Runtime command error:", err.response?.data || err);
      const detail = err.response?.data?.errors?.[0]?.detail;
      return context.createMessage(
        buildServerCard({
          title: "✕ Update Failed",
          description: detail || "Failed to update runtime version. Please try again later.",
        })
      );
    }
  },
};
