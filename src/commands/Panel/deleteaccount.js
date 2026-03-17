const User = require("../../models/User");
const userRegistry = require("../../services/userRegistry");
const BoosterPremium = require("../../models/BoosterPremium");
const api = require("../../structures/Ptero");
const { buildServerCard } = require("../../structures/serverCommandUi");

module.exports = {
  name: "deleteaccount",
  description: "Delete your panel account and all associated servers.",
  run: async ({ client, context }) => {
    const discordId = context.user?.id;
    if (!discordId) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Internal Error",
          description: "Unable to retrieve your user ID.",
          ephemeral: true,
        })
      );
    }

    const user = await userRegistry.getVerifiedUser(discordId);
    if (!user) {
      return context.createMessage(
        buildServerCard({
          title: "✕ Not Registered",
          description: "You don’t have an account registered with us.",
          ephemeral: true,
        })
      );
    }

    try {
      // Fetch all servers (supports up to 1000 servers)
      const allServers = await api.get("/servers?per_page=1000");
      const userServers = allServers.data.data.filter(
        s => s.attributes.user === user.pteroId
      );

      // Check for any suspended servers
      const suspended = userServers.find(s => s.attributes.suspended);
      if (suspended) {
        return context.createMessage(
          buildServerCard({
            title: "✕ Action Blocked",
            description: "Account cannot be deleted because one or more servers are suspended. Please contact support.",
            ephemeral: true,
          })
        );
      }

      // Proceed to delete all user servers
      for (const srv of userServers) {
        const serverId = srv.attributes.id;
        await api.delete(`/servers/${serverId}`);
      }

      // Delete user from panel and local DB
      await api.delete(`/users/${user.pteroId}`);
      await BoosterPremium.deleteOne({ discordId }).catch((err) =>
        console.warn("[DeleteAccount] Failed to delete premium record:", err?.message || err)
      );
      await User.deleteOne({ discordId });
      userRegistry.clearCachedUser(discordId);

      return context.createMessage(
        buildServerCard({
          title: "✔ Account Deleted",
          description: "Your panel account and all associated servers have been permanently deleted.",
          details: [
            `├─ **Deleted Servers:** ${userServers.length}`,
            `└─ **Deleted By:** ${context.user.username}.`,
          ],
          ephemeral: true,
        })
      );

    } catch (err) {
      console.error("Account deletion error:", err.message, err.response?.data || err);
      return context.createMessage(
        buildServerCard({
          title: "✕ Delete Failed",
          description: "Failed to delete your account. Please try again later.",
          ephemeral: true,
        })
      );
    }
  },
};
