import { readFileSync } from "node:fs";
import process from "node:process";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const state = JSON.parse(readFileSync(
  process.env.UNITY_MCP_HOT_RELOAD_TEST_STATE,
  "utf8"
));
const version = String(state.version);
const capabilities = { tools: { listChanged: true } };
if (state.resourcesCapability) capabilities.resources = {};
const server = new Server(
  { name: "hot-reload-fixture", version },
  { capabilities }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "hot_reload_probe",
    description: `Hot reload fixture ${version}`,
    inputSchema: {
      type: "object",
      properties: {
        delayMs: { type: "number" },
        crash: { type: "boolean" },
      },
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "hot_reload_probe") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
  if (request.params.arguments?.crash) {
    setImmediate(() => process.exit(73));
    await new Promise(() => {});
  }
  const delayMs = Math.max(0, Number(request.params.arguments?.delayMs) || 0);
  if (delayMs > 0) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
  }
  const result = {
    version,
    runtimePid: process.pid,
    agentId: process.env.UNITY_MCP_AGENT_ID,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("message", (message) => {
  if (message?.type !== "unity-mcp:shutdown") return;
  void server.close().finally(() => process.exit(0));
});
