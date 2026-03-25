const { cancelAccountDeletion } = require("../services/accountDeletion");

module.exports = async (client, member) => {
  try {
    const canceled = await cancelAccountDeletion(member.id);
    if (canceled) {
      console.log(`[GuildMemberAdd] ${member.user.tag} rejoined; canceled pending panel deletion.`);
    }
  } catch (err) {
    console.error(
      `[GuildMemberAdd] Failed to cancel pending deletion for ${member.user.tag}:`,
      err.message,
      err.response?.data || err
    );
  }
};

