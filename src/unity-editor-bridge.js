// Unity Editor HTTP Bridge Client
// Communicates with the C# plugin running inside Unity Editor
// Uses the async ticket queue exposed by the Unity Editor plugin.
import { CONFIG } from "./config.js";
import {
  getActiveBridgeUrl,
  getActiveInstanceContext,
  refreshRequestProjectPathBinding,
} from "./instance-discovery.js";
import {
  canRebindRequestProjectPath,
  getRequestAgentId,
  getRequestExpectedProjectName,
  getRequestExpectedProjectPath,
} from "./request-context.js";
import { logDebug, logWarn } from "./logger.js";
import { isReleaseManagedReplaySafeReadRoute } from
  "./tools/plugin-first-class-tools.js";

// Dynamic bridge URL â€" resolved per-call based on selected instance
function getBridgeUrl() {
  return getActiveBridgeUrl();
}

async function tryRefreshRequestProjectBinding() {
  try {
    return await refreshRequestProjectPathBinding();
  } catch (error) {
    logWarn(
      `[MCP Bridge] Failed to refresh the request's project binding: ${error.message}`
    );
    return null;
  }
}

function buildBridgeHeaders(additional = {}) {
  return buildTargetHeaders(getActiveInstanceContext(), getRequestAgentId(), additional, {
    expectedProjectPath: getRequestExpectedProjectPath(),
    expectedProjectName: getRequestExpectedProjectName(),
  });
}

export function buildTargetHeaders(instance, agentId, additional = {}, explicitBinding = {}) {
  const headers = { ...additional, "X-Agent-Id": agentId };
  const expectedProjectPath = explicitBinding.expectedProjectPath || instance?.projectPath;
  const expectedProjectName = explicitBinding.expectedProjectName || instance?.projectName;
  if (expectedProjectPath) {
    headers["X-UnityMCP-Expected-Project-Path"] = expectedProjectPath;
  }
  if (expectedProjectName) {
    headers["X-UnityMCP-Expected-Project-Name"] = expectedProjectName;
  }
  return headers;
}

let _requestSequence = 0;
export function createRequestId(command) {
  _requestSequence = (_requestSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${getRequestAgentId()}-${command}-${Date.now()}-${_requestSequence}`;
}

// Retry settings â€" handles Unity domain reloads (1-3 sec server downtime)
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 800; // 800ms, 1600ms, 3200ms, 6400ms
const POLL_TRANSIENT_RETRY_BASE_MS = 500;
const RELOAD_RETRY_MAX_DELAY_MS = 2000;
const ASSET_REFRESH_POLL_RECONNECT_BUDGET_MS = 300000;

/**
 * Sleep helper for retry backoff
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns true if the error looks like a transient connection issue
 * (server temporarily down during Unity domain reload).
 */
export function isTransientError(error, response) {
  if (error) {
    // Connection refused / reset / aborted â€" server is restarting
    const msg = error.message || "";
    const normalizedMessage = msg.toLowerCase();
    return (
      error.code === "ECONNREFUSED" ||
      error.code === "ECONNRESET" ||
      error.code === "EPIPE" ||
      error.code === "UND_ERR_SOCKET" ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("ECONNRESET") ||
      msg.includes("fetch failed") ||
      normalizedMessage.includes("unexpected end of json input") ||
      normalizedMessage.includes("premature close") ||
      normalizedMessage.includes("socket closed") ||
      normalizedMessage.includes("other side closed") ||
      normalizedMessage === "terminated" ||
      error.name === "AbortError"
    );
  }
  // HTTP 500/503 during domain reload (server half-alive)
  if (response && (response.status === 503 || response.status === 500)) {
    return true;
  }
  return false;
}

export function canReplayAfterLostTicket(command) {
  return (
    isReleaseManagedReplaySafeReadRoute(command) ||
    command.startsWith("_meta/") ||
    command === "packages/list" ||
    command === "packages/search" ||
    command === "asset/refresh" ||
    command === "asset/get-refresh-job" ||
    command === "wait/editor-idle" ||
    command === "uitoolkit/refresh" ||
    command === "testing/list-tests" ||
    command === "testing/get-job" ||
    command === "testing/get-package-job"
  );
}

/**
 * Submit a command to the queue and get a ticket ID.
 * POST /api/queue/submit with {apiPath, method, body, agentId}
 */
async function submitToQueue(apiPath, bodyString, requestId) {
  const url = `${getBridgeUrl()}/api/queue/submit`;

  const response = await fetch(url, {
    method: "POST",
    headers: buildBridgeHeaders({
      "Content-Type": "application/json",
      "Idempotency-Key": requestId,
    }),
    body: JSON.stringify({
      apiPath,
      body: bodyString,
    }),
    signal: AbortSignal.timeout(CONFIG.editorBridgeTimeout),
  });

  if (!response.ok) {
    const payload = await readHttpErrorPayload(response);
    const error = new Error(payload.error);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  const data = await response.json();
  if (!Number.isSafeInteger(data?.ticketId) || data.ticketId < 1) {
    const error = new Error("Unity queue submission did not return a valid ticketId.");
    error.payload = {
      success: false,
      errorCode: "invalid_queue_ticket",
      retryable: false,
      error: error.message,
    };
    throw error;
  }
  return data; // { ticketId, queuePosition, ... }
}

async function fetchQueueStatusRaw(ticketId, timeoutMs = 10000) {
  const url = `${getBridgeUrl()}/api/queue/status?ticketId=${ticketId}`;
  const response = await fetch(url, {
    method: "GET",
    headers: buildBridgeHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const payload = await readHttpErrorPayload(response);
    return {
      success: false,
      statusCode: response.status,
      retryable: typeof payload.retryable === "boolean"
        ? payload.retryable
        : isTransientError(null, response),
      error: payload.error,
      errorCode: payload.errorCode,
      data: payload,
    };
  }

  const data = await response.json();
  if (!isQueueTicketStatusEnvelope(data)) {
    const normalized = normalizeEditorCommandResult(data);
    if (!normalized.success) {
      return {
        success: false,
        statusCode: response.status,
        structuredFailure: true,
        retryable: Boolean(normalized.retryable),
        error: normalized.error,
        errorCode: normalized.errorCode,
        data,
      };
    }
  }

  return { success: true, data };
}

async function fetchQueueInfoRaw(timeoutMs = 5000) {
  const url = `${getBridgeUrl()}/api/queue/info`;
  const response = await fetch(url, {
    method: "GET",
    headers: buildBridgeHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const payload = await readHttpErrorPayload(response);
    return {
      success: false,
      statusCode: response.status,
      retryable: typeof payload.retryable === "boolean"
        ? payload.retryable
        : isTransientError(null, response),
      error: payload.error,
      errorCode: payload.errorCode,
      data: payload,
    };
  }

  const data = await response.json();
  const normalized = normalizeEditorCommandResult(data);
  return normalized.success
    ? { success: true, data }
    : {
        success: false,
        statusCode: response.status,
        structuredFailure: true,
        retryable: Boolean(normalized.retryable),
        error: normalized.error,
        errorCode: normalized.errorCode,
        data,
      };
}

async function readHttpErrorPayload(response) {
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return {
      ...payload,
      success: false,
      errorCode: payload.errorCode || `http_${response.status}`,
      error: payload.error || payload.message || response.statusText ||
        `Unity bridge returned HTTP ${response.status}.`,
    };
  }

  const conciseBody = text.trim().slice(0, 500);
  return {
    success: false,
    errorCode: `http_${response.status}`,
    transportOnly: true,
    error: conciseBody
      ? `Unity bridge returned HTTP ${response.status}: ${conciseBody}`
      : `Unity bridge returned HTTP ${response.status} ${response.statusText}`.trim(),
  };
}

function summarizeTransportFailure(failure) {
  return {
    errorCode: failure?.errorCode || "asset_refresh_transport_failure",
    error: failure?.error || failure?.message || "Asset refresh transport failed.",
    ticketId: failure?.ticketId ?? null,
    status: failure?.status || "",
  };
}

export function normalizeRecoveredAssetRefreshJob(job, originalFailure, refreshRequestId) {
  if (!job || typeof job !== "object" || Array.isArray(job) || !job.jobId || !job.status) {
    return null;
  }

  const status = String(job.status).toLowerCase();
  const knownStatuses = new Set([
    "queued",
    "running",
    "waiting-for-editor",
    "succeeded",
    "failed",
    "canceled",
    "cancelled",
  ]);
  if (!knownStatuses.has(status)) return null;

  const recoveredJob = {
    ...job,
    recoveredAfterTransportFailure: true,
    refreshRequestId,
    transportFailure: summarizeTransportFailure(originalFailure),
  };

  if (["failed", "canceled", "cancelled"].includes(status)) {
    const error = job.error || job.message || `Asset refresh job ${job.jobId} ${status}.`;
    return {
      success: false,
      data: recoveredJob,
      error,
      message: error,
      errorCode: job.errorCode || "asset_refresh_job_failed",
      recoveredAfterTransportFailure: true,
    };
  }

  return {
    success: true,
    data: recoveredJob,
    recoveredAfterTransportFailure: true,
  };
}

async function recoverAssetRefreshJob(refreshRequestId, originalFailure) {
  const response = await sendCommand("asset/get-refresh-job", { refreshRequestId });
  if (!response.success) return null;
  return normalizeRecoveredAssetRefreshJob(
    response.data,
    originalFailure,
    refreshRequestId
  );
}

async function recoverReloadSafeCommand(command, requestId, originalFailure) {
  if (command !== "asset/refresh") return null;
  return recoverAssetRefreshJob(requestId, originalFailure);
}

export function normalizeTerminalQueueStatus(statusData) {
  if (!statusData || typeof statusData !== "object") return null;

  if (statusData.status === "Completed") {
    const data = statusData.result !== undefined ? statusData.result : statusData;
    const normalized = normalizeEditorCommandResult(data);
    return normalized.success
      ? normalized
      : {
        ...normalized,
        ticketId: statusData.ticketId,
        status: statusData.status,
        actionName: statusData.actionName,
      };
  }

  if (["Failed", "TimedOut", "Canceled", "UncertainAfterReload"].includes(statusData.status)) {
    return normalizeFailedQueueStatus(statusData);
  }

  return null;
}

const ACTIVE_QUEUE_STATUSES = new Set(["Queued", "Executing"]);
const TERMINAL_QUEUE_STATUSES = new Set([
  "Completed", "Failed", "TimedOut", "Canceled", "UncertainAfterReload",
]);
const LOST_QUEUE_TICKET_ERROR_CODES = new Set([
  "ticket_not_found", "queue_ticket_not_found", "ticket_owner_mismatch",
]);

function isQueueTicketStatusEnvelope(value) {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    value.ticketId !== undefined &&
    (ACTIVE_QUEUE_STATUSES.has(value.status) || TERMINAL_QUEUE_STATUSES.has(value.status))
  );
}

function buildLostAliasedTicketResult(statusResult, ticketId, command) {
  return {
    success: false,
    retryable: true,
    errorCode: "queue_ticket_lost_after_reload",
    error:
      `Queue ticket ${ticketId} no longer identifies this agent's request after a Unity reload: ` +
      statusResult.error,
    causeErrorCode: statusResult.errorCode,
    ticketId,
    command,
  };
}

