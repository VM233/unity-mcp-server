import assert from "node:assert/strict";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getStructuredResult } from "./live-tool-response.mjs";

const serverRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const projectPath = process.env.UNITY_EXPECTED_PROJECT_PATH;
const packageName = process.env.UNITY_PACKAGE_TEST_NAME || "com.anklebreaker.unity-mcp";
const testNames = JSON.parse(process.env.UNITY_PACKAGE_TEST_NAMES || "[]");
assert.ok(projectPath, "UNITY_EXPECTED_PROJECT_PATH is required");
assert.ok(Array.isArray(testNames) && testNames.length > 0,
  "UNITY_PACKAGE_TEST_NAMES must be a non-empty JSON array");

const client = new Client({ name: "unity-mcp-package-job-reload-test", version: "1.0.0" },
  { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(serverRoot, "src", "index.js")],
  cwd: serverRoot,
  env: process.env,
  stderr: "inherit",
});

async function call(name, args, label) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 360000 });
  return getStructuredResult(response, label);
}

try {
  await client.connect(transport);
  const start = await call("unity_testing_run_package_tests", {
    expectedProjectPath: projectPath,
    packageName,
    mode: "EditMode",
    testNames,
  }, "start package tests");
  assert.ok(start.workflowId, JSON.stringify(start));

  let job = start;
  let pollCount = 0;
  while (!["succeeded", "failed", "canceled", "cancelled"].includes(job.status)) {
    pollCount++;
    job = await call("unity_testing_get_package_job", {
      expectedProjectPath: projectPath,
      workflowId: start.workflowId,
    }, `poll package workflow ${start.workflowId}`);
    if (!["succeeded", "failed", "canceled", "cancelled"].includes(job.status)) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }

  assert.equal(job.status, "succeeded", JSON.stringify(job));
  assert.equal(job.manifestRestored, true, JSON.stringify(job));
  assert.equal(job.testResult?.summary?.failed, 0, JSON.stringify(job));
  console.log(`Package workflow ${job.workflowId} survived reload across ${pollCount} poll(s); ` +
    `${job.testResult?.summary?.passed || 0} test(s) passed and manifest was restored.`);
} finally {
  await transport.close().catch(() => {});
}
