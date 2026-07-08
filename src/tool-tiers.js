// AnkleBreaker Unity MCP — Two-tier tool system
// Reduces the exposed tool count to avoid overwhelming MCP clients.
//
// Core tools: Always exposed as individual MCP tools (~60 tools)
// Advanced tools: Accessed via unity_advanced_tool (200+ tools)
//
// Why: MCP clients like Claude Cowork silently fail when a server
// exposes too many tools (our 268 tools / 125KB response was ~5x
// larger than working servers). This keeps us under the safe limit.
//
// Lazy loading: Advanced tools support dynamic dispatch. If a tool
// isn't in the cached map, callers can pass a raw Unity route directly,
// use a project-tool:<name> shortcut, or rely on route derivation
// (unity_terrain_list → terrain/list). This means new C# plugin routes
// and project-defined tools can run before MCP client metadata refreshes.

import { sendCommand } from "./unity-editor-bridge.js";

/**
 * Explicit route overrides for tools whose API endpoints
 * don't follow the standard name → route derivation pattern.
 * E.g. unity_mppm_* tools use "scenario/*" endpoints on the C# side.
 */
const ROUTE_OVERRIDES = {
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

/**
 * Derive an HTTP route from a tool name.
 * unity_terrain_raise_lower → terrain/raise-lower
 * unity_animation_create_clip → animation/create-clip
 */
function toolNameToRoute(toolName) {
  // Check explicit overrides first (for tools whose API routes don't match their name)
  if (ROUTE_OVERRIDES[toolName]) return ROUTE_OVERRIDES[toolName];

  // Remove unity_ prefix
  const withoutPrefix = toolName.replace(/^unity_/, "");
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

async function fetchPluginTools() {
  try {
    let metaTools = await sendCommand("_meta/tools", {});
    metaTools = metaTools?.data ?? metaTools;
    if (Array.isArray(metaTools?.tools)) {
      return metaTools.tools;
    }
  } catch (_) {
    // Older plugin builds only support _meta/routes.
  }

  try {
    let dynamicRoutes = await sendCommand("_meta/routes", {});
    dynamicRoutes = dynamicRoutes?.data ?? dynamicRoutes;
    if (Array.isArray(dynamicRoutes?.routes)) {
      return dynamicRoutes.routes.map((route) => ({
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
    }
  } catch (_) {
    // Plugin might not support dynamic metadata yet.
  }

  return [];
}

function isFirstClassProjectTool(tool) {
  return (
    tool &&
    typeof tool.toolName === "string" &&
    typeof tool.projectToolName === "string" &&
    tool.projectToolName.length > 0 &&
    typeof tool.route === "string" &&
    tool.route.startsWith("project-tools/call/")
  );
}

function normalizeInputSchema(schema) {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return schema;
  }

  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

export async function fetchFirstClassProjectTools() {
  const pluginTools = await fetchPluginTools();
  const exposed = [];
  const seen = new Set();

  for (const tool of pluginTools) {
    if (!isFirstClassProjectTool(tool) || seen.has(tool.toolName)) continue;

    seen.add(tool.toolName);
    exposed.push({
      name: tool.toolName,
      description:
        tool.description || `Project MCP tool: ${tool.projectToolName}`,
      inputSchema: normalizeInputSchema(tool.inputSchema),
      handler: async (params = {}) => {
        const result = await sendCommand(tool.route, params || {});
        return JSON.stringify(result, null, 2);
      },
    });
  }

  return exposed;
}

// ─── Core tool names (always exposed individually) ───
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
    // Extract category from tool name: unity_animation_create_clip → animation
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

  // ─── Meta-tools ───

  const catalogTool = {
    name: "unity_list_advanced_tools",
    description:
      "List all available advanced/specialized Unity tools organized by category. " +
      "These tools are not directly exposed but can be called via unity_advanced_tool. " +
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
      const pluginTools = await fetchPluginTools();
      const pluginToolsByName = new Map();
      for (const tool of pluginTools) {
        if (tool.toolName) pluginToolsByName.set(tool.toolName, tool);
      }

      // Merge dynamic routes into the advanced tool list
      // Dynamic routes that aren't in our cached map get listed as lazy-loadable tools
      let mergedCategories = { ...categories };
      let dynamicCount = 0;

      for (const tool of pluginTools) {
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
              description: meta?.description || `(lazy-loaded from Unity plugin)`,
            };
            if (includeSchema && meta?.inputSchema) {
              result.inputSchema = meta.inputSchema;
            }
            if (meta?.route) {
              result.route = meta.route;
            }
            return result;
          });

        const all = [
          ...matching.map((t) => ({ name: t.name, description: t.description })),
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
                .filter((tool) => tool.toolName && !advancedMap.has(tool.toolName) && !CORE_TOOLS.has(tool.toolName))
                .map((tool) => ({
                  name: tool.toolName,
                  route: tool.route,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
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
      "Execute an advanced/specialized Unity tool by name, a raw Unity route, or a project tool " +
      "via project-tool:<name>. Use this as the stable generic entry when tool metadata is stale.",
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description:
            'Tool name, raw route, or project tool shortcut. Examples: "unity_animation_create_controller", "packages/update-git", "project-tool:add-property".',
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
          console.error(`[MCP] Calling project tool "${projectToolName}" via stable generic entry`);
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
          console.error(`[MCP] Calling raw Unity route "${tool}" via stable generic entry`);
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

      const pluginTools = await fetchPluginTools();
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
      // Tool not in cached map — derive the route from the name and call Unity directly.
      // This allows new tools added to the C# plugin to work without restarting the MCP server.
      const route = toolNameToRoute(tool);
      if (route) {
        try {
          // Log to stderr, not stdout — stdout carries the MCP JSON-RPC transport.
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
