// AnkleBreaker Unity MCP - two-tier tool system
// Reduces the exposed tool count to avoid overwhelming MCP clients.
//
// Core tools: Always exposed as a deliberately small set of individual MCP tools.
// Advanced tools: Discoverable fallback access through unity_advanced_tool.
//
// Why: MCP clients like Claude Cowork silently fail when a server
// exposes too many tools. The generated manifest and catalog tests keep the
// default surface bounded while preserving lazy access to every route.
//
// Lazy loading: Advanced tools support dynamic dispatch. If a tool
// isn't in the cached map, callers can pass a raw Unity route directly
// or rely on route derivation
// (unity_terrain_list -> terrain/list). This means new C# plugin routes
// and project-defined tools can run before MCP client metadata refreshes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { CONFIG } from "./config.js";
import {
  cancelTicket,
  getQueueInfo,
  getTicketStatus,
  sendCommand,
} from "./unity-editor-bridge.js";
import { staticFirstClassPluginTools } from "./tools/plugin-first-class-tools.js";
import { STATIC_FIRST_CLASS_PLUGIN_ROUTES } from "./plugin-tool-policy.js";
import { logDebug } from "./logger.js";
import { createToolError } from "./tool-response.js";
import { auditSchema } from "./tool-schema-audit.js";

const PLUGIN_TOOLS_CACHE_SCHEMA_VERSION = 5;
const PLUGIN_TOOLS_CACHE_FILE = join(
  dirname(CONFIG.instanceRegistryPath),
  "plugin-tools-metadata-cache-v5.json"
);
const PLUGIN_TOOLS_LIVE_REFRESH_INTERVAL_MS = 10_000;
const STATIC_FIRST_CLASS_PLUGIN_ROUTE_SET =
  new Set(STATIC_FIRST_CLASS_PLUGIN_ROUTES);

let livePluginToolsCache = null;
let livePluginToolsFetchedAt = 0;

export function createAdvertisedToolRegistry(initialTools = []) {
  const toolsByName = new Map();

  const remember = (tools = []) => {
    for (const tool of tools) {
      if (tool && typeof tool.name === "string" && tool.name.length > 0) {
        toolsByName.set(tool.name, tool);
      }
    }
  };

  remember(initialTools);

  return {
    remember,
    get(name) {
      return toolsByName.get(name) || null;
    },
    values() {
      return [...toolsByName.values()];
    },
  };
}

/**
 * Explicit route overrides for tools whose API endpoints
 * don't follow the standard name -> route derivation pattern.
 * E.g. unity_mppm_* tools use "scenario/*" endpoints on the C# side.
 */
const ROUTE_OVERRIDES = {
  unity_asset_export_unitypackage: "asset/export-unitypackage",
  unity_compilation_errors: "compilation/errors",
  unity_mppm_list_scenarios: "scenario/list",
  unity_mppm_status: "scenario/status",
  unity_mppm_activate_scenario: "scenario/activate",
  unity_mppm_start: "scenario/start",
  unity_mppm_stop: "scenario/stop",
  unity_mppm_info: "scenario/info",
  unity_mppm_list_players: "mppm/list-players",
  unity_mppm_activate_player: "mppm/activate-player",
  unity_mppm_deactivate_player: "mppm/deactivate-player",
};

const TOOL_NAME_OVERRIDES = {
  "build/start": "unity_build",
  "compilation/errors": "unity_get_compilation_errors",
  "editor/play-mode": "unity_play_mode",
  "queue/status": "unity_queue_ticket_status",
};

const ROUTE_CATEGORY_PREFIXES = [
  ["prefab_asset", "prefab-asset"],
  ["serialized_object", "serialized-object"],
  ["scene_view", "scene-view"],
];

/**
 * Derive an HTTP route from a tool name.
 * unity_terrain_raise_lower -> terrain/raise-lower
 * unity_prefab_asset_set_property -> prefab-asset/set-property
 * unity_serialized_object_get -> serialized-object/get
 */