export function normalizeEditorCommandResult(data) {
  let current = data;
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== "object" || Array.isArray(current)) break;

    const hasError = typeof current.error === "string" && current.error.trim().length > 0;
    if (current.success === false || (current.success !== true && hasError)) {
      const message = current.error || current.message || "Unity Editor command failed.";
      return {
        ...current,
        success: false,
        error: message,
        errorCode: current.errorCode || "editor_command_failed",
        retryable: Boolean(current.retryable),
      };
    }

    if (current.success === true && current.data &&
        typeof current.data === "object" && !Array.isArray(current.data)) {
      current = current.data;
      continue;
    }
    break;
  }

  return { success: true, data: current };
}

function getQueuePollTimeoutMs(command, params = {}) {
  const configuredTimeout = CONFIG.queuePollTimeoutMs || CONFIG.editorBridgeTimeout;

  if (command === "asset/get-refresh-job") {
    const requestedTimeout = Number(params.timeoutMs);
    return Math.max(
      configuredTimeout,
      Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? requestedTimeout
        : ASSET_REFRESH_POLL_RECONNECT_BUDGET_MS
    );
  }

  if (command === "wait/editor-idle" || command === "uitoolkit/refresh") {
    const commandTimeout = Number(params.timeoutMs);
    const stableMs = Number(params.stableMs);
    const requestedWaitMs = Number.isFinite(commandTimeout) && commandTimeout > 0
      ? commandTimeout
      : 0;
    const requestedStableMs = Number.isFinite(stableMs) && stableMs > 0
      ? stableMs
      : 0;
    return Math.max(configuredTimeout, requestedWaitMs + requestedStableMs + 30000);
  }

  return configuredTimeout;
}

export function getReloadReconnectBudgetMs(command, params = {}) {
  return canReplayAfterLostTicket(command)
    ? Math.max(
      getQueuePollTimeoutMs(command, params),
      CONFIG.queueReloadRecoveryTimeoutMs || 0
    )
    : 0;
}

export function getQueueSubmitReconnectBudgetMs(command, params = {}, error = null) {
  const status = Number(error?.status);
  const confirmedReloadResponse =
    status === 404 || status === 500 || status === 503;
  const replayBudgetMs = getReloadReconnectBudgetMs(command, params);
  return confirmedReloadResponse || replayBudgetMs > 0
    ? Math.max(
      Math.max(0, CONFIG.queueReloadRecoveryTimeoutMs || 0),
      replayBudgetMs
    )
    : 0;
}

export function isTransientQueueSubmitError(error) {
  if (error?.payload && error.payload.retryable === false) {
    return false;
  }
  const status = Number(error?.status);
  return status === 404 || status === 500 || status === 503 ||
    isTransientError(error, null);
}

function mayIndicateStaleProjectBinding(failure) {
  return Boolean(
    failure?.retryable ||
    Number(failure?.status) === 409 ||
    Number(failure?.statusCode) === 409 ||
    failure?.errorCode === "target_project_mismatch" ||
    failure?.payload?.errorCode === "target_project_mismatch"
  );
}

function shouldRetryTransientConnection(command, params, startedAt, retryCount) {
  const reconnectBudgetMs = getReloadReconnectBudgetMs(command, params);
  if (reconnectBudgetMs > 0) {
    return Date.now() - startedAt < reconnectBudgetMs;
  }

  return retryCount < MAX_RETRIES;
}

function shouldReplayLostTicket(command, params, startedAt, replayCount, result) {
  if (!result?.retryable || !canReplayAfterLostTicket(command)) return false;

  // A reload may return the definitive missing/aliased-ticket response only as
  // the reconnect budget expires. One fresh submission is still required to
  // recover an idempotent read; otherwise the time spent waiting for Unity
  // consumes the very budget that was meant to enable the replay.
  if (result.errorCode === "queue_ticket_lost_after_reload" && replayCount === 0)
    return true;

  return shouldRetryTransientConnection(command, params, startedAt, replayCount);
}

function shouldRetryQueueSubmission(command, params, startedAt, retryCount, error) {
  const reconnectBudgetMs =
    getQueueSubmitReconnectBudgetMs(command, params, error);
  if (reconnectBudgetMs > 0) {
    return Date.now() - startedAt < reconnectBudgetMs;
  }

  return retryCount < MAX_RETRIES;
}

