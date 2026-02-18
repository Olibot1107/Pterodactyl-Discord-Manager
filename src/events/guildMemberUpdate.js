const { ChannelType, EmbedBuilder } = require("discord.js");

const THANK_YOU_CHANNEL_ID = "1472918619544621070";
const BOOSTER_ROLE_ID = "1473717031202193408";

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
        .setColor(0xFFD700) // Gold color for boosting
        .setTitle("🎉 New Server Booster!")
        .setDescription(`Thank you so much ${newMember.user.tag} for boosting our server!`)
        .addFields(
          { name: "🌟 What does this mean?", value: "Your support helps us grow and provide better experiences for everyone in our community!" },
          { name: "🎁 Booster Benefits", value: "Enjoy exclusive perks including special roles, priority support, and more!" }
        )
        .setThumbnail(newMember.user.displayAvatarURL({ dynamic: true }))
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
    }
  } catch (error) {
    console.error(`[Booster] Error handling guild member update:`, error);
  }
};
