const { ApplicationCommandOptionType } = require("discord.js");
const axios = require("axios");
const api = require("../../structures/Ptero");
const User = require("../../models/User");
const { buildServerCard } = require("../../structures/serverCommandUi");
const { ptero, ai: aiSettings } = require("../../../settings");

const aiSessions = new Map();
const MAX_LIST_ITEMS = 25;
const MAX_TEXT_CHARS = 1800;
const MAX_PROMPT_CHARS = 4000;
const CONSOLE_CAPTURE_MS = 1500;

function truncateText(value, max = MAX_TEXT_CHARS) {
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...(truncated)`;
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

function getSelectedServer(discordId) {
  return aiSessions.get(discordId) || null;
}

function formatFileSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)}KB`;
  return `${Math.round(value / (1024 * 1024))}MB`;
}

async function readServerFile(identifier, filePath) {
  const path = `/servers/${identifier}/files/contents?file=${encodeURIComponent(filePath)}`;
  const res = await clientApiRequest("GET", path);
  return typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2);
}

async function listServerFiles(identifier, directory) {
  const dir = directory || "/";
  const path = `/servers/${identifier}/files/list?directory=${encodeURIComponent(dir)}`;
  const res = await clientApiRequest("GET", path);
  return res.data?.data || [];
}

function getWebSocketImpl() {
  if (typeof WebSocket !== "undefined") return WebSocket;
  try {
    // eslint-disable-next-line global-require
    return require("ws");
  } catch (err) {
    return null;
  }
}

async function fetchConsoleOutput(identifier, command) {
  const wsImpl = getWebSocketImpl();
  if (!wsImpl) {
    throw new Error("WebSocket support is not available. Install the 'ws' package.");
  }

  const wsRes = await clientApiRequest("GET", `/servers/${identifier}/websocket`);
  const socket = wsRes.data?.data?.socket;
  const token = wsRes.data?.data?.token;

  if (!socket || !token) {
    throw new Error("Failed to create a console session.");
  }

  return new Promise((resolve, reject) => {
    const output = [];
    const ws = new wsImpl(socket);
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch (err) {
        // ignore close errors
      }
      resolve(output.join(""));
    }, CONSOLE_CAPTURE_MS);

    ws.onopen = () => {
      ws.send(JSON.stringify({ event: "auth", args: [token] }));
      if (command) {
        ws.send(JSON.stringify({ event: "send command", args: [command] }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload?.event === "console output" && Array.isArray(payload.args)) {
          output.push(payload.args.join(""));
        }
      } catch (err) {
        // ignore malformed payloads
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      resolve(output.join(""));
    };
  });
}

function buildNeedsServerCard() {
  return buildServerCard({
    title: "AI session not set",
    description: "Run `/ai server` first to choose a server.",
  });
}

function getAiConfig() {
  const provider = (process.env.AI_PROVIDER || aiSettings?.provider || "llama").toLowerCase();
  const apiKey = process.env.OPENAI_API_KEY || aiSettings?.apiKey;
  const model = process.env.AI_MODEL || aiSettings?.model || "Llama-4-Maverick-17B-128E-Instruct-FP8";
  const endpoint =
    aiSettings?.endpoint ||
    (provider === "ollama"
      ? "http://127.0.0.1:11434/api/chat"
      : "https://api.llama.com/v1/chat/completions");
  const maxTokens = Number(aiSettings?.maxOutputTokens) || 500;
  return { provider, apiKey, model, endpoint, maxTokens };
}