function getTransientRetryDelayMs(command, params, startedAt, retryCount) {
  const reconnectBudgetMs = getReloadReconnectBudgetMs(command, params);
  const exponentialDelay = RETRY_BASE_DELAY_MS * Math.pow(2, Math.min(retryCount, MAX_RETRIES));
  if (reconnectBudgetMs <= 0) return exponentialDelay;

  const remainingMs = Math.max(0, reconnectBudgetMs - (Date.now() - startedAt));
  return Math.min(exponentialDelay, RELOAD_RETRY_MAX_DELAY_MS, remainingMs);
}

function getQueueSubmitRetryDelayMs(command, params, startedAt, retryCount, error) {
  const reconnectBudgetMs =
    getQueueSubmitReconnectBudgetMs(command, params, error);
  const exponentialDelay = RETRY_BASE_DELAY_MS *
    Math.pow(2, Math.min(retryCount, MAX_RETRIES));
  if (reconnectBudgetMs <= 0) return exponentialDelay;

  const remainingMs = Math.max(0, reconnectBudgetMs - (Date.now() - startedAt));
  return Math.max(1,
    Math.min(exponentialDelay, RELOAD_RETRY_MAX_DELAY_MS, remainingMs));
}

function buildConnectionFailure(command, params, startedAt, retryCount, lastError) {
  const elapsedMs = Date.now() - startedAt;
  const reconnectBudgetMs = getReloadReconnectBudgetMs(command, params);
  return {
    success: false,
    retryable: reconnectBudgetMs > 0,
    errorCode: reconnectBudgetMs > 0 ? "reload_reconnect_timeout" : "editor_connection_failed",
    error: reconnectBudgetMs > 0
      ? `Unity Editor did not reconnect within the ${reconnectBudgetMs}ms reload recovery budget for ${command}: ${lastError?.message}`
      : `Connection failed after ${MAX_RETRIES} retries: ${lastError?.message}. Unity Editor may be reloading or not running.`,
    command,
    retryCount,
    elapsedMs,
    reconnectBudgetMs,
  };
}

function buildQueueSubmissionFailure(command, params, startedAt, retryCount, lastError) {
  const elapsedMs = Date.now() - startedAt;
  const reconnectBudgetMs =
    getQueueSubmitReconnectBudgetMs(command, params, lastError);
  const transient = isTransientQueueSubmitError(lastError);
  const timedOut = transient && reconnectBudgetMs > 0 &&
    elapsedMs >= reconnectBudgetMs;
  return {
    success: false,
    retryable: transient,
    errorCode: timedOut
      ? "queue_submit_recovery_timeout"
      : "queue_submit_failed",
    error: timedOut
      ? `Unity queue submission endpoint did not recover within ${reconnectBudgetMs}ms ` +
        `for ${command}: ${lastError?.message}`
      : `Unity queue submission failed for ${command}: ${lastError?.message}`,
    command,
    retryCount,
    elapsedMs,
    reconnectBudgetMs,
    queueEndpoint: "queue/submit",
    ticketReceived: false,
  };
}

export async function buildQueuePollTimeoutResult(ticketId, command, timeoutMs, elapsedMs,
  timing = {}) {
  const finalStatus = await fetchQueueStatusRaw(ticketId).catch((error) => ({
    success: false,
    error: error.message,
  }));

  if (finalStatus.success) {
    const statusData = finalStatus.data;
    const terminalResult = normalizeTerminalQueueStatus(statusData);
    if (terminalResult) return terminalResult;
  }

  const queueInfo = await fetchQueueInfoRaw()
    .catch((error) => ({ success: false, error: error.message }));
  const nextToolArgs = {
    tool: "unity_queue_ticket_status",
    params: { ticketId },
  };

  return {
    success: false,
    retryable: false,
    errorCode: "queue_poll_timeout",
    error:
      `Queue polling timed out after ${timeoutMs}ms for ticket ${ticketId}. ` +
      "Inspect the existing ticket with unity_advanced_tool before retrying the command.",
    ticketId,
    command,
    pollTimedOut: true,
    pollTimeoutMs: timeoutMs,
    elapsedMs,
    wallElapsedMs: timing.wallElapsedMs ?? elapsedMs,
    reloadRecoveryElapsedMs: timing.reloadRecoveryElapsedMs ?? 0,
    lastKnownTicket: summarizeFinalTicketStatus(finalStatus),
    queueState: summarizeQueueState(queueInfo),
    nextTool: "unity_advanced_tool",
    nextToolArgs,
  };
}

function summarizeFinalTicketStatus(statusResult) {
  if (!statusResult || typeof statusResult !== "object") return null;
  if (!statusResult.success) {
    return {
      reachable: statusResult.structuredFailure === true,
      validTicket: false,
      statusCode: statusResult.statusCode,
      errorCode: statusResult.errorCode,
      error: statusResult.error,
    };
  }

  const data = statusResult.data || {};
  return {
    reachable: true,
    ticketId: data.ticketId,
    status: data.status,
    actionName: data.actionName,
  };
}

function summarizeQueueState(queueResult) {
  if (!queueResult || typeof queueResult !== "object") return null;
  if (!queueResult.success) {
    return {
      reachable: false,
      statusCode: queueResult.statusCode,
      errorCode: queueResult.errorCode,
      error: queueResult.error,
    };
  }

  const data = queueResult.data || {};
  return {
    reachable: true,
    totalQueued: data.totalQueued,
    executingCount: data.executingCount,
    activeAgents: data.activeAgents,
  };
}

/**
 * Poll the queue status for a ticket until completion.
 * GET /api/queue/status?ticketId=X
 */
