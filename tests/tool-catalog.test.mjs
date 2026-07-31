import assert from "node:assert/strict";
import test from "node:test";

import { STATIC_FIRST_CLASS_PLUGIN_ROUTES } from "../src/plugin-tool-policy.js";
import { auditToolCatalog } from "../src/tool-schema-audit.js";
import { contextTools } from "../src/tools/context-tools.js";
import { editorTools } from "../src/tools/editor-tools.js";
import { hubTools } from "../src/tools/hub-tools.js";
import { instanceTools } from "../src/tools/instance-tools.js";
import { staticFirstClassPluginTools } from "../src/tools/plugin-first-class-tools.js";
import {
  mergeFirstClassPluginToolMetadata,
  splitToolTiers,
} from "../src/tool-tiers.js";

test("static server tools have complete descriptions and array schemas", () => {
  const { coreTools, metaTools } = splitToolTiers(editorTools);
  const issues = auditToolCatalog([
    ...instanceTools,
    ...hubTools,
    ...coreTools,
    ...metaTools,
    ...contextTools,
  ]);
  assert.deepEqual(issues, []);
});

test("generated plugin snapshot exactly implements the first-class route policy", () => {
  assert.deepEqual(
    staticFirstClassPluginTools.map((tool) => tool.route),
    STATIC_FIRST_CLASS_PLUGIN_ROUTES
  );
  assert.deepEqual(
    auditToolCatalog(staticFirstClassPluginTools, { requireRoute: true }),
    []
  );
});

test("tool catalog audit rejects malformed output schemas", () => {
  const issues = auditToolCatalog([
    {
      name: "malformed_output",
      description: "Exercise output schema validation.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      outputSchema: {
        type: "object",
        properties: {
          tags: [
            "[items, System.Collections.Generic.Dictionary`2[System.String,System.Object]]",
            "[type, array]",
          ],
        },
      },
    },
  ]);

  assert.ok(issues.some((issue) =>
    issue.code === "schema_not_object" &&
    issue.path === "$.outputSchema.tags"
  ));
});

test("incomplete live metadata cannot erase a release-managed build schema", () => {
  const buildSnapshot = staticFirstClassPluginTools.find(
    (tool) => tool.toolName === "unity_build");
  assert.ok(buildSnapshot);
  assert.deepEqual(buildSnapshot.inputSchema.required, ["outputPath"]);
  assert.ok(buildSnapshot.inputSchema.properties.target);
  assert.ok(buildSnapshot.inputSchema.properties.overwrite);
  assert.ok(buildSnapshot.inputSchema.properties.run);
  assert.ok(buildSnapshot.inputSchema.properties.terminateAfter);

  const merged = mergeFirstClassPluginToolMetadata(buildSnapshot, {
    toolName: "unity_build",
    route: "build/start",
    category: "build",
    description: "Live build metadata without schemas.",
    tags: ["firstClass", "longRunning"],
  });
  assert.equal(merged.description, "Live build metadata without schemas.");
  assert.deepEqual(merged.inputSchema, buildSnapshot.inputSchema);
  assert.deepEqual(merged.outputSchema, buildSnapshot.outputSchema);
});

test("editor state declares its compact process-state contract", () => {
  const editorState = editorTools.find((tool) => tool.name === "unity_editor_state");
  assert.ok(editorState);
  assert.ok(editorState.description.includes("presence-only tags"));
  assert.deepEqual(editorState.outputSchema.required, [
    "tags",
    "activeScene",
    "activeScenePath",
    "sceneDirty",
    "unityVersion",
    "platform",
    "projectPath",
  ]);
  assert.equal(editorState.outputSchema.properties.tags.minItems, 1);
  assert.ok(editorState.outputSchema.properties.tags.items.enum.includes("idle"));
});

test("overlapping scene searches are available through one canonical first-class tool", () => {
  const { coreTools } = splitToolTiers(editorTools);
  const coreNames = new Set(coreTools.map((tool) => tool.name));

  assert.equal(coreNames.has("unity_search_by_name"), false);
  assert.equal(coreNames.has("unity_search_by_component"), false);
  assert.equal(
    STATIC_FIRST_CLASS_PLUGIN_ROUTES.includes("search/scene"),
    true
  );
});
