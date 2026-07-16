// Unity MCP — Multi-Instance Discovery
// Discovers running Unity Editor instances via:
//   1. Shared registry file (%LOCALAPPDATA%/UnityMCP/instances.json)
//   2. Port scanning fallback (7890-7899)
//
// Also manages instance selection state for the current MCP session.

import { readFileSync } from "fs";
import { CONFIG } from "./config.js";
import { debugLog } from "./state-persistence.js";
import {
  getRequestAgentId,
  getRequestPortOverride,
  getRequestTargetInstance,
} from "./request-context.js";

// ─── Per-Agent Session State ───
// Tracks which Unity instance each agent is targeting.
// State is stored in Maps keyed by agent ID because a SINGLE MCP process serves
// ALL agents/tasks in the same Claude Desktop session. Without per-agent state,
// Agent A selecting ProjectA would cause Agent B's commands to also route to
// ProjectA — the classic "cross-agent contamination" bug.
//
// Request-local AsyncLocalStorage selects the correct Map entry even when MCP
// clients execute multiple tool calls concurrently in one server process.
const _agentInstances = new Map();          // agentId → { port, projectName, projectPath, ... }
const _agentSelectionRequired = new Map();  // agentId → boolean

/**
 * Get the currently selected Unity instance for the current agent.
 * @returns {object|null} Selected instance info, or null if none selected.
 */
export function getSelectedInstance() {
  return _agentInstances.get(getRequestAgentId()) || null;
}

/**
 * Validate that the currently selected instance is still alive and hosts the expected project.
 * Called on first tool execution to catch cases where Unity was closed or port changed.
 *
 * Compile-time resilience:
 *   During long Unity compilations the main thread is blocked, so the HTTP bridge
 *   can't respond to pings. We use the instance registry file (written at startup,
 *   persists across compiles) as a secondary signal. If a port is unresponsive but
 *   the registry still claims our project is on that port, we keep the selection —
 *   Unity is likely just compiling. We only clear the selection when we have positive
 *   evidence the project is gone (not in registry AND not responding).
 *
 * @returns {object|null} Validated instance, or null if validation cleared the selection.
 */
export async function validateSelectedInstance() {
  const agentId = getRequestAgentId();
  const currentInstance = _agentInstances.get(agentId);
  if (!currentInstance) {
    return null;
  }

  const saved = currentInstance;
  const savedPath = saved.projectPath;
  const savedPort = saved.port;

  // Ping the saved port and check what project is actually there
  const alive = await pingInstance(savedPort);
  if (alive) {
    const info = await getInstanceInfo(savedPort);
    if (info && info.projectPath &&
        normalizeProjectPath(info.projectPath) === normalizeProjectPath(savedPath)) {
      return currentInstance;
    }

    if (info && info.projectPath) {
      // PORT SWAP DETECTED: a different project is on the saved port
      debugLog(`⚠ Port swap detected! Port ${savedPort} now hosts "${info.projectName}" (expected "${saved.projectName}")`);
      console.error(
        `[MCP Discovery] Port swap detected: port ${savedPort} now hosts "${info.projectName}" instead of "${saved.projectName}". Re-discovering...`
      );
    }
    // Fall through to re-discovery (swap or info unavailable)
  } else {
    // Port not responding — could be compiling, could be shut down.
    // Check the registry file as a secondary signal before assuming the worst.
    const registryEntries = readRegistryFile();
    const registryMatch = registryEntries.find(
      (entry) =>
        entry.port === savedPort &&
        entry.projectPath &&
        normalizeProjectPath(entry.projectPath) === normalizeProjectPath(savedPath)
    );

    if (registryMatch) {
      if (isRegistryEntryStale(registryMatch)) {
        debugLog(
          `Port ${savedPort} unresponsive and registry entry is STALE (lastSeen: ${registryMatch.lastSeen}). Unity likely crashed. Proceeding to re-discovery.`
        );
      } else {
        // Entry is fresh — Unity is very likely just compiling
        debugLog(
          `Port ${savedPort} unresponsive but registry entry is fresh — likely compiling. Keeping selection.`
        );
        return currentInstance;
      }
    }

    debugLog(`Port ${savedPort} unresponsive and not in registry — re-discovering...`);
  }

  // Re-discover all instances and find the one matching our saved projectPath
  const instances = await discoverInstances();
  const match = instances.find(
    (inst) => inst.projectPath &&
      normalizeProjectPath(inst.projectPath) === normalizeProjectPath(savedPath)
  );

  if (match) {
    debugLog(`Re-selected ${saved.projectName} on new port ${match.port} (was ${savedPort})`);
    _agentInstances.set(agentId, match);
    _agentSelectionRequired.set(agentId, false);
    return match;
  }

  // Last resort: check if the registry has our project on ANY port (could be compiling on a new port)
  const registryFallback = readRegistryFile().find(
    (entry) => entry.projectPath &&
      normalizeProjectPath(entry.projectPath) === normalizeProjectPath(savedPath)
  );
  if (registryFallback && registryFallback.port) {
    if (isRegistryEntryStale(registryFallback)) {
      debugLog(
        `Project "${saved.projectName}" found in registry but entry is STALE. Clearing selection.`
      );
    } else {
      debugLog(
        `Project "${saved.projectName}" found in registry on port ${registryFallback.port} (fresh) — likely compiling. Keeping selection.`
      );
      const updated = { ...saved, port: registryFallback.port };
      _agentInstances.set(agentId, updated);
      return updated;
    }
  }

  // Project truly gone — not responding AND not in registry
  debugLog(`Project "${saved.projectName}" no longer found. Clearing selection for agent ${agentId}.`);
  _agentInstances.delete(agentId);
  _agentSelectionRequired.set(agentId, false);
  return null;
}