function toolNameToRoute(toolName) {
  // Check explicit overrides first (for tools whose API routes don't match their name)
  if (ROUTE_OVERRIDES[toolName]) return ROUTE_OVERRIDES[toolName];

  // Remove unity_ prefix
  const withoutPrefix = toolName.replace(/^unity_/, "");

  for (const [toolPrefix, routeCategory] of ROUTE_CATEGORY_PREFIXES) {
    const exactPrefix = `${toolPrefix}_`;
    if (withoutPrefix.startsWith(exactPrefix)) {
      const action = withoutPrefix.slice(exactPrefix.length).replace(/_/g, "-");
      return action ? `${routeCategory}/${action}` : null;
    }
  }

  // Split into parts: first part is category, rest is action
  const parts = withoutPrefix.split("_");
  if (parts.length < 2) return null;
  const category = parts[0];
  const action = parts.slice(1).join("-");
  return `${category}/${action}`;
}

function routeToToolName(route) {
  if (TOOL_NAME_OVERRIDES[route]) return TOOL_NAME_OVERRIDES[route];
  return "unity_" + route.replace(/\//g, "_").replace(/-/g, "_");
}

function isUnityRoute(value) {
  return typeof value === "string" && value.includes("/") && !value.startsWith("/") && !value.includes("..");
}

function loadPluginToolsCache() {
  try {
    if (existsSync(PLUGIN_TOOLS_CACHE_FILE)) {
      const data = JSON.parse(readFileSync(PLUGIN_TOOLS_CACHE_FILE, "utf-8"));
      if (data?.schemaVersion === PLUGIN_TOOLS_CACHE_SCHEMA_VERSION &&
          Array.isArray(data.tools)) {
        return data.tools;
      }
    }
  } catch {
    return [];
  }
  return [];
}

function savePluginToolsCache(tools) {
  if (Array.isArray(tools) && tools.length > 0) {
    try {
      mkdirSync(dirname(PLUGIN_TOOLS_CACHE_FILE), { recursive: true });
      writeFileSync(
        PLUGIN_TOOLS_CACHE_FILE,
        JSON.stringify({
          schemaVersion: PLUGIN_TOOLS_CACHE_SCHEMA_VERSION,
          updatedAt: Date.now(),
          tools,
        })
      );
    } catch {
      // Live metadata remains usable even when the disk cache cannot be written.
    }
  }
}

async function fetchPluginToolsLive(firstClassOnly = true, {
  includeSchema = firstClassOnly,
  category,
  cache = firstClassOnly,
} = {}) {
  try {
    const tools = [];
    let receivedToolPage = false;
    let offset = 0;
    for (let page = 0; page < 100; page++) {
      let metaTools = await sendCommand("_meta/tools", {
        firstClassOnly,
        compact: true,
        includeSchema,
        category,
        offset,
        limit: 200,
      });
      metaTools = metaTools?.data ?? metaTools;
      if (!Array.isArray(metaTools?.tools)) break;
      receivedToolPage = true;
      tools.push(...metaTools.tools);
      if (!Number.isInteger(metaTools.nextOffset) ||
          metaTools.tools.length === 0) break;
      offset = metaTools.nextOffset;
    }

    if (receivedToolPage) {
      if (cache && tools.length > 0) {
        savePluginToolsCache(tools);
        livePluginToolsCache = tools;
        livePluginToolsFetchedAt = Date.now();
      }
      return tools;
    }
  } catch (error) {
    // The live plugin may be temporarily unavailable during a domain reload.
    logDebug(`[MCP] Live Unity tool discovery unavailable: ${error?.message || error}`);
  }

  return [];
}

export function pluginToolsFingerprint(tools) {
  if (!Array.isArray(tools)) return "[]";

  return JSON.stringify(
    tools
      .filter((tool) =>
        STATIC_FIRST_CLASS_PLUGIN_ROUTE_SET.has(tool?.route) &&
        hasToolTag(tool, "firstClass"))
      .map((tool) => ({
        toolName: tool?.toolName || "",
        route: tool?.route || "",
        tags: normalizeToolTags(tool),
        sideEffects: normalizeStringList(tool?.sideEffects),
        description: tool?.description || "",
        inputSchema: tool?.inputSchema || null,
        outputSchema: tool?.outputSchema || null,
        annotations: tool?.annotations || null,
      }))
      .sort((left, right) =>
        `${left.toolName}\n${left.route}`.localeCompare(`${right.toolName}\n${right.route}`))
  );
}

export async function refreshPluginToolsMetadata() {
  const previousTools = livePluginToolsCache || loadPluginToolsCache();
  const previousFingerprint = pluginToolsFingerprint(previousTools);
  const tools = await fetchPluginToolsLive();
  if (tools.length === 0) {
    return { changed: false, tools: previousTools, fingerprint: previousFingerprint };
  }

  const fingerprint = pluginToolsFingerprint(tools);
  return {
    changed: fingerprint !== previousFingerprint,
    tools,
    fingerprint,
  };
}

async function fetchPluginToolsForToolList() {
  const now = Date.now();
  if (
    livePluginToolsCache &&
    now - livePluginToolsFetchedAt < PLUGIN_TOOLS_LIVE_REFRESH_INTERVAL_MS
  ) {
    return livePluginToolsCache;
  }

  return loadPluginToolsCache();
}

async function fetchPluginToolsForCatalog({ category, includeSchema = false } = {}) {
  return fetchPluginToolsLive(false, { category, includeSchema, cache: false })
    .catch(() => []);
}

function isFallbackTool(tool) {
  return hasToolTag(tool, "fallback");
}

function isFirstClassRouteTool(tool) {
  return (
    tool &&
    hasToolTag(tool, "firstClass") &&
    !isFallbackTool(tool) &&
    typeof tool.toolName === "string" &&
    typeof tool.route === "string" &&
    tool.route.length > 0
  );
}

function normalizeStringList(value) {
  return Array.isArray(value)
    ? [...new Set(value
      .filter((item) => typeof item === "string" && item.length > 0))]
      .sort((left, right) => left.localeCompare(right))
    : [];
}

function normalizeToolTags(tool) {
  return normalizeStringList(tool?.tags);
}

function hasToolTag(tool, tag) {
  return normalizeToolTags(tool).includes(tag);
}

function normalizeInputSchema(schema) {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return sanitizeToolMetadata(schema);
  }

  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

function isNonEmptyObject(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0;
}

function isValidToolSchema(value, path) {
  return isNonEmptyObject(value) &&
    auditSchema(value, path).length === 0;
}

export function mergeFirstClassPluginToolMetadata(releaseManaged, live) {
  if (!releaseManaged) return live;
  if (!live) return releaseManaged;

  const merged = { ...releaseManaged, ...live };
  for (const key of ["toolName", "route", "category", "description"]) {
    if (typeof live[key] !== "string" || live[key].length === 0) {
      merged[key] = releaseManaged[key];
    }
  }
  for (const key of ["inputSchema", "outputSchema"]) {
    if (!isValidToolSchema(live[key], `$.${key}`) &&
        isNonEmptyObject(releaseManaged[key])) {
      merged[key] = releaseManaged[key];
    }
  }
  if (!isNonEmptyObject(live.annotations) &&
      isNonEmptyObject(releaseManaged.annotations)) {
    merged.annotations = releaseManaged.annotations;
  }
  return merged;
}

export function sanitizeToolMetadata(value) {
  if (typeof value === "string") {
    return value
      .replace(/â€”|â€“|—|–/g, "-")
      .replace(/â†’|→/g, "->")
      .replace(/â€¦|…/g, "...")
      .replace(/â€˜|â€™|‘|’/g, "'")
      .replace(/â€œ|â€�|“|”/g, '"')
      .replace(/â€¢|•/g, "-")
      .replace(/⚠️|⚠/g, "Warning:");
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeToolMetadata(item));
  }

  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = sanitizeToolMetadata(item);
    }
    return result;
  }

  return value;
}

