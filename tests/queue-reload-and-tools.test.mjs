import assert from "node:assert/strict";
import test from "node:test";

import {
  canReplayAfterLostTicket,
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

test("LostAfterReload is a failed terminal status", () => {
  const result = normalizeTerminalQueueStatus({
    ticketId: 42,
    actionName: "wait/editor-idle",
    status: "LostAfterReload",
    retryable: true,
    errorCode: "ticket_lost_after_reload",
    result: {
      success: false,
      error: "Ticket state was lost after a Unity domain reload.",
      errorCode: "ticket_lost_after_reload",
      retryable: true,
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.status, "LostAfterReload");
  assert.equal(result.errorCode, "ticket_lost_after_reload");
  assert.equal(result.retryable, true);
});

test("only explicitly replayable reload-safe routes are retried", () => {
  assert.equal(canReplayAfterLostTicket("wait/editor-idle"), true);
  assert.equal(canReplayAfterLostTicket("testing/list-tests"), true);
  assert.equal(canReplayAfterLostTicket("testing/get-package-job"), true);
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
});
