import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { runWithRequestContext } from "../src/request-context.js";
import { contextTools } from "../src/tools/context-tools.js";
import { editorTools } from "../src/tools/editor-tools.js";
import { hubTools } from "../src/tools/hub-tools.js";
import { instanceTools } from "../src/tools/instance-tools.js";
import { sendCommand } from "../src/unity-editor-bridge.js";
import { splitToolTiers } from "../src/tool-tiers.js";

function readArgument(name, fallback = "") {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

const port = Number(readArgument("port", process.env.UNITY_BRIDGE_PORT || "7890"));
const projectPath = readArgument("project-path");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("--port must be an integer between 1 and 65535.");
}

const { metaTools } = splitToolTiers(editorTools);
const baselineTierSource = execFileSync(
  "git",
  ["show", "HEAD:src/tool-tiers.js"],
  { encoding: "utf8" }
);
const coreBlock = baselineTierSource.match(
  /const CORE_TOOLS = new Set\(\[([\s\S]*?)\]\);/
);
if (!coreBlock) {
  throw new Error("Could not read the baseline CORE_TOOLS policy from Git HEAD.");
}
const baselineCoreNames = new Set(
  [...coreBlock[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
);
const coreTools = editorTools.filter((tool) => baselineCoreNames.has(tool.name));
const toolsByName = new Map();
for (const tool of [
  ...instanceTools,
  ...hubTools,
  ...coreTools,
  ...metaTools,
  ...contextTools,
]) {
  toolsByName.set(tool.name, {
    name: tool.name,
    route: "",
    category: tool.name.replace(/^unity_/, "").split("_")[0],
    source: "server",
    description: tool.description,
  });
}

const pluginTools = [];
await runWithRequestContext({
  agentId: "tool-audit-baseline",
  portOverride: port,
  targetInstance: { port, ...(projectPath ? { projectPath } : {}) },
  expectedProjectPath: projectPath,
}, async () => {
  let offset = 0;
  for (let page = 0; page < 20; page++) {
    const response = await sendCommand("_meta/tools", {
      firstClassOnly: true,
      compact: false,
      includeSchema: true,
      offset,
      limit: 200,
    });
    const payload = response?.data ?? response;
    if (!Array.isArray(payload?.tools)) {
      throw new Error(`Unity metadata request failed: ${JSON.stringify(response)}`);
    }
    pluginTools.push(...payload.tools);
    if (!payload.hasMore) break;
    offset = Number.isInteger(payload.nextOffset)
      ? payload.nextOffset
      : offset + payload.tools.length;
  }
});

for (const tool of pluginTools) {
  toolsByName.set(tool.toolName, {
    name: tool.toolName,
    route: tool.route,
    category: tool.category || tool.route?.split("/")[0] || "unknown",
    source: tool.projectToolName ? "project" : "plugin",
    description: tool.description,
  });
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputPath = join(
  dirname(scriptDirectory),
  "docs",
  "tool-audit-baseline.json"
);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify({
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  port,
  projectPath,
  counts: {
    serverSurface: instanceTools.length + hubTools.length + coreTools.length +
      metaTools.length + contextTools.length,
    pluginFirstClass: pluginTools.length,
    combinedExposed: toolsByName.size,
  },
  tools: [...toolsByName.values()],
}, null, 2) + "\n");

console.log(`Captured ${toolsByName.size} exposed tools in ${outputPath}.`);
