import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CONFIG } from "../src/config.js";
import {
  buildQueuePollTimeoutResult,
  canReplayAfterLostTicket,
  buildTargetHeaders,
  createRequestId,
  getQueueSubmitReconnectBudgetMs,
  getReloadReconnectBudgetMs,
  isTransientError,
  isTransientQueueSubmitError,
  normalizeEditorCommandResult,
  normalizeRecoveredAssetRefreshJob,
  normalizeTerminalQueueStatus,
  pollQueueStatus,
  sendCommand,
} from "../src/unity-editor-bridge.js";
import { runWithRequestContext } from "../src/request-context.js";
import { injectEditorBindingSchema } from "../src/tool-schema.js";
import { discoverInstances, normalizeProjectPath } from "../src/instance-discovery.js";
import { editorTools } from "../src/tools/editor-tools.js";
import { hubTools } from "../src/tools/hub-tools.js";
import { instanceTools } from "../src/tools/instance-tools.js";
import { contextTools } from "../src/tools/context-tools.js";
import { staticFirstClassPluginTools } from "../src/tools/plugin-first-class-tools.js";
import {
  createPluginToolsCachePayload,
  createAdvertisedToolRegistry,
  invokeFirstClassPluginRoute,
  isPluginToolsCacheCompatible,
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

test("Editor command failures propagate error-only payloads", () => {
  const result = normalizeEditorCommandResult({ error: "Package Manager rejected the ref." });
  assert.equal(result.success, false);
  assert.equal(result.error, "Package Manager rejected the ref.");
  assert.equal(result.errorCode, "editor_command_failed");
});

test("successful Editor command envelopes unwrap to one bridge data layer", () => {
  assert.deepEqual(normalizeEditorCommandResult({
    success: true,
    data: {
      success: true,
      data: { value: 3 },
    },
  }), {
    success: true,
    data: { value: 3 },
  });
});

test("asset preview unwraps bridge data into valid MCP media blocks", async () => {
  const originalFetch = globalThis.fetch;
  const previewBase64 = Buffer.from("preview-png").toString("base64");
  globalThis.fetch = createCompletedQueueFetch({
    success: true,
    data: {
      assetPath: "Assets/Preview.prefab",
      width: 64,
      height: 32,
      base64: previewBase64,
    },
  });

  try {
    const preview = editorTools.find(
      (tool) => tool.name === "unity_graphics_asset_preview");
    const result = await runWithRequestContext(testRequestContext(), () =>
      preview.handler({ assetPath: "Assets/Preview.prefab" }));

    assert.equal(Array.isArray(result), true);
    assert.deepEqual(result[0], {
      type: "image",
      data: previewBase64,
      mimeType: "image/png",
    });
    assert.deepEqual(JSON.parse(result[1].text), {
      assetPath: "Assets/Preview.prefab",
      width: 64,
      height: 32,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("asset preview reports a structured failure instead of emitting undefined image data",
  async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createCompletedQueueFetch({
      success: true,
      data: { assetPath: "Assets/Preview.prefab" },
    });

    try {
      const preview = editorTools.find(
        (tool) => tool.name === "unity_graphics_asset_preview");
      const result = await runWithRequestContext(testRequestContext(), () =>
        preview.handler({ assetPath: "Assets/Preview.prefab" }));
      const failure = JSON.parse(result);

      assert.equal(failure.success, false);
      assert.equal(failure.errorCode, "asset_preview_payload_missing");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

test("material info preserves its optional inline preview after bridge unwrapping",
  async () => {
    const originalFetch = globalThis.fetch;
    const previewBase64 = Buffer.from("material-png").toString("base64");
    globalThis.fetch = createCompletedQueueFetch({
      success: true,
      data: {
        assetPath: "Assets/Preview.mat",
        shader: "Test/Shader",
        base64: previewBase64,
      },
    });

    try {
      const materialInfo = editorTools.find(
        (tool) => tool.name === "unity_graphics_material_info");
      const result = await runWithRequestContext(testRequestContext(), () =>
        materialInfo.handler({ assetPath: "Assets/Preview.mat" }));

      assert.equal(Array.isArray(result), true);
      assert.equal(result[0].data, previewBase64);
      assert.deepEqual(JSON.parse(result[1].text), {
        assetPath: "Assets/Preview.mat",
        shader: "Test/Shader",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

test("test runner reads the started job before performing its early poll", async () => {
  const originalFetch = globalThis.fetch;
  let submitCount = 0;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("/api/queue/submit")) {
      submitCount++;
      return Response.json({ ticketId: submitCount });
    }
    if (target.includes("/api/queue/status?ticketId=1")) {
      return Response.json({
        ticketId: 1,
        actionName: "testing/run-tests",
        status: "Completed",
        result: {
          success: true,
          data: { jobId: "test-job-1", status: "running" },
        },
      });
    }
    if (target.includes("/api/queue/status?ticketId=2")) {
      return Response.json({
        ticketId: 2,
        actionName: "testing/get-job",
        status: "Completed",
        result: {
          success: true,
          data: { jobId: "test-job-1", status: "succeeded", passed: 3 },
        },
      });
    }
    throw new Error(`unexpected fetch ${target}`);
  };

  try {
    const runTests = editorTools.find(
      (tool) => tool.name === "unity_testing_run_tests");
    const result = await runWithRequestContext(testRequestContext(), () =>
      runTests.handler({ mode: "EditMode" }));

    assert.equal(submitCount, 2);
    assert.deepEqual(JSON.parse(result), {
      jobId: "test-job-1",
      status: "succeeded",
      passed: 3,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createCompletedQueueFetch(result) {
  return async (url) => {
    const target = String(url);
    if (target.endsWith("/api/queue/submit")) {
      return Response.json({ ticketId: 901 });
    }
    if (target.includes("/api/queue/status?ticketId=901")) {
      return Response.json({
        ticketId: 901,
        actionName: "test/command",
        status: "Completed",
        result,
      });
    }
    throw new Error(`unexpected fetch ${target}`);
  };
}

function testRequestContext() {
  return {
    agentId: "agent-editor-tool-envelope",
    portOverride: 7891,
    targetInstance: {
      port: 7891,
      projectPath: "D:/UnityProjects/BattleIdle/apps/game-client-unity",
      projectName: "BattleIdle",
    },
    expectedProjectPath: "D:/UnityProjects/BattleIdle/apps/game-client-unity",
  };
}

test("incomplete reload JSON is a transient transport failure", () => {
  assert.equal(isTransientError(new SyntaxError("Unexpected end of JSON input"), null), true);
  assert.equal(isTransientError(new Error("other side closed"), null), true);
  assert.equal(isTransientError(new SyntaxError("Unexpected token at position 4"), null), false);
});

test("queue submit 404 is transient under the current queue-only plugin contract", () => {
  const error = new Error("HTTP 404: bridge is reloading");
  error.status = 404;
  assert.equal(isTransientQueueSubmitError(error), true);
  assert.ok(getQueueSubmitReconnectBudgetMs(
    "prefab-asset/remove-gameobject", {}, error) >=
    CONFIG.queueReloadRecoveryTimeoutMs);
});

test("a transient queue-submit 404 retries the queue without poisoning later commands",
  async () => {
    const originalFetch = globalThis.fetch;
    const originalRecoveryTimeout = CONFIG.queueReloadRecoveryTimeoutMs;
    const calls = [];
    const requestIds = [];
    let submitCount = 0;

    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      calls.push(target);
      if (target.endsWith("/api/queue/submit")) {
        requestIds.push(options.headers["Idempotency-Key"]);
        submitCount++;
        if (submitCount === 1) {
          return new Response("bridge is reloading", { status: 404 });
        }
        return Response.json({ ticketId: submitCount });
      }
      if (target.includes("/api/queue/status?ticketId=")) {
        return Response.json({
          ticketId: submitCount,
          actionName: "scene/info",
          status: "Completed",
          result: { success: true, data: { sequence: submitCount } },
        });
      }
      throw new Error(`unexpected fetch ${target}`);
    };
    CONFIG.queueReloadRecoveryTimeoutMs = 2_000;

    try {
      const context = {
        agentId: "agent-queue-404",
        portOverride: 7891,
        targetInstance: {
          port: 7891,
          projectPath: "D:/UnityProjects/BattleIdle/apps/game-client-unity",
          projectName: "BattleIdle",
        },
        expectedProjectPath:
          "D:/UnityProjects/BattleIdle/apps/game-client-unity",
      };
      const recovered = await runWithRequestContext(
        context, () => sendCommand("scene/info", {}));
      const next = await runWithRequestContext(
        context, () => sendCommand("scene/info", {}));

      assert.equal(recovered.success, true);
      assert.equal(next.success, true);
      assert.equal(submitCount, 3);
      assert.equal(requestIds[0], requestIds[1]);
      assert.notEqual(requestIds[1], requestIds[2]);
      assert.equal(calls.some((target) =>
        target.endsWith("/api/scene/info")), false);
      assert.equal(calls.filter((target) =>
        target.endsWith("/api/queue/submit")).length, 3);
    } finally {
      globalThis.fetch = originalFetch;
      CONFIG.queueReloadRecoveryTimeoutMs = originalRecoveryTimeout;
    }
  });

test("non-retryable structured queue submission errors keep their Unity error code",
  async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/api/queue/submit")) {
        return Response.json({
          success: false,
          error: "The request reached the wrong Unity project.",
          errorCode: "target_project_mismatch",
          retryable: false,
          actualProjectPath: "D:/OtherProject",
        }, { status: 409 });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    try {
      const result = await runWithRequestContext({
        agentId: "agent-project-mismatch",
        portOverride: 7891,
        targetInstance: {
          port: 7891,
          projectPath: "D:/UnityProjects/BattleIdle/apps/game-client-unity",
          projectName: "BattleIdle",
        },
        expectedProjectPath:
          "D:/UnityProjects/BattleIdle/apps/game-client-unity",
      }, () => sendCommand("scene/info", {}));

      assert.equal(result.success, false);
      assert.equal(result.errorCode, "target_project_mismatch");
      assert.equal(result.retryable, false);
      assert.equal(result.actualProjectPath, "D:/OtherProject");
      assert.equal(result.error.includes("HTTP 409"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

test("queue polling pauses operation time during a bounded reload outage", async () => {
  const originalFetch = globalThis.fetch;
  const originalPollTimeout = CONFIG.queuePollTimeoutMs;
  const originalRecoveryTimeout = CONFIG.queueReloadRecoveryTimeoutMs;
  const originalPollInterval = CONFIG.queuePollIntervalMs;
  const originalPollMax = CONFIG.queuePollMaxMs;
  const unavailableUntil = Date.now() + 80;
  globalThis.fetch = async (url) => {
    if (!String(url).includes("/api/queue/status?ticketId=reload-ticket"))
      throw new Error(`unexpected fetch ${url}`);
    if (Date.now() < unavailableUntil) {
      const error = new Error("fetch failed: ECONNRESET");
      error.code = "ECONNRESET";
      throw error;
    }
    return Response.json({
      ticketId: "reload-ticket",
      actionName: "testing/get-package-job",
      status: "Completed",
      result: { success: true, workflowId: "workflow-survived" },
    });
  };
  CONFIG.queuePollTimeoutMs = 30;
  CONFIG.queueReloadRecoveryTimeoutMs = 200;
  CONFIG.queuePollIntervalMs = 5;
  CONFIG.queuePollMaxMs = 10;

  try {
    const result = await pollQueueStatus(
      "reload-ticket", "testing/get-package-job", {});
    assert.equal(result.success, true);
    assert.equal(result.data.workflowId, "workflow-survived");
  } finally {
    globalThis.fetch = originalFetch;
    CONFIG.queuePollTimeoutMs = originalPollTimeout;
    CONFIG.queueReloadRecoveryTimeoutMs = originalRecoveryTimeout;
    CONFIG.queuePollIntervalMs = originalPollInterval;
    CONFIG.queuePollMaxMs = originalPollMax;
  }
});

test("queue reload recovery returns a finite timeout when the bridge never returns", async () => {
  const originalFetch = globalThis.fetch;
  const originalPollTimeout = CONFIG.queuePollTimeoutMs;
  const originalRecoveryTimeout = CONFIG.queueReloadRecoveryTimeoutMs;
  const originalPollMax = CONFIG.queuePollMaxMs;
  globalThis.fetch = async () => {
    const error = new Error("fetch failed: ECONNREFUSED");
    error.code = "ECONNREFUSED";
    throw error;
  };
  CONFIG.queuePollTimeoutMs = 500;
  CONFIG.queueReloadRecoveryTimeoutMs = 30;
  CONFIG.queuePollMaxMs = 10;

  try {
    const startedAt = Date.now();
    const result = await pollQueueStatus(
      "missing-bridge-ticket", "testing/get-package-job", {});
    assert.equal(result.success, false);
    assert.equal(result.errorCode, "queue_reload_recovery_timeout");
    assert.equal(result.reloadRecoveryTimedOut, true);
    assert.ok(Date.now() - startedAt < 250);
  } finally {
    globalThis.fetch = originalFetch;
    CONFIG.queuePollTimeoutMs = originalPollTimeout;
    CONFIG.queueReloadRecoveryTimeoutMs = originalRecoveryTimeout;
    CONFIG.queuePollMaxMs = originalPollMax;
  }
});

test("fresh Unity BOM registry leases remain discoverable while ping is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const originalRegistryPath = CONFIG.instanceRegistryPath;
  const originalPortStart = CONFIG.portRangeStart;
  const originalPortEnd = CONFIG.portRangeEnd;
  const originalStaleness = CONFIG.registryStalenessTimeoutMs;
  const registryPath = join(
    mkdtempSync(join(tmpdir(), "unity-mcp-reload-discovery-")), "instances.json");
  const port = 32123;
  const baseEntry = {
    port,
    projectName: "ReloadingProject",
    projectPath: "D:/UnityProjects/ReloadingProject",
    processId: process.pid,
    registeredAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    isReloading: true,
    reloadStartedAt: new Date().toISOString(),
  };
  globalThis.fetch = async () => {
    const error = new Error("fetch failed: ECONNREFUSED");
    error.code = "ECONNREFUSED";
    throw error;
  };
  CONFIG.instanceRegistryPath = registryPath;
  CONFIG.portRangeStart = port;
  CONFIG.portRangeEnd = port;
  CONFIG.registryStalenessTimeoutMs = 100;

  try {
    writeFileSync(registryPath, `\uFEFF${JSON.stringify([baseEntry])}`);
    const duringReload = await discoverInstances();
    assert.equal(duringReload.length, 1);
    assert.equal(duringReload[0].projectName, "ReloadingProject");
    assert.equal(duringReload[0].status, "reloading");
    assert.equal(duringReload[0].isReachable, false);

    writeFileSync(registryPath, JSON.stringify([{
      ...baseEntry,
      lastSeen: new Date(Date.now() - 1000).toISOString(),
    }]));
    assert.deepEqual(await discoverInstances(), []);
  } finally {
    globalThis.fetch = originalFetch;
    CONFIG.instanceRegistryPath = originalRegistryPath;
    CONFIG.portRangeStart = originalPortStart;
    CONFIG.portRangeEnd = originalPortEnd;
    CONFIG.registryStalenessTimeoutMs = originalStaleness;
  }
});

test("reachable Unity instances report main-thread queue warm-up separately from liveness", async () => {
  const originalFetch = globalThis.fetch;
  const originalRegistryPath = CONFIG.instanceRegistryPath;
  const originalPortStart = CONFIG.portRangeStart;
  const originalPortEnd = CONFIG.portRangeEnd;
  const registryPath = join(
    mkdtempSync(join(tmpdir(), "unity-mcp-warming-discovery-")), "instances.json");
  const port = 32124;
  const baseEntry = {
    port,
    projectName: "WarmingProject",
    projectPath: "D:/UnityProjects/WarmingProject",
    processId: process.pid,
    registeredAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    isReloading: false,
  };

  globalThis.fetch = async () => Response.json({
    status: "ok",
    queueReady: false,
    projectName: baseEntry.projectName,
    projectPath: baseEntry.projectPath,
    unityVersion: "6000.4.10f1",
  });
  CONFIG.instanceRegistryPath = registryPath;
  CONFIG.portRangeStart = port;
  CONFIG.portRangeEnd = port;

  try {
    writeFileSync(registryPath, JSON.stringify([baseEntry]));
    const instances = await discoverInstances();
    assert.equal(instances.length, 1);
    assert.equal(instances[0].isReachable, true);
    assert.equal(instances[0].queueReady, false);
    assert.equal(instances[0].status, "warming_up");
  } finally {
    globalThis.fetch = originalFetch;
    CONFIG.instanceRegistryPath = originalRegistryPath;
    CONFIG.portRangeStart = originalPortStart;
    CONFIG.portRangeEnd = originalPortEnd;
  }
});

test("a non-terminal queue ticket remains a timeout failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/api/queue/status?ticketId=71")) {
      return Response.json({
        ticketId: 71,
        actionName: "wait/editor-idle",
        status: "Queued",
        queuePosition: 1,
      });
    }
    if (target.endsWith("/api/queue/info")) {
      return Response.json({ totalQueued: 1, executingCount: 0 });
    }
    throw new Error(`unexpected fetch ${target}`);
  };

  try {
    const result = await buildQueuePollTimeoutResult(
      71, "wait/editor-idle", 60_000, 60_250);
    assert.equal(result.success, false);
    assert.equal(result.errorCode, "queue_poll_timeout");
    assert.equal(result.retryable, false);
    assert.match(result.error, /unity_advanced_tool/);
    assert.equal(result.nextTool, "unity_advanced_tool");
    assert.deepEqual(result.nextToolArgs, {
      tool: "unity_queue_ticket_status",
      params: { ticketId: 71 },
    });
    assert.equal(result.lastKnownTicket.status, "Queued");
    assert.equal(result.queueState.totalQueued, 1);

    const { metaTools } = splitToolTiers(editorTools);
    const advancedTool = metaTools.find((tool) => tool.name === result.nextTool);
    const recovered = JSON.parse(await advancedTool.handler(result.nextToolArgs));
    assert.equal(recovered.success, true);
    assert.equal(recovered.data.ticketId, 71);
    assert.equal(recovered.data.status, "Queued");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue submission failure never falls back to a direct command endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const originalRecoveryTimeout = CONFIG.queueReloadRecoveryTimeoutMs;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response("queue unavailable", { status: 404 });
  };
  CONFIG.queueReloadRecoveryTimeoutMs = 5;

  try {
    const result = await sendCommand("scene/info", {});
    assert.equal(result.success, false);
    assert.equal(result.errorCode, "queue_submit_recovery_timeout");
    assert.ok(calls.length >= 1);
    assert.equal(calls.every((url) =>
      new URL(url).pathname === "/api/queue/submit"), true);
  } finally {
    globalThis.fetch = originalFetch;
    CONFIG.queueReloadRecoveryTimeoutMs = originalRecoveryTimeout;
  }
});

test("plugin-declared queue tools use direct control endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.endsWith("/api/queue/info"))
      return Response.json({ totalQueued: 0 });
    if (target.includes("/api/queue/status?ticketId=72"))
      return Response.json({ ticketId: 72, status: "Completed" });
    if (target.endsWith("/api/queue/cancel"))
      return Response.json({ ticketId: 73, status: "Canceled" });
    throw new Error(`unexpected fetch ${target}`);
  };

  try {
    const info = await invokeFirstClassPluginRoute("queue/info");
    const status = await invokeFirstClassPluginRoute("queue/status", { ticketId: 72 });
    const canceled = await invokeFirstClassPluginRoute("queue/cancel", { ticketId: 73 });

    assert.equal(info.success, true);
    assert.equal(status.data.status, "Completed");
    assert.equal(canceled.data.status, "Canceled");
    assert.equal(calls.some(({ target }) => target.endsWith("/api/queue/submit")), false);
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[1].options.method, "GET");
    assert.equal(calls[2].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[2].options.body), { ticketId: 73 });
  } finally {
    globalThis.fetch = originalFetch;
  }
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
    assert.equal(schema.properties.port.type, "integer", name);
    assert.ok(schema.properties.expectedProjectPath, name);
    assert.ok(schema.properties.expectedProjectName, name);
    assert.deepEqual(schema.required, ["value"]);
  }

  assert.equal(injectEditorBindingSchema("unity_list_instances", {
    type: "object", properties: {},
  }).properties.expectedProjectPath, undefined);
  assert.equal(injectEditorBindingSchema("unity_hub_list_projects", {
    type: "object", properties: {},
  }).properties.expectedProjectPath, undefined);
});

test("execute code schema exposes one-off namespace imports and project configuration", () => {
  const executeCode = editorTools.find((tool) => tool.name === "unity_execute_code");
  assert.ok(executeCode);
  assert.equal(executeCode.inputSchema.properties.usings.type, "array");
  assert.equal(executeCode.inputSchema.properties.usings.items.type, "string");
  assert.match(executeCode.inputSchema.properties.usings.description, /Project Settings > Unity MCP/);
  assert.equal(executeCode.inputSchema.properties.includeStackTrace.type, "boolean");
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
    { toolName: "unity_asset_refresh", route: "asset/refresh", tags: ["firstClass"], inputSchema: { type: "object" } },
    { toolName: "unity_asset_list", route: "asset/list", tags: ["firstClass"], inputSchema: { type: "object" } },
  ];
  const reordered = [first[1], first[0]];
  const changed = [
    first[1],
    { ...first[0], inputSchema: { type: "object", required: ["value"] } },
  ];

  assert.equal(pluginToolsFingerprint(first), pluginToolsFingerprint(reordered));
  assert.notEqual(pluginToolsFingerprint(first), pluginToolsFingerprint(changed));
});

test("cold-start plugin metadata cache is bound to the release snapshot", () => {
  const current = createPluginToolsCachePayload([
    { toolName: "unity_prefab_asset_configure_component" },
  ], 1234);

  assert.equal(isPluginToolsCacheCompatible(current), true);
  assert.equal(isPluginToolsCacheCompatible({
    ...current,
    releaseFingerprint: "stale-release-snapshot",
  }), false);
  assert.equal(isPluginToolsCacheCompatible({
    ...current,
    schemaVersion: current.schemaVersion - 1,
  }), false);
});

test("advertised tools remain callable across volatile instance catalog refreshes", () => {
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

test("default tool surface stays bounded and exposes only canonical consolidated tools", () => {
  const { coreTools, metaTools } = splitToolTiers(editorTools);
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
  assert.equal(exposedByName.has("unity_console_log"), false);
  assert.equal(exposedByName.has("unity_console_query"), true);
  assert.equal(exposedByName.has("unity_project_tools_list"), true);
  assert.equal(exposedByName.has("unity_project_tools_get"), true);
  assert.equal(exposedByName.has("unity_project_tools_execute"), true);
  assert.equal([...exposedByName.keys()].some((name) => name.startsWith("unity_uma_")), false);

  const projectToolList = exposedByName.get("unity_project_tools_list");
  const projectToolGet = exposedByName.get("unity_project_tools_get");
  assert.equal("includeSchema" in projectToolList.inputSchema.properties, false);
  assert.deepEqual(projectToolGet.inputSchema.required, ["toolName"]);

  const retiredToolNames = [
    "unity_asset_instantiate_prefab",
    "unity_search_assets",
    "unity_selection_find_by_type",
    "unity_graphics_scene_capture",
    "unity_graphics_game_capture",
    "unity_graphics_prefab_render",
    "unity_graphics_texture_info",
    "unity_texture_set_sprite",
    "unity_texture_set_normalmap",
    "unity_prefab_asset_instantiate_prefab",
    "unity_uitoolkit_wait_refresh",
  ];
  const declaredToolNames = new Set([
    ...editorTools.map((tool) => tool.name),
    ...staticFirstClassPluginTools.map((tool) => tool.toolName),
  ]);
  const manifest = JSON.parse(
    readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const manifestToolNames = new Set(manifest.tools.map((tool) => tool.name));
  for (const toolName of retiredToolNames) {
    assert.equal(declaredToolNames.has(toolName), false, toolName);
    assert.equal(exposedByName.has(toolName), false, toolName);
    assert.equal(manifestToolNames.has(toolName), false, toolName);
  }

  for (const toolName of [
    "unity_asset_list",
    "unity_scene_instantiate_prefab",
    "unity_build_get_job",
    "unity_uitoolkit_refresh",
  ]) {
    assert.equal(exposedByName.has(toolName), true, toolName);
  }

  const staleStaticRoutes = [
    "asset/instantiate-prefab",
    "search/assets",
    "selection/find-by-type",
    "graphics/scene-capture",
    "graphics/game-capture",
    "graphics/prefab-render",
    "graphics/texture-info",
    "texture/set-sprite",
    "texture/set-normalmap",
    "prefab-asset/instantiate-prefab",
    "uitoolkit/wait-refresh",
  ];
  const staticRoutes = new Set(staticFirstClassPluginTools.map((tool) => tool.route));
  for (const route of staleStaticRoutes) {
    assert.equal(staticRoutes.has(route), false, route);
  }

  const assetList = exposedByName.get("unity_asset_list");
  assert.ok(assetList.inputSchema.properties.limit);
  assert.equal(assetList.inputSchema.properties.maxResults, undefined);

  const sceneInstantiate = exposedByName.get("unity_scene_instantiate_prefab");
  assert.deepEqual(sceneInstantiate.inputSchema.required, ["prefabPath"]);
  assert.ok(sceneInstantiate.inputSchema.properties.parent);
  assert.equal(sceneInstantiate.inputSchema.properties.assetPath, undefined);

  assert.equal(exposedByName.has("unity_prefab_asset_transaction_edit"), false);

  const configureComponent = exposedByName.get("unity_prefab_asset_configure_component");
  assert.ok(configureComponent);
  assert.deepEqual(configureComponent.inputSchema.required, ["assetPath", "componentType"]);
  assert.ok(configureComponent.inputSchema.properties.createPathIfMissing);
  assert.ok(configureComponent.inputSchema.properties.properties);
  assert.ok(configureComponent.inputSchema.properties.references.items.properties.referenceAssetPath);

  const assetMove = exposedByName.get("unity_asset_move");
  assert.deepEqual(assetMove.inputSchema.required, ["moves"]);
  assert.ok(assetMove.inputSchema.properties.execution);

  const setReference = exposedByName.get("unity_component_set_reference");
  assert.deepEqual(setReference.inputSchema.required, ["references"]);
  assert.ok(setReference.inputSchema.properties.execution.properties.continueOnError);

  assert.equal(exposedByName.has("unity_localization_upsert_entry"), false);

  const refreshJob = exposedByName.get("unity_asset_get_refresh_job");
  assert.ok(refreshJob);
  assert.deepEqual(Object.keys(refreshJob.inputSchema.properties),
    ["jobId", "refreshRequestId", "clear", "timeoutMs"]);
});

test("scene tools advertise modal-free explicit save behavior", () => {
  const openScene = editorTools.find((tool) => tool.name === "unity_scene_open");
  const saveScene = editorTools.find((tool) => tool.name === "unity_scene_save");
  const newScene = editorTools.find((tool) => tool.name === "unity_scene_new");

  assert.match(openScene.description, /without modal dialogs/i);
  assert.match(newScene.description, /without modal dialogs/i);
  assert.deepEqual(Object.keys(saveScene.inputSchema.properties).sort(),
    ["overwrite", "path"]);
  assert.match(saveScene.description, /explicit asset path/i);
});

test("prefab add component exposes atomic initial serialized properties", () => {
  const addComponent = editorTools.find(
    (tool) => tool.name === "unity_prefab_add_component"
  );

  assert.ok(addComponent);
  assert.match(addComponent.description, /optionally initialize/i);
  assert.deepEqual(addComponent.inputSchema.required,
    ["assetPath", "componentType"]);
  const properties = addComponent.inputSchema.properties.properties;
  assert.equal(properties.type, "object");
  assert.equal(properties.additionalProperties, true);
  assert.match(properties.description, /before the new component is saved/i);
});

test("prefab add GameObject uses the bridge parent-path contract", () => {
  const addGameObject = editorTools.find(
    (tool) => tool.name === "unity_prefab_add_gameobject"
  );

  assert.ok(addGameObject);
  assert.ok(addGameObject.inputSchema.properties.parentPrefabPath);
  assert.equal(addGameObject.inputSchema.properties.prefabPath, undefined);
});

test("asset refresh queue failure is reconciled by exact persistent request ID", async () => {
  const originalFetch = globalThis.fetch;
  let submittedRequestId = "";
  let recoveryRequestId = "";

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/api/queue/submit")) {
      const body = JSON.parse(options.body);
      assert.equal(options.headers["X-UnityMCP-Expected-Project-Path"],
        "D:/UnityProjects/BattleIdle/apps/game-client-unity");
      if (body.apiPath === "asset/refresh") {
        submittedRequestId = options.headers["Idempotency-Key"];
        return Response.json({ ticketId: 17 });
      }
      if (body.apiPath === "asset/get-refresh-job") {
        recoveryRequestId = JSON.parse(body.body).refreshRequestId;
        return Response.json({ ticketId: 18 });
      }
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
    if (target.includes("/api/queue/status?ticketId=18")) {
      return Response.json({
        ticketId: 18,
        actionName: "asset/get-refresh-job",
        status: "Completed",
        result: {
          jobId: "refresh-17",
          status: "succeeded",
        },
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
