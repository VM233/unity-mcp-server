import { createToolError } from "../tool-response.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;

function normalize(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase();
}

function tokenize(value) {
  const normalized = normalize(value);
  const tokens = new Set(normalized.match(/[\p{L}\p{N}]+/gu) || []);
  for (const token of [...tokens]) {
    if (/^[\p{Script=Han}]+$/u.test(token) && token.length > 1) {
      for (let index = 0; index < token.length - 1; index++) {
        tokens.add(token.slice(index, index + 2));
      }
    }
  }
  return [...tokens];
}

function matchesFilter(actual, expected) {
  return !expected || normalize(actual) === normalize(expected);
}

function listContainsAll(actual, expected) {
  if (!Array.isArray(expected) || expected.length === 0) return true;
  const values = new Set((actual || []).map(normalize));
  return expected.every((item) => values.has(normalize(item)));
}

function toolSearchDocument(tool) {
  const metadata = tool.catalog || {};
  return normalize([
    tool.name,
    tool.description,
    metadata.moduleId,
    metadata.category,
    metadata.capability,
    metadata.operationKind,
    metadata.whenToUse,
    ...(metadata.aliases || []),
    ...(metadata.searchTerms || []),
  ].join(" "));
}

function scoreTool(tool, query) {
  const metadata = tool.catalog || {};
  const normalizedQuery = normalize(query);
  const normalizedName = normalize(tool.name);
  const aliases = (metadata.aliases || []).map(normalize);
  const document = toolSearchDocument(tool);
  const queryTokens = tokenize(query);
  let score = 0;
  const reasons = [];

  if (normalizedName === normalizedQuery) {
    score += 1000;
    reasons.push("canonicalName");
  } else if (normalizedName.includes(normalizedQuery)) {
    score += 300;
    reasons.push("canonicalName");
  }
  if (aliases.includes(normalizedQuery)) {
    score += 500;
    reasons.push("alias");
  }
  if (normalize(metadata.capability).includes(normalizedQuery)) {
    score += 180;
    reasons.push("capability");
  }

  let matchedTokens = 0;
  for (const token of queryTokens) {
    if (token.length > 0 && document.includes(token)) {
      matchedTokens++;
    }
  }
  if (matchedTokens > 0) {
    score += matchedTokens * 35;
    reasons.push(...queryTokens
      .filter((token) => document.includes(token))
      .slice(0, 4));
  }
  if (queryTokens.length > 0 && matchedTokens === queryTokens.length) {
    score += 120;
  }

  const notFor = normalize(metadata.notFor);
  if (notFor && queryTokens.some((token) => notFor.includes(token))) {
    score -= 80;
  }
  return { score, reasons: [...new Set(reasons)] };
}

function brief(tool, match) {
  const metadata = tool.catalog || {};
  const requiredArguments = Array.isArray(tool.inputSchema?.required)
    ? tool.inputSchema.required
    : [];
  return {
    name: tool.name,
    moduleId: metadata.moduleId,
    category: metadata.category,
    capability: metadata.capability,
    summary: tool.description,
    ...(match?.reasons?.length ? { whyMatched: match.reasons } : {}),
    ...(requiredArguments.length ? { requiredArguments } : {}),
    ...(metadata.preconditions?.length
      ? { preconditions: metadata.preconditions }
      : {}),
    ...(metadata.sideEffects?.length
      ? { sideEffects: metadata.sideEffects }
      : {}),
    ...(metadata.notFor ? { notFor: metadata.notFor } : {}),
  };
}

function details(tool, revision) {
  const metadata = tool.catalog || {};
  return {
    name: tool.name,
    moduleId: metadata.moduleId,
    category: metadata.category,
    capability: metadata.capability,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema || {},
    annotations: tool.annotations || {},
    ...(metadata.operationKind ? { operationKind: metadata.operationKind } : {}),
    ...(metadata.whenToUse ? { whenToUse: metadata.whenToUse } : {}),
    ...(metadata.notFor ? { notFor: metadata.notFor } : {}),
    ...(metadata.preconditions?.length
      ? { preconditions: metadata.preconditions }
      : {}),
    ...(metadata.sideEffects?.length
      ? { sideEffects: metadata.sideEffects }
      : {}),
    ...(metadata.errorCodes?.length ? { errorCodes: metadata.errorCodes } : {}),
    ...(metadata.completionEvidence
      ? { completionEvidence: metadata.completionEvidence }
      : {}),
    ...(metadata.cleanupToolName
      ? { cleanupToolName: metadata.cleanupToolName }
      : {}),
    catalogRevision: revision,
  };
}

