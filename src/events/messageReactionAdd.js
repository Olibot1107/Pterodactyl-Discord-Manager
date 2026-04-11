module.exports = async (client, reaction, user) => {
  try {
    if (user.bot) return;

    const message = reaction.message;
    if (!message.guild) return;

    const botMember = message.guild.members.me;
    if (!botMember) return;

    const existingBotReaction = message.reactions.cache.find(
      (r) => r.me && r.emoji.name === reaction.emoji.name
    );

    if (!existingBotReaction) {
      await reaction.message.react(reaction.emoji.name);
    }

    const userReactions = message.reactions.cache.filter(
      (r) => !r.me && r.emoji.name === reaction.emoji.name
    );

    if (userReactions.size === 0) {
      const botReaction = message.reactions.cache.find(
        (r) => r.me && r.emoji.name === reaction.emoji.name
      );
      if (botReaction) {
        await botReaction.remove();
      }
    }
  } catch (err) {
    console.error(`[MessageReactionAdd] Error:`, err.message);
  }
};