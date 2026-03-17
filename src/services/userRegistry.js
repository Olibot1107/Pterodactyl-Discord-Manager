const User = require("../models/User");
const BoosterPremium = require("../models/BoosterPremium");
const api = require("../structures/Ptero");

const CACHE_TTL_MS = 30_000;
const verifiedCache = new Map();

function cacheUser(user) {
  if (!user || !user.discordId) return;
  verifiedCache.set(user.discordId, {
    user,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function getCachedUser(discordId) {
  const entry = verifiedCache.get(discordId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    verifiedCache.delete(discordId);
    return null;
  }
  return entry.user;
}

function clearCachedUser(discordId) {
  verifiedCache.delete(discordId);
}

async function fetchPanelUser(pteroId) {
  if (!pteroId) return null;
  const response = await api.get(`/users/${pteroId}`);
  return response.data?.attributes || null;
}

async function reconcilePremiumStatus(user) {
  if (!user?.discordId) return;
  const premium = await BoosterPremium.findOne({ discordId: user.discordId });
  if (!premium || !premium.serverId) return;

  try {
    await api.get(`/servers/${premium.serverId}`);
  } catch (err) {
    if (err.response?.status === 404) {
      await BoosterPremium.deleteOne({ discordId: user.discordId });
      return;
    }
    if (process.env.NODE_ENV !== "test") {
      console.warn(
        `[userRegistry] Unable to verify premium server ${premium.serverIdentifier}: ${err.message}`
      );
    }
  }
}

async function validateUserRecord(user) {
  if (!user) return null;
  if (!user.pteroId) {
    await User.deleteOne({ discordId: user.discordId });
    clearCachedUser(user.discordId);
    return null;
  }

  try {
    const remote = await fetchPanelUser(user.pteroId);
    if (!remote) {
      await User.deleteOne({ discordId: user.discordId });
      clearCachedUser(user.discordId);
      return null;
    }

    if (
      remote.email &&
      typeof remote.email === "string" &&
      remote.email !== user.email
    ) {
      await User.updateOne({ id: user.id }, { email: remote.email });
      user.email = remote.email;
    }

    await reconcilePremiumStatus(user);

    cacheUser(user);
    return user;
  } catch (err) {
    if (err.response?.status === 404) {
      await User.deleteOne({ discordId: user.discordId });
      clearCachedUser(user.discordId);
      return null;
    }
    throw err;
  }
}

async function getVerifiedUser(discordId, options = {}) {
  if (!discordId) return null;
  if (!options.forceRefresh) {
    const cached = getCachedUser(discordId);
    if (cached) return cached;
  }

  const user = await User.findOne({ discordId });
  if (!user) return null;

  return await validateUserRecord(user);
}

module.exports = {
  getVerifiedUser,
  clearCachedUser,
};
