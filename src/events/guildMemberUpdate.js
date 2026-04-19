const { ChannelType, EmbedBuilder } = require("discord.js");
const { discord } = require("../../settings");
const { revokeBoosterPerks } = require("../structures/boosterPerks");
const { logAction, logError, logWarn } = require("../structures/logger");

const THANK_YOU_CHANNEL_ID = "1472918619544621070";
const BOOSTER_ROLE_ID = discord?.boosterRoleId || "1473717031202193408";

module.exports = async (client, oldMember, newMember) => {
  try {
    // Check if the user now has the boost role (booster role)
    const oldBoosted = oldMember.premiumSince;
    const newBoosted = newMember.premiumSince;

    // If the user just started boosting
    if (!oldBoosted && newBoosted) {
      logAction("Boost Started", `${newMember.user.tag}`);

      // Add the booster role
      if (!newMember.roles.cache.has(BOOSTER_ROLE_ID)) {
        await newMember.roles.add(BOOSTER_ROLE_ID);
        logAction("Role Added", `booster role -> ${newMember.user.tag}`);
      }

      // Get the channel to send the thank you message
      const channel = await client.channels.fetch(THANK_YOU_CHANNEL_ID);

      if (!channel || channel.type !== ChannelType.GuildText) {
        logWarn(`Channel ${THANK_YOU_CHANNEL_ID} not found or is not a text channel`);
        return;
      }

      // Create thank you embed
      const embed = new EmbedBuilder()
        .setColor(0xF47FFF)
        .setAuthor({
          name: `${newMember.user.username} just boosted the server`,
          iconURL: newMember.user.displayAvatarURL({ dynamic: true }),
        })
        .setTitle("Thanks for the boost")
        .setDescription(
          `<@${newMember.user.id}> just boosted **${newMember.guild.name}**.\nWe really appreciate the support.`
        )
        .addFields(
          {
            name: "What your boost does",
            value: "It helps us keep things running smoothly and improve the server for everyone.",
          },
          {
            name: "Booster perks",
            value: "You now have the booster role and access to booster-only perks.",
          }
        )
        .setThumbnail(newMember.user.displayAvatarURL({ dynamic: true }))
        .setFooter({ text: "You are appreciated." })
        .setTimestamp();

      // Send thank you message
      await channel.send({
        embeds: [embed],
        allowedMentions: { users: [newMember.user.id] }
      });
    }

    // If the user stopped boosting
    if (oldBoosted && !newBoosted) {
      logAction("Boost Stopped", `${newMember.user.tag}`);

      // Remove the booster role
      if (newMember.roles.cache.has(BOOSTER_ROLE_ID)) {
        await newMember.roles.remove(BOOSTER_ROLE_ID);
        logAction("Role Removed", `booster role <- ${newMember.user.tag}`);
      }

      // Get the channel to send the unboost message
      const channel = await client.channels.fetch(THANK_YOU_CHANNEL_ID);

      if (!channel || channel.type !== ChannelType.GuildText) {
        logWarn(`Channel ${THANK_YOU_CHANNEL_ID} not found or is not a text channel`);
        return;
      }

      // Create unboost embed
      const embed = new EmbedBuilder()
        .setColor(0x808080) // Gray color for unboosting
        .setTitle("📉 Server Boost Removed")
        .setDescription(`${newMember.user.tag} has stopped boosting our server.`)
        .addFields(
          { name: "💔 We'll miss you!", value: "Your support meant a lot to our community. We hope to see you boosting again soon!" },
          { name: "✨ Keep in Touch", value: "You're still part of our community! Feel free to re-boost anytime to regain your perks." }
        )
        .setThumbnail(newMember.user.displayAvatarURL({ dynamic: true }))
        .setTimestamp();

      // Send unboost message
      await channel.send({
        embeds: [embed],
        allowedMentions: { users: [newMember.user.id] }
      });

      await revokeBoosterPerks({
        userId: newMember.user.id,
        userTag: newMember.user.tag,
      });
    }
  } catch (error) {
    logError(`Error handling guild member update: ${error.message}`);
  }
};
