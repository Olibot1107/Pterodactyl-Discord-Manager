const User = require("../models/User");
const api = require("../structures/Ptero");

module.exports = async (client, member) => {
  console.log(`[GuildMemberRemove] ${member.user.tag} left the server. Checking for linked panel account...`);

  try {
    // Find the user in the database
    const user = await User.findOne({ discordId: member.id });
    if (!user) {
      console.log(`[GuildMemberRemove] No panel account found for ${member.user.tag}.`);
      return;
    }

    console.log(`[GuildMemberRemove] Found panel account for ${member.user.tag} (Ptero ID: ${user.pteroId}). Deleting...`);

    // Fetch all servers owned by the user
    const allServers = await api.get("/servers?per_page=1000");
    const userServers = allServers.data.data.filter(
      s => s.attributes.user === user.pteroId
    );

    // Delete all user servers
    for (const srv of userServers) {
      const serverId = srv.attributes.id;
      console.log(`[GuildMemberRemove] Deleting server: ${srv.attributes.name} (ID: ${serverId})`);
      try {
        await api.delete(`/servers/${serverId}`);
        console.log(`[GuildMemberRemove] Successfully deleted server: ${srv.attributes.name}`);
      } catch (serverErr) {
        console.error(`[GuildMemberRemove] Failed to delete server ${srv.attributes.name}:`, serverErr.message);
      }
    }

    // Delete user from panel
    console.log(`[GuildMemberRemove] Deleting panel user: ${user.email}`);
    await api.delete(`/users/${user.pteroId}`);

    // Delete user from local database
    await User.deleteOne({ discordId: member.id });

    console.log(`[GuildMemberRemove] Successfully deleted panel account and all servers for ${member.user.tag}`);

  } catch (err) {
    console.error(`[GuildMemberRemove] Error processing ${member.user.tag}:`, err.message, err.response?.data || err);
  }
};