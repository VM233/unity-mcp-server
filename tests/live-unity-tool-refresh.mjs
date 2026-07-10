import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const serverRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const tempRoot = mkdtempSync(join(tmpdir(), "unity-mcp-live-refresh-"));
const registryPath = join(tempRoot, "instances.json");
const cachePath = join(tempRoot, "plugin-tools-metadata-cache.json");

writeFileSync(cachePath, JSON.stringify({
  updatedAt: 0,
  tools: [{
    route: "mcp/health",
    toolName: "unity_mcp_health",
    firstClass: true,
    exposure: "first-class",
    inputSchema: { type: "object", properties: {} },
  }],
}));

const environment = Object.fromEntries(
  Object.entries({
    ...process.env,
    UNITY_INSTANCE_REGISTRY: registryPath,
    UNITY_BRIDGE_PORT: "7890",
  }).filter(([, value]) => value !== undefined)
);

const client = new Client({ name: "unity-mcp-live-refresh-test", version: "1.0.0" },
  { capabilities: {} });
let resolveListChanged;
const listChanged = new Promise((resolveNotification) => {
  resolveListChanged = resolveNotification;
});
client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolveListChanged());

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(serverRoot, "src", "index.js")],
  cwd: serverRoot,
  env: environment,
  stderr: "inherit",
});

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

try {
  await client.connect(transport);
  assert.equal(client.getServerCapabilities()?.tools?.listChanged, true);

  const initial = await client.listTools();
  assert.equal(initial.tools.some((tool) => tool.name === "unity_testing_run_package_tests"), false);

  await withTimeout(listChanged, 60000, "tool list change notification timed out");

  const refreshed = await client.listTools();
  assert.equal(refreshed.tools.some((tool) => tool.name === "unity_testing_run_package_tests"), true);
  assert.equal(refreshed.tools.some((tool) => tool.name === "unity_prefab_asset_move_component"), true);
  console.log("Live Unity tool metadata refreshed without reconnecting.");
} finally {
  await transport.close().catch(() => {});
  rmSync(tempRoot, { recursive: true, force: true });
}
