import assert from "node:assert/strict";
import test from "node:test";

import {
  canReplayAfterLostTicket,
  buildTargetHeaders,
  createRequestId,
  getReloadReconnectBudgetMs,
  normalizeTerminalQueueStatus,
} from "../src/unity-editor-bridge.js";
import { editorTools } from "../src/tools/editor-tools.js";
import { hubTools } from "../src/tools/hub-tools.js";
import { instanceTools } from "../src/tools/instance-tools.js";
import { contextTools } from "../src/tools/context-tools.js";
import { staticFirstClassPluginTools } from "../src/tools/plugin-first-class-tools.js";
import { umaTools } from "../src/tools/uma-tools.js";
import { pluginToolsFingerprint, splitToolTiers } from "../src/tool-tiers.js";

test("UncertainAfterReload is a non-retryable failed terminal status", () => {
  const result = normalizeTerminalQueueStatus({
    ticketId: 42,
    actionName: "wait/editor-idle",
    status: "UncertainAfterReload",
    retryable: false,
    errorCode: "mutation_outcome_uncertain_after_reload",
    result: {
      success: false,
      error: "The mutation outcome is uncertain after a Unity domain reload.",
      errorCode: "mutation_outcome_uncertain_after_reload",
      retryable: false,
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.status, "UncertainAfterReload");
  assert.equal(result.errorCode, "mutation_outcome_uncertain_after_reload");
  assert.equal(result.retryable, false);
});

test("only explicitly replayable reload-safe routes are retried", () => {
  assert.equal(canReplayAfterLostTicket("wait/editor-idle"), true);
  assert.equal(canReplayAfterLostTicket("testing/list-tests"), true);
  assert.equal(canReplayAfterLostTicket("testing/get-package-job"), true);
  assert.equal(canReplayAfterLostTicket("asset/refresh"), true);
  assert.equal(canReplayAfterLostTicket("prefab-asset/remove-gameobject"), false);
});

test("reload-safe waits use their full command timeout instead of a fixed retry count", () => {
  const defaultBudget = getReloadReconnectBudgetMs("wait/editor-idle", {});
  const longWaitBudget = getReloadReconnectBudgetMs("wait/editor-idle", {
    timeoutMs: 180_000,
    stableMs: 2_000,
  });

  assert.ok(defaultBudget >= 120_000);
  assert.ok(longWaitBudget >= 212_000);
  assert.equal(getReloadReconnectBudgetMs("prefab-asset/remove-gameobject", {}), 0);
});

test("mutating transport headers bind agent and selected Unity project", () => {
  const headers = buildTargetHeaders({
    projectPath: "D:/UnityProjects/BattleIdle/apps/game-client-unity",
    projectName: "BattleIdle",
  }, "agent-42", { "Content-Type": "application/json" });
  assert.equal(headers["X-Agent-Id"], "agent-42");
  assert.equal(headers["X-UnityMCP-Expected-Project-Path"],
    "D:/UnityProjects/BattleIdle/apps/game-client-unity");
  assert.equal(headers["X-UnityMCP-Expected-Project-Name"], "BattleIdle");
});

test("generated idempotency keys are unique command-scoped values", () => {
  const first = createRequestId("asset/create-folder");
  const second = createRequestId("asset/create-folder");
  assert.notEqual(first, second);
  assert.match(first, /asset\/create-folder/);
});

test("plugin tool metadata fingerprint is order independent and schema sensitive", () => {
  const first = [
    { toolName: "unity_b", route: "b/run", firstClass: true, inputSchema: { type: "object" } },
    { toolName: "unity_a", route: "a/run", firstClass: true, inputSchema: { type: "object" } },
  ];
  const reordered = [first[1], first[0]];
  const changed = [
    first[1],
    { ...first[0], inputSchema: { type: "object", required: ["value"] } },
  ];

  assert.equal(pluginToolsFingerprint(first), pluginToolsFingerprint(reordered));
  assert.notEqual(pluginToolsFingerprint(first), pluginToolsFingerprint(changed));
});

test("default tool surface stays bounded and omits duplicate prefab aliases", () => {
  const { coreTools, metaTools } = splitToolTiers([...editorTools, ...umaTools]);
  const exposedByName = new Map(
    [...instanceTools, ...hubTools, ...coreTools, ...metaTools, ...contextTools]
      .map((tool) => [tool.name, tool])
  );
  for (const tool of staticFirstClassPluginTools) {
    if (!exposedByName.has(tool.toolName)) {
      exposedByName.set(tool.toolName, {
        name: tool.toolName,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
  }

  const exposed = [...exposedByName.values()];
  assert.ok(exposed.length <= 105, `expected <=105 tools, got ${exposed.length}`);
  assert.ok(JSON.stringify({ tools: exposed }).length <= 60_000);
  assert.equal(JSON.stringify(exposed).includes("Alias for"), false);
  assert.equal(exposedByName.has("unity_prefab_asset_batch_edit"), false);
  assert.equal(exposedByName.has("unity_asset_move_batch"), false);
  assert.equal(exposedByName.has("unity_component_batch_wire"), false);
  assert.equal(exposedByName.has("unity_localization_upsert_entries"), false);
  assert.equal(exposedByName.has("unity_prefab_asset_instantiate_child_prefab"), false);

  const transaction = exposedByName.get("unity_prefab_asset_transaction_edit");
  assert.ok(transaction);
  assert.ok(JSON.stringify(transaction.inputSchema).length < 2_500);
  assert.deepEqual(transaction.inputSchema.properties.execution.properties.mode.enum,
    ["auto", "immediate", "batched"]);
  assert.equal(transaction.inputSchema.properties.execution.properties.continueOnError, undefined);

  const assetMove = exposedByName.get("unity_asset_move");
  assert.deepEqual(assetMove.inputSchema.required, ["moves"]);
  assert.ok(assetMove.inputSchema.properties.execution);

  const setReference = exposedByName.get("unity_component_set_reference");
  assert.deepEqual(setReference.inputSchema.required, ["references"]);
  assert.ok(setReference.inputSchema.properties.execution.properties.continueOnError);

  const localizationUpsert = exposedByName.get("unity_localization_upsert_entry");
  assert.deepEqual(localizationUpsert.inputSchema.required, ["collection", "entries"]);
  assert.ok(localizationUpsert.inputSchema.properties.execution);

  const refreshJob = exposedByName.get("unity_asset_get_refresh_job");
  assert.ok(refreshJob);
  assert.deepEqual(Object.keys(refreshJob.inputSchema.properties), ["jobId", "clear"]);
});
