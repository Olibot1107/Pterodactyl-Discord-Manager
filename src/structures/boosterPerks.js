const BoosterPremium = require("../models/BoosterPremium");
const CustomDomain = require("../models/CustomDomain");
const { updateServerBuild } = require("./pteroBuild");
const { createProxyAdminClient, getProxyAdminConfig } = require("./ProxyAdmin");

async function revokeBoosterPerks({ userId, userTag = "Unknown" }) {
  // Revoke premium server perks if set
  try {
    const premium = await BoosterPremium.findOne({ discordId: userId });
    if (premium) {
      let originalLimits = {};
      try {
        originalLimits = JSON.parse(premium.originalLimits || "{}");
      } catch (parseErr) {
        console.warn("[Booster] Failed to parse original limits for premium rollback:", parseErr.message);
      }

      try {
        await updateServerBuild(premium.serverId, originalLimits);
        console.log(`[Booster] Reverted premium limits for ${userTag} on ${premium.serverIdentifier}`);
      } catch (updateErr) {
        console.warn(
          `[Booster] Failed to revert premium limits for ${premium.serverIdentifier}:`,
          updateErr.response?.data || updateErr.message
        );
      }

      await BoosterPremium.deleteOne({ discordId: userId });
    }
  } catch (err) {
    console.warn("[Booster] Failed to revoke premium server:", err.message);
  }

  // Revoke custom domains if set
  try {
    const domains = await CustomDomain.findMany({ discordId: userId });
    if (domains.length) {
      const { adminBaseUrl, masterToken } = getProxyAdminConfig();
      if (!adminBaseUrl || !masterToken) {
        console.warn("[Booster] Custom domain admin not configured; skipping domain removal.");
      } else {
        const proxyAdmin = createProxyAdminClient();
        if (!proxyAdmin) {
          console.warn("[Booster] Failed to create proxy admin client; skipping domain removal.");
        } else {
          for (const entry of domains) {
            try {
              const res = await proxyAdmin.delete("/domains", {
                data: { domain: entry.domain },
                validateStatus: () => true,
              });
              if (res.status === 200 || res.status === 404) {
                await CustomDomain.deleteOne({ id: entry.id });
              } else {
                console.warn(
                  `[Booster] Failed to remove custom domain ${entry.domain}:`,
                  res?.data || res.status
                );
              }
            } catch (removeErr) {
              console.warn(
                `[Booster] Failed to remove custom domain ${entry.domain}:`,
                removeErr.response?.data || removeErr.message
              );
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn("[Booster] Failed to revoke custom domains:", err.message);
  }
}

module.exports = {
  revokeBoosterPerks,
};
