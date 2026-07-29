import assert from "node:assert/strict";
import test from "node:test";

import { STATIC_FIRST_CLASS_PLUGIN_ROUTES } from "../src/plugin-tool-policy.js";
import { auditToolCatalog } from "../src/tool-schema-audit.js";
import { contextTools } from "../src/tools/context-tools.js";
import { editorTools } from "../src/tools/editor-tools.js";
import { hubTools } from "../src/tools/hub-tools.js";
import { instanceTools } from "../src/tools/instance-tools.js";
import { staticFirstClassPluginTools } from "../src/tools/plugin-first-class-tools.js";
import { splitToolTiers } from "../src/tool-tiers.js";

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
