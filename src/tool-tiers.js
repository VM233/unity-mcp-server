// AnkleBreaker Unity MCP - two-tier tool system
// Reduces the exposed tool count to avoid overwhelming MCP clients.
//
// Core tools: Always exposed as individual MCP tools (~60 tools)
// Advanced tools: Fallback access through unity_advanced_tool (200+ tools)
//
// Why: MCP clients like Claude Cowork silently fail when a server
// exposes too many tools (our 268 tools / 125KB response was ~5x
// larger than working servers). This keeps us under the safe limit.
//
// Lazy loading: Advanced tools support dynamic dispatch. If a tool
// isn't in the cached map, callers can pass a raw Unity route directly,
// use a project-tool:<name> shortcut, or rely on route derivation
// (unity_terrain_list -> terrain/list). This means new C# plugin routes
// and project-defined tools can run before MCP client metadata refreshes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { CONFIG } from "./config.js";
import { sendCommand } from "./unity-editor-bridge.js";
import { loadState, persistState } from "./state-persistence.js";
import { staticFirstClassPluginTools } from "./tools/plugin-first-class-tools.js";

const PLUGIN_TOOLS_CACHE_KEY = "pluginToolsMetadata";
const PLUGIN_TOOLS_CACHE_FILE = join(dirname(CONFIG.instanceRegistryPath), "plugin-tools-metadata-cache.json");
const PLUGIN_TOOLS_LIVE_REFRESH_INTERVAL_MS = 10_000;

let livePluginToolsCache = null;
let livePluginToolsFetchedAt = 0;
let livePluginToolsFetchPromise = null;

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
  return "unity_" + route.replace(/\//g, "_").replace(/-/g, "_");
}

function isUnityRoute(value) {
  return typeof value === "string" && value.includes("/") && !value.startsWith("/") && !value.includes("..");
}

function getProjectToolName(value) {
  if (typeof value !== "string") return null;

  const prefixes = ["project-tool:", "project:"];
  for (const prefix of prefixes) {
    if (value.startsWith(prefix)) {
      const toolName = value.slice(prefix.length).trim();
      return toolName || null;
    }
  }

  return null;
}

function loadPluginToolsCache() {
  try {
    if (existsSync(PLUGIN_TOOLS_CACHE_FILE)) {
      const data = JSON.parse(readFileSync(PLUGIN_TOOLS_CACHE_FILE, "utf-8"));
      if (Array.isArray(data?.tools)) return data.tools;
      if (Array.isArray(data)) return data;
    }
  } catch {
    // Fall through to legacy session cache.
  }

  const cached = loadState(PLUGIN_TOOLS_CACHE_KEY);
  return Array.isArray(cached) ? cached : [];
}

function savePluginToolsCache(tools) {
  if (Array.isArray(tools) && tools.length > 0) {
    try {
      mkdirSync(dirname(PLUGIN_TOOLS_CACHE_FILE), { recursive: true });
      writeFileSync(
        PLUGIN_TOOLS_CACHE_FILE,
        JSON.stringify({ updatedAt: Date.now(), tools }, null, 2)
      );
    } catch {
      // Keep the legacy cache as a fallback if the long-lived cache cannot be written.
    }
    persistState(PLUGIN_TOOLS_CACHE_KEY, tools);
  }
}

async function fetchPluginToolsLive(firstClassOnly = true) {
  try {
    let metaTools = await sendCommand("_meta/tools", { firstClassOnly, compact: firstClassOnly });
    metaTools = metaTools?.data ?? metaTools;
    if (Array.isArray(metaTools?.tools)) {
      savePluginToolsCache(metaTools.tools);
      livePluginToolsCache = metaTools.tools;
      livePluginToolsFetchedAt = Date.now();
      return metaTools.tools;
    }
  } catch (_) {
    // Older plugin builds only support _meta/routes.
  }

  try {
    let dynamicRoutes = await sendCommand("_meta/routes", {});
    dynamicRoutes = dynamicRoutes?.data ?? dynamicRoutes;
    if (Array.isArray(dynamicRoutes?.routes)) {
      const tools = dynamicRoutes.routes.map((route) => ({
        route,
        toolName: routeToToolName(route),
        category: route.split("/")[0],
        description: `Lazy Unity route: ${route}`,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: true,
        },
      }));
      savePluginToolsCache(tools);
      livePluginToolsCache = tools;
      livePluginToolsFetchedAt = Date.now();
      return tools;
    }
  } catch (_) {
    // Plugin might not support dynamic metadata yet.
  }

  return [];
}