export async function pollQueueStatus(ticketId, command, params = {}) {
  let pollIntervalMs = CONFIG.queuePollIntervalMs;
  const maxIntervalMs = Math.min(1000, CONFIG.queuePollMaxMs);
  const startTime = Date.now();
  // Use dedicated poll timeout (longer than bridge timeout to handle slow operations like execute_code)
  const timeoutMs = getQueuePollTimeoutMs(command, params);
  const reloadRecoveryTimeoutMs = canReplayAfterLostTicket(command)
    ? Math.max(0, CONFIG.queueReloadRecoveryTimeoutMs || 0)
    : 0;
  let consecutive404s = 0;
  let sawTransientPollError = false;
  let transientRetryCount = 0;
  let recoveredTransientMs = 0;
  let transientStartedAt = null;
  const max404Grace = 5; // Allow a few 404s during the dequeueâ†’execute race window

  const getReloadRecoveryElapsedMs = (now) =>
    recoveredTransientMs + (transientStartedAt === null ? 0 : now - transientStartedAt);
  const beginTransient = (startedAt) => {
    if (reloadRecoveryTimeoutMs > 0 && transientStartedAt === null)
      transientStartedAt = startedAt;
  };
  const finishTransient = (endedAt) => {
    if (transientStartedAt === null) return;
    recoveredTransientMs += endedAt - transientStartedAt;
    transientStartedAt = null;
  };
  const capTransientDelay = (delay) => {
    if (transientStartedAt === null || reloadRecoveryTimeoutMs <= 0)
      return delay;
    const remaining = reloadRecoveryTimeoutMs - getReloadRecoveryElapsedMs(Date.now());
    return Math.max(1, Math.min(delay, remaining));
  };

  while (true) {
    const now = Date.now();
    const wallElapsedMs = now - startTime;
    const reloadRecoveryElapsedMs = getReloadRecoveryElapsedMs(now);
    if (transientStartedAt !== null && reloadRecoveryElapsedMs >= reloadRecoveryTimeoutMs) {
      return {
        success: false,
        retryable: true,
        errorCode: "queue_reload_recovery_timeout",
        error:
          `Queue polling could not reconnect to Unity within ${reloadRecoveryTimeoutMs}ms ` +
          `for ticket ${ticketId}.`,
        ticketId,
        command,
        reloadRecoveryTimedOut: true,
        reloadRecoveryTimeoutMs,
        reloadRecoveryElapsedMs,
        wallElapsedMs,
      };
    }

    // Domain reload downtime has its own bounded budget and does not consume the
    // operation's active Editor processing time.
    const activeElapsedMs = wallElapsedMs - reloadRecoveryElapsedMs;
    if (activeElapsedMs > timeoutMs) {
      return buildQueuePollTimeoutResult(ticketId, command, timeoutMs, activeElapsedMs, {
        wallElapsedMs,
        reloadRecoveryElapsedMs,
      });
    }

    // Poll status
    const pollAttemptStartedAt = Date.now();
    try {
      const statusResult = await fetchQueueStatusRaw(ticketId);

      if (!statusResult.success) {
        const bindingRecovery = canRebindRequestProjectPath() &&
          mayIndicateStaleProjectBinding(statusResult);
        const rebound = bindingRecovery
          ? await tryRefreshRequestProjectBinding()
          : null;
        if (bindingRecovery && (rebound?.changed || !statusResult.retryable)) {
          beginTransient(pollAttemptStartedAt);
          sawTransientPollError = true;
          const delay = capTransientDelay(Math.min(
            POLL_TRANSIENT_RETRY_BASE_MS * Math.pow(1.5, transientRetryCount++),
            maxIntervalMs
          ));
          await sleep(delay);
          continue;
        }

        if (statusResult.structuredFailure) {
          finishTransient(Date.now());
          if (sawTransientPollError && canReplayAfterLostTicket(command) &&
              LOST_QUEUE_TICKET_ERROR_CODES.has(statusResult.errorCode)) {
            return buildLostAliasedTicketResult(statusResult, ticketId, command);
          }

          return {
            ...normalizeEditorCommandResult(statusResult.data),
            ticketId,
            command,
          };
        }

        if (statusResult.retryable) {
          beginTransient(pollAttemptStartedAt);
          sawTransientPollError = true;
          const delay = capTransientDelay(Math.min(
            POLL_TRANSIENT_RETRY_BASE_MS * Math.pow(1.5, transientRetryCount++),
            maxIntervalMs
          ));
          logWarn(
            `[MCP Bridge] Queue poll ${statusResult.error} for ticket ${ticketId}; retrying in ${delay}ms...`
          );
          await sleep(delay);
          continue;
        }

        finishTransient(Date.now());
        // Grace period for 404 â€" ticket may be between dequeue and execution tracking
        if (statusResult.statusCode === 404) {
          consecutive404s++;
          if (consecutive404s < max404Grace) {
            await sleep(pollIntervalMs);
            pollIntervalMs = Math.min(Math.ceil(pollIntervalMs * 1.5), maxIntervalMs);
            continue;
          }
        }
        if (statusResult.statusCode === 404 && sawTransientPollError) {
          return {
            success: false,
            retryable: true,
            errorCode: "queue_ticket_lost_after_reload",
            error: `Queue ticket ${ticketId} was lost after a Unity reload: ${statusResult.error}`,
            ticketId,
            command,
          };
        }

        if (statusResult.data && statusResult.data.success === false) {
          return {
            ...statusResult.data,
            ticketId,
            command,
          };
        }

        return {
          success: false,
          errorCode: statusResult.errorCode || "queue_status_failed",
          retryable: Boolean(statusResult.retryable),
          error: statusResult.error,
          ticketId,
          command,
        };
      }

      finishTransient(Date.now());
      // Reset 404 counter on successful poll
      consecutive404s = 0;
      transientRetryCount = 0;

      const statusData = statusResult.data;

      const terminalResult = normalizeTerminalQueueStatus(statusData);
      if (terminalResult) return terminalResult;

      if (!ACTIVE_QUEUE_STATUSES.has(statusData?.status)) {
        return {
          success: false,
          retryable: false,
          errorCode: "invalid_queue_status",
          error:
            `Unity returned an invalid queue status envelope for ticket ${ticketId}.`,
          ticketId,
          command,
        };
      }

      // Still processing â€" wait before polling again
      await sleep(pollIntervalMs);

      // Increase poll interval up to max
      pollIntervalMs = Math.min(
        Math.ceil(pollIntervalMs * 1.5),
        maxIntervalMs
      );
    } catch (error) {
      if (isTransientError(error, null)) {
        await tryRefreshRequestProjectBinding();
        beginTransient(pollAttemptStartedAt);
        sawTransientPollError = true;
        const delay = capTransientDelay(Math.min(
          POLL_TRANSIENT_RETRY_BASE_MS * Math.pow(1.5, transientRetryCount++),
          maxIntervalMs
        ));
        logWarn(
          `[MCP Bridge] Queue poll transient error for ticket ${ticketId}: ${error.message}; retrying in ${delay}ms...`
        );
        await sleep(delay);
        continue;
      }

      return {
        success: false,
        errorCode: "queue_poll_failed",
        retryable: false,
        error: `Error polling queue: ${error.message}`,
        ticketId,
        command,
      };
    }
  }
}

function normalizeFailedQueueStatus(statusData) {
  const result = statusData?.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const message = result.error || result.message || statusData.errorMessage || "Queue processing failed";
    return {
      ...result,
      success: false,
      error: message,
      errorCode: result.errorCode || statusData.errorCode || "queue_processing_failed",
      retryable: Boolean(result.retryable || statusData.retryable),
      ticketId: statusData.ticketId,
      status: statusData.status,
      actionName: statusData.actionName,
    };
  }

  const message = statusData?.error || statusData?.errorMessage || "Queue processing failed";
  return {
    success: false,
    error: message,
    errorCode: statusData?.errorCode || "queue_processing_failed",
    retryable: Boolean(statusData?.retryable),
    ticketId: statusData?.ticketId,
    status: statusData?.status,
    actionName: statusData?.actionName,
  };
}

/**
 * Send a command to the Unity Editor bridge.
 * Submits through the async ticket queue and polls for completion.
 * Automatically retries on transient failures (e.g. Unity domain reload)
 * with exponential backoff so multi-agent workflows stay resilient.
 */
export async function sendCommand(command, params = {}) {
  const bodyString = JSON.stringify(params);
  const requestId = createRequestId(command);
  let lostTicketReplayCount = 0;
  let queueSubmitRetryCount = 0;
  let queueSubmitStartedAt = Date.now();
  const startedAt = Date.now();
  let submitLastError = null;

  while (true) {
    try {
      const ticketData = await submitToQueue(command, bodyString, requestId);
      const ticketId = ticketData.ticketId;

      // Log to stderr, not stdout — stdout is reserved for the MCP JSON-RPC
      // transport and any non-JSON data there closes strict clients (e.g. Codex).
      logDebug(`[MCP Bridge] Submitted ${command} to queue, ticket: ${ticketId}`);

      const result = await pollQueueStatus(ticketId, command, params);
      if (!result.success) {
        const recovered = await recoverReloadSafeCommand(command, requestId, result);
        if (recovered) return recovered;
      }
      if (!result.success && shouldReplayLostTicket(
          command, params, startedAt, lostTicketReplayCount, result)) {
        lostTicketReplayCount++;
        const delay = getTransientRetryDelayMs(
          command, params, startedAt, lostTicketReplayCount - 1);
        logWarn(
          `[MCP Bridge] Replaying "${command}" after lost queue ticket ${ticketId} in ${delay}ms (retry ${lostTicketReplayCount})...`
        );
        await sleep(delay);
        queueSubmitStartedAt = Date.now();
        queueSubmitRetryCount = 0;
        continue;
      }

      return lostTicketReplayCount > 0
        ? { ...result, replayedAfterLostTicket: true, replayCount: lostTicketReplayCount }
        : result;
    } catch (submitError) {
      submitLastError = submitError;
      const transientSubmitError = isTransientQueueSubmitError(submitError);
      const bindingRecovery = canRebindRequestProjectPath() &&
        mayIndicateStaleProjectBinding(submitError);
      if (transientSubmitError || bindingRecovery)
        await tryRefreshRequestProjectBinding();
      if ((transientSubmitError || bindingRecovery) &&
          shouldRetryQueueSubmission(
            command, params, queueSubmitStartedAt, queueSubmitRetryCount,
            submitError)) {
        const delay = getQueueSubmitRetryDelayMs(
          command, params, queueSubmitStartedAt, queueSubmitRetryCount,
          submitError);
        logWarn(
          `[MCP Bridge] Error submitting to queue: ${submitError.message}, retrying in ${delay}ms (retry ${queueSubmitRetryCount + 1})...`
        );
        await sleep(delay);
        queueSubmitRetryCount++;
        continue;
      }
      if (submitError?.payload && submitError.payload.transportOnly !== true) {
        return normalizeEditorCommandResult(submitError.payload);
      }
      break;
    }
  }

  const failure = buildQueueSubmissionFailure(
    command,
    params,
    queueSubmitStartedAt,
    queueSubmitRetryCount,
    submitLastError
  );
  return (await recoverReloadSafeCommand(command, requestId, failure)) || failure;
}

