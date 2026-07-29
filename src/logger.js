import { CONFIG } from "./config.js";

const LEVEL_PRIORITY = {
  silent: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function shouldLog(level) {
  return LEVEL_PRIORITY[CONFIG.logLevel] >= LEVEL_PRIORITY[level];
}

function write(level, message) {
  if (!shouldLog(level)) return;
  console.error(message);
}

export const logError = (message) => write("error", message);
export const logWarn = (message) => write("warn", message);
export const logInfo = (message) => write("info", message);
export const logDebug = (message) => write("debug", message);
