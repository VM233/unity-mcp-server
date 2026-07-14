import assert from "node:assert/strict";
import test from "node:test";

import { AsyncSingleFlight } from "../src/async-single-flight.js";
import { getActiveBridgeUrl, getActiveInstanceContext } from "../src/instance-discovery.js";
import {
  getRequestAgentId,
  runWithRequestContext,
} from "../src/request-context.js";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("parallel request contexts keep agent and port routing isolated", async () => {
  const [first, second] = await Promise.all([
    runWithRequestContext({
      agentId: "agent-a",
      portOverride: 7891,
      targetInstance: { port: 7891, projectPath: "D:/ProjectA", projectName: "ProjectA" },
    }, async () => {
      await delay(20);
      return {
        agentId: getRequestAgentId(),
        bridgeUrl: getActiveBridgeUrl(),
        projectPath: getActiveInstanceContext()?.projectPath,
      };
    }),
    runWithRequestContext({
      agentId: "agent-b",
      portOverride: 7892,
      targetInstance: { port: 7892, projectPath: "D:/ProjectB", projectName: "ProjectB" },
    }, async () => {
      await delay(5);
      return {
        agentId: getRequestAgentId(),
        bridgeUrl: getActiveBridgeUrl(),
        projectPath: getActiveInstanceContext()?.projectPath,
      };
    }),
  ]);

  assert.deepEqual(first, {
    agentId: "agent-a",
    bridgeUrl: "http://127.0.0.1:7891",
    projectPath: "D:/ProjectA",
  });
  assert.deepEqual(second, {
    agentId: "agent-b",
    bridgeUrl: "http://127.0.0.1:7892",
    projectPath: "D:/ProjectB",
  });
});

test("single flight shares concurrent discovery and clears after completion", async () => {
  const singleFlight = new AsyncSingleFlight();
  let executions = 0;
  const operation = async () => {
    executions += 1;
    await delay(10);
    return executions;
  };

  const firstPair = await Promise.all([
    singleFlight.run("agent-a", operation),
    singleFlight.run("agent-a", operation),
  ]);
  assert.deepEqual(firstPair, [1, 1]);
  assert.equal(executions, 1);

  assert.equal(await singleFlight.run("agent-a", operation), 2);
  assert.equal(executions, 2);
});
