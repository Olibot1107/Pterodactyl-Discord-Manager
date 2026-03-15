const { ChannelType, EmbedBuilder } = require("discord.js");
const { discord } = require("../../settings");
const BoosterPremium = require("../models/BoosterPremium");
const CustomDomain = require("../models/CustomDomain");
const { updateServerBuild } = require("../structures/pteroBuild");
const { createProxyAdminClient, getProxyAdminConfig } = require("../structures/ProxyAdmin");

const THANK_YOU_CHANNEL_ID = "1472918619544621070";
const BOOSTER_ROLE_ID = discord?.boosterRoleId || "1473717031202193408";

module.exports = async (client, oldMember, newMember) => {
  try {
    // Check if the user now has the boost role (booster role)
    const oldBoosted = oldMember.premiumSince;
    const newBoosted = newMember.premiumSince;

    // If the user just started boosting
    if (!oldBoosted && newBoosted) {
      console.log(`[Booster] ${newMember.user.tag} has started boosting the server!`);

      // Add the booster role
      if (!newMember.roles.cache.has(BOOSTER_ROLE_ID)) {
        await newMember.roles.add(BOOSTER_ROLE_ID);
        console.log(`[Booster] Added booster role to ${newMember.user.tag}`);
      }

      // Get the channel to send the thank you message
      const channel = await client.channels.fetch(THANK_YOU_CHANNEL_ID);

      if (!channel || channel.type !== ChannelType.GuildText) {
        console.warn(`[Booster] Channel ${THANK_YOU_CHANNEL_ID} not found or is not a text channel`);
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
      console.log(`[Booster] ${newMember.user.tag} has stopped boosting the server.`);

      // Remove the booster role
      if (newMember.roles.cache.has(BOOSTER_ROLE_ID)) {
        await newMember.roles.remove(BOOSTER_ROLE_ID);
        console.log(`[Booster] Removed booster role from ${newMember.user.tag}`);
      }

      // Get the channel to send the unboost message
      const channel = await client.channels.fetch(THANK_YOU_CHANNEL_ID);

      if (!channel || channel.type !== ChannelType.GuildText) {
        console.warn(`[Booster] Channel ${THANK_YOU_CHANNEL_ID} not found or is not a text channel`);
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

      // Revoke premium server perks if set
      try {
        const premium = await BoosterPremium.findOne({ discordId: newMember.user.id });
        if (premium) {
          let originalLimits = {};
          try {
            originalLimits = JSON.parse(premium.originalLimits || "{}");
          } catch (parseErr) {
            console.warn("[Booster] Failed to parse original limits for premium rollback:", parseErr.message);
          }

          try {
            await updateServerBuild(premium.serverId, originalLimits);
            console.log(
              `[Booster] Reverted premium limits for ${newMember.user.tag} on ${premium.serverIdentifier}`
            );
          } catch (updateErr) {
            console.warn(
              `[Booster] Failed to revert premium limits for ${premium.serverIdentifier}:`,
              updateErr.response?.data || updateErr.message
            );
          }

          await BoosterPremium.deleteOne({ discordId: newMember.user.id });
        }
      } catch (err) {
        console.warn("[Booster] Failed to revoke premium server:", err.message);
      }

      // Revoke custom domains if set
      try {
        const domains = await CustomDomain.findMany({ discordId: newMember.user.id });
        if (domains.length) {
          const { adminBaseUrl, masterToken } = getProxyAdminConfig();
          if (!adminBaseUrl || !masterToken) {
            console.warn("[Booster] Custom domain admin not configured; skipping domain removal.");
          } else {
            const proxyAdmin = createProxyAdminClient();
            if (!proxyAdmin) {
              console.warn("[Booster] Failed to create proxy admin client; skipping domain removal.");
            } else {
              for (const entry of domains) {
                try {
                  const res = await proxyAdmin.delete("/domains", {
                    data: { domain: entry.domain },
                    validateStatus: () => true,
                  });
                  if (res.status === 200 || res.status === 404) {
                    await CustomDomain.deleteOne({ id: entry.id });
                  } else {
                    console.warn(
                      `[Booster] Failed to remove custom domain ${entry.domain}:`,
                      res?.data || res.status
                    );
                  }
                } catch (removeErr) {
                  console.warn(
                    `[Booster] Failed to remove custom domain ${entry.domain}:`,
                    removeErr.response?.data || removeErr.message
                  );
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn("[Booster] Failed to revoke custom domains:", err.message);
      }
    }
  } catch (error) {
    console.error(`[Booster] Error handling guild member update:`, error);
  }
};
