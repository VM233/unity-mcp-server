#!/usr/bin/env node

// AnkleBreaker Unity MCP Server — Main entry point
// Provides tools for Unity Hub management and Unity Editor control via MCP protocol
//
// Multi-agent support:
//   Each MCP stdio process gets a unique agent ID (pid-based + random suffix).
//   This lets the Unity plugin's queue system differentiate between agents for
//   fair round-robin scheduling and session tracking.
//
// Multi-instance support:
//   Discovers all running Unity Editor instances (via shared registry + port scanning).
//   On first tool call, auto-selects if only one instance is found.
//   If multiple instances are running, prompts the user to select one.
//
// Project Context:
//   Exposes project-specific documentation via MCP Resources and a dedicated tool.

import { randomBytes } from "crypto";
import { createRequire } from "module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { hubTools } from "./tools/hub-tools.js";
import { contextTools } from "./tools/context-tools.js";
import { instanceTools } from "./tools/instance-tools.js";
import { createHealthTools } from "./tools/health-tools.js";
import { ToolCatalog, hostTool } from "./catalog/tool-catalog.js";
import { UnityToolCatalogSource } from "./catalog/unity-tool-catalog.js";
import { sanitizeToolMetadata } from "./catalog/tool-metadata.js";
import { createToolDiscoveryTools } from "./discovery/tool-discovery.js";
import { AdvertisedToolRegistry } from "./exposure/advertised-tool-registry.js";
import { getProjectContext } from "./unity-editor-bridge.js";
import {
  autoSelectInstance,
  getSelectedInstance,
  isInstanceSelectionRequired,
  resolveInstanceContextForPort,
  resolveInstanceContextForProjectPath,
  validateSelectedInstance,
} from "./instance-discovery.js";
import { debugLog } from "./state-persistence.js";
import { injectEditorBindingSchema } from "./tool-schema.js";
import { CONFIG } from "./config.js";
import {
  getRequestAgentId,
  runWithRequestContext,
  setDefaultRequestAgentId,
} from "./request-context.js";
import { AsyncSingleFlight } from "./async-single-flight.js";
import {
  buildToolResponse,
  createToolError,
  createToolOutputSchema,
  guardToolResponseSize,
} from "./tool-response.js";

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require("../package.json");

const SERVER_INSTRUCTIONS =
  "Use only canonical typed tools. If the exact tool is visible, call it directly. " +
  "Otherwise call unity_tools_search with the task intent, then unity_tools_get for one result; " +
  "after the tool list refresh, invoke that canonical tool. Use unity_tools_list only for browsing. " +
  "Never guess Unity routes or use generic executors. Follow asynchronous work only through " +
  "unity_jobs_get, unity_jobs_cancel, and unity_jobs_cleanup.";

// ─── Per-process agent identity ───
// Each MCP stdio process = one Cowork agent.
// Generate a unique ID so the Unity plugin can track and schedule fairly.
const PROCESS_AGENT_ID = process.env.UNITY_MCP_AGENT_ID ||
  `agent-${process.pid}-${randomBytes(3).toString("hex")}`;
setDefaultRequestAgentId(PROCESS_AGENT_ID);

// ─── Canonical catalog and bounded bootstrap surface ───
const unityCatalogSource = new UnityToolCatalogSource();
const toolCatalog = new ToolCatalog({
  unitySource: unityCatalogSource,
  hostTools: [
    ...instanceTools.map((tool) => hostTool(tool, {
      moduleId: "host.instances",
      category: "instance",
      capability: "instance-binding",
      operationKind: tool.name === "unity_select_instance" ? "select" : "inspect",
      sideEffects: tool.name === "unity_select_instance"
        ? ["changesHostBinding"]
        : [],
    })),
    ...hubTools.map((tool) => hostTool(tool, {
      moduleId: "host.hub",
      category: "hub",
      capability: "unity-hub",
      searchTerms: ["Unity Editor installation", "Unity modules"],
    })),
    ...contextTools.map((tool) => hostTool(tool, {
      moduleId: "host.context",
      category: "context",
      capability: "project-context",
      operationKind: "inspect",
      preconditions: ["projectBound"],
    })),
  ],
});

const healthTools = createHealthTools({
  getCatalog: () => toolCatalog,
  getSelectedInstance,
});

let advertisedTools;
const discoveryTools = createToolDiscoveryTools({
  catalog: toolCatalog,
  refreshCatalog: refreshCatalogForSelectedInstance,
  activateTool: activateCanonicalTool,
});

