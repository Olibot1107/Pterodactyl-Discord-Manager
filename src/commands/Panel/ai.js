const {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require("discord.js");
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
const WRITE_PERMISSION_MS = 10 * 60 * 1000;
const pendingWrites = new Map();

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

async function writeServerFile(identifier, filePath, content) {
  const keys = getClientApiKeys();
  let lastError;

  for (const key of keys) {
    try {
      return await axios({
        method: "POST",
        url: `${ptero.url}/api/client/servers/${identifier}/files/write?file=${encodeURIComponent(filePath)}`,
        data: content,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "text/plain",
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

async function callAi(messages) {
  const { provider, apiKey, model, endpoint, maxTokens } = getAiConfig();

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

const TOOL_DEFS = [
  {
    name: "list_files",
    description: "List files in a directory on the selected server.",
    args: { path: "string (directory path, default /)" },
  },
  {
    name: "read_file",
    description: "Read the full contents of a file on the selected server.",
    args: { path: "string (file path)" },
  },
  {
    name: "read_console",
    description: "Read recent console output; optionally run a command first.",
    args: { command: "string (optional)" },
  },
  {
    name: "propose_write",
    description: "Propose writing or creating a file; must be approved by the user.",
    args: { path: "string (file path)", content: "string (full file contents)" },
  },
];

function buildToolPrompt() {
  const lines = TOOL_DEFS.map((tool) => {
    const args = Object.entries(tool.args)
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ");
    return `- ${tool.name}: ${tool.description} (args: ${args})`;
  });

  return [
    "You can request tools by returning JSON only.",
    "If you need a tool, respond with:",
    '{"action":"tool","name":"<tool_name>","args":{...}}',
    "If you are ready to answer, respond with:",
    '{"action":"final","content":"..."}',
    "Paths are server file paths (often under /home/container).",
    "Only use the tools listed below.",
    "Tools:",
    ...lines,
  ].join("\n");
}

function parseAiAction(raw) {
  if (!raw) return { type: "final", content: "" };
  const text = String(raw).trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return { type: "final", content: text };
  }

  const candidate = text.slice(firstBrace, lastBrace + 1);
  try {
    const parsed = JSON.parse(candidate);
    if (parsed?.action === "tool" && parsed?.name) {
      return { type: "tool", name: parsed.name, args: parsed.args || {} };
    }
    if (parsed?.action === "final") {
      return { type: "final", content: parsed.content || "" };
    }
  } catch (err) {
    // Fall through to treat as text.
  }

  return { type: "final", content: text };
}

async function runTool(session, tool) {
  switch (tool.name) {
    case "list_files": {
      const directory = tool.args?.path || "/";
      const files = await listServerFiles(session.identifier, directory);
      return {
        directory,
        files: files.map((item) => {
          const attrs = item.attributes || {};
          return {
            name: attrs.name,
            isFile: Boolean(attrs.is_file),
            size: attrs.size,
          };
        }),
      };
    }
    case "read_file": {
      const filePath = tool.args?.path;
      if (!filePath) throw new Error("read_file requires a path.");
      const content = await readServerFile(session.identifier, filePath);
      return { path: filePath, content };
    }
    case "read_console": {
      const command = tool.args?.command || "";
      const output = await fetchConsoleOutput(session.identifier, command);
      return { command, output };
    }
    case "propose_write": {
      const filePath = tool.args?.path;
      const content = tool.args?.content;
      if (!filePath || typeof content !== "string") {
        throw new Error("propose_write requires path and content.");
      }
      return { path: filePath, content };
    }
    default:
      throw new Error(`Unknown tool: ${tool.name}`);
  }
}

function buildWriteApprovalCard(path, content) {
  const preview = truncateText(content, MAX_TEXT_CHARS);
  return buildServerCard({
    title: "Approve file write?",
    description: `File: \`${path}\``,
    details: [`\`\`\`txt\n${preview.replace(/```/g, "````")}\n\`\`\``],
    buttonDivider: true,
  });
}

async function requestWriteApproval({ client, context, session, path, content }) {
  const requestId = `ai-write-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  pendingWrites.set(requestId, {
    discordId: context.user.id,
    session,
    path,
    content,
    createdAt: Date.now(),
  });

  const approveButton = new ButtonBuilder()
    .setCustomId(`${requestId}:approve`)
    .setStyle(ButtonStyle.Success)
    .setLabel("Approve write");
  const denyButton = new ButtonBuilder()
    .setCustomId(`${requestId}:deny`)
    .setStyle(ButtonStyle.Danger)
    .setLabel("Deny");

  const payload = buildWriteApprovalCard(path, content);
  const container = payload.components?.[0];
  if (container?.addActionRowComponents) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(approveButton, denyButton)
    );
  }
  const message = await context.createMessage(payload);

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: WRITE_PERMISSION_MS,
  });

  collector.on("collect", async (interaction) => {
    const [id, action] = interaction.customId.split(":");
    const pending = pendingWrites.get(id);

    if (!pending) {
      return interaction.reply({
        content: "That request has expired.",
        ephemeral: true,
      });
    }

    if (interaction.user.id !== pending.discordId) {
      return interaction.reply({
        content: "Only the requester can approve this.",
        ephemeral: true,
      });
    }

    if (action === "approve") {
      try {
        await writeServerFile(pending.session.identifier, pending.path, pending.content);
        await interaction.update(
          buildServerCard({
            title: "File written",
            description: `Saved \`${pending.path}\` on **${pending.session.name}**.`,
          })
        );
      } catch (err) {
        await interaction.update(
          buildServerCard({
            title: "Write failed",
            description: err.response?.data?.errors?.[0]?.detail || err.message || "Failed to write file.",
          })
        );
      }
    } else {
      await interaction.update(
        buildServerCard({
          title: "Write cancelled",
          description: "No changes were made.",
        })
      );
    }

    pendingWrites.delete(id);
    collector.stop();
  });

  collector.on("end", () => {
    pendingWrites.delete(requestId);
  });
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

  run: async ({ client, context }) => {
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

      if (subcommand === "ask") {
        const prompt = context.options.getString("prompt");
        const systemContent = [
          "You are a concise technical support assistant for Pterodactyl servers.",
          "Use tools to read files or console output when needed.",
          "If you want to write or create a file, call propose_write and wait for approval.",
          buildToolPrompt(),
        ].join("\n\n");

        const messages = [
          { role: "system", content: systemContent },
          {
            role: "user",
            content: `Server: ${session.name} (${session.identifier})\nQuestion: ${prompt}`,
          },
        ];

        let finalAnswer = "";

        for (let i = 0; i < 4; i += 1) {
          const raw = await callAi(messages);
          const action = parseAiAction(raw);

          if (action.type === "tool") {
            if (action.name === "propose_write") {
              const proposal = await runTool(session, action);
              await requestWriteApproval({
                client,
                context,
                session,
                path: proposal.path,
                content: proposal.content,
              });
              return;
            }

            const result = await runTool(session, action);
            const resultText = truncateText(JSON.stringify(result, null, 2), MAX_PROMPT_CHARS);
            messages.push({ role: "assistant", content: raw });
            messages.push({
              role: "user",
              content: `Tool result (${action.name}):\n${resultText}`,
            });
            continue;
          }

          finalAnswer = action.content || raw || "";
          break;
        }

        const safeResponse = truncateText(finalAnswer || "No response returned.", MAX_TEXT_CHARS);

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