/**
 * Get queue information and stats.
 * GET /api/queue/info
 */
export async function getQueueInfo() {
  try {
    const url = `${getBridgeUrl()}/api/queue/info`;
    const response = await fetch(url, {
      method: "GET",
      headers: buildBridgeHeaders(),
      signal: AbortSignal.timeout(CONFIG.editorBridgeTimeout),
    });

    if (!response.ok) {
      return normalizeEditorCommandResult(await readHttpErrorPayload(response));
    }

    return normalizeEditorCommandResult(await response.json());
  } catch (error) {
    return {
      success: false,
      error: `Failed to get queue info: ${error.message}`,
    };
  }
}

/**
 * Get status of a specific queue ticket.
 * GET /api/queue/status?ticketId=X
 */
export async function getTicketStatus(ticketId) {
  try {
    const url = `${getBridgeUrl()}/api/queue/status?ticketId=${ticketId}`;
    const response = await fetch(url, {
      method: "GET",
      headers: buildBridgeHeaders(),
      signal: AbortSignal.timeout(CONFIG.editorBridgeTimeout),
    });

    if (!response.ok) {
      return normalizeEditorCommandResult(await readHttpErrorPayload(response));
    }

    const data = await response.json();
    return isQueueTicketStatusEnvelope(data)
      ? { success: true, data }
      : normalizeEditorCommandResult(data);
  } catch (error) {
    return {
      success: false,
      error: `Failed to get ticket status: ${error.message}`,
    };
  }
}

/** Cancel one queued ticket owned by the current agent. */
export async function cancelTicket(ticketId) {
  try {
    const response = await fetch(`${getBridgeUrl()}/api/queue/cancel`, {
      method: "POST",
      headers: buildBridgeHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ticketId }),
      signal: AbortSignal.timeout(CONFIG.editorBridgeTimeout),
    });
    if (!response.ok) {
      return normalizeEditorCommandResult(await readHttpErrorPayload(response));
    }
    return normalizeEditorCommandResult(await response.json());
  } catch (error) {
    return { success: false, error: `Failed to cancel ticket: ${error.message}` };
  }
}

/**
 * Check if the Unity Editor bridge is reachable
 */
export async function ping() {
  try {
    const response = await fetch(`${getBridgeUrl()}/api/ping`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      const data = await response.json();
      return { connected: true, ...data };
    }
    return { connected: false, error: `HTTP ${response.status}` };
  } catch {
    return { connected: false, error: "Unity Editor bridge not reachable" };
  }
}

// â"€â"€â"€ Convenience wrappers for common Editor operations â"€â"€â"€

export async function getSceneInfo() {
  return sendCommand("scene/info");
}

export async function openScene(scenePath) {
  return sendCommand("scene/open", { path: scenePath });
}

export async function saveScene(params = {}) {
  return sendCommand("scene/save", params);
}

export async function newScene() {
  return sendCommand("scene/new");
}

export async function getHierarchy(params) {
  return sendCommand("scene/hierarchy", params);
}

export async function createGameObject(params) {
  return sendCommand("gameobject/create", params);
}

export async function deleteGameObject(params) {
  return sendCommand("gameobject/delete", params);
}

export async function getGameObjectInfo(params) {
  return sendCommand("gameobject/info", params);
}

export async function setTransform(params) {
  return sendCommand("gameobject/set-transform", params);
}

export async function addComponent(params) {
  return sendCommand("component/add", params);
}

export async function removeComponent(params) {
  return sendCommand("component/remove", params);
}

export async function setComponentProperty(params) {
  return sendCommand("component/set-property", params);
}

export async function getComponentProperties(params) {
  return sendCommand("component/get-properties", params);
}

export async function getReferenceableObjects(params) {
  return sendCommand("component/get-referenceable", params);
}

export async function executeMenuItem(menuPath) {
  return sendCommand("editor/execute-menu-item", { menuPath });
}

export async function getProjectInfo() {
  return sendCommand("project/info");
}

export async function getAssetList(params) {
  return sendCommand("asset/list", params);
}

export async function importAsset(params) {
  return sendCommand("asset/import", params);
}

export async function refreshAssets(params) {
  return sendCommand("asset/refresh", params);
}

export async function deleteAsset(params) {
  return sendCommand("asset/delete", params);
}

export async function createScript(params) {
  return sendCommand("script/create", params);
}

export async function readScript(params) {
  return sendCommand("script/read", params);
}

export async function updateScript(params) {
  return sendCommand("script/update", params);
}

export async function buildProject(params) {
  return sendCommand("build/start", params);
}

export async function clearConsoleLog() {
  return sendCommand("console/clear");
}

export async function getCompilationErrors(params) {
  return sendCommand("compilation/errors", params);
}

export async function playMode(params) {
  return sendCommand("editor/play-mode", params); // action: "play", "pause", "stop"
}

export async function getEditorState() {
  return sendCommand("editor/state");
}

export async function executeCode(params) {
  return sendCommand("editor/execute-code", typeof params === "string" ? { code: params } : params);
}

export async function createPrefab(params) {
  return sendCommand("asset/create-prefab", params);
}

export async function setMaterial(params) {
  return sendCommand("renderer/set-material", params);
}

export async function createMaterial(params) {
  return sendCommand("asset/create-material", params);
}

// â"€â"€â"€ Animation â"€â"€â"€

export async function createAnimatorController(params) {
  return sendCommand("animation/create-controller", params);
}

export async function getAnimatorControllerInfo(params) {
  return sendCommand("animation/controller-info", params);
}

export async function addAnimationParameter(params) {
  return sendCommand("animation/add-parameter", params);
}

export async function removeAnimationParameter(params) {
  return sendCommand("animation/remove-parameter", params);
}

export async function addAnimationState(params) {
  return sendCommand("animation/add-state", params);
}

export async function removeAnimationState(params) {
  return sendCommand("animation/remove-state", params);
}

export async function addAnimationTransition(params) {
  return sendCommand("animation/add-transition", params);
}

export async function createAnimationClip(params) {
  return sendCommand("animation/create-clip", params);
}

export async function getAnimationClipInfo(params) {
  return sendCommand("animation/clip-info", params);
}

export async function setAnimationClipCurve(params) {
  return sendCommand("animation/set-clip-curve", params);
}

export async function setAnimationObjectReferenceCurve(params) {
  return sendCommand("animation/set-object-reference-curve", params);
}

export async function addAnimationLayer(params) {
  return sendCommand("animation/add-layer", params);
}

