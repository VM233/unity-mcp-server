import assert from "node:assert/strict";
import test from "node:test";

import { ToolCatalog, hostTool } from "../src/catalog/tool-catalog.js";
import { unityMetadataToCatalogTool } from "../src/catalog/unity-tool-catalog.js";
import { createToolDiscoveryTools } from "../src/discovery/tool-discovery.js";
import { AdvertisedToolRegistry } from
  "../src/exposure/advertised-tool-registry.js";

function metadata(overrides = {}) {
  return {
    route: "scene/hierarchy",
    toolName: "unity_scene_hierarchy",
    category: "scene",
    moduleId: "unity.scene",
    capability: "scene-query",
    operationKind: "inspect",
    description: "Read the selected Unity scene hierarchy.",
    whenToUse: "Use when inspecting scene ownership and object structure.",
    notFor: "Do not use for project asset searches.",
    inputSchema: {
      type: "object",
      properties: {
        maxDepth: { type: "integer", description: "Maximum hierarchy depth." },
      },
      additionalProperties: false,
    },
    outputSchema: { type: "object", additionalProperties: true },
    tags: ["readOnly"],
    sideEffects: ["readsProjectState"],
    errorCodes: ["invalid_arguments"],
    searchTerms: ["hierarchy", "scene tree"],
    preconditions: ["projectBound"],
    ...overrides,
  };
}

function catalogWith(tools) {
  const source = {
    tools,
    schemaVersion: 7,
    refresh: async () => ({ changed: false, revision: "test", toolCount: tools.length }),
  };
  return new ToolCatalog({ unitySource: source });
}

test("Unity metadata becomes one canonical typed catalog entry", () => {
  const tool = unityMetadataToCatalogTool(metadata());
  assert.equal(tool.name, "unity_scene_hierarchy");
  assert.equal(tool.catalog.moduleId, "unity.scene");
  assert.equal(tool.catalog.capability, "scene-query");
  assert.equal(tool.catalog.operationKind, "inspect");
  assert.deepEqual(tool.catalog.preconditions, ["projectBound"]);
  assert.deepEqual(tool.catalog.sideEffects, ["readsProjectState"]);
  assert.equal(tool.inputSchema.additionalProperties, false);
});

test("catalog rejects incomplete contracts instead of guessing executable routes", () => {
  for (const property of [
    "route", "toolName", "category", "description", "inputSchema", "outputSchema",
  ]) {
    const invalid = metadata();
    delete invalid[property];
    assert.throws(() => unityMetadataToCatalogTool(invalid), new RegExp(property));
  }
});

test("catalog rejects duplicate names across host and Unity modules", () => {
  const source = {
    tools: [unityMetadataToCatalogTool(metadata({ toolName: "same_name" }))],
    schemaVersion: 7,
    refresh: async () => ({ changed: false }),
  };
  const host = hostTool({
    name: "same_name",
    description: "Host duplicate used by the test.",
    inputSchema: { type: "object", properties: {} },
    handler: () => ({}),
  }, {
    moduleId: "host.test",
    category: "test",
    capability: "test",
  });
  assert.throws(
    () => new ToolCatalog({ unitySource: source, hostTools: [host] }),
    /duplicate tool name same_name/);
});

test("list gives bounded module/category counts without returning schemas", async () => {
  const tools = [
    unityMetadataToCatalogTool(metadata()),
    unityMetadataToCatalogTool(metadata({
      route: "asset/list",
      toolName: "unity_asset_list",
      category: "asset",
      moduleId: "unity.asset",
      capability: "asset-query",
      description: "List project assets with filters.",
    })),
  ];
  const catalog = catalogWith(tools);
  const [list] = createToolDiscoveryTools({
    catalog,
    refreshCatalog: async () => ({ changed: false }),
    activateTool: async () => false,
  });
  const result = await list.handler({});
  assert.equal(result.totalTools, 2);
  assert.deepEqual(result.modules, [
    { name: "unity.asset", toolCount: 1 },
    { name: "unity.scene", toolCount: 1 },
  ]);
  assert.equal(JSON.stringify(result).includes("inputSchema"), false);
});

test("search ranks exact names and Chinese intent without returning full schemas", async () => {
  const hierarchy = unityMetadataToCatalogTool(metadata({
    description: "读取场景层级并检查对象结构。",
    searchTerms: ["场景", "层级", "对象结构"],
  }));
  const assets = unityMetadataToCatalogTool(metadata({
    route: "asset/list",
    toolName: "unity_asset_list",
    category: "asset",
    moduleId: "unity.asset",
    capability: "asset-query",
    description: "List project assets.",
    searchTerms: ["assets"],
  }));
  const catalog = catalogWith([hierarchy, assets]);
  const [, search] = createToolDiscoveryTools({
    catalog,
    refreshCatalog: async () => ({ changed: false }),
    activateTool: async () => false,
  });

  const chinese = await search.handler({ query: "检查场景层级" });
  assert.equal(chinese.results[0].name, "unity_scene_hierarchy");
  assert.equal(JSON.stringify(chinese).includes("inputSchema"), false);

  const exact = await search.handler({ query: "unity_asset_list" });
  assert.equal(exact.results[0].name, "unity_asset_list");
  assert.deepEqual(exact.results[0].whyMatched, ["canonicalName", "unity", "asset", "list"]);
});

test("get returns the full contract and activates only the selected typed tool", async () => {
  const hierarchy = unityMetadataToCatalogTool(metadata());
  const catalog = catalogWith([hierarchy]);
  const activated = [];
  const [, , get] = createToolDiscoveryTools({
    catalog,
    refreshCatalog: async () => ({ changed: false }),
    activateTool: async (tool) => {
      activated.push(tool.name);
      return true;
    },
  });
  const result = await get.handler({ name: "unity_scene_hierarchy" });
  assert.equal(result.tool.name, "unity_scene_hierarchy");
  assert.equal(result.tool.catalogRevision, "host");
  assert.ok(result.tool.inputSchema.properties.maxDepth);
  assert.deepEqual(activated, ["unity_scene_hierarchy"]);
});

test("advertised registry preserves activated names and reconciles schema changes", () => {
  const bootstrap = {
    name: "unity_tools_search",
    description: "Search tools.",
    inputSchema: { type: "object", properties: {} },
  };
  const registry = new AdvertisedToolRegistry([bootstrap]);
  const first = unityMetadataToCatalogTool(metadata());
  assert.equal(registry.activate(first), true);
  assert.equal(registry.activate(first), false);

  const changed = unityMetadataToCatalogTool(metadata({
    inputSchema: {
      type: "object",
      properties: { maxNodes: { type: "integer" } },
      additionalProperties: false,
    },
  }));
  const catalog = catalogWith([changed]);
  assert.equal(registry.reconcile(catalog), true);
  assert.ok(registry.get(first.name).inputSchema.properties.maxNodes);

  const empty = catalogWith([]);
  assert.equal(registry.reconcile(empty), true);
  assert.equal(registry.get(first.name), null);
  assert.equal(registry.get(bootstrap.name), bootstrap);
});
