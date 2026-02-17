const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
} = require("discord.js");

const SERVER_CARD_COLOR = 0x1b0f13;
const SERVER_COOLDOWN_MS = 5_000;
const cooldowns = new Map();

function buildServerCard({
  title,
  description,
  details = [],
  button,
  buttonDivider = false,
  ephemeral = false,
  extraComponents = [],
}) {
  const container = new ContainerBuilder().setAccentColor(SERVER_CARD_COLOR);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${title}\n${description}`)
  );

  if (details.length) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true)
    );

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(details.join("\n"))
    );
  }

  if (button?.url && button?.label) {
    if (buttonDivider) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true)
      );
    }

    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel(button.label)
          .setURL(button.url)
      )
    );
  }

  const flags = ephemeral
    ? (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral)
    : MessageFlags.IsComponentsV2;

  return {
    flags,
    components: [container, ...extraComponents],
  };
}

function consumeServerCooldown(discordId) {
  const now = Date.now();
  const lastUsed = cooldowns.get(discordId);

  if (lastUsed && now - lastUsed < SERVER_COOLDOWN_MS) {
    return Math.max(1, Math.ceil((SERVER_COOLDOWN_MS - (now - lastUsed)) / 1000));
  }

  cooldowns.set(discordId, now);
  setTimeout(() => cooldowns.delete(discordId), SERVER_COOLDOWN_MS);
  return 0;
}

function buildServerCooldownCard(secondsRemaining) {
  return buildServerCard({
    title: "✕ Cooldown",
    description: `Wait **${secondsRemaining}s** before reusing \`server\`.`,
  });
}

module.exports = {
  buildServerCard,
  buildServerCooldownCard,
  consumeServerCooldown,
};
