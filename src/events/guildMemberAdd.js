const { cancelAccountDeletion } = require("../services/accountDeletion");
const { logAction, logError } = require("../structures/logger");

module.exports = async (client, member) => {
  try {
    const canceled = await cancelAccountDeletion(member.id);
    if (canceled) {
      logAction("Member Rejoin", `${member.user.tag} canceled pending panel deletion`);
    }
  } catch (err) {
    logError(`Failed to cancel pending deletion for ${member.user.tag}: ${err.message}`);
  }
};
