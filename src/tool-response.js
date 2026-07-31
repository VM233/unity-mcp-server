import { Buffer } from "node:buffer";

const SERVER_PRESENCE_TAG_FIELDS = new Map([
  ["pollTimedOut", "pollTimedOut"],
  ["recoveredAfterTransportFailure", "recoveredAfterTransportFailure"],
  ["reloadRecoveryTimedOut", "reloadRecoveryTimedOut"],
  ["replayedAfterLostTicket", "replayedAfterLostTicket"],
  ["ticketReceived", "ticketReceived"],
  ["transportOnly", "transportOnly"],
]);

export function createToolError(errorCode, message, extra = {}) {
  return {
    success: false,
    errorCode,
    retryable: false,
    error: message,
    ...extra,
  };
}

export function serializeToolError(errorCode, message, extra = {}) {
  return JSON.stringify(createToolError(errorCode, message, extra));
}

export function isStructuredToolFailure(result) {
  if (Array.isArray(result)) {
    return result.some((block) =>
      block?.type === "text" && isStructuredToolFailure(block.text));
  }

  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }

  return Boolean(value && typeof value === "object" && value.success === false);
}

export function toContentBlocks(result) {
  if (Array.isArray(result)) {
    return result;
  }

  if (typeof result === "string") {
    return [{ type: "text", text: result }];
  }

  return [{
    type: "text",
    text: JSON.stringify(result === undefined ? null : result),
  }];
}

export const GENERIC_TOOL_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    result: {},
    errorCode: { type: "string" },
    error: { type: "string" },
    retryable: { type: "boolean" },
  },
  required: ["success"],
  oneOf: [
    {
      properties: { success: { const: true } },
      required: ["success", "result"],
    },
    {
      properties: { success: { const: false } },
      required: ["success", "errorCode", "error", "retryable"],
    },
  ],
  additionalProperties: true,
};

export function createToolOutputSchema(resultSchema) {
  const schema = resultSchema && typeof resultSchema === "object" && !Array.isArray(resultSchema)
    ? resultSchema
    : {};
  return {
    type: "object",
    properties: {
      success: { type: "boolean" },
      result: schema,
      errorCode: { type: "string" },
      error: { type: "string" },
      retryable: { type: "boolean" },
    },
    required: ["success"],
    oneOf: [
      {
        properties: { success: { const: true } },
        required: ["success", "result"],
      },
      {
        properties: { success: { const: false } },
        required: ["success", "errorCode", "error", "retryable"],
      },
    ],
    additionalProperties: true,
  };
}

function tryParseJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function summarizeMediaBlocks(blocks) {
  const summary = [];
  for (const block of blocks || []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "image" || block.type === "audio") {
      const item = { type: block.type };
      if (block.mimeType) item.mimeType = block.mimeType;
      summary.push(item);
    }
  }
  return summary;
}

export function normalizeStructuredToolResult(result) {
  if (Array.isArray(result)) {
    const textBlocks = result
      .filter((block) => block?.type === "text")
      .map((block) => tryParseJson(block.text));
    const parsedObject = textBlocks.find((value) =>
      value && typeof value === "object" && !Array.isArray(value));
    if (parsedObject) {
      const normalized = normalizeStructuredToolResult(parsedObject);
      const media = summarizeMediaBlocks(result);
      if (media.length > 0) normalized.media = media;
      return normalized;
    }
    return {
      success: true,
      result: {
        text: textBlocks.map((value) =>
          typeof value === "string" ? value : JSON.stringify(value)),
        media: summarizeMediaBlocks(result),
      },
    };
  }

  const value = tryParseJson(result);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      success: true,
      result: value === undefined ? null : value,
    };
  }

  if (value.success === false) {
    return {
      ...value,
      success: false,
      errorCode: value.errorCode || "operation_failed",
      error: value.error || value.message || "Operation failed.",
      retryable: Boolean(value.retryable),
    };
  }

  if (value.success === true && Object.hasOwn(value, "data")) {
    const { success: _success, data, ...metadata } = value;
    return {
      success: true,
      result: data,
      ...metadata,
    };
  }

  if (value.success === true) {
    if (value.jobId || value.ticketId) {
      const { success: _success, ...operation } = value;
      return {
        success: true,
        result: operation,
      };
    }
    if (Object.hasOwn(value, "result")) {
      return {
        ...value,
        success: true,
      };
    }
    const { success: _success, ...resultValue } = value;
    return {
      success: true,
      result: resultValue,
    };
  }

  return {
    success: true,
    result: value,
  };
}

export function summarizeStructuredToolResult(structuredContent) {
  if (!structuredContent?.success) {
    const code = structuredContent?.errorCode || "operation_failed";
    const message = structuredContent?.error || "Operation failed.";
    return `${code}: ${message}`;
  }

  const result = structuredContent.result;
  const candidate = result && typeof result === "object" && !Array.isArray(result)
    ? result
    : structuredContent;
  if (candidate?.jobId) {
    const type = candidate.jobType || "persistent";
    const status = candidate.status || "queued";
    return `${type} job ${candidate.jobId} is ${status}.`;
  }
  if (candidate?.ticketId) {
    return `Unity queue ticket ${candidate.ticketId} is ${candidate.status || "queued"}.`;
  }
  if (candidate?.cleanupStatus) {
    return `Cleanup is ${candidate.cleanupStatus}.`;
  }
  return "Tool completed successfully.";
}

