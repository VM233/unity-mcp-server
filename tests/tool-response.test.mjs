import assert from "node:assert/strict";
import test from "node:test";

import {
  buildToolResponse,
  compactSuccessfulToolResult,
  createToolOutputSchema,
  guardToolResponseSize,
  guardResponseSize,
  isStructuredToolFailure,
  measureContentBytes,
  normalizeStructuredToolResult,
  toContentBlocks,
} from "../src/tool-response.js";
import {
  normalizeLogLevel,
  readIntegerSetting,
} from "../src/config.js";
import { instanceTools } from "../src/tools/instance-tools.js";

test("tool responses serialize objects into one stable text block", () => {
  const blocks = toContentBlocks({ value: 3 });
  assert.deepEqual(blocks, [{
    type: "text",
    text: "{\"value\":3}",
  }]);
});

test("public MCP replies expose structuredContent and keep text human-readable", () => {
  const response = buildToolResponse({
    success: true,
    data: {
      value: 3,
    },
  });

  assert.deepEqual(response.structuredContent, {
    success: true,
    result: {
      value: 3,
    },
  });
  assert.equal(response.content.length, 1);
  assert.equal(response.content[0].type, "text");
  assert.equal(response.content[0].text, "Tool completed successfully.");
  assert.doesNotMatch(response.content[0].text, /^\s*[{[]/);
});

test("project-tool success envelopes remain structured without JSON text parsing by clients", () => {
  assert.deepEqual(normalizeStructuredToolResult({
    success: true,
    result: {
      sessionToken: "session-1",
    },
    cleanupToolName: "vmframework/runtime-game-item-session",
  }), {
    success: true,
    result: {
      sessionToken: "session-1",
    },
    cleanupToolName: "vmframework/runtime-game-item-session",
  });
});

test("tool output schemas wrap the route result in the standard response envelope", () => {
  const outputSchema = createToolOutputSchema({
    type: "object",
    properties: {
      value: { type: "integer" },
    },
    required: ["value"],
    additionalProperties: false,
  });

  assert.deepEqual(outputSchema.required, ["success"]);
  assert.deepEqual(outputSchema.properties.result.required, ["value"]);
  assert.equal(outputSchema.properties.result.properties.value.type, "integer");
  assert.deepEqual(outputSchema.oneOf[0].required, ["success", "result"]);
  assert.deepEqual(outputSchema.oneOf[1].required,
    ["success", "errorCode", "error", "retryable"]);
});

test("success-only bridge envelopes normalize into the stable result field", () => {
  const response = buildToolResponse({
    success: true,
    jobId: "job-1",
    status: "queued",
    result: null,
  });

  assert.deepEqual(response.structuredContent, {
    success: true,
    result: {
      jobId: "job-1",
      status: "queued",
      result: null,
    },
  });
  assert.match(response.content[0].text, /job-1/);
});

test("successful internal bridge envelopes are removed from public tool replies", () => {
  assert.equal(
    compactSuccessfulToolResult('{"success":true,"data":{"value":3}}'),
    '{"value":3}'
  );
  assert.deepEqual(
    compactSuccessfulToolResult({
      success: true,
      data: { value: 3 },
      recoveredAfterTransportFailure: true,
    }),
    { value: 3, tags: ["recoveredAfterTransportFailure"] }
  );
  const failure = '{"success":false,"errorCode":"failed","error":"No."}';
  assert.equal(compactSuccessfulToolResult(failure), failure);
});

test("server transport lifecycle booleans use presence-only tags", () => {
  const success = buildToolResponse({
    success: true,
    data: {
      status: "succeeded",
      recoveredAfterTransportFailure: true,
    },
    replayedAfterLostTicket: true,
    replayCount: 1,
    ticketReceived: false,
  });
  assert.deepEqual(success.structuredContent, {
    success: true,
    result: {
      status: "succeeded",
    },
    replayCount: 1,
    tags: [
      "recoveredAfterTransportFailure",
      "replayedAfterLostTicket",
    ],
  });

  const failure = buildToolResponse({
    success: false,
    errorCode: "queue_reload_recovery_timeout",
    error: "Unity did not reconnect.",
    retryable: true,
    pollTimedOut: true,
    ticketReceived: false,
  });
  assert.equal(failure.structuredContent.pollTimedOut, undefined);
  assert.equal(failure.structuredContent.ticketReceived, undefined);
  assert.deepEqual(failure.structuredContent.tags, ["pollTimedOut"]);
});

test("response sizing counts UTF-8 bytes and never appends a soft warning block", () => {
  const blocks = [{ type: "text", text: "你好" }];
  assert.equal(measureContentBytes(blocks), 6);

  const guarded = guardResponseSize(blocks, {
    softLimitBytes: 5,
    hardLimitBytes: 20,
  });
  assert.equal(guarded.exceedsSoftLimit, true);
  assert.equal(guarded.exceedsHardLimit, false);
  assert.equal(guarded.content, blocks);
  assert.equal(guarded.content.length, 1);
});

test("oversized responses become one structured non-retryable error", () => {
  const guarded = guardResponseSize([
    { type: "text", text: "x".repeat(30) },
  ], {
    softLimitBytes: 10,
    hardLimitBytes: 20,
  });

  assert.equal(guarded.exceedsHardLimit, true);
  assert.equal(guarded.content.length, 1);
  const payload = JSON.parse(guarded.content[0].text);
  assert.equal(payload.success, false);
  assert.equal(payload.errorCode, "response_too_large");
  assert.equal(payload.retryable, false);
  assert.equal(isStructuredToolFailure(guarded.content), true);
});

test("structured response sizing replaces both channels with one structured error", () => {
  const guarded = guardToolResponseSize(buildToolResponse({
    success: true,
    data: {
      value: "x".repeat(100),
    },
  }), {
    softLimitBytes: 10,
    hardLimitBytes: 20,
  });

  assert.equal(guarded.exceedsHardLimit, true);
  assert.equal(guarded.response.isError, true);
  assert.equal(guarded.response.structuredContent.success, false);
  assert.equal(guarded.response.structuredContent.errorCode, "response_too_large");
  assert.doesNotMatch(guarded.response.content[0].text, /^\s*[{[]/);
});

test("numeric settings are clamped and invalid log levels fall back safely", () => {
  assert.equal(readIntegerSetting("abc", 7, { minimum: 1 }), 7);
  assert.equal(readIntegerSetting("-2", 7, { minimum: 1 }), 1);
  assert.equal(readIntegerSetting("999", 7, { maximum: 10 }), 10);
  assert.equal(normalizeLogLevel("DEBUG"), "debug");
  assert.equal(normalizeLogLevel("verbose"), "info");
});

test("instance tools expose only implemented options and validate port as an integer", () => {
  const listTool = instanceTools.find((tool) => tool.name === "unity_list_instances");
  const selectTool = instanceTools.find((tool) => tool.name === "unity_select_instance");

  assert.deepEqual(listTool.inputSchema.properties, {});
  assert.equal(selectTool.inputSchema.properties.port.type, "integer");
  assert.equal(selectTool.inputSchema.properties.port.minimum, 1);
  assert.equal(selectTool.inputSchema.properties.port.maximum, 65535);
});