export async function assignAnimatorController(params) {
  return sendCommand("animation/assign-controller", params);
}

export async function getCurveKeyframes(params) {
  return sendCommand("animation/get-curve-keyframes", params);
}

export async function removeCurve(params) {
  return sendCommand("animation/remove-curve", params);
}

export async function addKeyframe(params) {
  return sendCommand("animation/add-keyframe", params);
}

export async function removeKeyframe(params) {
  return sendCommand("animation/remove-keyframe", params);
}

export async function addAnimationEvent(params) {
  return sendCommand("animation/add-event", params);
}

export async function removeAnimationEvent(params) {
  return sendCommand("animation/remove-event", params);
}

export async function getAnimationEvents(params) {
  return sendCommand("animation/get-events", params);
}

export async function setClipSettings(params) {
  return sendCommand("animation/set-clip-settings", params);
}

export async function removeAnimationTransition(params) {
  return sendCommand("animation/remove-transition", params);
}

export async function removeAnimationLayer(params) {
  return sendCommand("animation/remove-layer", params);
}

export async function createBlendTree(params) {
  return sendCommand("animation/create-blend-tree", params);
}

export async function getBlendTreeInfo(params) {
  return sendCommand("animation/get-blend-tree", params);
}

// â"€â"€â"€ Prefab (Advanced) â"€â"€â"€

export async function getPrefabInfo(params) {
  return sendCommand("prefab/info", params);
}

export async function createPrefabVariant(params) {
  return sendCommand("prefab/create-variant", params);
}

export async function applyPrefabOverrides(params) {
  return sendCommand("prefab/apply-overrides", params);
}

export async function revertPrefabOverrides(params) {
  return sendCommand("prefab/revert-overrides", params);
}

export async function unpackPrefab(params) {
  return sendCommand("prefab/unpack", params);
}

export async function duplicateGameObject(params) {
  return sendCommand("gameobject/duplicate", params);
}

export async function setGameObjectActive(params) {
  return sendCommand("gameobject/set-active", params);
}

export async function reparentGameObject(params) {
  return sendCommand("gameobject/reparent", params);
}

// â"€â"€â"€ Prefab Asset (Direct Editing) â"€â"€â"€

export async function getPrefabAssetHierarchy(params) {
  return sendCommand("prefab-asset/hierarchy", params);
}

export async function getPrefabAssetProperties(params) {
  return sendCommand("prefab-asset/get-properties", params);
}

export async function setPrefabAssetProperty(params) {
  return sendCommand("prefab-asset/set-property", params);
}

export async function addPrefabAssetComponent(params) {
  return sendCommand("prefab-asset/add-component", params);
}

export async function removePrefabAssetComponent(params) {
  return sendCommand("prefab-asset/remove-component", params);
}

export async function setPrefabAssetReference(params) {
  return sendCommand("prefab-asset/set-reference", params);
}

export async function addPrefabAssetGameObject(params) {
  return sendCommand("prefab-asset/add-gameobject", params);
}

export async function removePrefabAssetGameObject(params) {
  return sendCommand("prefab-asset/remove-gameobject", params);
}

// â"€â"€â"€ Prefab Variant Management â"€â"€â"€

export async function getPrefabVariantInfo(params) {
  return sendCommand("prefab-asset/variant-info", params);
}

export async function comparePrefabVariantToBase(params) {
  return sendCommand("prefab-asset/compare-variant", params);
}

export async function applyPrefabVariantOverride(params) {
  return sendCommand("prefab-asset/apply-variant-override", params);
}

export async function revertPrefabVariantOverride(params) {
  return sendCommand("prefab-asset/revert-variant-override", params);
}

export async function transferPrefabVariantOverrides(params) {
  return sendCommand("prefab-asset/transfer-variant-overrides", params);
}

// â"€â"€â"€ Physics â"€â"€â"€

export async function physicsRaycast(params) {
  return sendCommand("physics/raycast", params);
}

export async function physicsOverlapSphere(params) {
  return sendCommand("physics/overlap-sphere", params);
}

export async function physicsOverlapBox(params) {
  return sendCommand("physics/overlap-box", params);
}

export async function getCollisionMatrix(params) {
  return sendCommand("physics/collision-matrix", params);
}

export async function setCollisionLayer(params) {
  return sendCommand("physics/set-collision-layer", params);
}

export async function setGravity(params) {
  return sendCommand("physics/set-gravity", params);
}

// â"€â"€â"€ Lighting â"€â"€â"€

export async function getLightingInfo(params) {
  return sendCommand("lighting/info", params);
}

export async function createLight(params) {
  return sendCommand("lighting/create", params);
}

export async function setEnvironment(params) {
  return sendCommand("lighting/set-environment", params);
}

export async function createReflectionProbe(params) {
  return sendCommand("lighting/create-reflection-probe", params);
}

export async function createLightProbeGroup(params) {
  return sendCommand("lighting/create-light-probe-group", params);
}

// â"€â"€â"€ Audio â"€â"€â"€

export async function getAudioInfo(params) {
  return sendCommand("audio/info", params);
}

export async function createAudioSource(params) {
  return sendCommand("audio/create-source", params);
}

export async function setGlobalAudio(params) {
  return sendCommand("audio/set-global", params);
}

// â"€â"€â"€ Tags & Layers â"€â"€â"€

export async function getTagsAndLayers(params) {
  return sendCommand("taglayer/info", params);
}

export async function addTag(params) {
  return sendCommand("taglayer/add-tag", params);
}

export async function setTag(params) {
  return sendCommand("taglayer/set-tag", params);
}

export async function setLayer(params) {
  return sendCommand("taglayer/set-layer", params);
}

export async function setStatic(params) {
  return sendCommand("taglayer/set-static", params);
}

// â"€â"€â"€ Selection & Scene View â"€â"€â"€

export async function getSelection(params) {
  return sendCommand("selection/get", params);
}

export async function setSelection(params) {
  return sendCommand("selection/set", params);
}

export async function focusSceneView(params) {
  return sendCommand("selection/focus-scene-view", params);
}

// â"€â"€â"€ Input Actions â"€â"€â"€

export async function createInputActions(params) {
  return sendCommand("input/create", params);
}

export async function getInputActionsInfo(params) {
  return sendCommand("input/info", params);
}

export async function addInputActionMap(params) {
  return sendCommand("input/add-map", params);
}

export async function removeInputActionMap(params) {
  return sendCommand("input/remove-map", params);
}

export async function addInputAction(params) {
  return sendCommand("input/add-action", params);
}

export async function removeInputAction(params) {
  return sendCommand("input/remove-action", params);
}

export async function addInputBinding(params) {
  return sendCommand("input/add-binding", params);
}

export async function addInputCompositeBinding(params) {
  return sendCommand("input/add-composite-binding", params);
}

// â"€â"€â"€ Assembly Definitions â"€â"€â"€

export async function createAssemblyDef(params) {
  return sendCommand("asmdef/create", params);
}

export async function getAssemblyDefInfo(params) {
  return sendCommand("asmdef/info", params);
}

export async function listAssemblyDefs(params) {
  return sendCommand("asmdef/list", params);
}

export async function addAssemblyDefReferences(params) {
  return sendCommand("asmdef/add-references", params);
}

export async function removeAssemblyDefReferences(params) {
  return sendCommand("asmdef/remove-references", params);
}

export async function setAssemblyDefPlatforms(params) {
  return sendCommand("asmdef/set-platforms", params);
}

export async function updateAssemblyDefSettings(params) {
  return sendCommand("asmdef/update-settings", params);
}

export async function createAssemblyRef(params) {
  return sendCommand("asmdef/create-ref", params);
}

// â"€â"€â"€ Profiler â"€â"€â"€

export async function enableProfiler(params) {
  return sendCommand("profiler/enable", params);
}

export async function getRenderingStats(params) {
  return sendCommand("profiler/stats", params);
}

