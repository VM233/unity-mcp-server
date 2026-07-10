import assert from "node:assert/strict";
import test from "node:test";

import {
  canReplayAfterLostTicket,
  normalizeTerminalQueueStatus,
} from "../src/unity-editor-bridge.js";
import { pluginToolsFingerprint } from "../src/tool-tiers.js";

test("LostAfterReload is a failed terminal status", () => {
  const result = normalizeTerminalQueueStatus({
    ticketId: 42,
    actionName: "wait/editor-idle",
    status: "LostAfterReload",
    retryable: true,
    errorCode: "ticket_lost_after_reload",
    result: {
      success: false,
      error: "Ticket state was lost after a Unity domain reload.",
      errorCode: "ticket_lost_after_reload",
      retryable: true,
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.status, "LostAfterReload");
  assert.equal(result.errorCode, "ticket_lost_after_reload");
  assert.equal(result.retryable, true);
});

test("only explicitly replayable reload-safe routes are retried", () => {
  assert.equal(canReplayAfterLostTicket("wait/editor-idle"), true);
  assert.equal(canReplayAfterLostTicket("testing/list-tests"), true);
  assert.equal(canReplayAfterLostTicket("testing/get-package-job"), true);
  assert.equal(canReplayAfterLostTicket("prefab-asset/remove-gameobject"), false);
});

test("plugin tool metadata fingerprint is order independent and schema sensitive", () => {
  const first = [
    { toolName: "unity_b", route: "b/run", firstClass: true, inputSchema: { type: "object" } },
    { toolName: "unity_a", route: "a/run", firstClass: true, inputSchema: { type: "object" } },
  ];
  const reordered = [first[1], first[0]];
  const changed = [
    first[1],
    { ...first[0], inputSchema: { type: "object", required: ["value"] } },
  ];

  assert.equal(pluginToolsFingerprint(first), pluginToolsFingerprint(reordered));
  assert.notEqual(pluginToolsFingerprint(first), pluginToolsFingerprint(changed));
});
