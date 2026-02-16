const { EmbedBuilder, MessageFlags, ButtonBuilder, ButtonStyle, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
const User = require("../../models/User");
const PendingUser = require("../../models/PendingUser");
const api = require("../../structures/Ptero");
const { ptero } = require("../../../settings");
const crypto = require("crypto");
const sendEmail = require("../../structures/sendVerificationEmail");

// Cooldown tracking
const cooldowns = new Map();
const COOLDOWN_TIME = 5 * 60 * 1000; // 5 minutes
const CODE_EXPIRY = 5 * 60 * 1000; // 5 minutes
const BANNED_MEMBERS = ["1332006483600347157"];
const ALLOWED_CATEGORY_ID = "1375517232733618227";

/**
 * Generates a cryptographically secure random password
 */
function generatePassword(length = 16) {
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=";
  const bytes = crypto.randomBytes(length);
  let password = "";
  
  for (let i = 0; i < length; i++) {
    password += charset[bytes[i] % charset.length];
  }
  
  return password;
}

/**
 * Validates email format
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Checks and enforces cooldown
 */
function checkCooldown(discordId) {
  if (!cooldowns.has(discordId)) return null;
  
  const lastUsed = cooldowns.get(discordId);
  const timeElapsed = Date.now() - lastUsed;
  
  if (timeElapsed < COOLDOWN_TIME) {
    const remaining = Math.ceil((COOLDOWN_TIME - timeElapsed) / 1000 / 60);
    return remaining;
  }
  
  return null;
}

/**
 * Sets cooldown for a user
 */
function setCooldown(discordId) {
  cooldowns.set(discordId, Date.now());
  setTimeout(() => cooldowns.delete(discordId), COOLDOWN_TIME);
}

/**
 * Cleans up existing user if panel account doesn't exist
 */
async function cleanupStaleUser(discordId, pteroId) {
  try {
    const panelUser = await api.get(`/users/${pteroId}`);
    
    if (panelUser?.data?.object === "user") {
      return true; // User exists on panel
    }
    
    await User.deleteOne({ discordId });
    return false;
  } catch (err) {
    if (err.response?.status === 404) {
      await User.deleteOne({ discordId });
      return false;
    }
    throw err;
  }
}

/**
 * Checks if email is already registered on the panel
 */
async function isEmailRegistered(email) {
  const emailCheck = await api.get("/users", {
    searchParams: { filter: email },
  });
  
  return emailCheck.data?.data?.some(
    (u) => u.attributes.email.toLowerCase() === email.toLowerCase()
  );
}

module.exports = {
  name: "register",
  description: "Register a new panel account (one-time only)",
  options: [
    {
      name: "email",
      description: "Your email address",
      type: 3,
      required: true,
    },
  ],

  run: async ({ client, context }) => {
    // Check if context has already replied or deferred
    const replyMethod = context.deferred || context.replied ? 'editReply' : 'reply';
    
    const discordId = context.user.id;
    const email = context.options.getString("email").trim();

    // Check cooldown
    const cooldownRemaining = checkCooldown(discordId);
    if (cooldownRemaining) {
      return context[replyMethod]({
        embeds: [
          new EmbedBuilder()
            .setColor("#ED4245")
            .setTitle("Cooldown Active")
            .setDescription(`Please wait ${cooldownRemaining} minute(s) before using this command again.`),
        ],
        ephemeral: true,
      });
    }

    // Check if user is banned
    if (BANNED_MEMBERS.includes(discordId)) {
      return context[replyMethod]({
        embeds: [
          new EmbedBuilder()
            .setColor("#ED4245")
            .setTitle("Access Denied")
            .setDescription("You are banned from creating an account."),
        ],
        ephemeral: true,
      });
    }

    // Validate email
    if (!isValidEmail(email)) {
      return context[replyMethod]({
        embeds: [
          new EmbedBuilder()
            .setColor("#ED4245")
            .setTitle("Invalid Email")
            .setDescription("Please provide a valid email address."),
        ],
        ephemeral: true,
      });
    }

    // Check if user already exists
    try {
      const existing = await User.findOne({ discordId });
      
      if (existing) {
        const userExists = await cleanupStaleUser(discordId, existing.pteroId);
        
        if (userExists) {
          return context[replyMethod]({
            embeds: [
              new EmbedBuilder()
                .setColor("#ED4245")
                .setTitle("Account Already Exists")
                .setDescription("You have already registered an account. If you've forgotten your credentials, please contact support."),
            ],
            ephemeral: true,
          });
        }
      }
    } catch (err) {
      console.error("Error checking existing user:", err);
      return context[replyMethod]({
        embeds: [
          new EmbedBuilder()
            .setColor("#FEE75C")
            .setTitle("Verification Error")
            .setDescription("Internal error while verifying your account. Please try again later."),
        ],
        ephemeral: true,
      });
    }

    // Check if email is already registered
    try {
      if (await isEmailRegistered(email)) {
        return context[replyMethod]({
          embeds: [
            new EmbedBuilder()
              .setColor("#ED4245")
              .setTitle("Email Already Registered")
              .setDescription("This email is already registered. Please use a different email address."),
          ],
          ephemeral: true,
        });
      }
    } catch (err) {
      console.error("Error checking email:", err);
      return context[replyMethod]({
        embeds: [
          new EmbedBuilder()
            .setColor("#FEE75C")
            .setTitle("Email Verification Failed")
            .setDescription("Unable to verify email. Please try again later."),
        ],
        ephemeral: true,
      });
    }

    // Generate and save verification code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + CODE_EXPIRY;

    try {
      await PendingUser.deleteMany({ discordId });
      await new PendingUser({ discordId, email, code, expiresAt }).save();
    } catch (err) {
      console.error("Error saving pending user:", err);
      return context[replyMethod]({
        embeds: [
          new EmbedBuilder()
            .setColor("#FEE75C")
            .setTitle("Database Error")
            .setDescription("Database error. Please try again later."),
        ],
        ephemeral: true,
      });
    }

    // Send verification email
    try {
      await sendEmail(email, code);
    } catch (err) {
      console.error("Email send error:", err);
      await PendingUser.deleteOne({ discordId });
      return context[replyMethod]({
        embeds: [
          new EmbedBuilder()
            .setColor("#ED4245")
            .setTitle("Email Send Failed")
            .setDescription("Failed to send verification email. Please check your email address and try again."),
        ],
        ephemeral: true,
      });
    }

    // Set cooldown only after successful email send
    setCooldown(discordId);

    // Create button for code submission
    const verifyButton = new ButtonBuilder()
      .setCustomId(`verify_code_${discordId}`)
      .setLabel("Enter Verification Code")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("🔐");

    const row = new ActionRowBuilder().addComponents(verifyButton);

    // Send ephemeral verification prompt with button
    await context[replyMethod]({
      embeds: [
        new EmbedBuilder()
          .setColor("#5865F2")
          .setTitle("Verification Email Sent")
          .setDescription(
            `A 6-digit verification code has been sent to **${email}**.\n\n` +
            `**Next Steps:**\n` +
            `• Check your email inbox (and spam folder)\n` +
            `• Click the button below to submit your code\n` +
            `• You have **5 minutes** to verify\n\n` +
            `The code will expire if not entered in time.`
          )
          .setFooter({ text: `Verification for ${context.user.tag}` })
          .setTimestamp(),
      ],
      components: [row],
      ephemeral: true,
    });

    // Set up button interaction handler
    const filter = (i) => i.customId === `verify_code_${discordId}` && i.user.id === discordId;
    const collector = context.channel.createMessageComponentCollector({
      filter,
      time: CODE_EXPIRY,
      max: 1,
    });

    collector.on("collect", async (interaction) => {
      // Create modal for code input
      const modal = new ModalBuilder()
        .setCustomId(`verify_modal_${discordId}`)
        .setTitle("Email Verification");

      const codeInput = new TextInputBuilder()
        .setCustomId("verification_code")
        .setLabel("6-Digit Verification Code")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("Enter the 6-digit code from your email")
        .setRequired(true)
        .setMinLength(6)
        .setMaxLength(6);

      const actionRow = new ActionRowBuilder().addComponents(codeInput);
      modal.addComponents(actionRow);

      await interaction.showModal(modal);

      // Wait for modal submission
      try {
        const modalSubmit = await interaction.awaitModalSubmit({
          filter: (i) => i.customId === `verify_modal_${discordId}` && i.user.id === discordId,
          time: CODE_EXPIRY,
        });

        const submittedCode = modalSubmit.fields.getTextInputValue("verification_code").trim();

        // Verify code
        const pending = await PendingUser.findOne({ discordId });

        if (!pending || Date.now() > pending.expiresAt) {
          await modalSubmit.reply({
            embeds: [
              new EmbedBuilder()
                .setColor("#ED4245")
                .setTitle("Code Expired")
                .setDescription("Your verification code has expired. Please run `/register` again to get a new code."),
            ],
            flags: MessageFlags.Ephemeral,
          });
          await PendingUser.deleteOne({ discordId });
          return;
        }

        if (pending.code !== submittedCode) {
          await modalSubmit.reply({
            embeds: [
              new EmbedBuilder()
                .setColor("#ED4245")
                .setTitle("Incorrect Code")
                .setDescription("The code you entered is incorrect. Registration canceled.\n\nPlease run `/register` again if you'd like to try again."),
            ],
            flags: MessageFlags.Ephemeral,
          });
          await PendingUser.deleteOne({ discordId });
          return;
        }

        // Create panel account
        const password = generatePassword();
        const firstName = context.user.username;
        const lastName = "User";

        let res;
        try {
          res = await api.post("/users", {
            username: discordId,
            email,
            first_name: firstName,
            last_name: lastName,
            password,
            language: ptero.defaultLanguage || "en",
          });
        } catch (err) {
          console.error("Panel account creation error:", err.response?.data || err);
          await modalSubmit.reply({
            embeds: [
              new EmbedBuilder()
                .setColor("#ED4245")
                .setTitle("Account Creation Failed")
                .setDescription("Failed to create your panel account. Please contact support."),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (!res?.data?.attributes?.id) {
          console.error("Invalid API response - missing user ID:", res?.data);
          await modalSubmit.reply({
            embeds: [
              new EmbedBuilder()
                .setColor("#ED4245")
                .setTitle("Unexpected Error")
                .setDescription("Received an invalid response from the panel. Please contact an administrator."),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // Save user to database
        const pteroId = res.data.attributes.id;
        await new User({ discordId, email, pteroId }).save();
        await PendingUser.deleteOne({ discordId });

        // Send success message (ephemeral)
        await modalSubmit.reply({
          embeds: [
            new EmbedBuilder()
              .setColor("#57F287")
              .setTitle("Account Created Successfully")
              .setDescription(
                `Your panel account has been created! Here are your login credentials:\n\n` +
                `**Login Details:**\n` +
                `**Email:** \`${email}\`\n` +
                `**Username:** \`${discordId}\`\n` +
                `**Password:** ||${password}||\n\n` +
                `**Panel URL:** ${ptero.url}\n\n` +
                `**Important:** Please save these credentials and change your password immediately after logging in.`
              )
              .setFooter({ text: "Keep your credentials secure" })
              .setTimestamp(),
          ],
          flags: MessageFlags.Ephemeral,
        });

        // Send public notification
        await context[replyMethod]({
          embeds: [
            new EmbedBuilder()
              .setColor("#57F287")
              .setDescription(`<@${discordId}> has registered an account!`),
          ],
        });

      } catch (err) {
        console.error("Modal submission error:", err);
        await PendingUser.deleteOne({ discordId });
      }
    });

    collector.on("end", async (collected) => {
      if (collected.size === 0) {
        // Timeout occurred
        await PendingUser.deleteOne({ discordId });
      }
    });
  },
};