export async function fetchFirstClassPluginTools() {
  const pluginTools = await fetchPluginToolsForToolList();
  const candidatesByName = new Map();

  for (const tool of staticFirstClassPluginTools) {
    candidatesByName.set(tool.toolName, tool);
  }

  for (const tool of pluginTools) {
    if (!STATIC_FIRST_CLASS_PLUGIN_ROUTE_SET.has(tool?.route)) continue;
    if (!isFirstClassRouteTool(tool)) continue;
    if (!tool.toolName) continue;
    candidatesByName.set(
      tool.toolName,
      mergeFirstClassPluginToolMetadata(candidatesByName.get(tool.toolName), tool)
    );
  }

  const exposed = [];
  for (const tool of candidatesByName.values()) {
    exposed.push({
      name: tool.toolName,
      description: sanitizeToolMetadata(
        tool.description || `Unity MCP route: ${tool.route}`),
      inputSchema: normalizeInputSchema(tool.inputSchema),
      outputSchema: tool.outputSchema && typeof tool.outputSchema === "object"
        ? sanitizeToolMetadata(tool.outputSchema)
        : {},
      annotations: sanitizeToolMetadata(tool.annotations || {}),
      handler: async (params = {}) =>
        invokeFirstClassPluginRoute(tool.route, params || {}),
    });
  }

  return exposed;
}

