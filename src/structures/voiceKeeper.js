const {
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
} = require("@discordjs/voice");
const { discord } = require("../../settings");

const TARGET_VOICE_CHANNEL_ID = "1472918619544621071";
const TARGET_GUILD_ID = discord.guildId;
const RECONNECT_DELAY_MS = 3_000;

async function ensurePersistentVoiceConnection(client) {
  if (!TARGET_GUILD_ID || !TARGET_VOICE_CHANNEL_ID) return;

  let guild = client.guilds.cache.get(TARGET_GUILD_ID);
  if (!guild) {
    guild = await client.guilds.fetch(TARGET_GUILD_ID).catch(() => null);
  }
  if (!guild) return;

  let channel = guild.channels.cache.get(TARGET_VOICE_CHANNEL_ID);
  if (!channel) {
    channel = await guild.channels.fetch(TARGET_VOICE_CHANNEL_ID).catch(() => null);
  }

  if (!channel || !channel.isVoiceBased()) {
    console.warn("[VoiceKeeper] Target channel is missing or not voice-based.");
    return;
  }

  let connection = getVoiceConnection(guild.id);

  if (
    connection &&
    connection.state.status !== VoiceConnectionStatus.Destroyed &&
    connection.joinConfig.channelId === TARGET_VOICE_CHANNEL_ID
  ) {
    return;
  }

  if (connection) {
    try {
      connection.destroy();
    } catch {}
  }

  connection = joinVoiceChannel({
    channelId: TARGET_VOICE_CHANNEL_ID,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  connection.on("stateChange", (_oldState, newState) => {
    if (
      newState.status === VoiceConnectionStatus.Disconnected ||
      newState.status === VoiceConnectionStatus.Destroyed
    ) {
      setTimeout(() => ensurePersistentVoiceConnection(client), RECONNECT_DELAY_MS);
    }
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    console.log(`[VoiceKeeper] Connected to voice channel ${TARGET_VOICE_CHANNEL_ID}.`);
  } catch (err) {
    console.warn("[VoiceKeeper] Failed to establish voice connection:", err.message || err);
    try {
      connection.destroy();
    } catch {}
    setTimeout(() => ensurePersistentVoiceConnection(client), RECONNECT_DELAY_MS);
  }
}

module.exports = {
  TARGET_VOICE_CHANNEL_ID,
  ensurePersistentVoiceConnection,
};