toolCatalog.addHostTools([
  ...healthTools.map((tool) => hostTool(tool, {
    moduleId: "host.health",
    category: "health",
    capability: "mcp-health",
    operationKind: "inspect",
  })),
  ...discoveryTools.map((tool) => hostTool(tool, {
    moduleId: "host.discovery",
    category: "tools",
    capability: "tool-discovery",
    operationKind: tool.name === "unity_tools_get" ? "inspect" : "search",
  })),
]);

const BOOTSTRAP_TOOLS = [
  ...instanceTools,
  ...hubTools,
  ...healthTools,
  ...discoveryTools,
];
advertisedTools = new AdvertisedToolRegistry(BOOTSTRAP_TOOLS);
console.error(
  `[MCP] Canonical catalog bootstrap: ${BOOTSTRAP_TOOLS.length} exposed tools`
);

async function refreshCatalogForSelectedInstance() {
  if (!getSelectedInstance()) {
    return {
      changed: false,
      revision: toolCatalog.revision,
      toolCount: toolCatalog.values().length,
    };
  }
  return toolCatalog.refreshUnity();
}

async function activateCanonicalTool(tool) {
  let changed = advertisedTools.activate(tool);
  const metadata = tool.catalog || {};
  const requiresJobTools = metadata.tags?.includes("longRunning") ||
    Boolean(metadata.cleanupToolName);
  if (requiresJobTools) {
    for (const name of ["unity_jobs_get", "unity_jobs_cancel", "unity_jobs_cleanup"]) {
      const dependency = toolCatalog.get(name);
      if (dependency) changed = advertisedTools.activate(dependency) || changed;
    }
  }
  if (changed) await server.sendToolListChanged();
  return changed;
}

// ─── Per-Agent Session State ───
// A SINGLE MCP process serves ALL agents/tasks in the same Claude Desktop session.
// Without per-agent state, Agent A's context injection would prevent Agent B from
// getting its own context, and Agent A's instance discovery would be skipped for Agent B.
// We key state by agent ID to prevent cross-agent contamination.

// Instance auto-discovery: each agent discovers instances on their first tool call.
const _discoveryDonePerAgent = new Map(); // agentId → boolean
const _discoverySingleFlight = new AsyncSingleFlight();

/**
 * Perform instance discovery on first tool call.
 * Returns a prompt string if user needs to select an instance, or null.
 */
async function ensureInstanceDiscovery() {
  const agentId = getRequestAgentId();
  return _discoverySingleFlight.run(agentId, () => performInstanceDiscovery(agentId));
}

async function performInstanceDiscovery(agentId) {
  const _instanceDiscoveryDone = _discoveryDonePerAgent.get(agentId) || false;
  debugLog(`ensureInstanceDiscovery: _instanceDiscoveryDone=${_instanceDiscoveryDone}, selectedPort=${getSelectedInstance()?.port || 'null'}, selectionRequired=${isInstanceSelectionRequired()}`);

  if (_instanceDiscoveryDone) {
    // Discovery already done (likely restored from persistence).
    // Validate that the persisted instance selection still points to the correct project.
    // This detects port swaps: e.g. ProjectA was on port 7891 but now ProjectB is there.
    const validated = await validateSelectedInstance();
    if (validated) {
      debugLog(`Persisted selection validated OK: ${validated.projectName} on port ${validated.port}`);
      return {
        status: "selected",
        instance: validated,
      };
    }

    // Validation cleared the selection (project no longer running). Re-discover
    // during this call so callers do not need one guaranteed failing request.
    debugLog(`Persisted selection invalidated - re-discovering now.`);
    _discoveryDonePerAgent.set(agentId, false);
  }

  _discoveryDonePerAgent.set(agentId, true);

  try {
    const result = await autoSelectInstance();

    if (result.autoSelected) {
      return {
        status: "selected",
        instance: result.instance,
      };
    }

    if (result.instances.length === 0) {
      return {
        status: "unavailable",
        instances: [],
      };
    }

    // Multiple instances found — check if one is already selected
    const alreadySelected = getSelectedInstance();
    if (alreadySelected) {
      return {
        status: "selected",
        instance: alreadySelected,
        instances: result.instances,
      };
    }

    return {
      status: "selection_required",
      instances: result.instances,
    };
  } catch (err) {
    _discoveryDonePerAgent.set(agentId, false);
    console.error(`[MCP] Instance discovery failed: ${err.message}`);
    return {
      status: "discovery_failed",
      error: err.message,
    };
  }
}

// ─── Create MCP Server ───
const server = new Server(
  {
    name: "unity-mcp",
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: { listChanged: true },
      resources: {},
    },
    instructions: SERVER_INSTRUCTIONS,
  }
);

