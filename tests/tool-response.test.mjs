import assert from "node:assert/strict";
import test from "node:test";

import {
  compactSuccessfulToolResult,
  guardResponseSize,
  isStructuredToolFailure,
  measureContentBytes,
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
    { value: 3, recoveredAfterTransportFailure: true }
  );
  const failure = '{"success":false,"errorCode":"failed","error":"No."}';
  assert.equal(compactSuccessfulToolResult(failure), failure);
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
