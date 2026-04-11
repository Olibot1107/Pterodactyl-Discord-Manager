module.exports = async (client, reaction, user) => {
  try {
    console.log(`[MessageReactionAdd] Received from ${user.tag}`);

    if (user.bot) {
      console.log(`[MessageReactionAdd] User is bot, skipping`);
      return;
    }

    let message = reaction.message;
    if (!message.guild) {
      if (message.partial) {
        console.log(`[MessageReactionAdd] Message is partial, fetching...`);
        message = await message.fetch();
      }
      console.log(`[MessageReactionAdd] No guild, skipping`);
      return;
    }

    const emoji = reaction.emoji;
    const emojiStr = emoji.id ? emoji.toString() : emoji.name;
    console.log(`[MessageReactionAdd] Emoji: ${emojiStr}`);

    const existingBotReaction = message.reactions.cache.find(
      (r) => r.me && (r.emoji.id ? r.emoji.id === emoji.id : r.emoji.name === emoji.name)
    );
    console.log(`[MessageReactionAdd] Existing bot reaction: ${existingBotReaction ? 'yes' : 'no'}`);

    if (!existingBotReaction) {
      console.log(`[MessageReactionAdd] Adding reaction...`);
      await message.react(emojiStr);
      console.log(`[MessageReactionAdd] Reaction added`);
    }

    const userReactions = message.reactions.cache.filter(
      (r) => !r.me && (r.emoji.id ? r.emoji.id === emoji.id : r.emoji.name === emoji.name)
    );
    console.log(`[MessageReactionAdd] User reactions count: ${userReactions.size}`);

    if (userReactions.size === 0) {
      const botReaction = message.reactions.cache.find(
        (r) => r.me && (r.emoji.id ? r.emoji.id === emoji.id : r.emoji.name === emoji.name)
      );
      if (botReaction) {
        console.log(`[MessageReactionAdd] Removing bot reaction...`);
        await botReaction.remove();
        console.log(`[MessageReactionAdd] Bot reaction removed`);
      }
    }
  } catch (err) {
    console.error(`[MessageReactionAdd] Error:`, err.message, err.stack);
  }
};