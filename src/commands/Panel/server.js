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
const ADMIN_SUBCOMMANDS = new Set(["suspend", "unsuspend"]);
const TRANSFER_SUBCOMMAND = "transfer";
const TRANSFER_TIMEOUT_MS = 20 * 60 * 1000;
const TRANSFER_POLL_MS = 5_000;
const FILE_COPY_POLL_MS = 1_000;
const MAX_COPY_FILES = 2_000;
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

async function fetchAllNodes() {
  const allNodes = [];
  for (let page = 1; ; page++) {
    const res = await api.get(`/nodes?page=${page}&per_page=100`);
    const nodes = res.data.data || [];
    allNodes.push(...nodes);
    if (nodes.length < 100) break;
  }
  return allNodes;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForInstallationCompletion(serverId) {
  const deadline = Date.now() + TRANSFER_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const res = await api.get(`/servers/${serverId}`);
    const server = res.data?.attributes;
    if (!server) break;
    if (!server.is_installing) return server;
    await sleep(TRANSFER_POLL_MS);
  }

  return null;
}

function buildPath(directory, name) {
  if (!directory || directory === "/") return `/${name}`;
  return `${directory.replace(/\/$/, "")}/${name}`;
}

function parseStartupVariables(startupResponse) {
  const data = startupResponse?.data || {};
  const vars =
    data?.attributes?.relationships?.variables?.data ||
    data?.meta?.startup_variables ||
    data?.data ||
    [];

  const environment = {};
  for (const row of vars) {
    const attrs = row?.attributes || row || {};
    const key = attrs.env_variable;
    if (!key) continue;
    const value = attrs.server_value ?? attrs.default_value ?? "";
    environment[key] = String(value);
  }

  return environment;
}

async function copyServerFiles(sourceIdentifier, destinationIdentifier) {
  const queue = ["/"];
  const files = [];
  const folders = ["/"];

  while (queue.length) {
    const directory = queue.shift();
    const res = await clientApiRequest(
      "GET",
      `/servers/${sourceIdentifier}/files/list?directory=${encodeURIComponent(directory)}`
    );
    const entries = res.data?.data || [];

    for (const entry of entries) {
      const attrs = entry?.attributes || {};
      const name = attrs.name;
      if (!name) continue;
      if (attrs.is_symlink) continue;

      const fullPath = buildPath(directory, name);
      const isFile = !!attrs.is_file;

      if (isFile) {
        files.push(fullPath);
      } else {
        folders.push(fullPath);
        queue.push(fullPath);
      }
    }
  }

  if (files.length > MAX_COPY_FILES) {
    throw new Error(`Too many files to copy (${files.length}).`);
  }

  for (const folder of folders.slice(1)) {
    const normalized = folder.replace(/^\/+/, "");
    const parts = normalized.split("/");
    const name = parts.pop();
    const root = parts.length ? `/${parts.join("/")}` : "/";

    await clientApiRequest("POST", `/servers/${destinationIdentifier}/files/create-folder`, {
      root,
      name,
    });
  }

  for (const path of files) {
    const encodedPath = encodeURIComponent(path);
    const download = await clientApiRequest(
      "GET",
      `/servers/${sourceIdentifier}/files/download?file=${encodedPath}`
    );
    const url = download.data?.attributes?.url;
    if (!url) throw new Error(`Missing download URL for ${path}`);

    const normalized = path.replace(/^\/+/, "");
    const parts = normalized.split("/");
    const filename = parts.pop();
    const directory = parts.length ? `/${parts.join("/")}` : "/";

    await clientApiRequest("POST", `/servers/${destinationIdentifier}/files/pull`, {
      url,
      directory,
      filename,
      use_header: false,
      foreground: true,
    });

    await sleep(FILE_COPY_POLL_MS);
  }

  return { files: files.length, folders: folders.length - 1 };
}

