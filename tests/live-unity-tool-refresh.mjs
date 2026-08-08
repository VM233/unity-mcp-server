import assert from "node:assert/strict";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { getStructuredResult } from "./live-tool-response.mjs";

const serverRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const expectedProjectPath = process.env.UNITY_EXPECTED_PROJECT_PATH;
const client = new Client({ name: "unity-mcp-live-catalog-test", version: "1.0.0" },
  { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(serverRoot, "src", "index.js")],
  cwd: serverRoot,
  env: process.env,
  stderr: "inherit",
});

async function call(name, args = {}) {
  const response = await client.callTool(
    { name, arguments: args }, undefined, { timeout: 120000 });
  return getStructuredResult(response, name);
}

try {
  await client.connect(transport);
  assert.equal(client.getServerCapabilities()?.tools?.listChanged, true);

  const initial = await client.listTools();
  assert.deepEqual(initial.tools.map((tool) => tool.name), [
    "unity_hub_available_releases",
    "unity_hub_get_install_path",
    "unity_hub_install_editor",
    "unity_hub_install_modules",
    "unity_hub_list_editors",
    "unity_hub_set_install_path",
    "unity_list_instances",
    "unity_mcp_health",
    "unity_select_instance",
    "unity_tools_get",
    "unity_tools_list",
    "unity_tools_search",
  ]);

  const instanceResult = await call("unity_list_instances");
  const instances = instanceResult.instances || [];
  assert.ok(instances.length > 0, "No Unity Editor instance was discovered");
  const target = expectedProjectPath
    ? instances.find((instance) =>
      instance.projectPath?.replaceAll("\\", "/").toLowerCase() ===
      expectedProjectPath.replaceAll("\\", "/").toLowerCase())
    : instances[0];
  assert.ok(target, `No Unity instance matched ${expectedProjectPath}`);
  await call("unity_select_instance", { port: target.port });

  let listChanged;
  const changed = new Promise((resolveChanged) => { listChanged = resolveChanged; });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => listChanged());

  const search = await call("unity_tools_search", { query: "scene hierarchy" });
  assert.ok(search.results.length > 0, JSON.stringify(search));
  const candidate = search.results.find((result) =>
    result.name === "unity_scene_hierarchy") || search.results[0];
  const detail = await call("unity_tools_get", { name: candidate.name });
  assert.equal(detail.tool.name, candidate.name);
  assert.ok(detail.tool.inputSchema);
  await Promise.race([changed, new Promise((resolveDelay) => setTimeout(resolveDelay, 1000))]);

  const activated = await client.listTools();
  assert.ok(activated.tools.some((tool) => tool.name === candidate.name));
  assert.equal(activated.tools.some((tool) => tool.name === "unity_advanced_tool"), false);
  assert.equal(activated.tools.some((tool) =>
    tool.name.startsWith("unity_project_tools_")), false);
  console.log(`Canonical catalog activated ${candidate.name} from ${search.results.length} candidate(s).`);
} finally {
  await transport.close().catch(() => {});
}
