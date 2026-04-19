const { patchConsole, logInfo, logError } = require("./structures/logger");
patchConsole();

logInfo("Starting bot worker...");

(async () => {
  try {
    await new (require("./structures/Client"))().build();
  } catch (err) {
    logError(`Bot worker failed to start: ${err.message}`);
    process.exit(1);
  }
})();