export function createToolDiscoveryTools({
  catalog,
  refreshCatalog,
  activateTool,
}) {
  const refresh = async () => {
    await refreshCatalog();
    return catalog.values();
  };

  const listTool = {
    name: "unity_tools_list",
    description:
      "Browse the canonical Unity MCP tool catalog by module or category. " +
      "Call without filters for bounded module and category counts; this tool never returns full schemas.",
    inputSchema: {
      type: "object",
      properties: {
        moduleId: {
          type: "string",
          description: "Exact module identifier to browse.",
        },
        category: {
          type: "string",
          description: "Exact category identifier to browse.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Zero-based result offset. Defaults to 0.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIST_LIMIT,
          description: `Maximum returned tools. Defaults to ${DEFAULT_LIST_LIMIT}.`,
        },
      },
      additionalProperties: false,
    },
    handler: async ({ moduleId, category, offset = 0, limit = DEFAULT_LIST_LIMIT } = {}) => {
      const tools = await refresh();
      if (!moduleId && !category) {
        const moduleCounts = new Map();
        const categoryCounts = new Map();
        for (const tool of tools) {
          const metadata = tool.catalog || {};
          moduleCounts.set(metadata.moduleId,
            (moduleCounts.get(metadata.moduleId) || 0) + 1);
          categoryCounts.set(metadata.category,
            (categoryCounts.get(metadata.category) || 0) + 1);
        }
        return {
          totalTools: tools.length,
          modules: [...moduleCounts]
            .map(([name, toolCount]) => ({ name, toolCount }))
            .sort((left, right) => left.name.localeCompare(right.name)),
          categories: [...categoryCounts]
            .map(([name, toolCount]) => ({ name, toolCount }))
            .sort((left, right) => left.name.localeCompare(right.name)),
          hint: "Call unity_tools_search for an intent or call again with moduleId/category to browse tools.",
        };
      }

      offset = Math.max(0, Number(offset) || 0);
      limit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
      const matching = tools.filter((tool) =>
        matchesFilter(tool.catalog?.moduleId, moduleId) &&
        matchesFilter(tool.catalog?.category, category));
      const page = matching.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return {
        tools: page.map((tool) => brief(tool)),
        ...(offset ? { offset } : {}),
        ...(nextOffset < matching.length
          ? { nextOffset, totalTools: matching.length }
          : {}),
      };
    },
  };

  const searchTool = {
    name: "unity_tools_search",
    description:
      "Find canonical typed Unity MCP tools from a natural-language task. " +
      "Returns a small ranked set with boundaries, required arguments, preconditions, and side effects but no full schemas.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "Natural-language task or exact tool name.",
        },
        moduleId: {
          type: "string",
          description: "Optional exact module identifier.",
        },
        category: {
          type: "string",
          description: "Optional exact category identifier.",
        },
        capability: {
          type: "string",
          description: "Optional exact module-defined capability.",
        },
        operationKind: {
          type: "string",
          description: "Optional exact operation kind such as inspect, update, validate, or build.",
        },
        effects: {
          type: "array",
          items: { type: "string" },
          uniqueItems: true,
          description: "Optional side effects that every result must declare.",
        },
        preconditions: {
          type: "array",
          items: { type: "string" },
          uniqueItems: true,
          description: "Optional preconditions that every result must declare.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
          description: `Maximum candidates. Defaults to ${DEFAULT_SEARCH_LIMIT}.`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: async ({
      query,
      moduleId,
      category,
      capability,
      operationKind,
      effects,
      preconditions,
      limit = DEFAULT_SEARCH_LIMIT,
    } = {}) => {
      if (typeof query !== "string" || query.trim().length === 0) {
        return createToolError("tool_query_required", "query is required.");
      }
      const tools = await refresh();
      limit = Math.max(1, Math.min(Number(limit) || DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT));
      const candidates = [];
      for (const tool of tools) {
        const metadata = tool.catalog || {};
        if (!matchesFilter(metadata.moduleId, moduleId) ||
            !matchesFilter(metadata.category, category) ||
            !matchesFilter(metadata.capability, capability) ||
            !matchesFilter(metadata.operationKind, operationKind) ||
            !listContainsAll(metadata.sideEffects, effects) ||
            !listContainsAll(metadata.preconditions, preconditions)) {
          continue;
        }
        const match = scoreTool(tool, query);
        if (match.score > 0) candidates.push({ tool, match });
      }
      candidates.sort((left, right) =>
        right.match.score - left.match.score ||
        left.tool.name.localeCompare(right.tool.name));
      return {
        query,
        results: candidates.slice(0, limit)
          .map(({ tool, match }) => brief(tool, match)),
        hint: "Call unity_tools_get for one result to obtain its full schema and activate it.",
      };
    },
  };

  const getTool = {
    name: "unity_tools_get",
    description:
      "Get the complete contract for one canonical Unity MCP tool and activate that typed tool for direct invocation. " +
      "Use an exact name returned by unity_tools_search or unity_tools_list.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          minLength: 1,
          description: "Exact canonical tool name.",
        },
        activate: {
          type: "boolean",
          description: "Activate the tool in the MCP tool list. Defaults to true.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: async ({ name, activate = true } = {}) => {
      if (typeof name !== "string" || name.trim().length === 0) {
        return createToolError("tool_name_required", "name is required.");
      }
      await refresh();
      const tool = catalog.get(name.trim());
      if (!tool) {
        return createToolError(
          "tool_not_found",
          `No canonical Unity MCP tool named ${name.trim()} exists.`,
          { name: name.trim(), nextTool: "unity_tools_search" }
        );
      }
      let activated = false;
      if (activate !== false) {
        activated = await activateTool(tool);
      }
      return {
        tool: details(tool, catalog.revision),
        activated,
        nextTool: tool.name,
      };
    },
  };

  return [listTool, searchTool, getTool];
}
