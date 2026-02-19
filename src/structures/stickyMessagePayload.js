const {
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
} = require("discord.js");

const STICKY_CARD_ACCENT = 0x2f3136;

function isComponentsV2Enabled(value) {
  return value === true || value === 1 || value === "1";
}

function buildStickyPayload(content, useComponentsV2) {
  const messageContent = String(content || "").trim();

  if (!isComponentsV2Enabled(useComponentsV2)) {
    return { content: messageContent };
  }

  const container = new ContainerBuilder()
    .setAccentColor(STICKY_CARD_ACCENT)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(messageContent));

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  };
}

module.exports = {
  buildStickyPayload,
  isComponentsV2Enabled,
};
