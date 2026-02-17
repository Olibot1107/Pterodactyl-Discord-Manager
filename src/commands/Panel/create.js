const { EmbedBuilder, ApplicationCommandOptionType } = require("discord.js");
const api = require("../../structures/Ptero");

const bannedUsers = []; // Discord IDs of banned users, e.g., ["123456789"]
const whitelistedServers = []; // UUIDs of whitelisted servers

// --- Role-based server limits ---
// Roles are checked top-to-bottom; the FIRST match wins.
// Add your Discord role IDs and how many servers that role allows.
const roleLimits = [
  { roleId: "ROLE_ID_HERE", max: 3, label: "VIP" },
  { roleId: "ROLE_ID_HERE", max: 2, label: "Supporter" },
  // Users with no matching role fall back to defaultMax below
];
const defaultMax = 1; // Default for users with no special role

const eggs = {
  nodejs: {
    id: 15,
    name: "Node.js",
    docker_image: "ghcr.io/parkervcp/yolks:nodejs_21",
    startup: `if [[ -d .git ]] && [[ "$AUTO_UPDATE" == "1" ]]; then git pull; fi; if [[ ! -z "$NODE_PACKAGES" ]]; then /usr/local/bin/npm install $NODE_PACKAGES; fi; if [[ ! -z "$UNNODE_PACKAGES" ]]; then /usr/local/bin/npm uninstall $UNNODE_PACKAGES; fi; if [ -f /home/container/package.json ]; then /usr/local/bin/npm install; fi; if [[ "$MAIN_FILE" == "*.js" ]]; then /usr/local/bin/node "/home/container/$MAIN_FILE" $NODE_ARGS; else /usr/local/bin/ts-node --esm "/home/container/$MAIN_FILE" $NODE_ARGS; fi`,
    environment: {
      USER_UPLOAD: "0",
      MAIN_FILE: "index.js",
      AUTO_UPDATE: "1",
      STARTUP_CMD: "npm start",
    },
  },
  python: {
    id: 17,
    name: "Python",
    docker_image: "ghcr.io/parkervcp/yolks:python_3.10",
    startup: `if [[ -d .git ]] && [[ "$AUTO_UPDATE" == "1" ]]; then git pull; fi; if [[ ! -z "$PY_PACKAGES" ]]; then pip install -U --prefix .local $PY_PACKAGES; fi; if [[ -f /home/container/$REQUIREMENTS_FILE ]]; then pip install -U --prefix .local -r $REQUIREMENTS_FILE; fi; /usr/local/bin/python /home/container/$PY_FILE`,
    environment: {
      USER_UPLOAD: "0",
      PY_FILE: "main.py",
      REQUIREMENTS_FILE: "requirements.txt",
      AUTO_UPDATE: "1",
      STARTUP_CMD: "python3 main.py",
    },
  },
};

// Returns the max servers allowed for a given Discord guild member
function getMaxServersForMember(member) {
  for (const role of roleLimits) {
    if (member.roles.cache.has(role.roleId)) {
      return { max: role.max, label: role.label };
    }
  }
  return { max: defaultMax, label: "Default" };
}

async function getUserByDiscordId(discordId) {
  let page = 1;
  while (true) {
    const res = await api.get(`/users?page=${page}&per_page=100`);
    const users = res.data.data || [];
    if (users.length === 0) break;

    const foundUser = users.find(u => u.attributes.username === discordId);
    if (foundUser) return foundUser;
    page++;
  }
  return null;
}

// Returns how many non-whitelisted servers a Pterodactyl user owns
async function getUserServerCount(pteroUserId) {
  let count = 0;
  let page = 1;

  while (true) {
    const res = await api.get(`/servers?page=${page}&per_page=100`);
    const servers = res.data.data || [];
    if (servers.length === 0) break;

    for (const server of servers) {
      if (
        server.attributes.user === pteroUserId &&
        !whitelistedServers.includes(server.attributes.uuid)
      ) {
        count++;
      }
    }

    page++;
  }

  return count;
}

const serverLimits = {
  memory: 514,
  swap: 0,
  disk: 4096,
  io: 500,
  cpu: 50,
  oom_disabled: false,
};

module.exports = {
  name: "create",
  description: "Create a server from available free slots",
  options: [
    {
      name: "egg",
      description: "Choose server type (Node.js, Python)",
      type: ApplicationCommandOptionType.String,
      required: true,
      choices: [
        { name: "Node.js", value: "nodejs" },
        { name: "Python", value: "python" },
      ],
    },
    {
      name: "servername",
      description: "Name your server",
      type: ApplicationCommandOptionType.String,
      required: true,
    },
  ],

  run: async ({ client, context }) => {
    const discordId = context.user.id;

    if (bannedUsers.includes(discordId)) {
      return context.createMessage({ content: "🚫 You are banned from creating new servers." });
    }

    const eggKey = context.options.getString("egg");
    const serverName = context.options.getString("servername");
    const egg = eggs[eggKey];
    if (!egg) return context.createMessage({ content: "❌ Invalid egg selection." });

    // Fetch the guild member so we can check their roles
    const member = context.member ?? await context.guild?.members.fetch(discordId).catch(() => null);
    if (!member) {
      return context.createMessage({ content: "❌ Could not resolve your guild membership." });
    }

    const { max: serverMax, label: tierLabel } = getMaxServersForMember(member);

    const pteroUser = await getUserByDiscordId(discordId);
    if (!pteroUser) {
      return context.createMessage({ content: "❌ No Pterodactyl user linked. Please register first." });
    }

    const currentCount = await getUserServerCount(pteroUser.attributes.id);
    if (currentCount >= serverMax) {
      return context.createMessage({
        content:
          serverMax === 1
            ? `⚠️ You already own a server. Your plan only allows **1** server per account.`
            : `⚠️ You have reached your server limit (**${currentCount}/${serverMax}**). Upgrade your role to create more.`,
      });
    }

    try {
      const res = await api.post("/servers", {
        name: serverName,
        user: pteroUser.attributes.id,
        egg: egg.id,
        docker_image: egg.docker_image,
        startup: egg.startup,
        environment: egg.environment,
        limits: serverLimits,
        feature_limits: {
          databases: 0,
          backups: 1,
          allocations: 1,
        },
        deploy: {
          locations: [1],
          dedicated_ip: false,
          port_range: [],
        },
        start_on_completion: true,
      });

      return context.createMessage({
        embeds: [
          new EmbedBuilder()
            .setColor("Green")
            .setTitle("✅ Server Created")
            .setDescription(
              `🖥️ **Name:** \`${serverName}\`\n` +
              `🍳 **Type:** \`${egg.name}\`\n` +
              `📊 **Servers:** \`${currentCount + 1}/${serverMax}\`\n` +
              `🎖️ **Tier:** \`${tierLabel}\`\n` +
              `🔗 [View on Panel](https://voidium.uk/server/${res.data.attributes.identifier})`
            ),
        ],
      });
    } catch (err) {
      console.error("Error creating server:", err.response?.data || err.message || err);
      return context.createMessage({ content: "❌ Failed to create server. Please try again later." });
    }
  },
};