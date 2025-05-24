const { EmbedBuilder, ApplicationCommandOptionType } = require("discord.js");
const api = require("../../structures/Ptero");

const eggs = {
  nodejs: {
    id: 16,
    name: "Node.js",
    docker_image: "ghcr.io/parkervcp/yolks:nodejs_18",
    startup: "npm start",
    environment: {
      USER_UPLOAD: "0",
      MAIN_FILE: "index.js",
      AUTO_UPDATE: "1",
      STARTUP_CMD: "npm start",
    },
  },
  python: {
    id: 27,
    name: "Python",
    docker_image: "ghcr.io/parkervcp/yolks:python_3.10",
    startup: "python3 main.py",
    environment: {
      USER_UPLOAD: "0",
      PY_FILE: "main.py",         // required: app py file
      REQUIREMENTS_FILE: "requirements.txt", // required: requirements file
      AUTO_UPDATE: "1",
      STARTUP_CMD: "python3 main.py",
    },
  },
  java: {
    id: 28,
    name: "Java",
    docker_image: "ghcr.io/parkervcp/yolks:java_17",
    startup: "java -jar server.jar",
    environment: {
      USER_UPLOAD: "0",
      JARFILE: "server.jar",         // required: jar file
      AUTO_UPDATE: "1",
      STARTUP_CMD: "java -jar server.jar",
    },
  },
};

const freePlanLimits = {
  cpu: 150,      // 1.5 vCore
  memory: 4096,  // 4 GB RAM
  disk: 5000,    // 5 GB Disk
};

async function getUserByDiscordId(discordId) {
  // Fetch users page by page to find the user with username = discordId
  let page = 1;
  while (true) {
    const res = await api.get(`/users?page=${page}&per_page=100`);
    const users = res.data.data || [];
    if (!users.length) break;
    const foundUser = users.find(u => u.attributes.username === discordId);
    if (foundUser) return foundUser;
    page++;
  }
  return null;
}

async function getUserServers(userId) {
  let page = 1;
  const servers = [];
  while (true) {
    const res = await api.get(`/servers?page=${page}&per_page=100`);
    const data = res.data.data || [];
    if (data.length === 0) break;

    // Compare against attributes.user (more reliable than relationships)
    const filtered = data.filter(srv => srv.attributes.user === userId);
    servers.push(...filtered);
    page++;
  }
  return servers;
}



module.exports = {
  name: "create",
  description: "Create a free server (1.5 vCore, 4GB RAM, 5GB Disk)",
  options: [
    {
      name: "egg",
      description: "Choose server type (Node.js, Python, Java)",
      type: ApplicationCommandOptionType.String,
      required: true,
      choices: [
        { name: "Node.js", value: "nodejs" },
        { name: "Python", value: "python" },
        { name: "Java", value: "java" },
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
    const selectedEggKey = context.options.getString("egg");
    const serverName = context.options.getString("servername");

    const egg = eggs[selectedEggKey];
    if (!egg) {
      return await context.createMessage({
        content: "❌ Invalid egg selection.",
        ephemeral: true,
      });
    }

    try {
      // Find the Pterodactyl user by Discord ID stored in username field
      const pteroUser = await getUserByDiscordId(discordId);
      if (!pteroUser) {
        return await context.createMessage({
          content:
            "❌ No Pterodactyl user found linked to your Discord account. Please register first.",
          ephemeral: true,
        });
      }

      // Get servers owned by this user
      const userServers = await getUserServers(pteroUser.attributes.id);
      if (userServers.length > 0) {
        return await context.createMessage({
          content:
            "❌ You already have a free server. Only one free server allowed per user.",
          ephemeral: true,
        });
      }

      // Create server payload
      const res = await api.post("/servers", {
        name: serverName,
        user: pteroUser.attributes.id, // Pterodactyl user ID
        egg: egg.id,
        docker_image: egg.docker_image,
        startup: egg.startup,
        environment: egg.environment,
        limits: {
          memory: freePlanLimits.memory,
          swap: 0,
          disk: freePlanLimits.disk,
          io: 500,
          cpu: freePlanLimits.cpu,
          oom_killer: true,
        },
        feature_limits: {
          databases: 0,
          backups: 1,
          allocations: 1,
        },
        deploy: {
          locations: [1], // Change to your location ID
          dedicated_ip: false,
          port_range: [],
        },
        start_on_completion: true,
      });

      return await context.createMessage({
        embeds: [
          new EmbedBuilder()
            .setColor("Green")
            .setTitle("✅ Server Created")
            .setDescription(
              `🖥️ **Name:** \`${serverName}\`\n🍳 **Type:** \`${egg.name}\`\n🔗 [View on Panel](https://panel.leonodes.xyz/server/${res.data.attributes.identifier})`
            ),
        ],
        ephemeral: true,
      });
    } catch (err) {
      console.error("Pterodactyl Error:", err.response?.data || err.message);
      return await context.createMessage({
        content: "❌ Failed to create server. Please try again later.",
        ephemeral: true,
      });
    }
  },
};
