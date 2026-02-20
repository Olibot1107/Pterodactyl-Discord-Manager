const { 
  EmbedBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  ActionRowBuilder, 
  ModalBuilder, 
  TextInputBuilder, 
  TextInputStyle 
} = require("discord.js");
const User = require("../../models/User");
const PendingUser = require("../../models/PendingUser");
const api = require("../../structures/Ptero");
const { ptero } = require("../../../settings");
const crypto = require("crypto");
const sendEmail = require("../../structures/sendVerificationEmail");
const { buildServerCard } = require("../../structures/serverCommandUi");
const { channel } = require("diagnostics_channel");

// Cooldown tracking
const cooldowns = new Map();
const COOLDOWN_TIME = 5 * 60 * 1000; // 5 minutes
const CODE_EXPIRY = 5 * 60 * 1000; // 5 minutes
const BANNED_MEMBERS = ["1332006483600347157"];

function generatePassword(length = 16) {
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=";
  const bytes = crypto.randomBytes(length);
  let password = "";
  for (let i = 0; i < length; i++) {
    password += charset[bytes[i] % charset.length];
  }
  return password;
}

function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function checkCooldown(discordId) {
  if (!cooldowns.has(discordId)) return null;
  const lastUsed = cooldowns.get(discordId);
  const timeElapsed = Date.now() - lastUsed;
  if (timeElapsed < COOLDOWN_TIME) {
    return Math.ceil((COOLDOWN_TIME - timeElapsed) / 1000 / 60);
  }
  return null;
}

function setCooldown(discordId) {
  cooldowns.set(discordId, Date.now());
  setTimeout(() => cooldowns.delete(discordId), COOLDOWN_TIME);
}

