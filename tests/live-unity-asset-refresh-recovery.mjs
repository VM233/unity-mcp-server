import assert from "node:assert/strict";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getStructuredEnvelope } from "./live-tool-response.mjs";

const serverRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const port = Number(process.env.UNITY_BRIDGE_PORT);
const projectPath = process.env.UNITY_EXPECTED_PROJECT_PATH;
const assetPath = process.env.UNITY_REFRESH_ASSET_PATH;
assert.ok(Number.isFinite(port), "UNITY_BRIDGE_PORT is required");
assert.ok(projectPath, "UNITY_EXPECTED_PROJECT_PATH is required");
assert.ok(assetPath, "UNITY_REFRESH_ASSET_PATH is required");

const client = new Client({ name: "unity-mcp-refresh-recovery-test", version: "1.0.0" },
  { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(serverRoot, "src", "index.js")],
  cwd: serverRoot,
  env: {
    ...process.env,
    UNITY_QUEUE_POLL_TIMEOUT: "1",
    UNITY_QUEUE_POLL_INTERVAL: "1",
    UNITY_QUEUE_POLL_MAX: "2",
  },
  stderr: "inherit",
});

try {
  await client.connect(transport);
  const envelope = getStructuredEnvelope(await client.callTool({
    name: "unity_asset_refresh",
    arguments: {
      port,
      expectedProjectPath: projectPath,
      assetPaths: [assetPath],
      saveAssets: false,
    },
  }), "forced asset-refresh timeout recovery");
  const job = envelope.result;

  assert.ok(envelope.tags?.includes("recoveredAfterTransportFailure"),
    JSON.stringify(envelope));
  assert.ok(job?.jobId, JSON.stringify(envelope));
  assert.equal(job.transportFailure?.errorCode, "queue_poll_timeout",
    JSON.stringify(envelope));
  console.log(`Recovered asset refresh ${job.jobId} after forced outer poll timeout.`);
} finally {
  await transport.close().catch(() => {});
}
