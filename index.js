const { ClusterManager, ReClusterManager } = require("discord-hybrid-sharding");
const { TOKEN } = require("./settings");
require("./sidebot/server");
const manager = new ClusterManager("./src/bot.js", {
  token: TOKEN,
  totalShards: "auto",
  totalClusters: "auto",
  mode: "process",
});

manager.extend(new ReClusterManager());
manager.on("clusterDestroy", (cluster) => console.log(`Destroyed shard ${cluster.id}`));
manager.spawn();
