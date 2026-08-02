import assert from "node:assert/strict";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  getStructuredEnvelope,
  getStructuredResult,
} from "./live-tool-response.mjs";

const serverRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const bridgePort = Number(process.env.UNITY_BRIDGE_PORT || "7890");
const waitTimeoutMs = Number(process.env.UNITY_RELOAD_WAIT_TIMEOUT_MS || "90000");
const clientTimeoutMs = waitTimeoutMs + 120000;
const client = new Client({ name: "unity-mcp-reload-replay-test", version: "1.0.0" },
  { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(serverRoot, "src", "index.js")],
  cwd: serverRoot,
  env: Object.fromEntries(Object.entries({
    ...process.env,
    UNITY_BRIDGE_PORT: String(bridgePort),
  }).filter(([, value]) => value !== undefined)),
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

async function callResult(name, args, label, timeout = clientTimeoutMs) {
  const response = await client.callTool(
    { name, arguments: args }, undefined, { timeout });
  return getStructuredResult(response, label);
}

async function waitForJob(start, label) {
  let job = start;
  for (let attempt = 0;
       job?.jobId && !["succeeded", "failed", "canceled", "cancelled"]
         .includes(job.status) && attempt < 120;
       attempt++) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    job = await callResult("unity_jobs_get", {
      port: bridgePort,
      jobId: start.jobId,
      ...(start.jobAccessToken ? { jobAccessToken: start.jobAccessToken } : {}),
    }, `${label} ${start.jobId}`);
  }
  assert.equal(job?.status, "succeeded", `${label}: ${JSON.stringify(job)}`);
  return job;
}

try {
  await client.connect(transport);

  const scheduleStart = await callResult("unity_execute_code", {
    port: bridgePort,
    code: `
double reloadAt = EditorApplication.timeSinceStartup + 1.5;
EditorApplication.CallbackFunction callback = null;
callback = () =>
{
    if (EditorApplication.timeSinceStartup < reloadAt) return;
    EditorApplication.update -= callback;
    UnityEditor.Compilation.CompilationPipeline.RequestScriptCompilation();
};
EditorApplication.update += callback;
return new { scheduled = true, reloadAt };
`,
  }, "schedule script reload");
  assert.ok(scheduleStart?.jobId, JSON.stringify(scheduleStart));
  await waitForJob(scheduleStart, "schedule script reload");

  const waitPromise = client.callTool({
    name: "unity_wait_editor_idle",
    arguments: {
      port: bridgePort,
      timeoutMs: waitTimeoutMs,
      stableFrames: 200,
      stableMs: 20000,
    },
  }, undefined, { timeout: clientTimeoutMs });

  const waitResponse = await withTimeout(
    waitPromise, clientTimeoutMs, "reload replay timed out");
  const waitEnvelope = getStructuredEnvelope(waitResponse, "reload idle wait");
  const waitData = waitEnvelope.result;
  const waitTags = new Set([
    ...(waitEnvelope.tags || []),
    ...(waitData?.tags || []),
  ]);

  assert.ok(waitTags.has("idle"), JSON.stringify(waitEnvelope));
  assert.equal(waitTags.has("timedOut"), false, JSON.stringify(waitEnvelope));
  if (waitTags.has("replayedAfterLostTicket")) {
    assert.ok(waitEnvelope.replayCount >= 1, JSON.stringify(waitEnvelope));
  }
  console.log(waitTags.has("replayedAfterLostTicket")
    ? `Reload-lost wait replayed successfully (${waitEnvelope.replayCount} replay).`
    : "Reload wait completed on its persistent queue ticket.");
} finally {
  await transport.close().catch(() => {});
}
