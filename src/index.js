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
//   Auto-injects context summary on the first tool call per session so agents
//   receive project knowledge without needing to explicitly request it.

import { randomBytes } from "crypto";
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
import { umaTools } from "./tools/uma-tools.js";
import { contextTools } from "./tools/context-tools.js";
import { instanceTools } from "./tools/instance-tools.js";
import {
  createAdvertisedToolRegistry,
  fetchFirstClassPluginTools,
  refreshPluginToolsMetadata,
  sanitizeToolMetadata,
  splitToolTiers,
} from "./tool-tiers.js";
import { getProjectContext, getReloadReconnectBudgetMs } from "./unity-editor-bridge.js";
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

// ─── Response size protection ───
// Prevents "Write EOF" errors when tool responses exceed stdio transport limits.
// Large Unity projects (79K+ objects) can generate multi-MB responses that crash the pipe.
function truncateResponseIfNeeded(contentBlocks) {
  // Estimate total size across all text blocks
  let totalSize = 0;
  for (const block of contentBlocks) {
    if (block.type === "text") {
      totalSize += (block.text || "").length;
    } else if (block.type === "image") {
      totalSize += (block.data || "").length;
    }
  }

  const softLimit = CONFIG.responseSoftLimitBytes;
  const hardLimit = CONFIG.responseHardLimitBytes;

  if (totalSize > hardLimit) {
    const sizeMB = (totalSize / (1024 * 1024)).toFixed(1);
    const limitMB = (hardLimit / (1024 * 1024)).toFixed(1);
    console.error(`[MCP] Response truncated: ${sizeMB}MB exceeds hard limit of ${limitMB}MB`);
    return [
      {
        type: "text",
        text:
          `⚠️ Response too large (${sizeMB} MB, limit: ${limitMB} MB) — truncated to prevent Write EOF error.\n\n` +
          `The requested data was too large to return in a single response. ` +
          `Use pagination parameters to request smaller chunks:\n` +
          `• unity_scene_hierarchy: use maxNodes, parentPath, or component filters\n` +
          `• unity_search_by_name/component/tag/layer: use limit parameter\n` +
          `• unity_asset_list: use maxResults parameter\n` +
          `• unity_console_log: use count parameter\n\n` +
          `Tip: For very large scenes, start with unity_scene_stats to get an overview, ` +
          `then use targeted searches (unity_search_by_name, unity_search_by_tag) instead of loading the full hierarchy.`,
      },
    ];
  }

  if (totalSize > softLimit) {
    const sizeMB = (totalSize / (1024 * 1024)).toFixed(1);
    console.error(`[MCP] Large response warning: ${sizeMB}MB exceeds soft limit`);
    // Still return the data but add a warning
    contentBlocks.push({
      type: "text",
      text: `\n⚠️ Large response (${sizeMB} MB). Consider using pagination parameters for better performance.`,
    });
  }

  return contentBlocks;
}

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
  splitToolTiers([...editorTools, ...umaTools]);
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

// Context auto-inject: each agent gets project context on their first tool call.
const _contextInjectedPerAgent = new Map(); // agentId → boolean
let _contextCache = null; // Shared cache (same project context for all agents)

// Instance auto-discovery: each agent discovers instances on their first tool call.
const _discoveryDonePerAgent = new Map(); // agentId → boolean
const _discoverySingleFlight = new AsyncSingleFlight();

async function getContextSummaryOnce() {
  const agentId = getRequestAgentId();
  if (_contextInjectedPerAgent.get(agentId)) return null;
  _contextInjectedPerAgent.set(agentId, true);

  try {
    if (!_contextCache) {
      _contextCache = await getProjectContext();
    }

    // Only inject if context is enabled and has content
    if (
      !_contextCache ||
      !_contextCache.enabled ||
      !_contextCache.categories ||
      _contextCache.categories.length === 0
    ) {
      return null;
    }

    let summary =
      "=== PROJECT CONTEXT (auto-provided by AB Unity MCP) ===\n\n";
    for (const entry of _contextCache.categories) {
      summary += `--- ${entry.category} ---\n`;
      // Truncate very long files for auto-inject
      let content = entry.content || "";
      if (content.length > 2000) {
        content =
          content.substring(0, 2000) +
          "\n... [truncated — use unity_get_project_context for full content]";
      }
      summary += content + "\n\n";
    }
    summary += "=== END PROJECT CONTEXT ===";
    return summary;
  } catch {
    // Context fetch failed (Unity not connected yet, etc.) — silently skip
    return null;
  }
}

/**
 * Perform instance discovery on first tool call.
 * Returns a prompt string if user needs to select an instance, or null.
 */
async function ensureInstanceDiscovery() {
  const agentId = getRequestAgentId();
  return _discoverySingleFlight.run(agentId, () => performInstanceDiscovery(agentId));
}

