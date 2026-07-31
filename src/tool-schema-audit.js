const DEFAULT_DESCRIPTION_PREFIXES = [
  "Execute Unity MCP route ",
  "Lazy Unity route: ",
  "(lazy-loaded from Unity plugin)",
];

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function addIssue(issues, code, path, message) {
  issues.push({ code, path, message });
}

function auditSchemaNode(schema, path, issues, { isProperty = false } = {}) {
  if (!isObject(schema)) {
    addIssue(issues, "schema_not_object", path, "Schema node must be an object.");
    return;
  }

  if (isProperty && !String(schema.description || "").trim()) {
    addIssue(
      issues,
      "property_description_missing",
      path,
      "Property schema needs a non-empty description."
    );
  }

  if (schema.type === "array" && !isObject(schema.items)) {
    addIssue(
      issues,
      "array_items_missing",
      path,
      "Array schema needs an items schema."
    );
  }

  if (schema.properties !== undefined && !isObject(schema.properties)) {
    addIssue(
      issues,
      "properties_not_object",
      `${path}.properties`,
      "properties must be an object."
    );
  }

  const properties = isObject(schema.properties) ? schema.properties : {};
  for (const [name, propertySchema] of Object.entries(properties)) {
    auditSchemaNode(propertySchema, `${path}.${name}`, issues, {
      isProperty: true,
    });
  }

  if (isObject(schema.items)) {
    auditSchemaNode(schema.items, `${path}[]`, issues);
  }

  if (Array.isArray(schema.required)) {
    for (const name of schema.required) {
      if (typeof name !== "string" || !Object.hasOwn(properties, name)) {
        addIssue(
          issues,
          "required_property_undeclared",
          `${path}.required`,
          `Required property "${name}" is not declared in properties.`
        );
      }
    }
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    if (schema[keyword] === undefined) continue;
    if (!Array.isArray(schema[keyword]) || schema[keyword].length === 0) {
      addIssue(
        issues,
        "schema_variants_invalid",
        `${path}.${keyword}`,
        `${keyword} must be a non-empty array of schemas.`
      );
      continue;
    }
    schema[keyword].forEach((variant, index) => {
      auditSchemaNode(variant, `${path}.${keyword}[${index}]`, issues);
    });
  }
}

export function auditSchema(schema, path = "$.schema") {
  const issues = [];
  auditSchemaNode(schema, path, issues);
  return issues;
}

export function auditToolDescriptor(tool, { requireRoute = false } = {}) {
  const issues = [];
  const name = tool?.name || tool?.toolName;
  if (typeof name !== "string" || !name.trim()) {
    addIssue(issues, "tool_name_missing", "$.name", "Tool name is required.");
  }
  if (requireRoute && (typeof tool?.route !== "string" || !tool.route.trim())) {
    addIssue(issues, "tool_route_missing", "$.route", "Tool route is required.");
  }

  const description = String(tool?.description || "").trim();
  if (!description) {
    addIssue(
      issues,
      "tool_description_missing",
      "$.description",
      "Tool description is required."
    );
  } else if (DEFAULT_DESCRIPTION_PREFIXES.some((prefix) =>
    description.startsWith(prefix))) {
    addIssue(
      issues,
      "tool_description_default",
      "$.description",
      "Tool description must explain the concrete behavior."
    );
  }

  issues.push(...auditSchema(tool?.inputSchema, "$.inputSchema"));
  if (tool?.outputSchema !== undefined && tool?.outputSchema !== null) {
    issues.push(...auditSchema(tool.outputSchema, "$.outputSchema"));
  }
  return issues;
}

export function auditToolCatalog(tools, options = {}) {
  const issues = [];
  const names = new Set();
  for (const tool of tools || []) {
    const name = tool?.name || tool?.toolName || "<unnamed>";
    if (names.has(name)) {
      issues.push({
        tool: name,
        code: "duplicate_tool_name",
        path: "$.name",
        message: `Tool name "${name}" is duplicated.`,
      });
    }
    names.add(name);

    for (const issue of auditToolDescriptor(tool, options)) {
      issues.push({ tool: name, ...issue });
    }
  }
  return issues;
}
