const BoosterPremium = require("../models/BoosterPremium");
const CustomDomain = require("../models/CustomDomain");
const { updateServerBuild } = require("./pteroBuild");
const { applyNodeMinimumLimitsToServer } = require("../services/nodeLimitRules");
const { createProxyAdminClient, getProxyAdminConfig } = require("./ProxyAdmin");
const { logAction, logWarn } = require("./logger");

async function revokeBoosterPerks({ userId, userTag = "Unknown" }) {
  // Revoke premium server perks if set
  try {
    const premium = await BoosterPremium.findOne({ discordId: userId });
    if (premium) {
      let originalLimits = {};
      try {
        originalLimits = JSON.parse(premium.originalLimits || "{}");
      } catch (parseErr) {
        logWarn(`Failed to parse original limits for premium rollback: ${parseErr.message}`);
      }

      try {
        await updateServerBuild(premium.serverId, originalLimits);
        logAction("Premium Reverted", `${userTag} on ${premium.serverIdentifier}`);
        await applyNodeMinimumLimitsToServer(premium.serverId).catch((err) => {
          logWarn(`Failed to re-apply node minimums for ${premium.serverIdentifier}: ${err.message}`);
        });
      } catch (updateErr) {
        logWarn(`Failed to revert premium limits for ${premium.serverIdentifier}: ${updateErr.message}`);
      }

      await BoosterPremium.deleteOne({ discordId: userId });
    }
  } catch (err) {
    logWarn(`Failed to revoke premium server: ${err.message}`);
  }

  // Revoke custom domains if set
  try {
    const domains = await CustomDomain.findMany({ discordId: userId });
    if (domains.length) {
      const { adminBaseUrl, masterToken } = getProxyAdminConfig();
      if (!adminBaseUrl || !masterToken) {
        logWarn("Custom domain admin not configured; skipping domain removal.");
      } else {
        const proxyAdmin = createProxyAdminClient();
        if (!proxyAdmin) {
          logWarn("Failed to create proxy admin client; skipping domain removal.");
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
                logWarn(`Failed to remove custom domain ${entry.domain}: ${res?.status}`);
              }
            } catch (removeErr) {
              logWarn(`Failed to remove custom domain ${entry.domain}: ${removeErr.message}`);
            }
          }
        }
      }
    }
  } catch (err) {
    logWarn(`Failed to revoke custom domains: ${err.message}`);
  }
}

module.exports = {
  revokeBoosterPerks,
};