function hasAdminAccess(actor) {
  return (
    actor.user.id === adminid ||
    actor.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );
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
    name: TRANSFER_SUBCOMMAND,
    description: "Move one of your servers to another node",
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
        name: "node",
        description: "Target node ID",
        type: ApplicationCommandOptionType.Integer,
        required: true,
        autocomplete: true,
      },
    ],
  });

  baseSubcommands.push({
    name: "suspend",
    description: "Suspend any server",
    type: ApplicationCommandOptionType.Subcommand,
    options: [
      {
        name: "server",
        description: "Choose any active server",
        type: ApplicationCommandOptionType.String,
        required: true,
        autocomplete: true,
      },
    ],
  });

  baseSubcommands.push({
    name: "unsuspend",
    description: "Unsuspend any server",
    type: ApplicationCommandOptionType.Subcommand,
    options: [
      {
        name: "server",
        description: "Choose any suspended server",
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
    const focusedOption = interaction.options.getFocused(true);
    const focused = String(focusedOption.value || "").toLowerCase();

    try {
      if (subcommand === TRANSFER_SUBCOMMAND && focusedOption.name === "node") {
        const nodes = await fetchAllNodes();
        const nodeChoices = nodes
          .map((node) => ({
            name: `${node.attributes.name} (#${node.attributes.id})`,
            value: node.attributes.id,
          }))
          .filter((node) => node.name.toLowerCase().includes(focused))
          .slice(0, 25);

        return interaction.respond(nodeChoices);
      }

      let serverPool = [];
      if (ADMIN_SUBCOMMANDS.has(subcommand) || subcommand === TRANSFER_SUBCOMMAND) {
        if (!hasAdminAccess(interaction)) return interaction.respond([]);
        serverPool = await fetchAllServers();
      } else {
        const { user, ownedServers } = await getUserAndOwnedServers(discordId);
        if (!user) return interaction.respond([]);
        serverPool = ownedServers;
      }

      const filteredServers = serverPool.filter((s) => {
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
    const isTransfer = subcommand === TRANSFER_SUBCOMMAND;

    try {
      if (ADMIN_SUBCOMMANDS.has(subcommand)) {
        if (!hasAdminAccess(context)) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Permission Denied",
              description: "Only admins can use `/server suspend` and `/server unsuspend`.",
            })
          );
        }

        const allServers = await fetchAllServers();
        const target = allServers.find((s) => s.attributes.identifier === identifier);
        if (!target) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Server Not Found",
              description: "That server was not found.",
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
              `├─ **Owner ID:** ${target.attributes.user}`,
              `├─ **Server:** ${target.attributes.name}`,
              `├─ **Identifier:** ${identifier}`,
              `└─ **Action By:** ${context.user.username}`,
            ],
          })
        );
      }

      let target;
      if (isTransfer) {
        if (!hasAdminAccess(context)) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Permission Denied",
              description: "Only admins can use `/server transfer`.",
            })
          );
        }

        const allServers = await fetchAllServers();
        target = allServers.find((s) => s.attributes.identifier === identifier);
        if (!target) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Server Not Found",
              description: "That server was not found.",
            })
          );
        }
      } else {
        const { user, ownedServers } = await getUserAndOwnedServers(discordId);
        if (!user) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Not Registered",
              description: "You are not registered. Use `/register` first.",
            })
          );
        }

        target = ownedServers.find((s) => s.attributes.identifier === identifier);
        if (!target) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Server Not Found",
              description: "That server was not found in your account.",
            })
          );
        }
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

      if (subcommand === TRANSFER_SUBCOMMAND) {
        const targetNodeId = context.options.getInteger("node");
        const allNodes = await fetchAllNodes();
        const destinationNode = allNodes.find((n) => n.attributes.id === targetNodeId);

        if (!destinationNode) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Invalid Node",
              description: `Node ID **${targetNodeId}** was not found.`,
            })
          );
        }

        if (Number(target.attributes.node) === Number(targetNodeId)) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Same Node",
              description: `**${target.attributes.name}** is already on node **${targetNodeId}**.`,
            })
          );
        }

        const sourceServerRes = await api.get(`/servers/${target.attributes.id}`);
        const sourceServer = sourceServerRes.data?.attributes;
        if (!sourceServer) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Server Data Missing",
              description: "Could not load full source server data.",
            })
          );
        }

        const startupRes = await api.get(`/servers/${target.attributes.id}/startup`);
        const environment = parseStartupVariables(startupRes);

        const createPayload = {
          name: sourceServer.name,
          user: sourceServer.user,
          egg: sourceServer.egg,
          docker_image: sourceServer.container?.image,
          startup: sourceServer.container?.startup_command || sourceServer.startup,
          environment,
          limits: sourceServer.limits,
          feature_limits: sourceServer.feature_limits,
          deploy: {
            locations: [destinationNode.attributes.location_id],
            dedicated_ip: false,
            port_range: [],
          },
          start_on_completion: false,
        };

        const createRes = await api.post("/servers", createPayload);
        const newServer = createRes.data?.attributes;
        if (!newServer) {
          return context.createMessage(
            buildServerCard({
              title: "✕ Clone Failed",
              description: "New server could not be created on target node.",
            })
          );
        }

        const installedServer = await waitForInstallationCompletion(newServer.id);
        if (!installedServer) {
          return context.createMessage(
            buildServerCard({
              title: "⚠ Install Timed Out",
              description: "New server creation started, but install did not finish in time.",
              details: [
                `├─ **Source:** ${target.attributes.name} (${identifier})`,
                `├─ **New Server:** ${newServer.identifier}`,
                `├─ **Target Node:** ${destinationNode.attributes.name} (#${targetNodeId})`,
                "└─ **Status:** Check the panel in a few minutes.",
              ],
            })
          );
        }

        await clientApiRequest("POST", `/servers/${identifier}/power`, { signal: "stop" });
        await sleep(3_000);

        const copyResult = await copyServerFiles(identifier, installedServer.identifier);

        await api.delete(`/servers/${target.attributes.id}`);

        return context.createMessage(
          buildServerCard({
            title: "✔ Transfer Complete",
            description: `**${target.attributes.name}** was cloned to **${destinationNode.attributes.name}** and old server was removed.`,
            details: [
              `├─ **Old Identifier:** ${identifier}`,
              `├─ **New Identifier:** ${installedServer.identifier}`,
              `├─ **From Node:** ${target.attributes.node}`,
              `├─ **To Node:** ${targetNodeId}`,
              `└─ **Files Copied:** ${copyResult.files} files in ${copyResult.folders} folders.`,
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
