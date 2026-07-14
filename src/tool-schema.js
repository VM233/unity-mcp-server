const TOOLS_SKIP_EDITOR_BINDING_INJECT = new Set([
  "unity_select_instance",
  "unity_list_instances",
]);

export function injectEditorBindingSchema(name, inputSchema) {
  if (
    !name.startsWith("unity_") ||
    name.startsWith("unity_hub_") ||
    TOOLS_SKIP_EDITOR_BINDING_INJECT.has(name)
  ) {
    return inputSchema;
  }

  const baseSchema = inputSchema || { type: "object", properties: {} };
  const properties = { ...(baseSchema.properties || {}) };
  properties.port ??= {
    type: "number",
    description: "Target Editor port.",
  };
  properties.expectedProjectPath ??= {
    type: "string",
    description:
      "Expected Unity project root path. Also resolves the target instance when port is omitted; the request is rejected before mutation if the path does not match.",
  };

  return {
    ...baseSchema,
    properties,
  };
}
