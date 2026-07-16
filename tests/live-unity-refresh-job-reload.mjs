import assert from "node:assert/strict";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const port = Number(process.env.UNITY_BRIDGE_PORT);
const projectPath = process.env.UNITY_EXPECTED_PROJECT_PATH;
const assetPath = process.env.UNITY_REFRESH_ASSET_PATH;
assert.ok(Number.isFinite(port), "UNITY_BRIDGE_PORT is required");
assert.ok(projectPath, "UNITY_EXPECTED_PROJECT_PATH is required");
assert.ok(assetPath, "UNITY_REFRESH_ASSET_PATH is required");

const client = new Client({ name: "unity-mcp-refresh-job-reload-test", version: "1.0.0" },
  { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(serverRoot, "src", "index.js")],
  cwd: serverRoot,
  env: process.env,
  stderr: "inherit",
});

function parseToolResponse(response, label) {
  assert.equal(response.isError, undefined, label + ": MCP call failed: " + JSON.stringify(response));
  const text = [...response.content]
    .reverse()
    .find((block) => block.type === "text" && block.text.trimStart().startsWith("{"))
    ?.text;
  assert.ok(text, label + ": no JSON response: " + JSON.stringify(response));
  return JSON.parse(text);
}

function unwrapSuccess(response, label) {
  let value = parseToolResponse(response, label);
  for (let depth = 0; depth < 4; depth++) {
    if (value?.success === false) {
      assert.notEqual(value.errorCode, "editor_connection_failed",
        label + ": refresh polling leaked a transient reload disconnect");
      assert.fail(label + ": " + JSON.stringify(value));
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
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 360000 });
  return unwrapSuccess(response, label);
}

try {
  await client.connect(transport);
  const binding = { port, expectedProjectPath: projectPath };
  const start = await call("unity_asset_refresh", {
    ...binding,
    assetPaths: [assetPath],
    forceUpdate: true,
    saveAssets: false,
  }, "start targeted script refresh");
  assert.ok(start.jobId, JSON.stringify(start));

  let job = start;
  let pollCount = 0;
  const startedAt = Date.now();
  while (!["succeeded", "failed", "canceled", "cancelled"].includes(job.status)) {
    pollCount++;
    job = await call("unity_asset_get_refresh_job", {
      ...binding,
      jobId: start.jobId,
      timeoutMs: 300000,
    }, "poll refresh job " + start.jobId);
    if (!["succeeded", "failed", "canceled", "cancelled"].includes(job.status)) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }

  assert.equal(job.status, "succeeded", JSON.stringify(job));
  assert.equal(job.result?.refreshMode, "targeted", JSON.stringify(job));
  assert.equal(job.result?.refreshedAllAssets, false, JSON.stringify(job));
  assert.ok(job.result?.forceUpdateSkippedPaths?.includes(assetPath), JSON.stringify(job));
  console.log("Refresh job " + start.jobId + " survived script reload in " +
    (Date.now() - startedAt) + "ms across " + pollCount +
    " poll(s); ForceUpdate was skipped for " + assetPath + ".");
} finally {
  await transport.close().catch(() => {});
}