/**
 * Check whether the session still needs the user to select an instance.
 */
export function isInstanceSelectionRequired() {
  return _agentSelectionRequired.get(getRequestAgentId()) || false;
}

/**
 * Mark that instance selection is required (multiple instances found, none selected).
 */
export function setInstanceSelectionRequired(required) {
  _agentSelectionRequired.set(getRequestAgentId(), required);
}

/**
 * Select a Unity instance by port number.
 * All subsequent bridge commands will be routed to this port.
 * @param {number} port - The port of the instance to select.
 * @returns {object} The selected instance info, or error.
 */
export async function selectInstance(port) {
  const agentId = getRequestAgentId();
  const instances = await discoverInstances();
  const match = instances.find((inst) => inst.port === port);

  if (!match) {
    return {
      success: false,
      error: `No Unity instance found on port ${port}. Use unity_list_instances to see available instances.`,
    };
  }

  // Verify the instance is actually reachable
  const alive = await pingInstance(port);
  if (!alive) {
    return {
      success: false,
      error: `Unity instance on port ${port} (${match.projectName}) is not responding. It may have shut down.`,
    };
  }

  _agentInstances.set(agentId, match);
  _agentSelectionRequired.set(agentId, false);
  debugLog(`selectInstance: agent ${agentId} selected port ${port} (${match.projectName})`);

  return {
    success: true,
    message: `Selected Unity instance: ${match.projectName} (port ${port})`,
    instance: match,
  };
}

/**
 * Get the bridge URL for the currently selected instance.
 * Priority: per-request port override > per-agent selection > default CONFIG port.
 * @returns {string} The base URL for HTTP bridge commands.
 */
export function getActiveBridgeUrl() {
  const host = CONFIG.editorBridgeHost;
  // Per-request override takes highest priority (stateless routing for parallel agents)
  const portOverride = getRequestPortOverride();
  if (portOverride !== null) {
    return `http://${host}:${portOverride}`;
  }
  const selected = _agentInstances.get(getRequestAgentId());
  if (selected) {
    return `http://${host}:${selected.port}`;
  }
  return `http://${host}:${CONFIG.editorBridgePort}`;
}

/**
 * Get the port of the currently selected instance, or the default.
 * Priority: per-request port override > per-agent selection > default CONFIG port.
 */
export function getActivePort() {
  const portOverride = getRequestPortOverride();
  if (portOverride !== null) {
    return portOverride;
  }
  const selected = _agentInstances.get(getRequestAgentId());
  if (selected) {
    return selected.port;
  }
  return CONFIG.editorBridgePort;
}

/** Return the project identity associated with this request's selected bridge port. */
export function getActiveInstanceContext() {
  const port = getActivePort();
  const requestTarget = getRequestTargetInstance();
  if (requestTarget && requestTarget.port === port) {
    return requestTarget;
  }
  const selected = _agentInstances.get(getRequestAgentId());
  if (selected && selected.port === port) {
    return selected;
  }

  return readRegistryFile().find((entry) => entry.port === port) || null;
}

/** Resolve the project identity for an explicit per-request port override. */
export async function resolveInstanceContextForPort(port) {
  const info = await getInstanceInfo(port);
  if (info?.projectPath || info?.projectName) {
    return { port, ...info, source: "live-port" };
  }

  return newestRegistryEntry(readRegistryFile().filter((entry) => entry.port === port));
}

