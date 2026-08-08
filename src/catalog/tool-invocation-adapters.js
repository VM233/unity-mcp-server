import {
  compactSuccessfulToolResult,
  createToolError,
} from "../tool-response.js";

function imageResult(result, {
  missingCode,
  missingMessage,
  allowMissing = false,
}) {
  const compact = compactSuccessfulToolResult(result);
  if (compact?.success === false || compact?.error) return compact;
  if (Object.hasOwn(compact || {}, "base64") &&
      typeof compact.base64 !== "string") {
    return createToolError(missingCode, missingMessage);
  }
  if (typeof compact?.base64 !== "string" || compact.base64.length === 0) {
    return allowMissing
      ? compact
      : createToolError(missingCode, missingMessage);
  }

  const metadata = { ...compact };
  delete metadata.base64;
  return [
    { type: "image", data: compact.base64, mimeType: "image/png" },
    { type: "text", text: JSON.stringify(metadata) },
  ];
}

const adapters = new Map([
  ["graphics/asset-preview", async (invoke) => imageResult(await invoke(), {
    missingCode: "asset_preview_payload_missing",
    missingMessage:
      "Unity completed the asset preview request without returning a PNG payload.",
  })],
  ["graphics/material-info", async (invoke) => imageResult(await invoke(), {
    missingCode: "material_preview_payload_invalid",
    missingMessage:
      "Unity returned a material preview payload that is not a base64 string.",
    allowMissing: true,
  })],
]);

export function invokeWithToolAdapter(route, invoke) {
  const adapter = adapters.get(route);
  return adapter ? adapter(invoke) : invoke();
}