export async function getMemoryInfo(params) {
  return sendCommand("profiler/memory", params);
}

export async function getProfilerFrameData(params) {
  return sendCommand("profiler/frame-data", params);
}

export async function analyzePerformance(params) {
  return sendCommand("profiler/analyze", params);
}

// â"€â"€â"€ Frame Debugger â"€â"€â"€

export async function enableFrameDebugger(params) {
  return sendCommand("debugger/enable", params);
}

export async function getFrameDebuggerEvents(params) {
  return sendCommand("debugger/events", params);
}

export async function getFrameDebuggerEventDetails(params) {
  return sendCommand("debugger/event-details", params);
}

// â"€â"€â"€ Memory Profiler â"€â"€â"€

export async function getMemoryStatus(params) {
  return sendCommand("profiler/memory-status", params);
}

export async function getMemoryBreakdown(params) {
  return sendCommand("profiler/memory-breakdown", params);
}

export async function getTopMemoryConsumers(params) {
  return sendCommand("profiler/memory-top-assets", params);
}

export async function takeMemorySnapshot(params) {
  return sendCommand("profiler/memory-snapshot", params);
}

// â"€â"€â"€ Shader Graph â"€â"€â"€

export async function getShaderGraphStatus(params) {
  return sendCommand("shadergraph/status", params);
}

export async function listShaders(params) {
  return sendCommand("shadergraph/list-shaders", params);
}

export async function listShaderGraphs(params) {
  return sendCommand("shadergraph/list", params);
}

export async function getShaderGraphInfo(params) {
  return sendCommand("shadergraph/info", params);
}

export async function getShaderProperties(params) {
  return sendCommand("shadergraph/get-properties", params);
}

export async function createShaderGraph(params) {
  return sendCommand("shadergraph/create", params);
}

export async function openShaderGraph(params) {
  return sendCommand("shadergraph/open", params);
}

export async function listSubGraphs(params) {
  return sendCommand("shadergraph/list-subgraphs", params);
}

export async function listVFXGraphs(params) {
  return sendCommand("shadergraph/list-vfx", params);
}

export async function openVFXGraph(params) {
  return sendCommand("shadergraph/open-vfx", params);
}

export async function getShaderGraphNodes(params) {
  return sendCommand("shadergraph/get-nodes", params);
}

export async function getShaderGraphEdges(params) {
  return sendCommand("shadergraph/get-edges", params);
}

export async function addShaderGraphNode(params) {
  return sendCommand("shadergraph/add-node", params);
}

export async function removeShaderGraphNode(params) {
  return sendCommand("shadergraph/remove-node", params);
}

export async function connectShaderGraphNodes(params) {
  return sendCommand("shadergraph/connect", params);
}

export async function disconnectShaderGraphNodes(params) {
  return sendCommand("shadergraph/disconnect", params);
}

export async function setShaderGraphNodeProperty(params) {
  return sendCommand("shadergraph/set-node-property", params);
}

export async function getShaderGraphNodeTypes(params) {
  return sendCommand("shadergraph/get-node-types", params);
}

// â"€â"€â"€ Agent Management â"€â"€â"€

export async function listAgents(params) {
  return sendCommand("agents/list", params);
}

export async function getAgentLog(params) {
  return sendCommand("agents/log", params);
}

// â"€â"€â"€ Search â"€â"€â"€

export async function findByComponent(params) {
  return sendCommand("search/by-component", params);
}

export async function findByTag(params) {
  return sendCommand("search/by-tag", params);
}

export async function findByLayer(params) {
  return sendCommand("search/by-layer", params);
}

export async function findByName(params) {
  return sendCommand("search/by-name", params);
}

export async function findByShader(params) {
  return sendCommand("search/by-shader", params);
}

export async function findMissingReferences(params) {
  return sendCommand("search/missing-references", params);
}

export async function getSceneStats(params) {
  return sendCommand("search/scene-stats", params);
}

// â"€â"€â"€ Project Settings â"€â"€â"€

export async function getQualitySettings(params) {
  return sendCommand("settings/quality", params);
}

export async function setQualityLevel(params) {
  return sendCommand("settings/quality-level", params);
}

export async function getPhysicsSettings(params) {
  return sendCommand("settings/physics", params);
}

export async function setPhysicsSettings(params) {
  return sendCommand("settings/set-physics", params);
}

export async function getTimeSettings(params) {
  return sendCommand("settings/time", params);
}

export async function setTimeSettings(params) {
  return sendCommand("settings/set-time", params);
}

export async function getPlayerSettings(params) {
  return sendCommand("settings/player", params);
}

export async function setPlayerSettings(params) {
  return sendCommand("settings/set-player", params);
}

export async function getRenderPipelineInfo(params) {
  return sendCommand("settings/render-pipeline", params);
}

// â"€â"€â"€ Undo â"€â"€â"€

export async function performUndo(params) {
  return sendCommand("undo/perform", params);
}

export async function performRedo(params) {
  return sendCommand("undo/redo", params);
}

export async function getUndoHistory(params) {
  return sendCommand("undo/history", params);
}

export async function clearUndo(params) {
  return sendCommand("undo/clear", params);
}

// â"€â"€â"€ Screenshot / Scene View â"€â"€â"€

export async function captureGameView(params) {
  return sendCommand("screenshot/game", params);
}

export async function captureSceneView(params) {
  return sendCommand("screenshot/scene", params);
}

export async function captureEditorWindow(params) {
  return sendCommand("screenshot/editor-window", params);
}

export async function getSceneViewInfo(params) {
  return sendCommand("sceneview/info", params);
}

export async function setSceneViewCamera(params) {
  return sendCommand("sceneview/set-camera", params);
}

// â"€â"€â"€ Graphics & Visuals â"€â"€â"€

export async function captureAssetPreview(params) {
  return sendCommand("graphics/asset-preview", params);
}

export async function getMeshInfo(params) {
  return sendCommand("graphics/mesh-info", params);
}

export async function getMaterialInfo(params) {
  return sendCommand("graphics/material-info", params);
}

export async function getRendererInfo(params) {
  return sendCommand("graphics/renderer-info", params);
}

export async function getLightingSummary(params) {
  return sendCommand("graphics/lighting-summary", params);
}

// â"€â"€â"€ Terrain â"€â"€â"€

export async function createTerrain(params) {
  return sendCommand("terrain/create", params);
}

export async function getTerrainInfo(params) {
  return sendCommand("terrain/info", params);
}

export async function setTerrainHeight(params) {
  return sendCommand("terrain/set-height", params);
}

export async function flattenTerrain(params) {
  return sendCommand("terrain/flatten", params);
}

export async function addTerrainLayer(params) {
  return sendCommand("terrain/add-layer", params);
}

export async function getTerrainHeight(params) {
  return sendCommand("terrain/get-height", params);
}

export async function listTerrains(params) {
  return sendCommand("terrain/list", params);
}

export async function raiseLowerTerrainHeight(params) {
  return sendCommand("terrain/raise-lower", params);
}

export async function smoothTerrainHeight(params) {
  return sendCommand("terrain/smooth", params);
}

export async function setTerrainNoise(params) {
  return sendCommand("terrain/noise", params);
}

export async function setTerrainHeightsRegion(params) {
  return sendCommand("terrain/set-heights-region", params);
}

export async function getTerrainHeightsRegion(params) {
  return sendCommand("terrain/get-heights-region", params);
}

export async function removeTerrainLayer(params) {
  return sendCommand("terrain/remove-layer", params);
}

export async function paintTerrainLayer(params) {
  return sendCommand("terrain/paint-layer", params);
}

export async function fillTerrainLayer(params) {
  return sendCommand("terrain/fill-layer", params);
}

export async function addTerrainTreePrototype(params) {
  return sendCommand("terrain/add-tree-prototype", params);
}

