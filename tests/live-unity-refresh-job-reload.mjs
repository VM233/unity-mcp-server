import assert from "node:assert/strict";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getStructuredResult } from "./live-tool-response.mjs";

const serverRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const projectPath = process.env.UNITY_EXPECTED_PROJECT_PATH;
const assetPath = process.env.UNITY_REFRESH_ASSET_PATH;
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

async function call(name, args, label = name) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 360000 });
  return getStructuredResult(response, label);
}

try {
  await client.connect(transport);
  // The project path is authoritative. Omitting an explicit port lets this
  // regression follow the same Editor if automatic port selection changes its
  // transport address while scripts reload.
  const binding = { expectedProjectPath: projectPath };
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