function compactServerPresenceMetadata(structuredContent) {
  if (!structuredContent || typeof structuredContent !== "object" ||
      Array.isArray(structuredContent)) {
    return structuredContent;
  }

  const compacted = { ...structuredContent };
  const tags = new Set(Array.isArray(compacted.tags) ? compacted.tags : []);
  const containers = [compacted];
  if (compacted.result && typeof compacted.result === "object" &&
      !Array.isArray(compacted.result)) {
    compacted.result = { ...compacted.result };
    containers.push(compacted.result);
  }
  if (compacted.data && typeof compacted.data === "object" &&
      !Array.isArray(compacted.data)) {
    compacted.data = { ...compacted.data };
    containers.push(compacted.data);
  }

  for (const container of containers) {
    for (const [field, tag] of SERVER_PRESENCE_TAG_FIELDS) {
      if (typeof container[field] !== "boolean") continue;
      if (container[field]) tags.add(tag);
      delete container[field];
    }
  }

  if (tags.size > 0) {
    compacted.tags = [...tags]
      .filter((tag) => typeof tag === "string" && tag.length > 0)
      .sort((left, right) => left.localeCompare(right));
  } else {
    delete compacted.tags;
  }
  return compacted;
}

export function buildToolResponse(result) {
  const structuredContent = compactServerPresenceMetadata(
    normalizeStructuredToolResult(result));
  const originalBlocks = Array.isArray(result) ? result : [];
  const mediaBlocks = originalBlocks.filter((block) =>
    block?.type === "image" || block?.type === "audio" || block?.type === "resource");
  return {
    structuredContent,
    content: [
      {
        type: "text",
        text: summarizeStructuredToolResult(structuredContent),
      },
      ...mediaBlocks,
    ],
    ...(structuredContent.success === false ? { isError: true } : {}),
  };
}

export function compactSuccessfulToolResult(result) {
  const wasString = typeof result === "string";
  let value = result;
  if (wasString) {
    try {
      value = JSON.parse(result);
    } catch {
      return result;
    }
  }

  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.success !== true || !Object.hasOwn(value, "data")) {
    return result;
  }

  const { success: _success, data, ...metadata } = value;
  let compacted = data;
  if (Object.keys(metadata).length > 0) {
    compacted = data && typeof data === "object" && !Array.isArray(data)
      ? { ...data, ...metadata }
      : { result: data, ...metadata };
  }

  compacted = compactServerPresenceMetadata(compacted);

  return wasString ? JSON.stringify(compacted) : compacted;
}

export function measureContentBytes(contentBlocks) {
  let totalBytes = 0;
  for (const block of contentBlocks) {
    if (block?.type === "text") {
      totalBytes += Buffer.byteLength(block.text || "", "utf8");
    } else if (block?.type === "image" || block?.type === "audio") {
      totalBytes += Buffer.byteLength(block.data || "", "utf8");
    }
  }
  return totalBytes;
}

export function guardResponseSize(contentBlocks, {
  softLimitBytes,
  hardLimitBytes,
} = {}) {
  const totalBytes = measureContentBytes(contentBlocks);
  const softLimit = Number.isFinite(softLimitBytes) && softLimitBytes > 0
    ? softLimitBytes
    : Number.POSITIVE_INFINITY;
  const hardLimit = Number.isFinite(hardLimitBytes) && hardLimitBytes > 0
    ? hardLimitBytes
    : Number.POSITIVE_INFINITY;

  if (totalBytes > hardLimit) {
    const error = createToolError(
      "response_too_large",
      "Tool response exceeded the transport limit. Retry with pagination or narrower filters.",
      {
        actualBytes: totalBytes,
        limitBytes: hardLimit,
        suggestedParameters: ["offset", "limit", "maxNodes", "parentPath", "filters"],
      }
    );
    return {
      content: [{ type: "text", text: JSON.stringify(error) }],
      totalBytes,
      exceedsSoftLimit: true,
      exceedsHardLimit: true,
    };
  }

  return {
    content: contentBlocks,
    totalBytes,
    exceedsSoftLimit: totalBytes > softLimit,
    exceedsHardLimit: false,
  };
}

export function guardToolResponseSize(response, {
  softLimitBytes,
  hardLimitBytes,
} = {}) {
  const structuredBytes = Buffer.byteLength(
    JSON.stringify(response?.structuredContent ?? null),
    "utf8"
  );
  const contentBytes = measureContentBytes(response?.content || []);
  const totalBytes = structuredBytes + contentBytes;
  const softLimit = Number.isFinite(softLimitBytes) && softLimitBytes > 0
    ? softLimitBytes
    : Number.POSITIVE_INFINITY;
  const hardLimit = Number.isFinite(hardLimitBytes) && hardLimitBytes > 0
    ? hardLimitBytes
    : Number.POSITIVE_INFINITY;

  if (totalBytes > hardLimit) {
    const structuredContent = createToolError(
      "response_too_large",
      "Tool response exceeded the transport limit. Retry with pagination or narrower filters.",
      {
        actualBytes: totalBytes,
        limitBytes: hardLimit,
        suggestedParameters: ["offset", "limit", "maxNodes", "parentPath", "filters"],
      }
    );
    return {
      response: {
        structuredContent,
        content: [{
          type: "text",
          text: summarizeStructuredToolResult(structuredContent),
        }],
        isError: true,
      },
      totalBytes,
      exceedsSoftLimit: true,
      exceedsHardLimit: true,
    };
  }

  return {
    response,
    totalBytes,
    exceedsSoftLimit: totalBytes > softLimit,
    exceedsHardLimit: false,
  };
}
