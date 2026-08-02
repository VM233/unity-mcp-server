import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(repositoryRoot, "src", "index.js");
const runtimeFixture = join(
  repositoryRoot, "tests", "fixtures", "hot-reload-runtime.mjs");

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

test("hot reload preserves one MCP stdio session and drains active requests", {
  timeout: 30_000,
}, async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "unity-mcp-server-hot-reload-"));
  const stateFile = join(tempRoot, "runtime-state.json");
  writeFileSync(stateFile, JSON.stringify({ version: "v1" }));

  const client = new Client(
    { name: "hot-reload-proxy-test", version: "1.0.0" },
    { capabilities: {} }
  );
  let listChangedCount = 0;
  const listChangedWaiters = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChangedCount += 1;
    for (const waiter of [...listChangedWaiters]) {
      if (listChangedCount >= waiter.target) {
        clearTimeout(waiter.timer);
        listChangedWaiters.splice(listChangedWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  });
  const waitForListChanged = (target) => {
    if (listChangedCount >= target) return Promise.resolve();
    return new Promise((resolveWait, rejectWait) => {
      const waiter = {
        target,
        resolve: resolveWait,
        timer: setTimeout(() => {
          listChangedWaiters.splice(listChangedWaiters.indexOf(waiter), 1);
          rejectWait(new Error(`tools/list_changed ${target} timed out`));
        }, 8_000),
      };
      listChangedWaiters.push(waiter);
    });
  };

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [launcher],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      UNITY_MCP_RUNTIME_ENTRY: runtimeFixture,
      UNITY_MCP_HOT_RELOAD_WATCH_PATHS: stateFile,
      UNITY_MCP_HOT_RELOAD_TEST_STATE: stateFile,
      UNITY_MCP_HOT_RELOAD_DEBOUNCE_MS: "25",
      UNITY_MCP_HOT_RELOAD_INIT_TIMEOUT_MS: "5000",
    },
    stderr: "pipe",
  });

  let stderr = "";
  const stderrWaiters = [];
  transport.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    for (const waiter of [...stderrWaiters]) {
      if (stderr.includes(waiter.text)) {
        clearTimeout(waiter.timer);
        stderrWaiters.splice(stderrWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  });
  const waitForStderr = (text) => {
    if (stderr.includes(text)) return Promise.resolve();
    return new Promise((resolveWait, rejectWait) => {
      const waiter = {
        text,
        resolve: resolveWait,
        timer: setTimeout(() => {
          stderrWaiters.splice(stderrWaiters.indexOf(waiter), 1);
          rejectWait(new Error(
            `stderr did not contain ${JSON.stringify(text)}\n${stderr}`));
        }, 8_000),
      };
      stderrWaiters.push(waiter);
    });
  };

  try {
    await client.connect(transport);
    const proxyPid = transport.pid;
    assert.ok(proxyPid, "stable proxy process did not start");

    const initialTools = await client.listTools();
    assert.equal(initialTools.tools[0].description, "Hot reload fixture v1");
    const first = await client.callTool({
      name: "hot_reload_probe",
      arguments: {},
    });
    assert.equal(first.structuredContent.version, "v1");

    const inFlight = client.callTool({
      name: "hot_reload_probe",
      arguments: { delayMs: 200 },
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    writeFileSync(stateFile, JSON.stringify({ version: "v2" }));

    const drained = await inFlight;
    assert.equal(drained.structuredContent.version, "v1");
    await withTimeout(
      waitForListChanged(1), 10_000, "first hot reload notification timed out");
    assert.equal(transport.pid, proxyPid, "Codex-facing stdio process changed");

    const secondTools = await client.listTools();
    assert.equal(secondTools.tools[0].description, "Hot reload fixture v2");
    const second = await client.callTool({
      name: "hot_reload_probe",
      arguments: {},
    });
    assert.equal(second.structuredContent.version, "v2");
    assert.notEqual(second.structuredContent.runtimePid,
      first.structuredContent.runtimePid);
    assert.equal(second.structuredContent.agentId, first.structuredContent.agentId);

    writeFileSync(stateFile, "not-json");
    await waitForStderr("Candidate runtime rejected; continuing generation");
    const afterRejectedCandidate = await client.callTool({
      name: "hot_reload_probe",
      arguments: {},
    });
    assert.equal(afterRejectedCandidate.structuredContent.version, "v2");

    writeFileSync(stateFile, JSON.stringify({ version: "v3" }));
    await withTimeout(
      waitForListChanged(2), 10_000, "second hot reload notification timed out");
    const third = await client.callTool({
      name: "hot_reload_probe",
      arguments: {},
    });
    assert.equal(third.structuredContent.version, "v3");
    assert.equal(third.structuredContent.agentId, first.structuredContent.agentId);
    assert.equal(transport.pid, proxyPid, "stdio proxy changed after second reload");

    writeFileSync(stateFile, JSON.stringify({
      version: "capability-change",
      resourcesCapability: true,
    }));
    await waitForStderr("candidate changed the MCP capability envelope");
    const afterCapabilityChange = await client.callTool({
      name: "hot_reload_probe",
      arguments: {},
    });
    assert.equal(afterCapabilityChange.structuredContent.version, "v3");

    writeFileSync(stateFile, JSON.stringify({ version: "v4" }));
    await withTimeout(
      waitForListChanged(3), 10_000, "third hot reload notification timed out");
    const fourth = await client.callTool({
      name: "hot_reload_probe",
      arguments: {},
    });
    assert.equal(fourth.structuredContent.version, "v4");

    const recoveryNotification = waitForListChanged(4);
    await assert.rejects(
      client.callTool({
        name: "hot_reload_probe",
        arguments: { crash: true },
      }),
      /runtime exited before this request completed/i
    );
    await withTimeout(
      recoveryNotification, 10_000, "runtime recovery notification timed out");
    const recovered = await client.callTool({
      name: "hot_reload_probe",
      arguments: {},
    });
    assert.equal(recovered.structuredContent.version, "v4");
    assert.equal(recovered.structuredContent.agentId, first.structuredContent.agentId);
    assert.notEqual(recovered.structuredContent.runtimePid,
      fourth.structuredContent.runtimePid);
    assert.equal(transport.pid, proxyPid, "stdio proxy changed after recovery");
  } finally {
    await transport.close().catch(() => {});
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
