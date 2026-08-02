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
  allowProjectPathRebind = false,
} = {}, callback) {
  const context = {
    agentId: agentId || defaultAgentId,
    portOverride: Number.isFinite(portOverride) ? portOverride : null,
    targetInstance: targetInstance || null,
    expectedProjectPath: expectedProjectPath || null,
    expectedProjectName: expectedProjectName || null,
    allowProjectPathRebind: Boolean(allowProjectPathRebind),
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

export function canRebindRequestProjectPath() {
  const context = requestContext.getStore();
  return Boolean(context?.allowProjectPathRebind && context.expectedProjectPath);
}

export function replaceRequestTargetInstance(targetInstance) {
  const context = requestContext.getStore();
  if (!context?.allowProjectPathRebind ||
      !Number.isFinite(targetInstance?.port)) {
    return false;
  }

  context.portOverride = targetInstance.port;
  context.targetInstance = targetInstance;
  return true;
}
