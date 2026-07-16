import assert from "node:assert/strict";
import test from "node:test";

import {
  canReplayAfterLostTicket,
  buildTargetHeaders,
  createRequestId,
  getReloadReconnectBudgetMs,
  isTransientError,
  normalizeEditorCommandResult,
  normalizeRecoveredAssetRefreshJob,
  normalizeTerminalQueueStatus,
  sendCommand,
} from "../src/unity-editor-bridge.js";
import { runWithRequestContext } from "../src/request-context.js";
import { injectEditorBindingSchema } from "../src/tool-schema.js";
import { normalizeProjectPath } from "../src/instance-discovery.js";
import { editorTools } from "../src/tools/editor-tools.js";
import { hubTools } from "../src/tools/hub-tools.js";
import { instanceTools } from "../src/tools/instance-tools.js";
import { contextTools } from "../src/tools/context-tools.js";
import { staticFirstClassPluginTools } from "../src/tools/plugin-first-class-tools.js";
import { umaTools } from "../src/tools/uma-tools.js";
import {
  createAdvertisedToolRegistry,
  pluginToolsFingerprint,
  splitToolTiers,
} from "../src/tool-tiers.js";

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

test("completed queue tickets propagate nested Editor failures", () => {
  const result = normalizeTerminalQueueStatus({
    ticketId: 43,
    actionName: "packages/update-git",
    status: "Completed",
    result: {
      success: true,
      data: {
        success: false,
        error: "Unable to resolve Git package.",
        errorCode: "package_resolve_failed",
      },
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.error, "Unable to resolve Git package.");
  assert.equal(result.errorCode, "package_resolve_failed");
  assert.equal(result.ticketId, 43);
  assert.equal(result.actionName, "packages/update-git");
});

test("legacy Editor responses propagate error-only payloads", () => {
  const result = normalizeEditorCommandResult({ error: "Package Manager rejected the ref." });
  assert.equal(result.success, false);
  assert.equal(result.error, "Package Manager rejected the ref.");
  assert.equal(result.errorCode, "editor_command_failed");
});

test("incomplete reload JSON is a transient transport failure", () => {
  assert.equal(isTransientError(new SyntaxError("Unexpected end of JSON input"), null), true);
  assert.equal(isTransientError(new Error("other side closed"), null), true);
  assert.equal(isTransientError(new SyntaxError("Unexpected token at position 4"), null), false);
});

test("only explicitly replayable reload-safe routes are retried", () => {
  assert.equal(canReplayAfterLostTicket("wait/editor-idle"), true);
  assert.equal(canReplayAfterLostTicket("testing/list-tests"), true);
  assert.equal(canReplayAfterLostTicket("testing/get-package-job"), true);
  assert.equal(canReplayAfterLostTicket("asset/refresh"), true);
  assert.equal(canReplayAfterLostTicket("asset/get-refresh-job"), true);
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
  assert.ok(getReloadReconnectBudgetMs("asset/get-refresh-job", {}) >= 300_000);
  assert.ok(getReloadReconnectBudgetMs("asset/get-refresh-job", { timeoutMs: 420_000 }) >= 420_000);
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

test("explicit project binding overrides stale discovered instance identity", () => {
  const headers = buildTargetHeaders({
    projectPath: "D:/UnityProjects/StaleProject",
    projectName: "StaleProject",
  }, "agent-42", {}, {
    expectedProjectPath: "D:\\UnityProjects\\BattleIdle\\apps\\game-client-unity",
    expectedProjectName: "BattleIdle",
  });
  assert.equal(headers["X-UnityMCP-Expected-Project-Path"],
    "D:\\UnityProjects\\BattleIdle\\apps\\game-client-unity");
  assert.equal(headers["X-UnityMCP-Expected-Project-Name"], "BattleIdle");
});

test("project identity comparison accepts Windows slash and casing differences", () => {
  assert.equal(
    normalizeProjectPath("D:\\UnityProjects\\BattleIdle\\apps\\game-client-unity\\"),
    normalizeProjectPath("d:/unityprojects/battleidle/apps/game-client-unity")
  );
});

test("first-class Editor schemas expose explicit project binding", () => {
  for (const name of ["unity_asset_refresh", "unity_execute_code", "unity_play_mode"]) {
    const schema = injectEditorBindingSchema(name, {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    });
    assert.ok(schema.properties.port, name);
    assert.ok(schema.properties.expectedProjectPath, name);
    assert.deepEqual(schema.required, ["value"]);
  }

  assert.equal(injectEditorBindingSchema("unity_list_instances", {
    type: "object", properties: {},
  }).properties.expectedProjectPath, undefined);
  assert.equal(injectEditorBindingSchema("unity_hub_list_projects", {
    type: "object", properties: {},
  }).properties.expectedProjectPath, undefined);
});

test("asset refresh recovery returns persistent job truth instead of transport failure", () => {
  const succeeded = normalizeRecoveredAssetRefreshJob({
    jobId: "refresh-1",
    status: "succeeded",
    success: true,
  }, {
    errorCode: "queue_poll_timeout",
    error: "outer poll timed out",
    ticketId: 91,
  }, "request-1");
  assert.equal(succeeded.success, true);
  assert.equal(succeeded.data.jobId, "refresh-1");
  assert.equal(succeeded.data.recoveredAfterTransportFailure, true);
  assert.equal(succeeded.data.transportFailure.errorCode, "queue_poll_timeout");

  const failed = normalizeRecoveredAssetRefreshJob({
    jobId: "refresh-2",
    status: "failed",
    error: "import failed",
  }, { error: "connection lost" }, "request-2");
  assert.equal(failed.success, false);
  assert.equal(failed.error, "import failed");
  assert.equal(normalizeRecoveredAssetRefreshJob({ status: "succeeded" }, {}, "request-3"), null);
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

test("advertised project tools remain callable across volatile instance catalog refreshes", () => {
  const core = { name: "unity_editor_ping", handler: () => "pong" };
  const battleToolV1 = {
    name: "unity_pt_battle_get_runtime_ready_state",
    handler: () => "battle-v1",
  };
  const registry = createAdvertisedToolRegistry([core]);

  registry.remember([battleToolV1]);
  registry.remember([]);

  assert.equal(registry.get(battleToolV1.name), battleToolV1);
  assert.equal(registry.get(battleToolV1.name).handler(), "battle-v1");

  const battleToolV2 = {
    name: battleToolV1.name,
    handler: () => "battle-v2",
  };
  registry.remember([battleToolV2]);
  assert.equal(registry.get(battleToolV1.name), battleToolV2);
  assert.equal(registry.get(battleToolV1.name).handler(), "battle-v2");
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
  assert.ok(exposed.length <= 106, `expected <=106 tools, got ${exposed.length}`);
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

  const configureComponent = exposedByName.get("unity_prefab_asset_configure_component");
  assert.ok(configureComponent);
  assert.deepEqual(configureComponent.inputSchema.required, ["assetPath", "componentType"]);
  assert.ok(configureComponent.inputSchema.properties.properties);
  assert.ok(configureComponent.inputSchema.properties.references.items.properties.referenceAssetPath);

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
  assert.deepEqual(Object.keys(refreshJob.inputSchema.properties),
    ["jobId", "refreshRequestId", "clear", "timeoutMs"]);
});

test("asset refresh queue failure is reconciled by exact persistent request ID", async () => {
  const originalFetch = globalThis.fetch;
  let submittedRequestId = "";
  let recoveryRequestId = "";

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/api/queue/submit")) {
      const body = JSON.parse(options.body);
      submittedRequestId = body.requestId;
      assert.equal(options.headers["X-UnityMCP-Expected-Project-Path"],
        "D:/UnityProjects/BattleIdle/apps/game-client-unity");
      return Response.json({ ticketId: 17 });
    }
    if (target.includes("/api/queue/status?ticketId=17")) {
      return Response.json({
        ticketId: 17,
        actionName: "asset/refresh",
        status: "TimedOut",
        errorCode: "request_timed_out",
        retryable: false,
        result: { success: false, error: "outer request timed out" },
      });
    }
    if (target.endsWith("/api/asset/get-refresh-job")) {
      recoveryRequestId = JSON.parse(options.body).refreshRequestId;
      return Response.json({
        success: true,
        jobId: "refresh-17",
        status: "succeeded",
      });
    }
    throw new Error(`unexpected fetch ${target}`);
  };

  try {
    const result = await runWithRequestContext({
      agentId: "agent-refresh",
      portOverride: 7891,
      targetInstance: {
        port: 7891,
        projectPath: "D:/UnityProjects/BattleIdle/apps/game-client-unity",
        projectName: "BattleIdle",
      },
      expectedProjectPath: "D:/UnityProjects/BattleIdle/apps/game-client-unity",
    }, () => sendCommand("asset/refresh", { assetPaths: ["Assets/test.uss"] }));

    assert.equal(result.success, true);
    assert.equal(result.data.jobId, "refresh-17");
    assert.equal(result.data.recoveredAfterTransportFailure, true);
    assert.ok(submittedRequestId);
    assert.equal(recoveryRequestId, submittedRequestId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
