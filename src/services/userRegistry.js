const User = require("../models/User");
const BoosterPremium = require("../models/BoosterPremium");
const api = require("../structures/Ptero");

const VERIFIED_CACHE_TTL_MS = 30_000;
const PANEL_USERS_CACHE_TTL_MS = 30_000;

const verifiedCache = new Map();
const panelUsersCache = {
  users: null,
  expiresAt: 0,
  pending: null,
};

function cacheUser(user) {
  if (!user || !user.discordId) return;
  verifiedCache.set(user.discordId, {
    user,
    expiresAt: Date.now() + VERIFIED_CACHE_TTL_MS,
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

function normalizePanelUser(remoteUser, fallbackDiscordId = null) {
  if (!remoteUser) return null;

  const discordId =
    remoteUser.external_id != null
      ? String(remoteUser.external_id)
      : fallbackDiscordId != null
        ? String(fallbackDiscordId)
        : null;

  return {
    ...remoteUser,
    discordId,
    pteroId: remoteUser.id ?? null,
  };
}

async function fetchPanelUsers(options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  const now = Date.now();

  if (!forceRefresh && panelUsersCache.users && panelUsersCache.expiresAt > now) {
    return panelUsersCache.users;
  }

  if (!forceRefresh && panelUsersCache.pending) {
    return panelUsersCache.pending;
  }

  const pending = (async () => {
    const users = [];
    let page = 1;

    while (true) {
      const response = await api.get("/users", {
        params: {
          page,
          per_page: 100,
        },
      });

      const pageUsers = Array.isArray(response.data?.data)
        ? response.data.data.map((entry) => entry?.attributes).filter(Boolean)
        : [];

      users.push(...pageUsers);

      const pagination = response.data?.meta?.pagination;
      if (!pagination) break;

      const currentPage = Number(pagination.current_page ?? page);
      const totalPages = Number(pagination.total_pages ?? currentPage);
      if (!pageUsers.length || currentPage >= totalPages) break;

      page = currentPage + 1;
    }

    panelUsersCache.users = users;
    panelUsersCache.expiresAt = Date.now() + PANEL_USERS_CACHE_TTL_MS;
    return users;
  })().catch((err) => {
    if (panelUsersCache.users) {
      if (process.env.NODE_ENV !== "test") {
        console.warn(
          `[userRegistry] Panel user list fetch failed, using stale cache: ${err.message}`
        );
      }

      return panelUsersCache.users;
    }

    throw err;
  });

  panelUsersCache.pending = pending;

  try {
    return await pending;
  } finally {
    if (panelUsersCache.pending === pending) {
      panelUsersCache.pending = null;
    }
  }
}

async function getPanelUserByDiscordId(discordId, options = {}) {
  const users = await fetchPanelUsers(options);
  return (
    users.find((user) => String(user?.external_id ?? "") === String(discordId)) ||
    null
  );
}

async function findPanelUser(discordId, options = {}) {
  const remote = await getPanelUserByDiscordId(discordId, options);
  if (remote || options.forceRefresh) {
    return remote;
  }

  return await getPanelUserByDiscordId(discordId, {
    ...options,
    forceRefresh: true,
  });
}

async function fetchPanelUser(pteroId) {
  if (!pteroId) return null;
  const response = await api.get(`/users/${pteroId}`);
  return response.data?.attributes || null;
}

async function reconcilePremiumStatus(user) {
  if (!user?.discordId) return;

  try {
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
  } catch (err) {
    if (process.env.NODE_ENV !== "test") {
      console.warn(
        `[userRegistry] Unable to reconcile premium status for ${user.discordId}: ${err.message}`
      );
    }
  }
}

async function resolveLegacyUser(discordId) {
  const legacyUser = await User.findOne({ discordId });
  if (!legacyUser || !legacyUser.pteroId) return null;

  try {
    const remote = await fetchPanelUser(legacyUser.pteroId);
    if (!remote) return null;

    return normalizePanelUser(remote, legacyUser.discordId);
  } catch (err) {
    if (err.response?.status === 404) {
      return null;
    }

    throw err;
  }
}

async function getVerifiedUser(discordId, options = {}) {
  if (!discordId) return null;

  const normalizedDiscordId = String(discordId);
  if (!options.forceRefresh) {
    const cached = getCachedUser(normalizedDiscordId);
    if (cached) return cached;
  }

  try {
    const remote = await findPanelUser(normalizedDiscordId, options);
    if (remote) {
      const user = normalizePanelUser(remote, normalizedDiscordId);
      cacheUser(user);
      await reconcilePremiumStatus(user);
      return user;
    }
  } catch (err) {
    if (process.env.NODE_ENV !== "test") {
      console.warn(
        `[userRegistry] Panel user lookup failed for ${normalizedDiscordId}: ${err.message}`
      );
    }
  }

  const legacyUser = await resolveLegacyUser(normalizedDiscordId);
  if (!legacyUser) return null;

  cacheUser(legacyUser);
  await reconcilePremiumStatus(legacyUser);
  return legacyUser;
}

module.exports = {
  getVerifiedUser,
  clearCachedUser,
};
