const { scheduleAccountDeletion, SEVEN_DAYS_MS } = require("../services/accountDeletion");

module.exports = async (client, member) => {
  try {
    console.log(
      `[GuildMemberRemove] ${member.user.tag} left. Scheduling panel deletion in ${Math.round(
        SEVEN_DAYS_MS / (24 * 60 * 60 * 1000)
      )} days...`
    );

    const pending = await scheduleAccountDeletion(member.id);
    if (!pending) {
      console.log(`[GuildMemberRemove] No linked panel account found for ${member.user.tag}.`);
      return;
    }

    console.log(
      `[GuildMemberRemove] Scheduled deletion for ${member.user.tag} at ${new Date(
        pending.deleteAfter
      ).toISOString()} (Ptero ID: ${pending.pteroId})`
    );
  } catch (err) {
    console.error(`[GuildMemberRemove] Error processing ${member.user.tag}:`, err.message, err.response?.data || err);
  }
};
