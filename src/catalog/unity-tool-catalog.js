import {
  cancelTicket,
  getQueueInfo,
  getTicketStatus,
  sendCommand,
} from "../unity-editor-bridge.js";
import { createHash } from "node:crypto";
import { invokeWithToolAdapter } from "./tool-invocation-adapters.js";

const MAX_METADATA_PAGES = 100;
const METADATA_PAGE_SIZE = 200;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringList(value) {
  return Array.isArray(value)
    ? [...new Set(value
      .filter((item) => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim()))]
      .sort((left, right) => left.localeCompare(right))
    : [];
}

async function invokeUnityTool(route, argumentsValue) {
  switch (route) {
    case "queue/info":
      return getQueueInfo();
    case "queue/status":
      return getTicketStatus(argumentsValue?.ticketId);
    case "queue/cancel":
      return cancelTicket(argumentsValue?.ticketId);
    default:
      return sendCommand(route, argumentsValue || {});
  }
}

function requireString(metadata, propertyName) {
  const value = metadata?.[propertyName];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Unity tool metadata requires a non-empty ${propertyName}.`
    );
  }
  return value.trim();
}

function normalizeSchema(metadata, propertyName) {
  const value = metadata?.[propertyName];
  if (!isObject(value)) {
    throw new Error(
      `Unity tool ${metadata?.toolName || metadata?.route || "<unknown>"} ` +
      `requires an object ${propertyName}.`
    );
  }
  return value;
}

export function unityMetadataToCatalogTool(metadata) {
  const name = requireString(metadata, "toolName");
  const route = requireString(metadata, "route");
  const category = requireString(metadata, "category");
  const description = requireString(metadata, "description");
  const inputSchema = normalizeSchema(metadata, "inputSchema");
  const outputSchema = normalizeSchema(metadata, "outputSchema");
  const moduleId = typeof metadata.moduleId === "string" && metadata.moduleId.trim()
    ? metadata.moduleId.trim()
    : `unity.${category}`;

  return {
    name,
    description,
    inputSchema,
    outputSchema,
    annotations: isObject(metadata.annotations) ? metadata.annotations : {},
    handler: (argumentsValue = {}) => invokeWithToolAdapter(
      route, () => invokeUnityTool(route, argumentsValue)),
    catalog: {
      sourceKind: "unity",
      moduleId,
      category,
      capability: typeof metadata.capability === "string"
        ? metadata.capability.trim()
        : category,
      route,
      aliases: normalizeStringList(metadata.aliases),
      searchTerms: normalizeStringList(metadata.searchTerms),
      operationKind: typeof metadata.operationKind === "string"
        ? metadata.operationKind.trim()
        : "",
      whenToUse: typeof metadata.whenToUse === "string"
        ? metadata.whenToUse.trim()
        : "",
      notFor: typeof metadata.notFor === "string"
        ? metadata.notFor.trim()
        : "",
      preconditions: normalizeStringList(metadata.preconditions),
      sideEffects: normalizeStringList(metadata.sideEffects),
      errorCodes: normalizeStringList(metadata.errorCodes),
      completionEvidence: typeof metadata.completionEvidence === "string"
        ? metadata.completionEvidence.trim()
        : "",
      cleanupToolName: typeof metadata.cleanupToolName === "string"
        ? metadata.cleanupToolName.trim()
        : "",
      tags: normalizeStringList(metadata.tags),
    },
  };
}

function catalogFingerprint(tools) {
  const canonical = JSON.stringify(tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
      catalog: tool.catalog,
    }))
    .sort((left, right) => left.name.localeCompare(right.name)));
  return createHash("sha256").update(canonical).digest("hex");
}

export async function fetchUnityToolMetadata() {
  const tools = [];
  let offset = 0;
  let schemaVersion = null;

  for (let page = 0; page < MAX_METADATA_PAGES; page++) {
    let response = await sendCommand("_meta/tools", {
      compact: true,
      includeSchema: true,
      offset,
      limit: METADATA_PAGE_SIZE,
    });
    response = response?.data ?? response;
    if (!isObject(response) || !Array.isArray(response.tools)) {
      throw new Error("Unity _meta/tools returned an invalid catalog page.");
    }

    schemaVersion ??= response.schemaVersion ?? null;
    tools.push(...response.tools);
    if (!Number.isInteger(response.nextOffset) || response.tools.length === 0) {
      return { tools, schemaVersion };
    }
    offset = response.nextOffset;
  }

  throw new Error("Unity _meta/tools exceeded the metadata pagination limit.");
}

export class UnityToolCatalogSource {
  constructor() {
    this._tools = [];
    this._fingerprint = createHash("sha256").update("[]").digest("hex");
    this._schemaVersion = null;
  }

  get tools() {
    return this._tools;
  }

  get revision() {
    return this._fingerprint;
  }

  get schemaVersion() {
    return this._schemaVersion;
  }

  async refresh() {
    const metadata = await fetchUnityToolMetadata();
    const tools = metadata.tools.map(unityMetadataToCatalogTool);
    const names = new Set();
    for (const tool of tools) {
      if (names.has(tool.name)) {
        throw new Error(`Unity catalog contains duplicate tool name ${tool.name}.`);
      }
      names.add(tool.name);
    }

    const fingerprint = catalogFingerprint(tools);
    const changed = fingerprint !== this._fingerprint;
    if (changed) {
      this._tools = tools;
      this._fingerprint = fingerprint;
      this._schemaVersion = metadata.schemaVersion;
    }
    return {
      changed,
      revision: this._fingerprint,
      schemaVersion: this._schemaVersion,
      toolCount: this._tools.length,
    };
  }
}
