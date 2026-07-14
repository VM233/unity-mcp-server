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
    UNITY_BRIDGE_PORT: process.env.UNITY_BRIDGE_PORT || "7890",
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

function getJsonText(response) {
  return [...response.content]
    .reverse()
    .find((block) => block.type === "text" && block.text.trimStart().startsWith("{"))
    ?.text || "";
}

try {
  await client.connect(transport);
  assert.equal(client.getServerCapabilities()?.tools?.listChanged, true);

  const initial = await client.listTools();
  const initialChars = JSON.stringify(initial).length;
  assert.ok(initial.tools.length <= 105);
  assert.ok(initialChars < 100_000);
  assert.equal(initial.tools.some((tool) => tool.description?.startsWith("IMPORTANT:")), false);
  const initialRefreshJob = initial.tools.find((tool) => tool.name === "unity_asset_get_refresh_job");
  assert.ok(initialRefreshJob);
  assert.deepEqual(Object.keys(initialRefreshJob.inputSchema.properties), ["jobId", "clear", "port"]);

  await withTimeout(listChanged, 60000, "tool list change notification timed out");

  const refreshed = await client.listTools();
  const refreshedChars = JSON.stringify(refreshed).length;
  assert.equal(refreshed.tools.some((tool) => tool.name === "unity_testing_run_package_tests"), true);
  assert.equal(refreshed.tools.some((tool) => tool.name === "unity_prefab_asset_move_component"), true);
  assert.equal(refreshed.tools.some((tool) => tool.name === "unity_prefab_asset_batch_edit"), false);
  assert.equal(refreshed.tools.some((tool) => tool.name === "unity_asset_move_batch"), false);
  assert.equal(refreshed.tools.some((tool) => tool.name === "unity_component_batch_wire"), false);
  assert.equal(refreshed.tools.some((tool) => tool.name === "unity_localization_upsert_entries"), false);
  const transaction = refreshed.tools.find((tool) => tool.name === "unity_prefab_asset_transaction_edit");
  const assetMove = refreshed.tools.find((tool) => tool.name === "unity_asset_move");
  const setReference = refreshed.tools.find((tool) => tool.name === "unity_component_set_reference");
  const localizationUpsert = refreshed.tools.find((tool) => tool.name === "unity_localization_upsert_entry");
  const refreshJob = refreshed.tools.find((tool) => tool.name === "unity_asset_get_refresh_job");
  assert.deepEqual(transaction.inputSchema.properties.execution.properties.mode.enum,
    ["auto", "immediate", "batched"]);
  assert.deepEqual(assetMove.inputSchema.required, ["moves"]);
  assert.deepEqual(setReference.inputSchema.required, ["references"]);
  assert.deepEqual(localizationUpsert.inputSchema.required, ["collection", "entries"]);
  assert.deepEqual(Object.keys(refreshJob.inputSchema.properties), ["jobId", "clear", "port"]);
  assert.equal(refreshed.tools.some((tool) => tool.annotations?.title), false);
  assert.equal(refreshed.tools.some((tool) =>
    Object.values(tool.annotations || {}).some((value) => value === false)), false);
  assert.equal(JSON.stringify(refreshed.tools).includes("Alias for"), false);
  assert.ok(refreshed.tools.length <= 155,
    `expected refreshed tools/list at or below 155 tools, got ${refreshed.tools.length}`);
  assert.ok(refreshedChars < 150_000,
    `expected refreshed tools/list below 150000 chars, got ${refreshedChars}`);
  assert.equal(refreshed.tools.some((tool) => tool.description?.startsWith("IMPORTANT:")), false);

  const pingResponse = await client.callTool({
    name: "unity_editor_ping",
    arguments: { port: Number(environment.UNITY_BRIDGE_PORT) },
  });
  const pingText = getJsonText(pingResponse);
  assert.equal(pingText.includes("\n"), false);

  const refreshJobResponse = await client.callTool({
    name: "unity_asset_get_refresh_job",
    arguments: { port: Number(environment.UNITY_BRIDGE_PORT) },
  });
  const refreshJobText = getJsonText(refreshJobResponse);
  assert.doesNotThrow(() => JSON.parse(refreshJobText));
  assert.equal(refreshJobText.includes("Unknown route"), false);

  const catalogResponse = await client.callTool({
    name: "unity_list_advanced_tools",
    arguments: { port: Number(environment.UNITY_BRIDGE_PORT) },
  });
  const catalogText = getJsonText(catalogResponse);
  assert.ok(catalogText, `advanced catalog response did not contain JSON: ${JSON.stringify(catalogResponse)}`);
  const catalog = JSON.parse(catalogText);
  assert.ok(catalogText.length < 10_000);
  assert.ok(Array.isArray(catalog.categories));
  assert.ok(catalog.categories.every((category) => !Array.isArray(category.tools)));

  const prefabCatalogResponse = await client.callTool({
    name: "unity_list_advanced_tools",
    arguments: {
      category: "prefab-asset",
      includeSchema: true,
      limit: 25,
      port: Number(environment.UNITY_BRIDGE_PORT),
    },
  });
  const prefabCatalogText = getJsonText(prefabCatalogResponse);
  const prefabCatalog = JSON.parse(prefabCatalogText);
  assert.ok(prefabCatalogText.length < 50_000);
  assert.ok(prefabCatalog.tools.length <= 25);
  console.log(`tools/list: ${initial.tools.length} tools / ${initialChars} chars initially; ` +
    `${refreshed.tools.length} tools / ${refreshedChars} chars after refresh.`);
  console.log(`advanced catalog: ${catalogText.length} chars summary; ` +
    `${prefabCatalogText.length} chars for prefab-asset schemas.`);
  console.log("Live Unity tool metadata refreshed without reconnecting.");
} finally {
  await transport.close().catch(() => {});
  rmSync(tempRoot, { recursive: true, force: true });
}
