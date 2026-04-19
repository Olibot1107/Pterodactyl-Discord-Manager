const { scheduleAccountDeletion, SEVEN_DAYS_MS } = require("../services/accountDeletion");
const { revokeAiApiKey } = require("../services/aiApiKeys");
const { logAction, logError, logInfo } = require("../structures/logger");

module.exports = async (client, member) => {
  try {
    logAction(
      "Member Leave",
      `${member.user.tag} left; scheduling panel deletion in ${Math.round(SEVEN_DAYS_MS / (24 * 60 * 60 * 1000))} days`
    );

    const aiRevoked = await revokeAiApiKey(member.id).catch(() => false);
    if (aiRevoked) {
      logInfo(`Revoked AI API key for ${member.user.tag}`);
    }

    const pending = await scheduleAccountDeletion(member.id);
    if (!pending) {
      logInfo(`No linked panel account found for ${member.user.tag}`);
      return;
    }

    logAction(
      "Account Deletion Scheduled",
      `${member.user.tag} at ${new Date(pending.deleteAfter).toISOString()} (Ptero ID: ${pending.pteroId})`
    );
  } catch (err) {
    logError(`Error processing ${member.user.tag}: ${err.message}`);
  }
};
