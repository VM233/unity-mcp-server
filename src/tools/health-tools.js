export function createHealthTools({ getCatalog, getSelectedInstance }) {
  return [
    {
      name: "unity_mcp_health",
      description:
        "Inspect the Unity MCP host binding and canonical catalog state without changing Unity. " +
        "Use this before discovery when connection or project ownership is uncertain.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: async () => {
        const catalog = getCatalog();
        const selected = getSelectedInstance();
        return {
          binding: selected
            ? {
                port: selected.port,
                projectName: selected.projectName,
                projectPath: selected.projectPath,
              }
            : null,
          catalogRevision: catalog.revision,
          catalogSchemaVersion: catalog.schemaVersion,
          catalogToolCount: catalog.values().length,
        };
      },
    },
  ];
}