export async function resolveInstanceContextForProjectPath(projectPath, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
  const pollIntervalMs = Math.max(10, Number(options.pollIntervalMs) || 250);
  const startedAt = Date.now();

  while (true) {
    const match = await resolveInstanceContextForProjectPathOnce(projectPath);
    if (match) return match;

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) return null;
    await new Promise((resolveDelay) => setTimeout(
      resolveDelay,
      Math.min(pollIntervalMs, timeoutMs - elapsedMs)
    ));
  }
}

async function resolveInstanceContextForProjectPathOnce(projectPath) {
  const normalizedPath = normalizeProjectPath(projectPath);
  if (!normalizedPath) return null;

  const registryMatch = newestRegistryEntry(readRegistryFile().filter(
    (entry) => normalizeProjectPath(entry.projectPath) === normalizedPath
  ));
  if (registryMatch) {
    const resolvedRegistryMatch = await resolveInstanceContextForPort(registryMatch.port);
    if (normalizeProjectPath(resolvedRegistryMatch?.projectPath) === normalizedPath) {
      return resolvedRegistryMatch;
    }
  }

  const instances = await discoverInstances();
  return instances.find(
    (entry) => normalizeProjectPath(entry.projectPath) === normalizedPath
  ) || null;
}

export function normalizeProjectPath(projectPath) {
  return String(projectPath || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function newestRegistryEntry(entries) {
  if (!entries.length) return null;
  return [...entries].sort((left, right) =>
    registryTimestamp(right) - registryTimestamp(left))[0];
}

function registryTimestamp(entry) {
  const value = Date.parse(entry?.lastSeen || entry?.registeredAt || "");
  return Number.isFinite(value) ? value : 0;
}

/**
 * Discover all running Unity instances.
 * Reads the shared registry file first, then validates each entry is alive.
 * Falls back to port scanning if the registry is empty/missing.
 *
 * @returns {Array<object>} List of discovered instances with their metadata.
 */
export async function discoverInstances() {
  let instances = [];

  // Step 1: Read registry file
  try {
    const registryData = readRegistryFile();
    if (registryData.length > 0) {
      // Validate each entry and replace potentially stale registry identity with
      // the live project identity currently listening on that port.
      const validated = await Promise.all(
        registryData.map(async (entry) => {
          const port = entry.port;
          if (!port) return null;

          const info = await getInstanceInfo(port);
          return info
            ? { ...entry, ...info, port, alive: true, source: "registry+live" }
            : null;
        })
      );

      instances = validated.filter((inst) => inst !== null);
    }
  } catch (err) {
    console.error(`[MCP Discovery] Error reading registry: ${err.message}`);
  }

  // Step 2: Port scan fallback (find instances not in registry)
  const registeredPorts = new Set(instances.map((i) => i.port));

  const scanPromises = [];
  for (let port = CONFIG.portRangeStart; port <= CONFIG.portRangeEnd; port++) {
    if (registeredPorts.has(port)) continue; // Already found via registry

    scanPromises.push(
      (async () => {
        const alive = await pingInstance(port);
        if (alive) {
          // Try to get project info from the instance
          const info = await getInstanceInfo(port);
          return {
            port,
            projectName: info?.projectName || `Unknown (port ${port})`,
            projectPath: info?.projectPath || "",
            unityVersion: info?.unityVersion || "",
            isClone: info?.isClone || false,
            cloneIndex: info?.cloneIndex ?? -1,
            alive: true,
            source: "portscan",
          };
        }
        return null;
      })()
    );
  }

  const scanned = await Promise.all(scanPromises);
  for (const inst of scanned) {
    if (inst) instances.push(inst);
  }

  return instances;
}

/**
 * Auto-select an instance if exactly one is available.
 * If multiple are found, marks selection as required.
 * If none are found, tries the default port.
 * @returns {object} Result with auto-selected instance or selection requirement.
 */
export async function autoSelectInstance() {
  const agentId = getRequestAgentId();
  const instances = await discoverInstances();

  if (instances.length === 0) {
    // No instances found — try default port as last resort
    const defaultAlive = await pingInstance(CONFIG.editorBridgePort);
    if (defaultAlive) {
      const info = await getInstanceInfo(CONFIG.editorBridgePort);
      const defaultInstance = {
        port: CONFIG.editorBridgePort,
        projectName: info?.projectName || "Unity Editor",
        projectPath: info?.projectPath || "",
        unityVersion: info?.unityVersion || "",
        isClone: false,
        cloneIndex: -1,
        alive: true,
        source: "default",
      };
      _agentInstances.set(agentId, defaultInstance);
      _agentSelectionRequired.set(agentId, false);
      debugLog(`autoSelect: agent ${agentId} → single default instance on port ${CONFIG.editorBridgePort}`);
      return {
        autoSelected: true,
        instance: defaultInstance,
        instances: [defaultInstance],
        message: `Auto-connected to Unity Editor: ${defaultInstance.projectName} (port ${CONFIG.editorBridgePort})`,
      };
    }

    _agentSelectionRequired.set(agentId, false);
    return {
      autoSelected: false,
      instances: [],
      message: "No Unity Editor instances found. Make sure Unity is running with the MCP plugin enabled.",
    };
  }

  if (instances.length === 1) {
    // Exactly one instance — auto-select it
    _agentInstances.set(agentId, instances[0]);
    _agentSelectionRequired.set(agentId, false);
    debugLog(`autoSelect: agent ${agentId} → single instance on port ${instances[0].port}`);
    return {
      autoSelected: true,
      instance: instances[0],
      instances,
      message: `Auto-connected to Unity Editor: ${instances[0].projectName} (port ${instances[0].port})`,
    };
  }

  // Multiple instances — require user selection (but only if none already selected for this agent)
  const agentSelected = _agentInstances.get(agentId);
  if (!agentSelected) {
    _agentSelectionRequired.set(agentId, true);
    debugLog(`autoSelect: agent ${agentId} → ${instances.length} instances found, selection required`);
  }
  return {
    autoSelected: false,
    instances,
    message: `Found ${instances.length} Unity Editor instances. Please use unity_select_instance to choose which one to work with.`,
  };
}

// ─── Internal helpers ───

/**
 * Check if a registry entry is stale (Unity likely crashed).
 * The plugin updates `lastSeen` every ~30s via a heartbeat. If the entry's
 * lastSeen timestamp is older than the staleness timeout, Unity likely crashed
 * without calling OnDisable (which would have cleaned up the entry).
 *
 * If the entry has no `lastSeen` field (old plugin version), we fall back to
 * `registeredAt`. If neither is present, we treat it as stale (no way to verify).
 *
 * @param {object} entry - A registry entry object.
 * @returns {boolean} True if the entry is considered stale.
 */
function isRegistryEntryStale(entry) {
  const timestamp = entry.lastSeen || entry.registeredAt;
  if (!timestamp) {
    // No timestamp at all — can't verify freshness, assume stale
    return true;
  }

  try {
    const entryTime = new Date(timestamp).getTime();
    if (isNaN(entryTime)) return true; // Unparseable timestamp

    const ageMs = Date.now() - entryTime;
    const isStale = ageMs > CONFIG.registryStalenessTimeoutMs;

    if (isStale) {
      const ageMinutes = Math.round(ageMs / 60000);
      debugLog(`Registry entry staleness check: age=${ageMinutes}min, threshold=${CONFIG.registryStalenessTimeoutMs / 60000}min → STALE`);
    }

    return isStale;
  } catch {
    return true; // Error parsing — assume stale
  }
}

/**
 * Read the instance registry file.
 * @returns {Array<object>} Parsed instance entries.
 */
function readRegistryFile() {
  try {
    const raw = readFileSync(CONFIG.instanceRegistryPath, "utf-8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    return [];
  } catch {
    // File doesn't exist or can't be parsed — that's fine
    return [];
  }
}

/**
 * Ping a Unity instance at a specific port (fast timeout for discovery).
 * @param {number} port
 * @returns {boolean} True if the instance is alive.
 */
async function pingInstance(port) {
  try {
    const url = `http://${CONFIG.editorBridgeHost}:${port}/api/ping`;
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(1500), // Short timeout for discovery
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get project information from a Unity instance via its ping endpoint.
 * @param {number} port
 * @returns {object|null} Project info, or null if unavailable.
 */
async function getInstanceInfo(port) {
  try {
    const url = `http://${CONFIG.editorBridgeHost}:${port}/api/ping`;
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok) return null;

    const data = await response.json();
    return {
      projectName: data.projectName || data.project || null,
      projectPath: data.projectPath || null,
      unityVersion: data.unityVersion || data.version || null,
      isClone: data.isClone || false,
      cloneIndex: data.cloneIndex ?? -1,
    };
  } catch {
    return null;
  }
}
