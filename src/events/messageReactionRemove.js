module.exports = async (client, reaction, user) => {
  try {
    if (user.bot) return;

    const message = reaction.message;
    if (!message.guild) return;

    const remainingReactions = message.reactions.cache.filter(
      (r) => !r.me && r.emoji.name === reaction.emoji.name
    );

    if (remainingReactions.size === 0) {
      const botReaction = message.reactions.cache.find(
        (r) => r.me && r.emoji.name === reaction.emoji.name
      );
      if (botReaction) {
        await botReaction.remove();
      }
    }
  } catch (err) {
    console.error(`[MessageReactionRemove] Error:`, err.message);
  }
};