export function pluginToolsFingerprint(tools) {
  if (!Array.isArray(tools)) return "[]";

  return JSON.stringify(
    tools
      .filter((tool) =>
        tool?.firstClass === true ||
        tool?.preferred === true ||
        tool?.exposure === "first-class")
      .map((tool) => ({
        toolName: tool?.toolName || "",
        route: tool?.route || "",
        exposure: tool?.exposure || "",
        description: tool?.description || "",
        inputSchema: tool?.inputSchema || null,
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

async function fetchPluginToolsForCatalog() {
  const now = Date.now();
  if (
    livePluginToolsCache &&
    now - livePluginToolsFetchedAt < PLUGIN_TOOLS_LIVE_REFRESH_INTERVAL_MS
  ) {
    return livePluginToolsCache;
  }

  if (!livePluginToolsFetchPromise) {
    livePluginToolsFetchPromise = fetchPluginToolsLive(false)
      .then((tools) => {
        if (tools.length > 0) {
          return tools;
        }

        const cached = loadPluginToolsCache();
        return cached.length > 0 ? cached : [];
      })
      .catch(() => loadPluginToolsCache())
      .finally(() => {
        livePluginToolsFetchPromise = null;
      });
  }

  return livePluginToolsFetchPromise;
}

function isFirstClassProjectTool(tool) {
  return (
    tool &&
    !isFallbackTool(tool) &&
    typeof tool.toolName === "string" &&
    typeof tool.projectToolName === "string" &&
    tool.projectToolName.length > 0 &&
    typeof tool.route === "string" &&
    tool.route.startsWith("project-tools/call/")
  );
}

function isFallbackTool(tool) {
  return tool?.exposure === "fallback" || tool?.fallback === true;
}

function isFirstClassRouteTool(tool) {
  const explicitlyFirstClass =
    tool?.firstClass === true ||
    tool?.exposure === "first-class" ||
    tool?.preferred === true;

  return (
    tool &&
    explicitlyFirstClass &&
    !isFallbackTool(tool) &&
    typeof tool.toolName === "string" &&
    typeof tool.route === "string" &&
    tool.route.length > 0
  );
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
    if (!isFirstClassProjectTool(tool) && !isFirstClassRouteTool(tool)) continue;
    if (!tool.toolName) continue;
    candidatesByName.set(tool.toolName, tool);
  }

  const exposed = [];
  for (const tool of candidatesByName.values()) {
    exposed.push({
      name: tool.toolName,
      description: sanitizeToolMetadata(
        tool.description || `Unity MCP route: ${tool.route}`),
      inputSchema: normalizeInputSchema(tool.inputSchema),
      annotations: sanitizeToolMetadata(tool.annotations || {}),
      handler: async (params = {}) =>
        JSON.stringify(await sendCommand(tool.route, params || {}), null, 2),
    });
  }

  return exposed;
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
  "unity_scene_new",
  "unity_scene_hierarchy",
  "unity_scene_stats",

  // GameObject CRUD
  "unity_gameobject_create",
  "unity_gameobject_delete",
  "unity_gameobject_info",
  "unity_gameobject_set_transform",
  "unity_gameobject_duplicate",
  "unity_gameobject_set_active",
  "unity_gameobject_reparent",

  // Component management
  "unity_component_add",
  "unity_component_remove",
  "unity_component_get_properties",
  "unity_component_set_property",
  "unity_component_set_reference",
  "unity_component_batch_wire",
  "unity_component_get_referenceable",

  // Asset management
  "unity_asset_list",
  "unity_asset_import",
  "unity_asset_refresh",
  "unity_asset_delete",
  "unity_asset_create_prefab",
  "unity_asset_instantiate_prefab",

  // Script management
  "unity_script_create",
  "unity_script_read",
  "unity_script_update",
  "unity_execute_code",

  // Material
  "unity_material_create",
  "unity_renderer_set_material",

  // Build & play
  "unity_build",
  "unity_play_mode",

  // Console & Compilation
  "unity_console_log",
  "unity_console_clear",
  "unity_get_compilation_errors",

  // Editor actions
  "unity_execute_menu_item",
  "unity_undo",
  "unity_redo",
  "unity_undo_history",

  // Selection & search
  "unity_selection_get",
  "unity_selection_set",
  "unity_selection_focus_scene_view",
  "unity_selection_find_by_type",
  "unity_search_by_component",
  "unity_search_by_tag",
  "unity_search_by_layer",
  "unity_search_by_name",
  "unity_search_assets",
  "unity_search_missing_references",

  // Screenshots & capture
  "unity_screenshot_game",
  "unity_screenshot_scene",
  "unity_screenshot_editor_window",
  "unity_graphics_scene_capture",
  "unity_graphics_game_capture",

  // Prefab basics
  "unity_prefab_info",
  "unity_set_object_reference",

  // Packages
  "unity_packages_list",
  "unity_packages_add",
  "unity_packages_remove",
  "unity_packages_search",
  "unity_packages_info",
  "unity_packages_update_git",
  "unity_packages_lint_metas",

  // Queue & agents
  "unity_queue_info",
  "unity_agents_list",
  "unity_agent_log",
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
      "Categories include: uma, animation, prefab, physics, lighting, audio, shadergraph, " +
      "amplify, terrain, particle, navmesh, ui, texture, profiler, memory, settings, " +
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
          description: "Include inputSchema for dynamically discovered tools. Defaults to false.",
        },
      },
    },
    handler: async ({ category, includeSchema } = {}) => {
      const pluginTools = await fetchPluginToolsForCatalog();
      const pluginToolsByName = new Map();
      for (const tool of pluginTools) {
        if (tool.toolName) pluginToolsByName.set(tool.toolName, tool);
      }

      // Merge dynamic routes into the advanced tool list
      // Dynamic routes that aren't in our cached map get listed as lazy-loadable tools
      let mergedCategories = { ...categories };
      let dynamicCount = 0;

      for (const tool of pluginTools) {
        if (isFirstClassProjectTool(tool) || isFirstClassRouteTool(tool)) continue;

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
            if (meta?.route) {
              result.route = meta.route;
            }
            return result;
          });

        const all = [
          ...matching.map((t) => ({ name: t.name, description: sanitizeToolMetadata(t.description) })),
          ...dynamicTools,
        ];

        if (all.length === 0) {
          return `No advanced tools found for category "${category}". Available categories: ${Object.keys(mergedCategories).join(", ")}`;
        }
        return JSON.stringify(all, null, 2);
      }

      // Full catalog grouped by category
      const result = {};
      for (const [cat, names] of Object.entries(mergedCategories)) {
        result[cat] = names;
      }
      return JSON.stringify(
        {
          totalAdvancedTools: advanced.length + dynamicCount,
          dynamicTools: dynamicCount,
          categories: result,
          dynamicToolDetails: includeSchema
            ? pluginTools
                .filter((tool) =>
                  tool.toolName &&
                  !advancedMap.has(tool.toolName) &&
                  !CORE_TOOLS.has(tool.toolName) &&
                  !isFirstClassProjectTool(tool) &&
                  !isFirstClassRouteTool(tool))
                .map((tool) => ({
                  name: tool.toolName,
                  route: tool.route,
                  description: sanitizeToolMetadata(tool.description),
                  inputSchema: sanitizeToolMetadata(tool.inputSchema),
                }))
            : undefined,
        },
        null,
        2
      );
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
            'Fallback tool name, raw route, or project tool shortcut. Examples: "unity_animation_create_controller", "packages/update-git", "project-tool:add-property".',
        },
        params: {
          type: "object",
          description:
            "Parameters to pass to the tool, raw route, or project tool.",
          additionalProperties: true,
        },
      },
      required: ["tool"],
    },
    handler: async ({ tool, params } = {}) => {
      if (!tool) {
        return "Error: 'tool' parameter is required. Use unity_list_advanced_tools to see available tools.";
      }

      const projectToolName = getProjectToolName(tool);
      if (projectToolName) {
        try {
          console.error(`[MCP] Calling project tool "${projectToolName}" via fallback generic entry`);
          const result = await sendCommand("project-tools/execute", {
            toolName: projectToolName,
            args: params || {},
          });
          return JSON.stringify(result, null, 2);
        } catch (err) {
          return `Error executing project tool "${projectToolName}": ${err.message}`;
        }
      }

      if (isUnityRoute(tool)) {
        try {
          console.error(`[MCP] Calling raw Unity route "${tool}" via fallback generic entry`);
          const result = await sendCommand(tool, params || {});
          return JSON.stringify(result, null, 2);
        } catch (err) {
          return `Error executing route "${tool}": ${err.message}`;
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
          console.error(`[MCP] Lazy-loading tool "${tool}" via plugin route "${dynamicTool.route}"`);
          const result = await sendCommand(dynamicTool.route, params || {});
          return JSON.stringify(result, null, 2);
        } catch (err) {
          return `Error executing "${tool}" (lazy route: ${dynamicTool.route}): ${err.message}`;
        }
      }

      // ─── Lazy loading fallback ───
      // Tool not in cached map - derive the route from the name and call Unity directly.
      // This allows new tools added to the C# plugin to work without restarting the MCP server.
      const route = toolNameToRoute(tool);
      if (route) {
        try {
          // Log to stderr, not stdout - stdout carries the MCP JSON-RPC transport.
          console.error(`[MCP] Lazy-loading tool "${tool}" via route "${route}"`);
          const result = await sendCommand(route, params || {});
          return JSON.stringify(result, null, 2);
        } catch (err) {
          return `Error executing "${tool}" (lazy route: ${route}): ${err.message}`;
        }
      }

      return `Error: Unknown tool "${tool}". Use unity_list_advanced_tools to see available tools.`;
    },
  };

  return {
    coreTools: core,
    metaTools: [catalogTool, advancedTool],
    advancedCount: advanced.length,
    coreCount: core.length,
  };
}
