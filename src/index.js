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
import { editorTools } from "./tools/editor-tools.js";
import { contextTools } from "./tools/context-tools.js";
import { instanceTools } from "./tools/instance-tools.js";
import {
  createAdvertisedToolRegistry,
  fetchFirstClassPluginTools,
  refreshPluginToolsMetadata,
  sanitizeToolMetadata,
  splitToolTiers,
} from "./tool-tiers.js";
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

// ─── Per-process agent identity ───
// Each MCP stdio process = one Cowork agent.
// Generate a unique ID so the Unity plugin can track and schedule fairly.
const PROCESS_AGENT_ID = `agent-${process.pid}-${randomBytes(3).toString("hex")}`;
setDefaultRequestAgentId(PROCESS_AGENT_ID);

// ─── Combine all tools (two-tier system) ───
// Split editor tools into core (always exposed) and advanced (on-demand via meta-tool).
// This keeps the tool count under ~70, preventing MCP client rejection caused by
// oversized tool lists (268 tools / 125KB was ~5x beyond what clients handle).
const { coreTools, metaTools, advancedCount, coreCount } =
  splitToolTiers(editorTools);
const ALL_TOOLS = [
  ...instanceTools,
  ...hubTools,
  ...coreTools,
  ...metaTools,
  ...contextTools,
];
const advertisedTools = createAdvertisedToolRegistry(ALL_TOOLS);
console.error(
  `[MCP] Tool tiers: ${coreCount} core + ${advancedCount} advanced (via unity_advanced_tool) = ${coreCount + advancedCount} total, ${ALL_TOOLS.length} exposed`
);

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

async function getExposedTools() {
  const pluginTools = await fetchFirstClassPluginTools();
  // Keep release-managed tools already advertised during this MCP process
  // callable through transient Editor reloads. Live metadata replaces the
  // schema and handler for a same-named route.
  advertisedTools.remember(pluginTools);
  return advertisedTools.values();
}

async function findExposedTool(name) {
  const pluginTools = await fetchFirstClassPluginTools();
  advertisedTools.remember(pluginTools);
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
        name !== "unity_get_project_context"
      ) {
        return buildToolResponse(createToolError(
          "unity_instance_unavailable",
          "No running Unity Editor instance was detected.",
          { nextTool: "unity_list_instances" }
        ));
      }

      tool = await findExposedTool(name);
      if (!tool) {
        return buildToolResponse(createToolError(
          "unknown_tool",
          `Unknown tool: ${name}`,
          { tool: name }
        ));
      }

      const handlerArgs = args ? { ...args } : {};
      if (handlerArgs.port !== undefined && name !== "unity_select_instance") {
        delete handlerArgs.port;
      }

      const result = await tool.handler(handlerArgs);
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
  const refresh = async () => {
    try {
      const result = await refreshPluginToolsMetadata();
      if (result.changed) {
        console.error("[MCP] Unity plugin tool metadata changed; notifying MCP clients");
        await server.sendToolListChanged();
      }
    } catch (error) {
      console.error(`[MCP] Plugin tool metadata refresh failed: ${error.message}`);
    } finally {
      const timer = setTimeout(refresh, 15000);
      timer.unref();
    }
  };

  const timer = setTimeout(refresh, 1000);
  timer.unref();
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  startPluginToolMetadataRefresh();
  debugLog(`=== SERVER START === v${SERVER_VERSION}, agent=${PROCESS_AGENT_ID}, discoveryDone=${_discoveryDonePerAgent.get(PROCESS_AGENT_ID) || false}, selectedPort=${getSelectedInstance()?.port || 'null'}`);
  console.error(
    `Unity MCP Server running on stdio (agent: ${PROCESS_AGENT_ID})`
  );
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
