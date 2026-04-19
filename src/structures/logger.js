const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const originalConsole = {
  log: console.log.bind(console),
  info: (console.info || console.log).bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: (console.debug || console.log).bind(console),
};

let patched = false;

function timestamp() {
  return new Date().toISOString();
}

function style(color, value) {
  return `${color}${value}${colors.reset}`;
}

function format(level, color, message) {
  return `${colors.gray}${timestamp()}${colors.reset} ${style(color, `[${level}]`)} ${message}`;
}

function normalizeArgs(args) {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return `${arg.message}\n${arg.stack || ""}`.trim();
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

function write(method, level, color, args) {
  originalConsole[method](format(level, color, normalizeArgs(args)));
}

function patchConsole() {
  if (patched) return;
  patched = true;

  console.log = (...args) => write("log", "INFO", colors.cyan, args);
  console.info = (...args) => write("info", "INFO", colors.cyan, args);
  console.warn = (...args) => write("warn", "WARN", colors.yellow, args);
  console.error = (...args) => write("error", "ERROR", colors.red, args);
  console.debug = (...args) => write("debug", "DEBUG", colors.magenta, args);
}

function logAction(action, details = "") {
  const suffix = details ? ` ${details}` : "";
  originalConsole.log(format("ACTION", colors.green, `${action}${suffix}`));
}

function logSuccess(message) {
  originalConsole.log(format("OK", colors.green, message));
}

function logInfo(message) {
  originalConsole.log(format("INFO", colors.cyan, message));
}

function logWarn(message) {
  originalConsole.warn(format("WARN", colors.yellow, message));
}

function logError(message) {
  originalConsole.error(format("ERROR", colors.red, message));
}

module.exports = {
  colors,
  patchConsole,
  logAction,
  logSuccess,
  logInfo,
  logWarn,
  logError,
};
