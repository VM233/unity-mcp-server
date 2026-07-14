import { AsyncLocalStorage } from "node:async_hooks";

const requestContext = new AsyncLocalStorage();
let defaultAgentId = "default";

export function setDefaultRequestAgentId(agentId) {
  defaultAgentId = agentId || "default";
}

export function runWithRequestContext({
  agentId,
  portOverride,
  targetInstance,
  expectedProjectPath,
  expectedProjectName,
} = {}, callback) {
  const context = {
    agentId: agentId || defaultAgentId,
    portOverride: Number.isFinite(portOverride) ? portOverride : null,
    targetInstance: targetInstance || null,
    expectedProjectPath: expectedProjectPath || null,
    expectedProjectName: expectedProjectName || null,
  };
  return requestContext.run(context, callback);
}

export function getRequestAgentId() {
  return requestContext.getStore()?.agentId || defaultAgentId;
}

export function getRequestPortOverride() {
  return requestContext.getStore()?.portOverride ?? null;
}

export function getRequestTargetInstance() {
  return requestContext.getStore()?.targetInstance || null;
}

export function getRequestExpectedProjectPath() {
  return requestContext.getStore()?.expectedProjectPath || null;
}

export function getRequestExpectedProjectName() {
  return requestContext.getStore()?.expectedProjectName || null;
}
