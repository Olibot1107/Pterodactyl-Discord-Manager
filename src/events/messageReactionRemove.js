// messageReactionRemove.js
module.exports = async (client, reaction, user) => {
  try {
    // Fetch partial reaction
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch (error) {
        console.error('[MessageReactionRemove] Failed to fetch reaction:', error);
        return;
      }
    }

    console.log(`[MessageReactionRemove] Received from ${user.tag} on message ${reaction.message.id}`);
    
    if (user.bot) return;
    
    let message = reaction.message;
    
    // Fetch partial message
    if (message.partial) {
      try {
        message = await message.fetch();
      } catch (error) {
        console.error('[MessageReactionRemove] Failed to fetch message:', error);
        return;
      }
    }
    
    if (!message.guild) return;
    
    const emoji = reaction.emoji;
    const emojiStr = emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
    console.log(`[MessageReactionRemove] Emoji: ${emojiStr}`);
    
    // Find the reaction object for this emoji
    const reactionForEmoji = message.reactions.cache.find(
      (r) => r.emoji.id ? r.emoji.id === emoji.id : r.emoji.name === emoji.name
    );
    
    if (!reactionForEmoji) {
      console.log(`[MessageReactionRemove] No reaction found for emoji`);
      return;
    }
    
    // Fetch users to check if any non-bot users remain
    const users = await reactionForEmoji.users.fetch();
    const hasNonBotUsers = users.some(u => !u.bot);
    
    console.log(`[MessageReactionRemove] Has non-bot users: ${hasNonBotUsers}`);
    
    // If only the bot has this reaction, remove it
    if (!hasNonBotUsers && reactionForEmoji.me) {
      console.log(`[MessageReactionRemove] Removing bot reaction (bot is only user)...`);
      await reactionForEmoji.users.remove(client.user.id);
      console.log(`[MessageReactionRemove] Bot reaction removed`);
    }
  } catch (err) {
    console.error(`[MessageReactionRemove] Error:`, err.message, err.stack);
  }
};