function isStructuredToolFailure(result) {
  if (Array.isArray(result)) {
    return result.some((block) =>
      block?.type === "text" && isStructuredToolFailure(block.text));
  }

  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }

  return Boolean(value && typeof value === "object" && value.success === false);
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
    } else if (getSelectedInstance() === null) {
      // Validation cleared the selection (project no longer running).
      // Re-run discovery on next call.
      debugLog(`Persisted selection invalidated — project no longer found. Will re-discover.`);
      _discoveryDonePerAgent.set(agentId, false);
    }
    return null;
  }

  _discoveryDonePerAgent.set(agentId, true);

  try {
    const result = await autoSelectInstance();

    if (result.autoSelected) {
      // Single instance found and auto-selected
      const inst = result.instance;
      const cloneInfo = inst.isClone ? ` (ParrelSync clone #${inst.cloneIndex})` : "";
      return (
        `=== UNITY INSTANCE (auto-connected) ===\n` +
        `Project: ${inst.projectName}${cloneInfo}\n` +
        `Port: ${inst.port}\n` +
        `Unity: ${inst.unityVersion || "unknown"}\n` +
        `Path: ${inst.projectPath || "unknown"}\n` +
        `=== END INSTANCE INFO ===`
      );
    }

    if (result.instances.length === 0) {
      return (
        `=== UNITY MCP WARNING ===\n` +
        `No Unity Editor instances were detected.\n` +
        `Make sure Unity is running with the MCP plugin enabled.\n` +
        `You can still use Unity Hub tools (unity_hub_*).\n` +
        `=== END WARNING ===`
      );
    }

    // Multiple instances found — check if one is already selected
    const alreadySelected = getSelectedInstance();
    if (alreadySelected) {
      // User already selected an instance before discovery ran — just confirm
      const cloneInfo = alreadySelected.isClone ? ` (ParrelSync clone #${alreadySelected.cloneIndex})` : "";
      return (
        `=== UNITY INSTANCE (user-selected) ===\n` +
        `Project: ${alreadySelected.projectName}${cloneInfo}\n` +
        `Port: ${alreadySelected.port}\n` +
        `Unity: ${alreadySelected.unityVersion || "unknown"}\n` +
        `Path: ${alreadySelected.projectPath || "unknown"}\n` +
        `(${result.instances.length} instances available — use unity_select_instance to switch)\n` +
        `=== END INSTANCE INFO ===`
      );
    }

    // No instance selected yet — prompt user to select
    let prompt =
      `=== MULTIPLE UNITY INSTANCES DETECTED ===\n` +
      `Found ${result.instances.length} running Unity Editor instances.\n` +
      `You MUST ask the user which instance to work with before proceeding.\n\n` +
      `Available instances:\n`;

    for (const inst of result.instances) {
      const cloneInfo = inst.isClone ? ` [ParrelSync clone #${inst.cloneIndex}]` : "";
      prompt += `  • Port ${inst.port}: ${inst.projectName}${cloneInfo} (Unity ${inst.unityVersion || "?"})\n`;
      if (inst.projectPath) {
        prompt += `    Path: ${inst.projectPath}\n`;
      }
    }

    prompt +=
      `\nCall unity_select_instance with the port number once the user has chosen.\n` +
      `=== END INSTANCE SELECTION REQUIRED ===`;

    return prompt;
  } catch (err) {
    _discoveryDonePerAgent.set(agentId, false);
    console.error(`[MCP] Instance discovery failed: ${err.message}`);
    return null;
  }
}

// ─── Create MCP Server ───
const server = new Server(
  {
    name: "unity-mcp",
    version: "3.3.2",
  },
  {
    capabilities: {
      tools: { listChanged: true },
      resources: {},
    },
  }
);

// ─── List Tools Handler ───
function toolWithEditorBindingSchema({ name, description, inputSchema, annotations }) {
  const schema = injectEditorBindingSchema(name, inputSchema);
  const tool = {
    name,
    description: sanitizeToolMetadata(description),
    inputSchema: sanitizeToolMetadata(schema),
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
  const projectTools = await fetchFirstClassPluginTools();
  // Keep every tool already advertised during this MCP process callable. A
  // live metadata refresh can temporarily switch to another Unity instance
  // whose project catalog does not contain the same project-defined tools.
  // New live metadata still replaces a same-named route/schema.
  advertisedTools.remember(projectTools);
  return advertisedTools.values();
}

async function findExposedTool(name) {
  const projectTools = await fetchFirstClassPluginTools();
  advertisedTools.remember(projectTools);
  return advertisedTools.get(name);
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = await getExposedTools();
  return {
    tools: tools.map(toolWithEditorBindingSchema),
  };
});

