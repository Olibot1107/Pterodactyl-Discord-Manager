const { patchConsole, logInfo } = require("./src/structures/logger");
patchConsole();

const { ClusterManager, ReClusterManager } = require("discord-hybrid-sharding");
const { TOKEN } = require("./settings");
const manager = new ClusterManager("./src/bot.js", {
  token: TOKEN,
  totalShards: "auto",
  totalClusters: "auto",
  mode: "process",
});

manager.extend(new ReClusterManager());
manager.on("clusterDestroy", (cluster) => logInfo(`Destroyed shard ${cluster.id}`));
manager.spawn();
