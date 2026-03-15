const { ApplicationCommandOptionType, PermissionFlagsBits } = require("discord.js");
const api = require("../../structures/Ptero");
const User = require("../../models/User");
const CustomDomain = require("../../models/CustomDomain");
const { createProxyAdminClient, getProxyAdminConfig } = require("../../structures/ProxyAdmin");
const { buildServerCard } = require("../../structures/serverCommandUi");
const { discord, adminid } = require("../../../settings");

const BOOSTER_ROLE_ID = discord?.boosterRoleId || "1473717031202193408";

const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

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

function hasAdminAccess(actor) {
  return (
    actor.user?.id === adminid ||
    actor.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );
}

function normalizeDomain(input) {
  return String(input || "").trim().toLowerCase();
}

function isValidHostname(input) {
  if (!input) return false;
  if (input.includes("/")) return false;
  if (input.includes("://")) return false;
  if (input.includes("@")) return false;
  return HOSTNAME_RE.test(input);
}

function normalizeName(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const aLen = a.length;
  const bLen = b.length;
  if (!aLen) return bLen;
  if (!bLen) return aLen;

  const row = Array.from({ length: bLen + 1 }, (_, idx) => idx);

  for (let i = 1; i <= aLen; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= bLen; j++) {
      const temp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        prev + cost
      );
      prev = temp;
    }
  }

  return row[bLen];
}

function scoreTarget(nodeName, targetName) {
  const nodeKey = normalizeName(nodeName);
  const targetKey = normalizeName(targetName);
  if (!nodeKey || !targetKey) return 0;
  if (nodeKey === targetKey) return 1;
  if (nodeKey.includes(targetKey) || targetKey.includes(nodeKey)) return 0.92;

  const distance = levenshtein(nodeKey, targetKey);
  const maxLen = Math.max(nodeKey.length, targetKey.length, 1);
  return 1 - distance / maxLen;
}

function pickBestTarget(nodeName, targets = []) {
  if (!targets.length) return null;
  let best = null;
  let bestScore = -1;
  for (const target of targets) {
    const score = scoreTarget(nodeName, target?.name || "");
    if (score > bestScore) {
      best = target;
      bestScore = score;
    }
  }
  return best;
}

function resolveServerSelection(serverPool, rawSelection) {
  const input = String(rawSelection || "").trim();
  if (!input) return null;

  let match = serverPool.find((s) => s.attributes.identifier === input);
  if (match) return match;

  const idMatch = input.match(/\(([^)]+)\)\s*$/);
  if (idMatch?.[1]) {
    match = serverPool.find((s) => s.attributes.identifier === idMatch[1]);
    if (match) return match;
  }

  const lower = input.toLowerCase();
  match = serverPool.find((s) => String(s.attributes.name || "").toLowerCase() === lower);
  if (match) return match;

  return serverPool.find((s) => String(s.attributes.name || "").toLowerCase().includes(lower)) || null;
}

async function getUserAndOwnedServers(discordId) {
  const user = await User.findOne({ discordId });
  if (!user) return { user: null, ownedServers: [] };

  const allServers = await fetchAllServers();
  const ownedServers = allServers.filter((s) => s.attributes.user === user.pteroId);
  return { user, ownedServers };
}

async function fetchServerDetails(serverId) {
  const res = await api.get(`/servers/${serverId}?include=allocations,node`);
  const attrs = res.data?.attributes || {};
  const relationships = attrs.relationships || {};
  const allocationsData = relationships.allocations?.data || [];
  const allocations = allocationsData.map((item) => item?.attributes || item).filter(Boolean);
  const defaultAllocation =
    allocations.find((alloc) => alloc.is_default) || allocations[0] || null;
  const port = defaultAllocation ? Number(defaultAllocation.port) : null;

  const nodeRel = relationships.node?.data || null;
  const nodeAttrs = nodeRel?.attributes || null;
  const nodeId = Number(
    nodeAttrs?.id ??
    nodeRel?.id ??
    attrs.node ??
    defaultAllocation?.node ??
    defaultAllocation?.node_id
  );
  const nodeName = nodeAttrs?.name || null;

  return {
    attrs,
    allocations,
    port: Number.isFinite(port) ? port : null,
    nodeId: Number.isFinite(nodeId) ? nodeId : null,
    nodeName,
  };
}

