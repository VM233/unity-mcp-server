import assert from "node:assert/strict";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const targets = JSON.parse(process.env.UNITY_BINDING_TARGETS || "[]");
assert.ok(Array.isArray(targets) && targets.length > 0,
  "UNITY_BINDING_TARGETS must be a non-empty JSON array");

const client = new Client({ name: "unity-mcp-multi-instance-binding-test", version: "1.0.0" },
  { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(serverRoot, "src", "index.js")],
  cwd: serverRoot,
  env: process.env,
  stderr: "inherit",
});

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function parseToolResponse(response, label) {
  assert.equal(response.isError, undefined, `${label}: MCP call failed: ${JSON.stringify(response)}`);
  const text = [...response.content]
    .reverse()
    .find((block) => block.type === "text" && block.text.trimStart().startsWith("{"))
    ?.text;
  assert.ok(text, `${label}: no JSON response: ${JSON.stringify(response)}`);
  return JSON.parse(text);
}

function unwrapSuccess(response, label) {
  let value = parseToolResponse(response, label);
  for (let depth = 0; depth < 4; depth++) {
    if (value?.success === false) {
      assert.fail(`${label}: ${JSON.stringify(value)}`);
    }
    if (value?.success === true && value.data && typeof value.data === "object") {
      value = value.data;
      continue;
    }
    break;
  }
  return value;
}

async function call(name, args, label = name) {
  return unwrapSuccess(await client.callTool({ name, arguments: args }), label);
}

async function waitForRefresh(target, start) {
  if (!start?.jobId || ["succeeded", "failed", "canceled", "cancelled"].includes(start.status)) {
    return start;
  }

  for (let attempt = 0; attempt < 120; attempt++) {
    const job = await call("unity_asset_get_refresh_job", {
      port: target.port,
      expectedProjectPath: target.projectPath,
      jobId: start.jobId,
    }, `refresh job ${target.port}`);
    if (["succeeded", "failed", "canceled", "cancelled"].includes(job.status)) return job;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  assert.fail(`refresh job ${start.jobId} on port ${target.port} did not settle`);
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  for (const toolName of ["unity_asset_refresh", "unity_execute_code", "unity_play_mode"]) {
    const tool = listed.tools.find((candidate) => candidate.name === toolName);
    assert.ok(tool, `${toolName} was not exposed`);
    assert.ok(tool.inputSchema.properties.port, `${toolName} did not expose port`);
    assert.ok(tool.inputSchema.properties.expectedProjectPath,
      `${toolName} did not expose expectedProjectPath`);
  }

  for (const target of targets) {
    const pathResolvedPing = await call("unity_editor_ping", {
      expectedProjectPath: target.projectPath,
    }, `path-resolved ping ${target.port}`);
    assert.equal(normalizePath(pathResolvedPing.projectPath), normalizePath(target.projectPath),
      `expectedProjectPath resolved to ${pathResolvedPing.projectPath} instead of ${target.projectPath}`);

    const binding = { port: target.port, expectedProjectPath: target.projectPath };
    const ping = await call("unity_editor_ping", binding, `ping ${target.port}`);
    assert.equal(normalizePath(ping.projectPath), normalizePath(target.projectPath),
      `port ${target.port} resolved to ${ping.projectPath}`);

    if (target.updatePackage) {
      const updated = await call("unity_packages_update_git", {
        ...binding,
        name: target.updatePackage.name,
        gitUrl: target.updatePackage.gitUrl,
        ref: target.updatePackage.ref,
        skipIfResolved: false,
        force: true,
      }, `package update ${target.port}`);
      assert.equal(updated.resolvedMatchesRequest, true, JSON.stringify(updated));
    }

    const executed = await call("unity_execute_code", {
      ...binding,
      code: "return System.IO.Directory.GetParent(UnityEngine.Application.dataPath).FullName;",
    }, `execute code ${target.port}`);
    assert.equal(normalizePath(executed.result), normalizePath(target.projectPath),
      `execute code on port ${target.port} reached ${executed.result}`);

    const state = await call("unity_editor_state", binding, `editor state ${target.port}`);
    if (target.validatePlayMode && state.isChangingPlayMode !== true) {
      if (state.isPlaying === true) {
        const toggled = await call("unity_play_mode", {
          ...binding, action: "pause",
        }, `play mode pause ${target.port}`);
        if (Boolean(toggled.isPaused) !== Boolean(state.isPaused)) {
          await call("unity_play_mode", {
            ...binding, action: "pause",
          }, `play mode restore ${target.port}`);
        }
      } else {
        await call("unity_play_mode", { ...binding, action: "stop" }, `play mode ${target.port}`);
      }
    } else if (target.validatePlayMode) {
      console.log(`port ${target.port}: play-mode mutation skipped while Editor changes mode`);
    }

    if (target.refreshAssetPath) {
      const refresh = await call("unity_asset_refresh", {
        ...binding,
        assetPaths: [target.refreshAssetPath],
        saveAssets: false,
      }, `asset refresh ${target.port}`);
      const settled = await waitForRefresh(target, refresh);
      assert.equal(settled.status, "succeeded", JSON.stringify(settled));
    }

    console.log(`port ${target.port}: ${target.projectPath} binding verified`);
  }
} finally {
  await transport.close().catch(() => {});
}