// ─── Call Tool Handler ───
const reloadSafeCommandByToolName = {
  unity_asset_refresh: "asset/refresh",
  unity_asset_get_refresh_job: "asset/get-refresh-job",
  unity_wait_editor_idle: "wait/editor-idle",
  unity_uitoolkit_wait_refresh: "uitoolkit/wait-refresh",
  unity_testing_list_tests: "testing/list-tests",
  unity_testing_get_job: "testing/get-job",
  unity_testing_get_package_job: "testing/get-package-job",
};

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const meta = request.params._meta || {};
  const agentId = meta.agentId || meta.agent_id || PROCESS_AGENT_ID;
  let portOverride = (args && typeof args.port === "number" && args.port)
    || (typeof meta.port === "number" && meta.port)
    || null;
  const expectedProjectPath = typeof args?.expectedProjectPath === "string"
    ? args.expectedProjectPath.trim()
    : "";
  const expectedProjectName = typeof args?.expectedProjectName === "string"
    ? args.expectedProjectName.trim()
    : "";

  let targetInstance = portOverride
    ? await resolveInstanceContextForPort(portOverride)
    : null;
  if (!portOverride && expectedProjectPath) {
    const reloadSafeCommand = reloadSafeCommandByToolName[name];
    const projectResolveTimeoutMs = Math.max(
      CONFIG.projectResolveTimeoutMs,
      reloadSafeCommand ? getReloadReconnectBudgetMs(reloadSafeCommand, args || {}) : 0
    );
    targetInstance = await resolveInstanceContextForProjectPath(expectedProjectPath, {
      timeoutMs: projectResolveTimeoutMs,
      pollIntervalMs: CONFIG.projectResolvePollIntervalMs,
    });
    portOverride = targetInstance?.port || null;
    if (!targetInstance) {
      const message =
        `No running Unity Editor instance could be resolved for expectedProjectPath ` +
        `'${expectedProjectPath}' within ${projectResolveTimeoutMs}ms.`;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            errorCode: "target_project_unavailable",
            retryable: true,
            error: message,
            message,
            expectedProjectPath,
            expectedProjectName,
            resolveTimeoutMs: projectResolveTimeoutMs,
          }),
        }],
        isError: true,
      };
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
  }, async () => {
    let tool = null;
    try {
      if (portOverride) {
        debugLog(`Port override active: ${portOverride} for tool ${name}`);
      }

      let instancePrompt = null;
      if (!portOverride && !expectedProjectPath &&
          name !== "unity_list_instances" && name !== "unity_select_instance") {
        instancePrompt = await ensureInstanceDiscovery();
      }

      const selectionRequired = !portOverride && isInstanceSelectionRequired();
      const selectedInstance = getSelectedInstance();
      debugLog(`Tool=${name}, agent=${agentId}, portOverride=${portOverride || 'null'}, selectionRequired=${selectionRequired}, selectedPort=${selectedInstance?.port || 'null'}, instancePrompt=${instancePrompt ? 'SET' : 'null'}, discoveryDone=${_discoveryDonePerAgent.get(agentId) || false}`);
      if (
        selectionRequired &&
        !name.startsWith("unity_hub_") &&
        name !== "unity_list_instances" &&
        name !== "unity_select_instance" &&
        name !== "unity_get_project_context"
      ) {
        return {
          content: [
            {
              type: "text",
              text:
                instancePrompt ||
                "Multiple Unity instances are running. You must call unity_list_instances and then unity_select_instance before using other Unity tools.",
            },
          ],
          isError: true,
        };
      }

      tool = await findExposedTool(name);
      if (!tool) {
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }

      const handlerArgs = args ? { ...args } : {};
      if (handlerArgs.port !== undefined && name !== "unity_select_instance") {
        delete handlerArgs.port;
      }

      const result = await tool.handler(handlerArgs);
      const contentBlocks = [];
      if (instancePrompt) {
        contentBlocks.push({ type: "text", text: instancePrompt });
      }

      const contextSummary = await getContextSummaryOnce();
      if (contextSummary) {
        contentBlocks.push({ type: "text", text: contextSummary });
      }

      if (Array.isArray(result)) {
        contentBlocks.push(...result);
      } else {
        contentBlocks.push({ type: "text", text: result });
      }

      return {
        content: truncateResponseIfNeeded(contentBlocks),
        ...(isStructuredToolFailure(result) ? { isError: true } : {}),
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error executing ${name}: ${error.message}`,
          },
        ],
        isError: true,
      };
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
  debugLog(`=== SERVER START === v3.3.2, agent=${PROCESS_AGENT_ID}, discoveryDone=${_discoveryDonePerAgent.get(PROCESS_AGENT_ID) || false}, selectedPort=${getSelectedInstance()?.port || 'null'}`);
  console.error(
    `Unity MCP Server running on stdio (agent: ${PROCESS_AGENT_ID})`
  );
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
