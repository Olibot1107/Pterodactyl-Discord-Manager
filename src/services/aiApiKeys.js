const crypto = require('crypto');
const { AiApiKey, AiRateLimit } = require('../database/database');

function generateApiKey() {
  const token = crypto.randomBytes(24).toString('base64url');
  return `ai_${token}`;
}

async function getOrCreateAiApiKey(discordId) {
  const existing = await AiApiKey.findOne({ discordId });
  if (existing?.apiKey) return existing;

  const now = Date.now();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const apiKey = generateApiKey();
    try {
      const created = await AiApiKey.create({
        discordId,
        apiKey,
        createdAt: now,
        updatedAt: now,
      });
      if (created?.apiKey) return created;
    } catch (err) {
      const message = String(err?.message || '');
      const isUniqueViolation = message.includes('UNIQUE constraint failed');
      if (!isUniqueViolation) throw err;

      const raced = await AiApiKey.findOne({ discordId });
      if (raced?.apiKey) return raced;
    }
  }

  throw new Error('Failed to generate a unique AI API key. Try again.');
}

async function revokeAiApiKey(discordId) {
  const existing = await AiApiKey.findOne({ discordId });
  if (!existing?.apiKey) return false;

  await AiRateLimit.deleteOne({ apiKey: existing.apiKey }).catch(() => {});
  await AiApiKey.deleteOne({ discordId });
  return true;
}

module.exports = {
  getOrCreateAiApiKey,
  revokeAiApiKey,
};
