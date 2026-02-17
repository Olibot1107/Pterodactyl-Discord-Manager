const { TARGET_VOICE_CHANNEL_ID, ensurePersistentVoiceConnection } = require("../structures/voiceKeeper");

module.exports = async (client, oldState, newState) => {
  if (!client.isReady()) return;
  if (client.cluster?.id !== 0) return;

  const botId = client.user?.id;
  if (!botId) return;
  if (oldState.id !== botId && newState.id !== botId) return;

  if (newState.channelId !== TARGET_VOICE_CHANNEL_ID) {
    setTimeout(() => ensurePersistentVoiceConnection(client), 1_000);
  }
};
