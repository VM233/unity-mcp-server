import { Buffer } from "node:buffer";

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