async function cleanupStaleUser(discordId, pteroId) {
  try {
    const panelUser = await api.get(`/users/${pteroId}`);
    if (panelUser?.data?.object === "user") return true;
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
    const discordId = context.user.id;
    const email = context.options.getString("email").trim();

    const cooldownRemaining = checkCooldown(discordId);
    if (cooldownRemaining) {
      return await context.editReply(
        buildServerCard({
          title: "✕ Cooldown Active",
          description: `Please wait ${cooldownRemaining} minute(s) before using this command again.`,
          ephemeral: true,
        })
      );
    }

    if (BANNED_MEMBERS.includes(discordId)) {
      return await context.editReply(
        buildServerCard({
          title: "✕ Access Denied",
          description: "You are banned from creating an account.",
          ephemeral: true,
        })
      );
    }

    if (!isValidEmail(email)) {
      return await context.editReply(
        buildServerCard({
          title: "✕ Invalid Email",
          description: "Please provide a valid email address.",
          ephemeral: true,
        })
      );
    }

    try {
      const existing = await User.findOne({ discordId });
      if (existing) {
        const userExists = await cleanupStaleUser(discordId, existing.pteroId);
        if (userExists) {
          return await context.editReply(
            buildServerCard({
              title: "✕ Account Already Exists",
              description: "You have already registered an account. If you've forgotten credentials, contact support.",
              ephemeral: true,
            })
          );
        }
      }
    } catch (err) {
      console.error("Error checking existing user:", err);
      return await context.editReply(
        buildServerCard({
          title: "✕ Verification Error",
          description: "Internal error while verifying your account. Please try again later.",
          ephemeral: true,
        })
      );
    }

    try {
      if (await isEmailRegistered(email)) {
        return await context.editReply(
          buildServerCard({
            title: "✕ Email Already Registered",
            description: "This email is already registered. Please use a different email address.",
            ephemeral: true,
          })
        );
      }
    } catch (err) {
      console.error("Error checking email:", err);
      return await context.editReply(
        buildServerCard({
          title: "✕ Email Verification Failed",
          description: "Unable to verify email. Please try again later.",
          ephemeral: true,
        })
      );
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + CODE_EXPIRY;

    try {
      await PendingUser.deleteMany({ discordId });
      await new PendingUser({ discordId, email, code, expiresAt }).save();
    } catch (err) {
      console.error("Error saving pending user:", err);
      return await context.editReply(
        buildServerCard({
          title: "✕ Database Error",
          description: "Database error. Please try again later.",
          ephemeral: true,
        })
      );
    }

    try {
      await sendEmail(email, code);
    } catch (err) {
      console.error("Email send error:", err);
      await PendingUser.deleteOne({ discordId });
      return await context.editReply(
        buildServerCard({
          title: "✕ Email Send Failed",
          description: "Failed to send verification email. Please check your email address and try again.",
          ephemeral: true,
        })
      );
    }

    setCooldown(discordId);

    const verifyButton = new ButtonBuilder()
      .setCustomId(`verify_code_${discordId}`)
      .setLabel("Enter Verification Code")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("🔐");

    const row = new ActionRowBuilder().addComponents(verifyButton);

    // Use editReply instead of reply because interaction is already deferred
    await context.editReply(
      buildServerCard({
        title: "✔ Verification Email Sent",
        description: `A 6-digit verification code has been sent to **${email}**.`,
        details: [
          "├─ Check your inbox (and spam folder)",
          "├─ Click the button below to submit your code",
          "└─ You have **5 minutes** to verify",
        ],
        ephemeral: true,
        extraComponents: [row],
      })
    );

    try {
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor("#57F287")
            .setDescription(`<@${discordId}> has started the registration process!`)
        ],
      });
    }
    catch (err) {
      console.error("Failed to send public notification:", err);
    }

    // Handle button interactions by adding a listener to interactionCreate
    const handleInteraction = async (i) => {
      if (i.customId === `verify_code_${discordId}` && i.user.id === discordId) {
        client.off('interactionCreate', handleInteraction);
        
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

        await i.showModal(modal);

        try {
          const modalSubmit = await i.awaitModalSubmit({
            filter: (m) => m.customId === `verify_modal_${discordId}` && m.user.id === discordId,
            time: CODE_EXPIRY,
          });

          const submittedCode = modalSubmit.fields.getTextInputValue("verification_code").trim();
          const pending = await PendingUser.findOne({ discordId });

          if (!pending || Date.now() > pending.expiresAt) {
            await modalSubmit.reply(
              buildServerCard({
                title: "✕ Code Expired",
                description: "Your verification code has expired. Please run `/register` again to get a new code.",
                ephemeral: true,
              })
            );
            await PendingUser.deleteOne({ discordId });
            return;
          }

          if (pending.code !== submittedCode) {
            await modalSubmit.reply(
              buildServerCard({
                title: "✕ Incorrect Code",
                description: "The code you entered is incorrect. Run `/register` again to try again.",
                ephemeral: true,
              })
            );
            await PendingUser.deleteOne({ discordId });
            return;
          }

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
            await modalSubmit.reply(
              buildServerCard({
                title: "✕ Account Creation Failed",
                description: "Failed to create your panel account. Please contact support.",
                ephemeral: true,
              })
            );
            return;
          }

          if (!res?.data?.attributes?.id) {
            console.error("Invalid API response - missing user ID:", res?.data);
            await modalSubmit.reply(
              buildServerCard({
                title: "✕ Unexpected Error",
                description: "Received an invalid response from the panel. Please contact an administrator.",
                ephemeral: true,
              })
            );
            return;
          }

          const pteroId = res.data.attributes.id;
          await new User({ discordId, email, pteroId }).save();
          await PendingUser.deleteOne({ discordId });

          await modalSubmit.reply(
            buildServerCard({
              title: "✔ Account Created Successfully",
              description: "Your panel account has been created.",
              details: [
                `├─ **Email:** \`${email}\``,
                `├─ **Username:** \`${discordId}\``,
                `├─ **Password:** ||${password}||`,
                `└─ **Panel URL:** ${ptero.url}`,
              ],
              ephemeral: true,
            })
          );

          try {
            await context.channel.send({
              embeds: [
                new EmbedBuilder()
                  .setColor("#57F287")
                  .setDescription(`<@${discordId}> has registered an account!`)
              ],
            });
          } catch (err) {
            console.error("Failed to send public notification:", err);
          }

        } catch (err) {
          console.error("Modal submission error:", err);
          await PendingUser.deleteOne({ discordId });
        }
      }
    };

    client.on('interactionCreate', handleInteraction);

    // Cleanup listener after timeout
    setTimeout(() => {
      client.off('interactionCreate', handleInteraction);
      PendingUser.deleteOne({ discordId });
    }, CODE_EXPIRY);
  },
};