export async function invokeFirstClassPluginRoute(route, params = {}) {
  switch (route) {
    case "queue/info":
      return getQueueInfo();
    case "queue/status":
      return getTicketStatus(params.ticketId);
    case "queue/cancel":
      return cancelTicket(params.ticketId);
    default:
      return sendCommand(route, params);
  }
}

// Core tool names (always exposed individually)
const CORE_TOOLS = new Set([
  // Connection & state
  "unity_editor_ping",
  "unity_editor_state",
  "unity_project_info",

  // Scene management
  "unity_scene_info",
  "unity_scene_open",
  "unity_scene_save",
  "unity_scene_hierarchy",
  "unity_scene_stats",

  // GameObject CRUD
  "unity_gameobject_create",
  "unity_gameobject_delete",
  "unity_gameobject_info",
  "unity_gameobject_set_transform",

  // Component management
  "unity_component_add",
  "unity_component_remove",
  "unity_component_get_properties",
  "unity_component_set_property",

  // Asset management
  "unity_asset_list",
  "unity_asset_import",
  "unity_asset_refresh",
  "unity_asset_delete",

  // Generic scripting escape hatch
  "unity_execute_code",

  // Build & play
  "unity_build",
  "unity_play_mode",

  // Console & Compilation
  "unity_console_clear",
  "unity_get_compilation_errors",

  // Multi-agent queue diagnostics
  "unity_queue_info",

  // Screenshots & capture
  "unity_screenshot_game",
  "unity_screenshot_scene",

  // Prefab basics
  "unity_prefab_info",

]);

/**
 * Split a flat tool array into { core, advanced }.
 * Also generates the meta-tools for accessing advanced tools.
 */
