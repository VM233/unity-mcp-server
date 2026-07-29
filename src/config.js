// AnkleBreaker Unity MCP — Configuration
// Adjust these paths to match your Unity installation

import { homedir } from "os";
import { join } from "path";

// Determine the instance registry path based on platform
function getRegistryPath() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(localAppData, "UnityMCP", "instances.json");
  }
  // macOS / Linux
  return join(homedir(), ".local", "share", "UnityMCP", "instances.json");
}

export function readIntegerSetting(value, fallback, {
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
} = {}) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function normalizeLogLevel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["silent", "error", "warn", "info", "debug"].includes(normalized)
    ? normalized
    : "info";
}

const editorBridgePort = readIntegerSetting(
  process.env.UNITY_BRIDGE_PORT,
  7890,
  { minimum: 1, maximum: 65535 }
);
const portRangeStart = readIntegerSetting(
  process.env.UNITY_PORT_RANGE_START,
  7890,
  { minimum: 1, maximum: 65535 }
);
const portRangeEnd = Math.max(
  portRangeStart,
  readIntegerSetting(
    process.env.UNITY_PORT_RANGE_END,
    7899,
    { minimum: 1, maximum: 65535 }
  )
);
const responseSoftLimitBytes = readIntegerSetting(
  process.env.UNITY_RESPONSE_SOFT_LIMIT,
  512 * 1024,
  { minimum: 16 * 1024 }
);
const responseHardLimitBytes = Math.max(
  responseSoftLimitBytes,
  readIntegerSetting(
    process.env.UNITY_RESPONSE_HARD_LIMIT,
    2 * 1024 * 1024,
    { minimum: 16 * 1024 }
  )
);

export const CONFIG = {
  // Unity Hub
  unityHubPath: process.env.UNITY_HUB_PATH || "C:\\Program Files\\Unity Hub\\Unity Hub.exe",

  // Unity Editor Bridge (default — used as fallback when no instance is selected)
  editorBridgeHost: process.env.UNITY_BRIDGE_HOST || "127.0.0.1",
  editorBridgePort,
  editorBridgeTimeout: readIntegerSetting(
    process.env.UNITY_BRIDGE_TIMEOUT,
    60000,
    { minimum: 1000 }
  ),

  // Multi-instance support
  portRangeStart,
  portRangeEnd,
  instanceRegistryPath: process.env.UNITY_INSTANCE_REGISTRY || getRegistryPath(),
  projectResolveTimeoutMs: readIntegerSetting(
    process.env.UNITY_PROJECT_RESOLVE_TIMEOUT,
    15000,
    { minimum: 0 }
  ),
  projectResolvePollIntervalMs: readIntegerSetting(
    process.env.UNITY_PROJECT_RESOLVE_POLL_INTERVAL,
    250,
    { minimum: 10 }
  ),

  // Queue mode polling (for async ticket-based requests)
  queuePollIntervalMs: readIntegerSetting(
    process.env.UNITY_QUEUE_POLL_INTERVAL,
    150,
    { minimum: 10 }
  ),
  queuePollMaxMs: readIntegerSetting(
    process.env.UNITY_QUEUE_POLL_MAX,
    1500,
    { minimum: 10 }
  ),
  queuePollTimeoutMs: readIntegerSetting(
    process.env.UNITY_QUEUE_POLL_TIMEOUT,
    120000,
    { minimum: 1000 }
  ),
  queueReloadRecoveryTimeoutMs: readIntegerSetting(
    process.env.UNITY_QUEUE_RELOAD_RECOVERY_TIMEOUT,
    120000,
    { minimum: 0 }
  ),

  // Default Unity Editor path pattern (version will be interpolated)
  editorPathPattern: process.env.UNITY_EDITOR_PATH || "C:\\Program Files\\Unity\\Hub\\Editor\\{version}\\Editor\\Unity.exe",

  // Registry staleness timeout (ms) — if a registry entry's lastSeen timestamp is older
  // than this AND the port is unresponsive, the entry is considered stale (Unity likely crashed).
  // The plugin sends a heartbeat every 30s, so 5 minutes gives plenty of margin.
  registryStalenessTimeoutMs: readIntegerSetting(
    process.env.UNITY_REGISTRY_STALENESS_TIMEOUT,
    300000,
    { minimum: 1000 }
  ),

  // Response size limits (bytes) — protects against Write EOF errors on large projects
  // Soft limit: log a warning but still return the response
  responseSoftLimitBytes,
  // Hard limit: truncate the response and return pagination guidance instead
  responseHardLimitBytes,

  // Logging
  logLevel: normalizeLogLevel(process.env.LOG_LEVEL),
};
