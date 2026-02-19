const { PermissionFlagsBits } = require("discord.js");
const StickyMessage = require("../models/StickyMessage");
const { buildStickyPayload } = require("../structures/stickyMessagePayload");

const pendingResends = new Map(); // stickyId -> timeout
const restickInProgress = new Set(); // stickyId
const DEFAULT_COOLDOWN_SECONDS = 5;

function clearPendingResend(stickyId) {
  const timer = pendingResends.get(stickyId);
  if (timer) {
    clearTimeout(timer);
    pendingResends.delete(stickyId);
  }
}

async function safelyDeleteMessage(channel, messageId) {
  if (!messageId || !channel?.messages?.fetch) return;
  try {
    const message = await channel.messages.fetch(messageId);
    if (message?.deletable) {
      await message.delete();
    }
  } catch {
    // Ignore deleted/missing message errors.
  }
}

async function restickSticky(client, stickyId) {
  if (restickInProgress.has(stickyId)) return;
  restickInProgress.add(stickyId);

  try {
    const config = await StickyMessage.findOne({ id: stickyId });
    if (!config) return;

    const channel =
      client.channels.cache.get(config.channelId) ||
      (await client.channels.fetch(config.channelId).catch(() => null));

    if (!channel?.isTextBased?.() || channel.isDMBased?.()) return;

    const botPerms = channel.permissionsFor(client.user);
    if (!botPerms?.has(PermissionFlagsBits.SendMessages)) return;

    await safelyDeleteMessage(channel, config.lastStickyMessageId);

    const stickyMessage = await channel.send(
      buildStickyPayload(config.content, config.useComponentsV2)
    );

    await StickyMessage.updateOne(
      { id: stickyId },
      {
        lastStickyMessageId: stickyMessage.id,
      }
    );
  } catch (err) {
    console.error(`[Sticky] Failed restick for sticky #${stickyId}:`, err);
  } finally {
    restickInProgress.delete(stickyId);
  }
}

module.exports = async (client, message) => {
  if (!message.guild || message.author?.bot) return;

  const guildId = message.guild.id;
  const channelId = message.channel.id;

  try {
    const stickies = await StickyMessage.findMany(
      { guildId, channelId },
      { orderBy: "id ASC" }
    );

    if (!stickies.length) return;

    for (const sticky of stickies) {
      const stickyId = Number(sticky.id);

      if (!stickyId) continue;
      if (message.id === sticky.lastStickyMessageId) continue;
      if (restickInProgress.has(stickyId)) continue;

      clearPendingResend(stickyId);

      const cooldownRaw = Number(sticky.cooldownSeconds);
      const cooldownSeconds = Number.isFinite(cooldownRaw)
        ? Math.max(0, cooldownRaw)
        : DEFAULT_COOLDOWN_SECONDS;

      const timer = setTimeout(async () => {
        pendingResends.delete(stickyId);
        await restickSticky(client, stickyId);
      }, cooldownSeconds * 1000);

      pendingResends.set(stickyId, timer);
    }
  } catch (err) {
    console.error(`[Sticky] Failed to process message for channel ${channelId}:`, err);
  }
};