export async function removeTerrainTreePrototype(params) {
  return sendCommand("terrain/remove-tree-prototype", params);
}

export async function placeTerrainTrees(params) {
  return sendCommand("terrain/place-trees", params);
}

export async function clearTerrainTrees(params) {
  return sendCommand("terrain/clear-trees", params);
}

export async function getTerrainTreeInstances(params) {
  return sendCommand("terrain/get-tree-instances", params);
}

export async function addTerrainDetailPrototype(params) {
  return sendCommand("terrain/add-detail-prototype", params);
}

export async function paintTerrainDetail(params) {
  return sendCommand("terrain/paint-detail", params);
}

export async function scatterTerrainDetail(params) {
  return sendCommand("terrain/scatter-detail", params);
}

export async function clearTerrainDetail(params) {
  return sendCommand("terrain/clear-detail", params);
}

export async function setTerrainHoles(params) {
  return sendCommand("terrain/set-holes", params);
}

export async function setTerrainSettings(params) {
  return sendCommand("terrain/set-settings", params);
}

export async function resizeTerrain(params) {
  return sendCommand("terrain/resize", params);
}

export async function createTerrainGrid(params) {
  return sendCommand("terrain/create-grid", params);
}

export async function setTerrainNeighbors(params) {
  return sendCommand("terrain/set-neighbors", params);
}

export async function importTerrainHeightmap(params) {
  return sendCommand("terrain/import-heightmap", params);
}

export async function exportTerrainHeightmap(params) {
  return sendCommand("terrain/export-heightmap", params);
}

export async function getTerrainSteepness(params) {
  return sendCommand("terrain/get-steepness", params);
}

// â"€â"€â"€ Particle System â"€â"€â"€

export async function createParticleSystem(params) {
  return sendCommand("particle/create", params);
}

export async function getParticleSystemInfo(params) {
  return sendCommand("particle/info", params);
}

export async function setParticleMainModule(params) {
  return sendCommand("particle/set-main", params);
}

export async function setParticleEmission(params) {
  return sendCommand("particle/set-emission", params);
}

export async function setParticleShape(params) {
  return sendCommand("particle/set-shape", params);
}

export async function particlePlayback(params) {
  return sendCommand("particle/playback", params);
}

// â"€â"€â"€ ScriptableObject â"€â"€â"€

export async function createScriptableObject(params) {
  return sendCommand("scriptableobject/create", params);
}

export async function getScriptableObjectInfo(params) {
  return sendCommand("scriptableobject/info", params);
}

export async function setScriptableObjectField(params) {
  return sendCommand("scriptableobject/set-field", params);
}

export async function listScriptableObjectTypes(params) {
  return sendCommand("scriptableobject/list-types", params);
}

// â"€â"€â"€ Texture â"€â"€â"€

export async function getTextureInfo(params) {
  return sendCommand("texture/info", params);
}

export async function setTextureImportSettings(params) {
  return sendCommand("texture/set-import", params);
}

export async function reimportTexture(params) {
  return sendCommand("texture/reimport", params);
}

// ─── Sprite Atlas ───

export async function createSpriteAtlas(params) {
  return sendCommand("spriteatlas/create", params);
}

export async function getSpriteAtlasInfo(params) {
  return sendCommand("spriteatlas/info", params);
}

export async function addToSpriteAtlas(params) {
  return sendCommand("spriteatlas/add", params);
}

export async function removeFromSpriteAtlas(params) {
  return sendCommand("spriteatlas/remove", params);
}

export async function setSpriteAtlasSettings(params) {
  return sendCommand("spriteatlas/settings", params);
}

export async function deleteSpriteAtlas(params) {
  return sendCommand("spriteatlas/delete", params);
}

export async function listSpriteAtlases(params) {
  return sendCommand("spriteatlas/list", params);
}

// ─── Navigation ───

export async function bakeNavMesh(params) {
  return sendCommand("navigation/bake", params);
}

export async function clearNavMesh(params) {
  return sendCommand("navigation/clear", params);
}

export async function addNavMeshAgent(params) {
  return sendCommand("navigation/add-agent", params);
}

export async function addNavMeshObstacle(params) {
  return sendCommand("navigation/add-obstacle", params);
}

export async function getNavMeshInfo(params) {
  return sendCommand("navigation/info", params);
}

export async function setAgentDestination(params) {
  return sendCommand("navigation/set-destination", params);
}

// â"€â"€â"€ UI â"€â"€â"€

export async function createCanvas(params) {
  return sendCommand("ui/create-canvas", params);
}

export async function createUIElement(params) {
  return sendCommand("ui/create-element", params);
}

export async function getUIInfo(params) {
  return sendCommand("ui/info", params);
}

export async function setUIText(params) {
  return sendCommand("ui/set-text", params);
}

export async function setUIImage(params) {
  return sendCommand("ui/set-image", params);
}

export async function listEditorUIWindows(params) {
  return sendCommand("uitoolkit/windows", params);
}

export async function getEditorUITree(params) {
  return sendCommand("uitoolkit/tree", params);
}

export async function queryEditorUI(params) {
  return sendCommand("uitoolkit/query", params);
}

export async function getEditorUIStyle(params) {
  return sendCommand("uitoolkit/style", params);
}

export async function repaintEditorUI(params) {
  return sendCommand("uitoolkit/repaint", params);
}

// â"€â"€â"€ Package Manager â"€â"€â"€

export async function listPackages(params) {
  return sendCommand("packages/list", params);
}

export async function addPackage(params) {
  return sendCommand("packages/add", params);
}

export async function removePackage(params) {
  return sendCommand("packages/remove", params);
}

export async function searchPackage(params) {
  return sendCommand("packages/search", params);
}

export async function getPackageInfo(params) {
  return sendCommand("packages/info", params);
}

export async function updateGitPackage(params) {
  return sendCommand("packages/update-git", params);
}

export async function lintPackageMetas(params) {
  return sendCommand("packages/lint-metas", params);
}

// â"€â"€â"€ Constraints & LOD â"€â"€â"€

export async function addConstraint(params) {
  return sendCommand("constraint/add", params);
}

export async function getConstraintInfo(params) {
  return sendCommand("constraint/info", params);
}

export async function createLODGroup(params) {
  return sendCommand("lod/create", params);
}

export async function getLODGroupInfo(params) {
  return sendCommand("lod/info", params);
}

// â"€â"€â"€ Prefs â"€â"€â"€

export async function getEditorPref(params) {
  return sendCommand("editorprefs/get", params);
}

export async function setEditorPref(params) {
  return sendCommand("editorprefs/set", params);
}

export async function deleteEditorPref(params) {
  return sendCommand("editorprefs/delete", params);
}

export async function getPlayerPref(params) {
  return sendCommand("playerprefs/get", params);
}

export async function setPlayerPref(params) {
  return sendCommand("playerprefs/set", params);
}

export async function deletePlayerPref(params) {
  return sendCommand("playerprefs/delete", params);
}

export async function deleteAllPlayerPrefs(params) {
  return sendCommand("playerprefs/delete-all", params);
}

// â"€â"€â"€ Project Context â"€â"€â"€

/**
 * Get project context files through the Editor command queue.
 * @param {string} [category] - Optional specific category to fetch. Omit for all.
 * @returns {object} Context data with categories and content.
 */
export async function getProjectContext(category = null) {
  const route = category
    ? `context/${encodeURIComponent(category)}`
    : "context";
  const response = await sendCommand(route, {});
  if (!response.success) {
    throw new Error(response.error || "Project context request failed.");
  }
  return response.data;
}

// ─── Testing ───

export async function runTests(params) {
  return sendCommand("testing/run-tests", params);
}
export async function getTestJob(params) {
  return sendCommand("testing/get-job", params);
}
export async function listTests(params) {
  return sendCommand("testing/list-tests", params);
}