// ─── List Tools Handler ───
function toolWithEditorBindingSchema({
  name,
  description,
  inputSchema,
  outputSchema,
  annotations,
}) {
  const schema = injectEditorBindingSchema(name, inputSchema);
  const tool = {
    name,
    description: sanitizeToolMetadata(description),
    inputSchema: sanitizeToolMetadata(schema),
    outputSchema: sanitizeToolMetadata(createToolOutputSchema(outputSchema)),
  };
  const cleanAnnotations = sanitizeToolMetadata(annotations || {});
  delete cleanAnnotations.title;
  for (const key of Object.keys(cleanAnnotations)) {
    if (cleanAnnotations[key] === false) {
      delete cleanAnnotations[key];
    }
  }
  if (Object.keys(cleanAnnotations).length > 0) {
    tool.annotations = cleanAnnotations;
  }
  return tool;
}

function getExposedTools() {
  return advertisedTools.values();
}

function findExposedTool(name) {
  return advertisedTools.get(name);
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = await getExposedTools();
  return {
    tools: tools.map(toolWithEditorBindingSchema),
  };
});

// ─── Call Tool Handler ───
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const meta = request.params._meta || {};
  const agentId = meta.agentId || PROCESS_AGENT_ID;
  let portOverride = (args && typeof args.port === "number" && args.port)
    || (typeof meta.port === "number" && meta.port)
    || null;
  const expectedProjectPath = typeof args?.expectedProjectPath === "string"
    ? args.expectedProjectPath.trim()
    : "";
  const expectedProjectName = typeof args?.expectedProjectName === "string"
    ? args.expectedProjectName.trim()
    : "";
  const allowProjectPathRebind = !portOverride && Boolean(expectedProjectPath);

  let targetInstance = portOverride
    ? await resolveInstanceContextForPort(portOverride)
    : null;
  if (!portOverride && expectedProjectPath) {
    const projectResolveTimeoutMs = CONFIG.projectResolveTimeoutMs;
    targetInstance = await resolveInstanceContextForProjectPath(expectedProjectPath, {
      timeoutMs: projectResolveTimeoutMs,
      pollIntervalMs: CONFIG.projectResolvePollIntervalMs,
    });
    portOverride = targetInstance?.port || null;
    if (!targetInstance) {
      const message =
        `No running Unity Editor instance could be resolved for expectedProjectPath ` +
        `'${expectedProjectPath}' within ${projectResolveTimeoutMs}ms.`;
      return buildToolResponse(createToolError(
        "target_project_unavailable",
        message,
        {
          retryable: true,
          expectedProjectPath,
          ...(expectedProjectName ? { expectedProjectName } : {}),
          resolveTimeoutMs: projectResolveTimeoutMs,
        }
      ));
    }
  }
  if (portOverride && expectedProjectPath && !targetInstance) {
    targetInstance = {
      port: portOverride,
      projectPath: expectedProjectPath,
      projectName: expectedProjectName,
      source: "explicit-binding-fallback",
    };
  }

  return runWithRequestContext({
    agentId,
    portOverride,
    targetInstance,
    expectedProjectPath,
    expectedProjectName,
    allowProjectPathRebind,
  }, async () => {
    let tool = null;
    try {
      if (portOverride) {
        debugLog(`Port override active: ${portOverride} for tool ${name}`);
      }

      let discoveryResult = null;
      if (!portOverride && !expectedProjectPath &&
          name !== "unity_list_instances" && name !== "unity_select_instance") {
        discoveryResult = await ensureInstanceDiscovery();
      }

      const selectionRequired = !portOverride && isInstanceSelectionRequired();
      const selectedInstance = getSelectedInstance();
      debugLog(`Tool=${name}, agent=${agentId}, portOverride=${portOverride || 'null'}, selectionRequired=${selectionRequired}, selectedPort=${selectedInstance?.port || 'null'}, discoveryStatus=${discoveryResult?.status || 'none'}, discoveryDone=${_discoveryDonePerAgent.get(agentId) || false}`);
      if (
        selectionRequired &&
        !name.startsWith("unity_hub_") &&
        name !== "unity_list_instances" &&
        name !== "unity_select_instance" &&
        name !== "unity_mcp_health" &&
        name !== "unity_get_project_context"
      ) {
        return buildToolResponse(createToolError(
          "unity_instance_selection_required",
          "Multiple Unity Editor instances are running. Select one before calling Editor tools.",
          {
            availableInstances: discoveryResult?.instances || [],
            nextTool: "unity_select_instance",
          }
        ));
      }

      if (
        !portOverride &&
        !selectedInstance &&
        discoveryResult?.status === "unavailable" &&
        !name.startsWith("unity_hub_") &&
        name !== "unity_list_instances" &&
        name !== "unity_select_instance" &&
        name !== "unity_mcp_health" &&
        name !== "unity_get_project_context"
      ) {
        return buildToolResponse(createToolError(
          "unity_instance_unavailable",
          "No running Unity Editor instance was detected.",
          { nextTool: "unity_list_instances" }
        ));
      }

      tool = findExposedTool(name);
      if (!tool) {
        return buildToolResponse(createToolError(
          "unknown_tool",
          `Unknown tool: ${name}`,
          { tool: name, nextTool: "unity_tools_get" }
        ));
      }

      const handlerArgs = args ? { ...args } : {};
      if (handlerArgs.port !== undefined && name !== "unity_select_instance") {
        delete handlerArgs.port;
      }

      const result = await tool.handler(handlerArgs);
      if (name === "unity_select_instance" && getSelectedInstance()) {
        const catalogRefresh = await refreshCatalogForSelectedInstance();
        if (catalogRefresh.changed && advertisedTools.reconcile(toolCatalog)) {
          await server.sendToolListChanged();
        }
      }
      const sizeGuard = guardToolResponseSize(buildToolResponse(result), {
        softLimitBytes: CONFIG.responseSoftLimitBytes,
        hardLimitBytes: CONFIG.responseHardLimitBytes,
      });
      if (sizeGuard.exceedsSoftLimit) {
        const sizeMB = (sizeGuard.totalBytes / (1024 * 1024)).toFixed(1);
        console.error(
          `[MCP] Large tool response from ${name}: ${sizeMB}MB` +
          (sizeGuard.exceedsHardLimit ? " (replaced with structured error)" : "")
        );
      }

      return sizeGuard.response;
    } catch (error) {
      return buildToolResponse(createToolError(
        "tool_execution_failed",
        `Error executing ${name}: ${error.message}`,
        { tool: name }
      ));
    }
  });
});

