const { EmbedBuilder } = require("discord.js");
const User = require("../../models/User");
const api = require("../../structures/Ptero");
const { ptero } = require("../../../settings");
const crypto = require("crypto");

// Generates a secure random password
function generatePassword(length = 12) {
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()";
  let password = "";
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    password += charset[bytes[i] % charset.length];
  }
  return password;
}

// Basic email validation
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

module.exports = {
  name: "register",
  description: "Register a new panel account (one-time only)",
  options: [
    {
      name: "email",
      description: "Your email address",
      type: 3, // String
      required: true,
    },
    {
      name: "first_name",
      description: "Your first name (optional)",
      type: 3,
      required: false,
    },
    {
      name: "last_name",
      description: "Your last name (optional)",
      type: 3,
      required: false,
    },
  ],

  run: async ({ client, context }) => {
    const channel = await client.channels.fetch(context.channelId);
const allowedCategoryId = "1375517232733618227";

// Check if channel is under the correct category
if (!channel || channel.parentId !== allowedCategoryId) {
  return context.createMessage({
    content: "❌ You can only use this command in a ticket channel.",
    ephemeral: true,
  });
}

    const discordId = context.user?.id;
    const email = context.options.getString("email");
    const firstName = context.options.getString("first_name") || context.user.username || "User";
    const lastName = context.options.getString("last_name") || "User";

    if (!discordId) {
      return context.createMessage({
        content: "❌ Internal error: Unable to retrieve your user ID.",
        ephemeral: true,
      });
    }

    if (!isValidEmail(email)) {
      return context.createMessage({
        content: "❌ Please provide a valid email address.",
        ephemeral: true,
      });
    }

    const existing = await User.findOne({ discordId });
    if (existing) {
      return context.createMessage({
        content: "❌ You have already registered an account.",
        ephemeral: true,
      });
    }

    const password = generatePassword();

    try {
      const res = await api.post("/users", {
        username: discordId,
        email,
        first_name: firstName,
        last_name: lastName,
        password,
        language: ptero.defaultLanguage,
      });

      if (!res?.data?.attributes?.id) {
        throw new Error("Invalid API response: missing user ID");
      }

      const pteroId = res.data.attributes.id;

      await new User({ discordId, email, pteroId }).save();

      return context.createMessage({
        embeds: [
          new EmbedBuilder()
            .setColor("#00FF00")
            .setTitle("✅ Account Created")
            .setDescription(
              `📧 **Email:** \`${email}\`\n🧾 **Username:** \`${discordId}\`\n🔑 **Password:** \`${password}\`\n\nLogin at [Panel](${ptero.url}). Please change your password immediately at [Reset Password](${ptero.url}/account).`
            )
            .setFooter({ text: "This message is visible only to you." }),
        ],
        ephemeral: true,
      });

    } catch (err) {
      let errorMessage = "❌ Failed to create panel account. Please try again later.";

      if (err.response?.data?.errors?.some(e => e.code === "Unique" && e.source?.field === "email")) {
        errorMessage = "❌ This email is already in use.";
      }

      console.error("Pterodactyl API error:", err.message, err.response?.data || err);
      return context.createMessage({ content: errorMessage, ephemeral: true });
    }
  },
};
