import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { STATIC_FIRST_CLASS_PLUGIN_ROUTES } from "../src/plugin-tool-policy.js";
import { runWithRequestContext } from "../src/request-context.js";
import { auditToolCatalog } from "../src/tool-schema-audit.js";
import { sendCommand } from "../src/unity-editor-bridge.js";

function readArgument(name, fallback = "") {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

const port = Number(readArgument("port", process.env.UNITY_BRIDGE_PORT || "7890"));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("--port must be an integer between 1 and 65535.");
}

const expectedProjectPath = readArgument("project-path");
const targetInstance = {
  port,
  ...(expectedProjectPath ? { projectPath: expectedProjectPath } : {}),
};

const allTools = [];
let offset = 0;
await runWithRequestContext({
  agentId: "plugin-tool-snapshot",
  portOverride: port,
  targetInstance,
  expectedProjectPath,
}, async () => {
  for (let page = 0; page < 20; page++) {
    const response = await sendCommand("_meta/tools", {
      firstClassOnly: false,
      compact: false,
      includeSchema: true,
      offset,
      limit: 200,
    });
    const payload = response?.data ?? response;
    if (!Array.isArray(payload?.tools)) {
      throw new Error(
        `Unity metadata request failed: ${JSON.stringify(response)}`
      );
    }
    allTools.push(...payload.tools);
    if (!Number.isInteger(payload.nextOffset)) break;
    offset = payload.nextOffset;
  }
});

const toolsByRoute = new Map(allTools.map((tool) => [tool.route, tool]));
const missingRoutes = STATIC_FIRST_CLASS_PLUGIN_ROUTES
  .filter((route) => !toolsByRoute.has(route));
if (missingRoutes.length > 0) {
  throw new Error(
    `Unity metadata did not contain required routes: ${missingRoutes.join(", ")}`
  );
}

const snapshot = STATIC_FIRST_CLASS_PLUGIN_ROUTES.map((route) => {
  const tool = toolsByRoute.get(route);
  const isFirstClass = Array.isArray(tool.tags) &&
    tool.tags.includes("firstClass");
  if (!isFirstClass) {
    throw new Error(`Unity metadata route "${route}" is not first-class.`);
  }
  return {
    toolName: tool.toolName,
    route,
    category: tool.category || route.split("/")[0],
    description: tool.description,
    inputSchema: tool.inputSchema || {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    outputSchema: tool.outputSchema || {
      type: "object",
      additionalProperties: true,
    },
    annotations: tool.annotations || {},
  };
});

const catalogIssues = auditToolCatalog(snapshot, { requireRoute: true });
if (catalogIssues.length > 0) {
  throw new Error(
    "Unity metadata failed the tool catalog quality gate:\n" +
    catalogIssues
      .map((issue) => `- ${issue.tool} ${issue.path}: ${issue.message}`)
      .join("\n")
  );
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputPath = join(
  dirname(scriptDirectory),
  "src",
  "tools",
  "plugin-first-class-tools.generated.json"
);
writeFileSync(outputPath, JSON.stringify(snapshot, null, 2) + "\n");
console.log(
  `Updated ${outputPath} with ${snapshot.length} plugin tool descriptors from port ${port}.`
);