// ─── MCP Resources: Expose project context files ───

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    const contextData = await getProjectContext();

    if (
      !contextData ||
      !contextData.enabled ||
      !contextData.categories
    ) {
      return { resources: [] };
    }

    return {
      resources: contextData.categories.map((entry) => ({
        uri: `unity-context://${encodeURIComponent(entry.category)}`,
        name: `Project Context: ${entry.category}`,
        description: `Project-specific documentation for ${entry.category}`,
        mimeType: "text/markdown",
      })),
    };
  } catch {
    return { resources: [] };
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const match = uri.match(/^unity-context:\/\/(.+)$/);

  if (!match) {
    throw new Error(`Unknown resource URI: ${uri}`);
  }

  const category = decodeURIComponent(match[1]);
  const contextData = await getProjectContext(category);

  if (contextData.error) {
    throw new Error(contextData.error);
  }

  return {
    contents: [
      {
        uri,
        mimeType: "text/markdown",
        text: contextData.content || "",
      },
    ],
  };
});

// ─── Start Server ───
function startPluginToolMetadataRefresh() {
  let stopped = false;
  let timer = null;
  const refresh = async () => {
    if (stopped) return;
    try {
      const result = await refreshCatalogForSelectedInstance();
      const exposedChanged = result.changed && advertisedTools.reconcile(toolCatalog);
      if (exposedChanged) {
        console.error("[MCP] Canonical Unity tool catalog changed; notifying MCP clients");
        await server.sendToolListChanged();
      }
    } catch (error) {
      console.error(`[MCP] Plugin tool metadata refresh failed: ${error.message}`);
    } finally {
      if (!stopped) {
        timer = setTimeout(refresh, 15000);
        timer.unref();
      }
    }
  };

  timer = setTimeout(refresh, 1000);
  timer.unref();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

let stopPluginToolMetadataRefresh = () => {};
let shuttingDown = false;

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  stopPluginToolMetadataRefresh = startPluginToolMetadataRefresh();
  debugLog(`=== SERVER START === v${SERVER_VERSION}, agent=${PROCESS_AGENT_ID}, discoveryDone=${_discoveryDonePerAgent.get(PROCESS_AGENT_ID) || false}, selectedPort=${getSelectedInstance()?.port || 'null'}`);
  console.error(
    `Unity MCP Server running on stdio (agent: ${PROCESS_AGENT_ID})`
  );
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopPluginToolMetadataRefresh();
  await server.close().catch(() => {});
}

process.on("message", (message) => {
  if (message?.type !== "unity-mcp:shutdown") return;
  void shutdown().finally(() => process.exit(0));
});

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
