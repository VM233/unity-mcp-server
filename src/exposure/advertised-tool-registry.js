function publicFingerprint(tool) {
  return JSON.stringify({
    name: tool?.name,
    description: tool?.description,
    inputSchema: tool?.inputSchema,
    outputSchema: tool?.outputSchema,
    annotations: tool?.annotations,
  });
}

export class AdvertisedToolRegistry {
  constructor(bootstrapTools) {
    this._bootstrapNames = new Set(bootstrapTools.map((tool) => tool.name));
    this._activeNames = new Set();
    this._toolsByName = new Map(bootstrapTools.map((tool) => [tool.name, tool]));
  }

  get(name) {
    return this._toolsByName.get(name) || null;
  }

  values() {
    return [...this._toolsByName.values()]
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  activate(tool) {
    if (!tool || typeof tool.name !== "string") {
      throw new Error("Cannot activate an invalid tool definition.");
    }
    const previous = this._toolsByName.get(tool.name);
    this._activeNames.add(tool.name);
    this._toolsByName.set(tool.name, tool);
    return !previous || publicFingerprint(previous) !== publicFingerprint(tool);
  }

  reconcile(catalog) {
    let changed = false;
    for (const name of [...this._activeNames]) {
      const tool = catalog.get(name);
      if (!tool) {
        this._activeNames.delete(name);
        if (!this._bootstrapNames.has(name)) {
          this._toolsByName.delete(name);
        }
        changed = true;
        continue;
      }
      const previous = this._toolsByName.get(name);
      if (!previous || publicFingerprint(previous) !== publicFingerprint(tool)) {
        this._toolsByName.set(name, tool);
        changed = true;
      }
    }
    return changed;
  }
}