export function splitToolTiers(allEditorTools) {
  const core = [];
  const advanced = [];

  for (const tool of allEditorTools) {
    if (CORE_TOOLS.has(tool.name)) {
      core.push(tool);
    } else {
      advanced.push(tool);
    }
  }

  // Build an index of advanced tools for the catalog
  const advancedIndex = advanced.map((t) => ({
    name: t.name,
    description: t.description,
  }));

  // Group advanced tools by category for the catalog
  const categories = {};
  for (const t of advanced) {
    // Extract category from tool name: unity_animation_create_clip -> animation
    const parts = t.name.replace(/^unity_/, "").split("_");
    const cat = parts[0];
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(t.name);
  }

  // Build the handler map for quick lookup
  const advancedMap = new Map();
  for (const t of advanced) {
    advancedMap.set(t.name, t);
  }

  // Meta-tools

  const catalogTool = {
    name: "unity_list_advanced_tools",
    description:
      "List fallback Unity tools organized by category. Prefer directly exposed unity_* tools first; " +
      "use unity_advanced_tool only when no concrete tool exists or metadata is stale. " +
      "Categories include: animation, prefab, physics, lighting, audio, shadergraph, " +
      "terrain, particle, navmesh, ui, texture, profiler, memory, settings, " +
      "input, asmdef, scriptableobject, constraint, lod, editorprefs, playerprefs, " +
      "vfx, graphics, sceneview, and more.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description:
            'Filter by category name (e.g. "animation", "prefab", "shadergraph"). Omit for full list.',
        },
        includeSchema: {
          type: "boolean",
          description:
            "Include inputSchema and outputSchema for dynamically discovered tools. Defaults to false.",
        },
        offset: {
          type: "number",
          description: "Tool offset within a selected category. Defaults to 0.",
        },
        limit: {
          type: "number",
          description: "Maximum tools returned for a selected category. Defaults to 100; capped at 200.",
        },
      },
    },
    handler: async ({ category, includeSchema, offset = 0, limit = 100 } = {}) => {
      offset = Math.max(0, Number(offset) || 0);
      limit = Math.max(1, Math.min(Number(limit) || 100, 200));
      const pluginTools = await fetchPluginToolsForCatalog({ category, includeSchema });
      const pluginToolsByName = new Map();
      for (const tool of pluginTools) {
        if (tool.toolName) pluginToolsByName.set(tool.toolName, tool);
      }

      // Merge dynamic routes into the advanced tool list
      // Dynamic routes that aren't in our cached map get listed as lazy-loadable tools
      const mergedCategories = Object.fromEntries(
        Object.entries(categories).map(([name, tools]) => [name, [...tools]])
      );
      let dynamicCount = 0;

      for (const tool of pluginTools) {
        if (STATIC_FIRST_CLASS_PLUGIN_ROUTE_SET.has(tool?.route)) continue;

        const route = tool.route;
        const toolName = tool.toolName || (route ? routeToToolName(route) : null);
        const cat = tool.category || route?.split("/")[0];
        if (!toolName || !cat) continue;

        // Skip if already in our cached map
        if (advancedMap.has(toolName) || CORE_TOOLS.has(toolName)) continue;

        // Add to merged categories
        if (!mergedCategories[cat]) mergedCategories[cat] = [];
        if (!mergedCategories[cat].includes(toolName)) {
          mergedCategories[cat].push(toolName);
          dynamicCount++;
        }
      }

      if (category) {
        const cat = category.toLowerCase();

        // Check cached tools first
        const matching = advanced.filter((t) => {
          const toolCat = t.name.replace(/^unity_/, "").split("_")[0];
          return toolCat === cat;
        });

        // Also include dynamic-only tools for this category
        const dynamicTools = (mergedCategories[cat] || [])
          .filter((name) => !advancedMap.has(name))
          .map((name) => {
            const meta = pluginToolsByName.get(name);
            const result = {
              name,
              description: sanitizeToolMetadata(meta?.description || `(lazy-loaded from Unity plugin)`),
            };
            if (includeSchema && meta?.inputSchema) {
              result.inputSchema = sanitizeToolMetadata(meta.inputSchema);
            }
            if (includeSchema && meta?.outputSchema) {
              result.outputSchema = sanitizeToolMetadata(meta.outputSchema);
            }
            if (meta?.route) {
              result.route = meta.route;
            }
            const tags = normalizeToolTags(meta);
            if (tags.length > 0) {
              result.tags = tags;
            }
            const sideEffects = normalizeStringList(meta?.sideEffects);
            if (sideEffects.length > 0) {
              result.sideEffects = sideEffects;
            }
            const errorCodes = normalizeStringList(meta?.errorCodes);
            if (errorCodes.length > 0) {
              result.errorCodes = errorCodes;
            }
            return result;
          });

        const allTools = [
          ...matching.map((tool) => {
            const result = {
              name: tool.name,
              description: sanitizeToolMetadata(tool.description),
            };
            if (includeSchema) {
              result.inputSchema = sanitizeToolMetadata(tool.inputSchema);
              result.outputSchema = sanitizeToolMetadata(tool.outputSchema || {});
            }
            return result;
          }),
          ...dynamicTools,
        ];

        if (allTools.length === 0) {
          return createToolError(
            "advanced_category_not_found",
            `No advanced tools were found for category "${category}".`,
            { availableCategories: Object.keys(mergedCategories).sort() }
          );
        }
        const page = allTools.slice(offset, offset + limit);
        const nextOffset = offset + page.length;
        const result = {
          category: cat,
          tools: page,
        };
        if (offset > 0) {
          result.offset = offset;
        }
        if (nextOffset < allTools.length) {
          result.nextOffset = nextOffset;
          result.totalTools = allTools.length;
        }
        return result;
      }

      const categorySummaries = Object.entries(mergedCategories)
        .map(([name, names]) => ({ name, toolCount: names.length }))
        .sort((left, right) => left.name.localeCompare(right.name));
      return {
        totalAdvancedTools: advanced.length + dynamicCount,
        dynamicTools: dynamicCount,
        categories: categorySummaries,
        hint: "Call again with category to list paginated tools and optional schemas.",
      };
    },
  };

  const advancedTool = {
    name: "unity_advanced_tool",
    description:
      "Fallback generic Unity entrypoint. Prefer directly exposed unity_* tools first. " +
      "Use this only when no concrete tool exists, a route is new, or metadata is stale.",
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description:
            'Fallback tool name or raw route. Examples: "unity_animation_create_controller" or "packages/update-git".',
        },
        params: {
          type: "object",
          description:
            "Parameters to pass to the tool or raw route.",
          additionalProperties: true,
        },
      },
      required: ["tool"],
    },
    handler: async ({ tool, params } = {}) => {
      if (!tool) {
        return createToolError(
          "advanced_tool_required",
          "tool is required. Use unity_list_advanced_tools to discover fallback tools."
        );
      }

      if (isUnityRoute(tool)) {
        try {
          logDebug(`[MCP] Calling raw Unity route "${tool}" via fallback generic entry`);
          return await sendCommand(tool, params || {});
        } catch (err) {
          return createToolError(
            "advanced_route_failed",
            `Failed to execute route "${tool}": ${err.message}`,
            { route: tool }
          );
        }
      }

      const targetTool = advancedMap.get(tool);
      if (targetTool) {
        return await targetTool.handler(params || {});
      }

      const pluginTools = await fetchPluginToolsLive(false);
      const dynamicTool = pluginTools.find((item) => item.toolName === tool);
      if (dynamicTool?.route) {
        try {
          logDebug(`[MCP] Lazy-loading tool "${tool}" via plugin route "${dynamicTool.route}"`);
          return await sendCommand(dynamicTool.route, params || {});
        } catch (err) {
          return createToolError(
            "advanced_tool_failed",
            `Failed to execute "${tool}": ${err.message}`,
            { tool, route: dynamicTool.route }
          );
        }
      }

      // ─── Lazy loading fallback ───
      // Tool not in cached map - derive the route from the name and call Unity directly.
      // This allows new tools added to the C# plugin to work without restarting the MCP server.
      const route = toolNameToRoute(tool);
      if (route) {
        try {
          // Log to stderr, not stdout - stdout carries the MCP JSON-RPC transport.
          logDebug(`[MCP] Lazy-loading tool "${tool}" via route "${route}"`);
          return await sendCommand(route, params || {});
        } catch (err) {
          return createToolError(
            "advanced_tool_failed",
            `Failed to execute "${tool}": ${err.message}`,
            { tool, route }
          );
        }
      }

      return createToolError(
        "advanced_tool_not_found",
        `Unknown fallback tool "${tool}". Use unity_list_advanced_tools to discover available tools.`,
        { tool }
      );
    },
  };

  return {
    coreTools: core,
    metaTools: [catalogTool, advancedTool],
    advancedCount: advanced.length,
    coreCount: core.length,
  };
}