async function callAi(prompt) {
  const { provider, apiKey, model, endpoint, maxTokens } = getAiConfig();

  const messages = [
    {
      role: "system",
      content: "You are a concise technical support assistant for Pterodactyl servers. Provide troubleshooting steps and propose minimal code edits when needed.",
    },
    {
      role: "user",
      content: prompt,
    },
  ];

  let res;
  if (provider === "ollama") {
    res = await axios.post(
      endpoint,
      {
        model,
        messages,
        stream: false,
        options: {
          temperature: 0.2,
          num_predict: maxTokens,
        },
      },
      { headers: { "Content-Type": "application/json" } }
    );
  } else {
    if (!apiKey) {
      throw new Error("AI API key is not configured.");
    }
    res = await axios.post(
      endpoint,
      {
        model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.2,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );
  }

  const content = extractAiContent(res.data);

  if (!content) {
    throw new Error("AI returned an empty response.");
  }

  return content;
}

function extractAiContent(payload) {
  if (!payload) return "";

  const choice = payload?.choices?.[0];
  if (choice?.message?.content !== undefined) {
    const content = choice.message.content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (!part) return "";
          if (typeof part === "string") return part;
          return part.text || part.content || "";
        })
        .filter(Boolean)
        .join("");
    }
    if (typeof content === "string") return content;
  }

  if (typeof choice?.text === "string") return choice.text;
  if (typeof payload?.message?.content === "string") return payload.message.content;
  if (Array.isArray(payload?.message?.content)) {
    return payload.message.content
      .map((part) => (typeof part === "string" ? part : part?.text || part?.content || ""))
      .filter(Boolean)
      .join("");
  }
  if (typeof payload?.completion_message?.content?.text === "string") {
    return payload.completion_message.content.text;
  }
  if (typeof payload?.completion_message?.content === "string") {
    return payload.completion_message.content;
  }
  if (typeof payload?.content === "string") return payload.content;
  if (typeof payload?.completion === "string") return payload.completion;
  if (typeof payload?.generated_text === "string") return payload.generated_text;
  if (typeof payload?.output_text === "string") return payload.output_text;
  if (typeof payload?.response?.output_text === "string") return payload.response.output_text;

  return "";
}

