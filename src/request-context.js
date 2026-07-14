import { AsyncLocalStorage } from "node:async_hooks";

const requestContext = new AsyncLocalStorage();
let defaultAgentId = "default";

export function setDefaultRequestAgentId(agentId) {
  defaultAgentId = agentId || "default";
}

export function runWithRequestContext({ agentId, portOverride, targetInstance } = {}, callback) {
  const context = {
    agentId: agentId || defaultAgentId,
    portOverride: Number.isFinite(portOverride) ? portOverride : null,
    targetInstance: targetInstance || null,
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
