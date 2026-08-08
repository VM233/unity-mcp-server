function normalizeHostTool(tool, metadata) {
  return {
    ...tool,
    catalog: {
      sourceKind: "host",
      moduleId: metadata.moduleId,
      category: metadata.category,
      capability: metadata.capability || metadata.category,
      aliases: metadata.aliases || [],
      searchTerms: metadata.searchTerms || [],
      operationKind: metadata.operationKind || "",
      whenToUse: metadata.whenToUse || "",
      notFor: metadata.notFor || "",
      preconditions: metadata.preconditions || [],
      sideEffects: metadata.sideEffects || [],
      errorCodes: metadata.errorCodes || [],
      completionEvidence: metadata.completionEvidence || "",
      cleanupToolName: "",
      tags: metadata.tags || [],
    },
  };
}

export class ToolCatalog {
  constructor({ unitySource, hostTools = [] }) {
    this._unitySource = unitySource;
    this._hostTools = hostTools.map(({ tool, metadata }) =>
      normalizeHostTool(tool, metadata));
    this._toolsByName = new Map();
    this._revision = "host";
    this._rebuild();
  }

  get revision() {
    return this._revision;
  }

  get schemaVersion() {
    return this._unitySource.schemaVersion;
  }

  values() {
    return [...this._toolsByName.values()]
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  get(name) {
    return this._toolsByName.get(name) || null;
  }

  addHostTools(hostTools) {
    this._hostTools.push(...hostTools.map(({ tool, metadata }) =>
      normalizeHostTool(tool, metadata)));
    this._rebuild();
  }

  async refreshUnity() {
    const result = await this._unitySource.refresh();
    if (result.changed) {
      this._revision = result.revision;
      this._rebuild();
    }
    return result;
  }

  _rebuild() {
    const toolsByName = new Map();
    for (const tool of [...this._hostTools, ...this._unitySource.tools]) {
      if (toolsByName.has(tool.name)) {
        throw new Error(`Tool catalog contains duplicate tool name ${tool.name}.`);
      }
      toolsByName.set(tool.name, tool);
    }
    this._toolsByName = toolsByName;
  }
}

export function hostTool(tool, metadata) {
  return { tool, metadata };
}
