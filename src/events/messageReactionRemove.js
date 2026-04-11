module.exports = async (client, reaction, user) => {
  try {
    console.log(`[MessageReactionRemove] Received from ${user.tag} on message ${reaction.message.id}`);

    const message = reaction.message;
    if (!message.guild) return;

    const emoji = reaction.emoji;
    const emojiStr = emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
    console.log(`[MessageReactionRemove] Emoji: ${emojiStr}`);

    const remainingReactions = message.reactions.cache.filter(
      (r) => !r.me && (r.emoji.id ? r.emoji.id === emoji.id : r.emoji.name === emoji.name)
    );
    console.log(`[MessageReactionRemove] Remaining user reactions: ${remainingReactions.size}`);

    if (remainingReactions.size === 0) {
      const botReaction = message.reactions.cache.find(
        (r) => r.me && (r.emoji.id ? r.emoji.id === emoji.id : r.emoji.name === emoji.name)
      );
      if (botReaction) {
        console.log(`[MessageReactionRemove] Removing bot reaction...`);
        await botReaction.remove();
        console.log(`[MessageReactionRemove] Bot reaction removed`);
      }
    }
  } catch (err) {
    console.error(`[MessageReactionRemove] Error:`, err.message, err.stack);
  }
};