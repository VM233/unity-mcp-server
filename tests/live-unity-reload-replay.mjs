import assert from "node:assert/strict";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

function parseToolResult(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

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

  const scheduleResult = parseToolResult(await client.callTool({
    name: "unity_execute_code",
    arguments: {
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
    },
  }));
  assert.equal(scheduleResult?.success, true);

  const waitPromise = client.callTool({
    name: "unity_wait_editor_idle",
    arguments: {
      port: bridgePort,
      timeoutMs: waitTimeoutMs,
      stableFrames: 200,
      stableMs: 20000,
    },
  }, undefined, { timeout: clientTimeoutMs });

  const waitResult = await withTimeout(waitPromise, clientTimeoutMs, "reload replay timed out");
  const waitData = parseToolResult(waitResult);

  if (waitData?.success !== true)
    console.error(`Reload wait failure: ${JSON.stringify(waitData)}`);
  assert.equal(waitData?.success, true);
  if (waitData?.replayedAfterLostTicket) {
    assert.ok(waitData?.replayCount >= 1);
  }
  assert.equal(waitData?.data?.timedOut, false);
  assert.equal(waitData?.data?.isIdle, true);
  console.log(waitData?.replayedAfterLostTicket
    ? `Reload-lost wait replayed successfully (${waitData.replayCount} replay).`
    : "Reload wait completed on its persistent queue ticket.");
} finally {
  await transport.close().catch(() => {});
}