module.exports = {
  name: "ai",
  description: "AI assistant for server troubleshooting",
  dmPermission: true,
  options: [
    {
      name: "server",
      description: "Choose the server for your AI session",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "server",
          description: "Pick one of your servers",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "files",
      description: "List files in a directory",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "path",
          description: "Directory path (defaults to /)",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
      ],
    },
    {
      name: "file",
      description: "Read a file",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "path",
          description: "File path",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "console",
      description: "Capture console output (optionally run a command)",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "command",
          description: "Command to send before capturing output",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
      ],
    },
    {
      name: "ask",
      description: "Ask the AI for help",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "prompt",
          description: "What do you need help with?",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: "file",
          description: "Optional file to include",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "console",
          description: "Include recent console output",
          type: ApplicationCommandOptionType.Boolean,
          required: false,
        },
      ],
    },
  ],

  autocomplete: async ({ interaction }) => {
    const focusedOption = interaction.options.getFocused(true);
    if (focusedOption.name !== "server") return interaction.respond([]);

    const discordId = interaction.user.id;
    const focused = String(focusedOption.value || "").toLowerCase();

    try {
      const { user, ownedServers } = await getUserAndOwnedServers(discordId);
      if (!user) return interaction.respond([]);

      const choices = ownedServers
        .map((s) => ({
          name: `${s.attributes.name} (${s.attributes.identifier})`,
          value: s.attributes.identifier,
        }))
        .filter((c) => c.name.toLowerCase().includes(focused) || c.value.toLowerCase().includes(focused))
        .slice(0, MAX_LIST_ITEMS);

      return interaction.respond(choices);
    } catch (err) {
      console.error("AI server autocomplete error:", err.response?.data || err);
      return interaction.respond([]);
    }
  },

  run: async ({ context }) => {
    const discordId = context.user.id;
    const subcommand = context.options.getSubcommand();

    try {
      if (subcommand === "server") {
        const identifier = context.options.getString("server");
        const { user, ownedServers } = await getUserAndOwnedServers(discordId);
        if (!user) {
          return context.createMessage(
            buildServerCard({
              title: "Account missing",
              description: "You need to register first with `/register`.",
            })
          );
        }

        const target = ownedServers.find((srv) => srv.attributes.identifier === identifier);
        if (!target) {
          return context.createMessage(
            buildServerCard({
              title: "Server not found",
              description: "Choose a server you own.",
            })
          );
        }

        aiSessions.set(discordId, {
          identifier,
          name: target.attributes.name,
          id: target.attributes.id,
        });

        return context.createMessage(
          buildServerCard({
            title: "AI session set",
            description: `Server selected: **${target.attributes.name}** (${identifier}).`,
          })
        );
      }

      const session = getSelectedServer(discordId);
      if (!session) {
        return context.createMessage(buildNeedsServerCard());
      }

      if (subcommand === "files") {
        const directory = context.options.getString("path") || "/";
        const files = await listServerFiles(session.identifier, directory);

        if (!files.length) {
          return context.createMessage(
            buildServerCard({
              title: "No files",
              description: `No files found in \`${directory}\`.`,
            })
          );
        }

        const lines = files.slice(0, MAX_LIST_ITEMS).map((item) => {
          const attrs = item.attributes || {};
          const label = attrs.is_file ? "FILE" : "DIR";
          const suffix = attrs.is_file ? ` (${formatFileSize(attrs.size)})` : "";
          return `${label} ${attrs.name}${suffix}`;
        });

        if (files.length > MAX_LIST_ITEMS) {
          lines.push(`...and ${files.length - MAX_LIST_ITEMS} more`);
        }

        return context.createMessage(
          buildServerCard({
            title: "File list",
            description: `Directory: \`${directory}\``,
            details: lines,
          })
        );
      }

      if (subcommand === "file") {
        const filePath = context.options.getString("path");
        const content = await readServerFile(session.identifier, filePath);
        const safeContent = truncateText(content);
        const wrapped = `\`\`\`txt\n${safeContent.replace(/```/g, "````")}\n\`\`\``;

        return context.createMessage(
          buildServerCard({
            title: "File contents",
            description: `File: \`${filePath}\``,
            details: [wrapped],
          })
        );
      }

      if (subcommand === "console") {
        const command = context.options.getString("command") || "";
        const output = await fetchConsoleOutput(session.identifier, command);
        const safeOutput = truncateText(output || "(no output captured)");
        const wrapped = `\`\`\`txt\n${safeOutput.replace(/```/g, "````")}\n\`\`\``;

        return context.createMessage(
          buildServerCard({
            title: "Console output",
            description: command ? `Command: \`${command}\`` : "Recent output",
            details: [wrapped],
          })
        );
      }

      if (subcommand === "ask") {
        const prompt = context.options.getString("prompt");
        const filePath = context.options.getString("file");
        const includeConsole = context.options.getBoolean("console") || false;

        let fileSnippet = "";
        if (filePath) {
          const fileContent = await readServerFile(session.identifier, filePath);
          fileSnippet = truncateText(fileContent, MAX_PROMPT_CHARS);
        }

        let consoleSnippet = "";
        if (includeConsole) {
          const output = await fetchConsoleOutput(session.identifier, "");
          consoleSnippet = truncateText(output || "(no output captured)", MAX_PROMPT_CHARS);
        }

        const parts = [
          `Server: ${session.name} (${session.identifier})`,
          "",
          `Question: ${prompt}`,
        ];

        if (filePath) {
          parts.push("", `File: ${filePath}`, fileSnippet || "(empty)");
        }

        if (includeConsole) {
          parts.push("", "Console output:", consoleSnippet || "(empty)");
        }

        const aiResponse = await callAi(parts.join("\n"));
        const safeResponse = truncateText(aiResponse, MAX_TEXT_CHARS);

        return context.createMessage(
          buildServerCard({
            title: "AI suggestions",
            description: "Here is what I found:",
            details: [safeResponse],
          })
        );
      }

      return context.createMessage(
        buildServerCard({
          title: "Unknown action",
          description: "That AI action is not supported yet.",
        })
      );
    } catch (err) {
      const detail = err.response?.data?.errors?.[0]?.detail;
      console.error("AI command failed:", err.response?.data || err);
      return context.createMessage(
        buildServerCard({
          title: "AI command failed",
          description: detail || err.message || "Something went wrong. Please try again.",
        })
      );
    }
  },
};
