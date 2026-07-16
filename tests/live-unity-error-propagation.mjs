import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const projectPath = process.env.UNITY_EXPECTED_PROJECT_PATH;
const packageName = process.env.UNITY_FAILURE_TEST_PACKAGE || "com.anklebreaker.unity-mcp";
const invalidRef = process.env.UNITY_FAILURE_TEST_REF || "0000000000000000000000000000000000000000";
assert.ok(projectPath, "UNITY_EXPECTED_PROJECT_PATH is required");

const manifestPath = join(projectPath, "Packages", "manifest.json");
const lockPath = join(projectPath, "Packages", "packages-lock.json");
const beforeManifest = await readFile(manifestPath);
const beforeLock = await readFile(lockPath);

const client = new Client({ name: "unity-mcp-error-propagation-test", version: "1.0.0" },
  { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(serverRoot, "src", "index.js")],
  cwd: serverRoot,
  env: process.env,
  stderr: "inherit",
});

function parseToolResponse(response) {
  const text = [...response.content]
    .reverse()
    .find((block) => block.type === "text" && block.text.trimStart().startsWith("{"))
    ?.text;
  assert.ok(text, `No JSON response: ${JSON.stringify(response)}`);
  return JSON.parse(text);
}

try {
  await client.connect(transport);
  const response = await client.callTool({
    name: "unity_packages_update_git",
    arguments: {
      expectedProjectPath: projectPath,
      name: packageName,
      ref: invalidRef,
      skipIfResolved: false,
      force: true,
    },
  }, undefined, { timeout: 360000 });

  const value = parseToolResponse(response);
  assert.equal(response.isError, true, JSON.stringify(response));
  assert.equal(value.success, false, JSON.stringify(value));
  assert.equal(value.data?.success, undefined, "Editor failure remained nested under a success envelope");
  assert.ok(value.error || value.message, JSON.stringify(value));
  assert.deepEqual(await readFile(manifestPath), beforeManifest, "manifest.json changed after failed update");
  assert.deepEqual(await readFile(lockPath), beforeLock, "packages-lock.json changed after failed update");
  console.log(`Failed ${packageName} update propagated as a top-level MCP error without file changes.`);
} finally {
  await transport.close().catch(() => {});
}
