import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
  getQueueInfo,
  getTicketStatus,
  cancelTicket,
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
import { invokeWithToolAdapter } from
  "../src/catalog/tool-invocation-adapters.js";
import {
  discoverInstances,
  normalizeProjectPath,
  refreshRequestProjectPathBinding,
} from "../src/instance-discovery.js";

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
    const result = await runWithRequestContext(testRequestContext(), () =>
      invokeWithToolAdapter("graphics/asset-preview", () =>
        sendCommand("graphics/asset-preview", {
          assetPath: "Assets/Preview.prefab",
        })));

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
      const result = await runWithRequestContext(testRequestContext(), () =>
        invokeWithToolAdapter("graphics/asset-preview", () =>
          sendCommand("graphics/asset-preview", {
            assetPath: "Assets/Preview.prefab",
          })));
      const failure = result;

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
      const result = await runWithRequestContext(testRequestContext(), () =>
        invokeWithToolAdapter("graphics/material-info", () =>
          sendCommand("graphics/material-info", {
            assetPath: "Assets/Preview.mat",
          })));

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

test("test runner returns the started job without hidden follow-up polling", async () => {
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
    throw new Error(`unexpected fetch ${target}`);
  };

  try {
    const result = await runWithRequestContext(testRequestContext(), () =>
      sendCommand("testing/run-tests", { mode: "EditMode" }));

    assert.equal(submitCount, 1);
    assert.deepEqual(result.data, {
      jobId: "test-job-1",
      status: "running",
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

test("only explicit transport-safe routes control lost-ticket replay", () => {
  assert.equal(canReplayAfterLostTicket("compilation/errors"), false);
  assert.equal(canReplayAfterLostTicket("console/query"), false);
  assert.equal(canReplayAfterLostTicket("search/scene"), false);
  assert.equal(canReplayAfterLostTicket("wait/editor-idle"), true);
  assert.equal(canReplayAfterLostTicket("testing/list-tests"), true);
  assert.equal(canReplayAfterLostTicket("testing/get-package-job"), true);
  assert.equal(canReplayAfterLostTicket("asset/refresh"), true);
  assert.equal(canReplayAfterLostTicket("asset/get-refresh-job"), true);
  assert.equal(canReplayAfterLostTicket("component/set-reference"), false);
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

test("an in-flight project-path binding follows the same project to its reload port",
  async (t) => {
    const originalFetch = globalThis.fetch;
    const originalRegistryPath = CONFIG.instanceRegistryPath;
    const originalPollTimeout = CONFIG.queuePollTimeoutMs;
    const originalRecoveryTimeout = CONFIG.queueReloadRecoveryTimeoutMs;
    const originalPollInterval = CONFIG.queuePollIntervalMs;
    const originalPollMax = CONFIG.queuePollMaxMs;
    const projectPath = "D:/UnityProjects/ReloadedProject";
    const oldPort = 32141;
    const newPort = 32142;
    const registryPath = join(
      mkdtempSync(join(tmpdir(), "unity-mcp-project-rebind-")), "instances.json");

    writeFileSync(registryPath, JSON.stringify([{
      port: newPort,
      projectPath,
      projectName: "ReloadedProject",
      lastSeen: new Date().toISOString(),
    }]));
    CONFIG.instanceRegistryPath = registryPath;
    CONFIG.queuePollTimeoutMs = 500;
    CONFIG.queueReloadRecoveryTimeoutMs = 2_000;
    CONFIG.queuePollIntervalMs = 1;
    CONFIG.queuePollMaxMs = 2;

    try {
      for (const staleSignal of [
        "disconnect", "project-mismatch", "structured-project-mismatch",
      ]) {
        await t.test(staleSignal, async () => {
          const submissions = [];
          let oldTicketStatusRead = false;
          let newTicketStatusReads = 0;

          globalThis.fetch = async (url, options = {}) => {
            const target = String(url);
            if (target === `http://127.0.0.1:${newPort}/api/ping`) {
              return Response.json({
                projectPath,
                projectName: "ReloadedProject",
                queueReady: true,
              });
            }
            if (target.endsWith("/api/queue/submit")) {
              submissions.push({
                target,
                requestId: options.headers["Idempotency-Key"],
                expectedProjectPath:
                  options.headers["X-UnityMCP-Expected-Project-Path"],
              });
              return Response.json({ ticketId: submissions.length });
            }
            if (target ===
                `http://127.0.0.1:${oldPort}/api/queue/status?ticketId=1`) {
              oldTicketStatusRead = true;
              if (staleSignal.endsWith("project-mismatch")) {
                return Response.json({
                  success: false,
                  error: "The port now hosts another Unity project.",
                  errorCode: "target_project_mismatch",
                  retryable: false,
                }, { status: staleSignal === "project-mismatch" ? 409 : 200 });
              }

              const error = new Error("fetch failed: ECONNRESET");
              error.code = "ECONNRESET";
              throw error;
            }
            if (target ===
                `http://127.0.0.1:${newPort}/api/queue/status?ticketId=1`) {
              newTicketStatusReads++;
              return Response.json({
                success: false,
                error: "The pre-reload read ticket no longer exists.",
                errorCode: "queue_ticket_not_found",
                retryable: false,
              }, { status: 404 });
            }
            if (target ===
                `http://127.0.0.1:${newPort}/api/queue/status?ticketId=2`) {
              return Response.json({
                ticketId: 2,
                actionName: "asset/get-refresh-job",
                status: "Completed",
                result: {
                  jobId: `refresh-${staleSignal}`,
                  status: "succeeded",
                },
              });
            }
            throw new Error(`unexpected fetch ${target}`);
          };

          const result = await runWithRequestContext({
            agentId: `agent-${staleSignal}`,
            portOverride: oldPort,
            targetInstance: {
              port: oldPort,
              projectPath,
              projectName: "ReloadedProject",
            },
            expectedProjectPath: projectPath,
            allowProjectPathRebind: true,
          }, () => sendCommand("asset/get-refresh-job", {
            jobId: `refresh-${staleSignal}`,
            timeoutMs: 500,
          }));

          assert.equal(result.success, true);
          assert.equal(result.data.status, "succeeded");
          assert.equal(result.data.jobId, `refresh-${staleSignal}`);
          assert.equal(result.replayedAfterLostTicket, true);
          assert.equal(oldTicketStatusRead, true);
          assert.ok(newTicketStatusReads >= 1);
          assert.equal(submissions.length, 2);
          assert.match(submissions[0].target, new RegExp(`:${oldPort}/`));
          assert.match(submissions[1].target, new RegExp(`:${newPort}/`));
          assert.equal(submissions[1].expectedProjectPath, projectPath);
          assert.equal(submissions[0].requestId, submissions[1].requestId);
        });
      }
    } finally {
      globalThis.fetch = originalFetch;
      CONFIG.instanceRegistryPath = originalRegistryPath;
      CONFIG.queuePollTimeoutMs = originalPollTimeout;
      CONFIG.queueReloadRecoveryTimeoutMs = originalRecoveryTimeout;
      CONFIG.queuePollIntervalMs = originalPollInterval;
      CONFIG.queuePollMaxMs = originalPollMax;
    }
  });

test("an explicit port binding never migrates through project-path recovery", async () => {
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCount++;
    throw new Error("explicit port recovery must not perform discovery");
  };

  try {
    const result = await runWithRequestContext({
      agentId: "agent-explicit-port",
      portOverride: 32151,
      targetInstance: {
        port: 32151,
        projectPath: "D:/UnityProjects/ExplicitProject",
        projectName: "ExplicitProject",
      },
      expectedProjectPath: "D:/UnityProjects/ExplicitProject",
      allowProjectPathRebind: false,
    }, () => refreshRequestProjectPathBinding());

    assert.equal(result, null);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("same-port reload replays catalog metadata whose old ticket belongs to another agent", async () => {
  const originalFetch = globalThis.fetch;
  const originalPollTimeout = CONFIG.queuePollTimeoutMs;
  const originalRecoveryTimeout = CONFIG.queueReloadRecoveryTimeoutMs;
  const originalPollInterval = CONFIG.queuePollIntervalMs;
  const originalPollMax = CONFIG.queuePollMaxMs;
  const submissions = [];
  let staleStatusReads = 0;

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/api/queue/submit")) {
      submissions.push(options.headers["Idempotency-Key"]);
      return Response.json({ ticketId: submissions.length === 1 ? 15244 : 16385 });
    }
    if (target.includes("/api/queue/status?ticketId=15244")) {
      staleStatusReads++;
      if (staleStatusReads === 1) {
        const error = new Error("fetch failed: ECONNRESET");
        error.code = "ECONNRESET";
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      return Response.json({
        success: false,
        error: "Ticket belongs to another agent.",
        errorCode: "ticket_owner_mismatch",
        retryable: false,
      });
    }
    if (target.includes("/api/queue/status?ticketId=16385")) {
      return Response.json({
        ticketId: 16385,
        actionName: "_meta/tools",
        status: "Completed",
        result: { counts: { errors: 0, warnings: 0 } },
      });
    }
    throw new Error(`unexpected fetch ${target}`);
  };
  CONFIG.queuePollTimeoutMs = 10;
  CONFIG.queueReloadRecoveryTimeoutMs = 200;
  CONFIG.queuePollIntervalMs = 1;
  CONFIG.queuePollMaxMs = 2;

  try {
    const result = await runWithRequestContext({
      agentId: "agent-same-port-reload",
      portOverride: 7890,
      targetInstance: {
        port: 7890,
        projectPath: "D:/UnityProjects/MarbleBattlers",
        projectName: "MarbleBattlers",
      },
      expectedProjectPath: "D:/UnityProjects/MarbleBattlers",
      allowProjectPathRebind: false,
    }, () => sendCommand("_meta/tools"));

    assert.equal(result.success, true,
      JSON.stringify({ result, submissions, staleStatusReads }));
    assert.deepEqual(result.data.counts, { errors: 0, warnings: 0 });
    assert.equal(result.replayedAfterLostTicket, true);
    assert.equal(submissions.length, 2);
    assert.equal(submissions[0], submissions[1]);
  } finally {
    globalThis.fetch = originalFetch;
    CONFIG.queuePollTimeoutMs = originalPollTimeout;
    CONFIG.queueReloadRecoveryTimeoutMs = originalRecoveryTimeout;
    CONFIG.queuePollIntervalMs = originalPollInterval;
    CONFIG.queuePollMaxMs = originalPollMax;
  }
});

test("queue polling fails closed on 200 structured errors and invalid status envelopes", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({
      success: false,
      error: "Ticket belongs to another agent.",
      errorCode: "ticket_owner_mismatch",
      retryable: false,
    });
    const denied = await pollQueueStatus(72, "asset/get-refresh-job", {});
    assert.equal(denied.success, false);
    assert.equal(denied.errorCode, "ticket_owner_mismatch");
    assert.equal(denied.retryable, false);

    globalThis.fetch = async () => Response.json({ success: true });
    const invalid = await pollQueueStatus(73, "asset/get-refresh-job", {});
    assert.equal(invalid.success, false);
    assert.equal(invalid.errorCode, "invalid_queue_status");
  } finally {
    globalThis.fetch = originalFetch;
  }
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
    assert.match(result.error, /unity_tools_get/);
    assert.equal(result.nextTool, "unity_tools_get");
    assert.deepEqual(result.nextToolArgs, {
      name: "unity_queue_ticket_status",
    });
    assert.equal(result.lastKnownTicket.status, "Queued");
    assert.equal(result.queueState.totalQueued, 1);

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

test("queue control functions use direct control endpoints", async () => {
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
    const info = await getQueueInfo();
    const status = await getTicketStatus(72);
    const canceled = await cancelTicket(73);

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

test("direct queue control endpoints honor structured failures returned with HTTP 200", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("/api/queue/info")) {
      return Response.json({
        success: false,
        error: "Queue unavailable.",
        errorCode: "queue_unavailable",
        retryable: true,
      });
    }
    if (target.includes("/api/queue/status?ticketId=74")) {
      return Response.json({
        success: false,
        error: "Ticket belongs to another agent.",
        errorCode: "ticket_owner_mismatch",
        retryable: false,
      });
    }
    if (target.endsWith("/api/queue/cancel")) {
      return Response.json({
        success: false,
        error: "Request is already executing.",
        errorCode: "request_not_cancelable",
        retryable: false,
      });
    }
    throw new Error(`unexpected fetch ${target}`);
  };

  try {
    const info = await getQueueInfo();
    const status = await getTicketStatus(74);
    const canceled = await cancelTicket(75);
    assert.equal(info.errorCode, "queue_unavailable");
    assert.equal(status.errorCode, "ticket_owner_mismatch");
    assert.equal(canceled.errorCode, "request_not_cancelable");
    assert.equal(info.success, false);
    assert.equal(status.success, false);
    assert.equal(canceled.success, false);
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
    normalizeProjectPath(
      "D:\\UnityProjects\\BattleIdle\\apps\\game-client-unity\\", "win32"),
    normalizeProjectPath(
      "d:/unityprojects/battleidle/apps/game-client-unity", "win32")
  );
});

test("project identity comparison preserves casing on case-sensitive hosts", () => {
  for (const platform of ["linux", "darwin"]) {
    assert.notEqual(
      normalizeProjectPath("/Projects/BattleIdle", platform),
      normalizeProjectPath("/projects/battleidle", platform),
      platform
    );
  }
  assert.equal(
    normalizeProjectPath("/Projects/BattleIdle/", "linux"),
    "/Projects/BattleIdle"
  );
});

test("canonical Editor schemas expose explicit project binding", () => {
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