async function fetchNodeName(nodeId) {
  if (!Number.isFinite(nodeId)) return null;
  const res = await api.get(`/nodes/${nodeId}`);
  return res.data?.attributes?.name || null;
}

async function fetchTargets(proxyAdmin) {
  const res = await proxyAdmin.get("/targets", { validateStatus: () => true });
  if (!res || res.status >= 400) {
    const message = res?.data?.error || res?.data?.message || `HTTP ${res?.status || ""}`;
    const err = new Error(`Failed to fetch proxy targets: ${message}`);
    err.status = res?.status;
    throw err;
  }
  return res.data?.targets || [];
}

async function removeProxyDomain(proxyAdmin, domain) {
  const res = await proxyAdmin.delete("/domains", {
    data: { domain },
    validateStatus: () => true,
  });

  if (res.status === 200 || res.status === 404) return true;

  const message = res?.data?.error || res?.data?.message || `HTTP ${res?.status || ""}`;
  const err = new Error(`Failed to remove domain: ${message}`);
  err.status = res.status;
  throw err;
}

module.exports = {
  name: "customdomain",
  description: "Set a custom domain for one of your servers (boosters only)",
  options: [
    {
      name: "set",
      description: "Point a custom domain to your server",
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
          name: "domain",
          description: "Custom domain (hostname only)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "remove",
      description: "Remove a custom domain from one of your servers",
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
      description: "Show your current custom domains",
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
      console.error("Custom domain autocomplete error:", err.response?.data || err);
      return interaction.respond([]);
    }
  },

  run: async ({ context }) => {
    const discordId = context.user.id;
    const subcommand = context.options.getSubcommand();
    const selection = context.options.getString("server");

    if (!hasAdminAccess(context)) {
      const member = context.member ?? await context.guild?.members.fetch(discordId).catch(() => null);
      if (!hasBoosterRole(member)) {
        return context.createMessage(
          buildServerCard({
            title: "X Boost Required",
            description: "You need the booster role to use custom domains.",
          })
        );
      }
    }

    try {
      if (subcommand === "list") {
        const rows = await CustomDomain.findMany({ discordId }, { orderBy: "updatedAt DESC" });
        if (!rows.length) {
          return context.createMessage(
            buildServerCard({
              title: "No custom domains",
              description: "Use `/customdomain set` to map a domain to your server.",
            })
          );
        }

        const lines = rows.slice(0, 20).map((row) => {
          const port = row.port ? `:${row.port}` : "";
          return `- \\`${row.domain}\\` -> \\`${row.serverIdentifier}\\`${port} (target: ${row.target})`;
        });
        const extra = rows.length > 20 ? `\n...and ${rows.length - 20} more.` : "";
        return context.createMessage(
          buildServerCard({
            title: "Your custom domains",
            description: `${lines.join("\n")}${extra}`,
          })
        );
      }

      const { adminBaseUrl, masterToken } = getProxyAdminConfig();
      if (!adminBaseUrl || !masterToken) {
        return context.createMessage(
          buildServerCard({
            title: "X Not Configured",
            description: "Custom domain admin settings are missing. Ask staff to update config.",
          })
        );
      }

      const proxyAdmin = createProxyAdminClient();
      if (!proxyAdmin) {
        return context.createMessage(
          buildServerCard({
            title: "X Not Configured",
            description: "Custom domain admin settings are missing. Ask staff to update config.",
          })
        );
      }

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

      const owned = resolveServerSelection(serverPool, selection);
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

      const identifier = owned.attributes.identifier;

      if (subcommand === "remove") {
        const existing = await CustomDomain.findOne({ discordId, serverIdentifier: identifier });
        if (!existing) {
          return context.createMessage(
            buildServerCard({
              title: "Nothing to remove",
              description: "No custom domain was set for that server.",
            })
          );
        }

        try {
          await removeProxyDomain(proxyAdmin, existing.domain);
        } catch (err) {
          console.warn("Custom domain removal failed:", err.message);
        }

        await CustomDomain.deleteOne({ id: existing.id });

        return context.createMessage(
          buildServerCard({
            title: "Custom domain removed",
            description: `Removed the custom domain for **${owned.attributes.name}**.`,
          })
        );
      }

      if (subcommand === "set") {
        const rawDomain = context.options.getString("domain");
        const domain = normalizeDomain(rawDomain);
        if (!isValidHostname(domain)) {
          return context.createMessage(
            buildServerCard({
              title: "Invalid domain",
              description: "Please provide a valid hostname (no http:// and no paths).",
            })
          );
        }

        const existingByDomain = await CustomDomain.findOne({ domain });
        if (existingByDomain && existingByDomain.discordId !== discordId) {
          return context.createMessage(
            buildServerCard({
              title: "Domain already in use",
              description: "That domain is already linked to another server.",
            })
          );
        }

        const existing = await CustomDomain.findOne({ discordId, serverIdentifier: identifier });

        const details = await fetchServerDetails(owned.attributes.id);
        let nodeName = details.nodeName;
        if (!nodeName && Number.isFinite(details.nodeId)) {
          nodeName = await fetchNodeName(details.nodeId);
        }

        const port = details.port;
        if (!Number.isFinite(port) || port <= 0) {
          return context.createMessage(
            buildServerCard({
              title: "Port not found",
              description: "Could not resolve the server allocation port.",
            })
          );
        }

        const targets = await fetchTargets(proxyAdmin);
        if (!targets.length) {
          return context.createMessage(
            buildServerCard({
              title: "No proxy targets",
              description: "The proxy admin API did not return any targets.",
            })
          );
        }

        const target = pickBestTarget(nodeName || identifier, targets);
        if (!target?.name) {
          return context.createMessage(
            buildServerCard({
              title: "Target not found",
              description: "Could not match the server node to a proxy target.",
            })
          );
        }

        if (existing && existing.domain !== domain) {
          try {
            await removeProxyDomain(proxyAdmin, existing.domain);
          } catch (err) {
            console.warn("Custom domain swap removal failed:", err.message);
          }
        }

        const res = await proxyAdmin.post(
          "/domains",
          { domain, target: target.name, port },
          { validateStatus: () => true }
        );

        if (!res || res.status >= 400) {
          const message = res?.data?.error || res?.data?.message || `HTTP ${res?.status || ""}`;
          return context.createMessage(
            buildServerCard({
              title: "Failed to set domain",
              description: `Proxy admin rejected the request: ${message}`,
            })
          );
        }

        try {
          await CustomDomain.upsert({
            discordId,
            serverId: owned.attributes.id,
            serverIdentifier: identifier,
            domain,
            target: target.name,
            port,
            nodeId: details.nodeId || null,
            nodeName: nodeName || null,
            createdAt: existing?.createdAt || Date.now(),
            updatedAt: Date.now(),
          });
        } catch (dbErr) {
          if (String(dbErr?.message || "").includes("UNIQUE")) {
            return context.createMessage(
              buildServerCard({
                title: "Domain already in use",
                description: "That domain is already linked to another server.",
              })
            );
          }
          try {
            await removeProxyDomain(proxyAdmin, domain);
          } catch (rollbackErr) {
            console.warn("Custom domain rollback failed:", rollbackErr.message);
          }
          throw dbErr;
        }

        return context.createMessage(
          buildServerCard({
            title: "Custom domain set",
            description: `**${domain}** now routes to **${owned.attributes.name}**.`,
            details: [
              `- **Target:** ${target.name}`,
              `- **Port:** ${port}`,
              `- **Node match:** ${nodeName || "Unknown"}`,
            ],
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
      console.error("Custom domain command error:", err.response?.data || err);
      return context.createMessage(
        buildServerCard({
          title: "Custom domain failed",
          description: "Something went wrong while saving your custom domain.",
        })
      );
    }
  },
};
