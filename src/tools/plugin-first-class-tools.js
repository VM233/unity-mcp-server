const vector3Schema = (description) => ({
  type: "object",
  description,
  properties: {
    x: { type: "number" },
    y: { type: "number" },
    z: { type: "number" },
  },
});

const diffProperties = {
  includePrefabFileDiff: {
    type: "boolean",
    description: "Return before/after prefab YAML diff. Defaults to true.",
  },
  prefabFileDiffMode: {
    type: "string",
    description: "Diff return mode: summary, minimal, or full. Defaults to summary.",
  },
  prefabFileDiffContextLines: {
    type: "number",
    description: "Context lines around prefab YAML changes.",
  },
  prefabFileDiffMaxLines: {
    type: "number",
    description: "Maximum diff lines returned.",
  },
};

const typeProp = (name) => ({
  type: "string",
  enum: [name],
  description: "Operation type. The runtime also accepts op or action, but type is preferred.",
});

const prefabPathProp = {
  type: "string",
  description: "Path of the GameObject inside the prefab. Empty means root.",
};

const componentIndexProps = {
  componentIndex: {
    type: "number",
    description: "Component index when multiple components of this type exist. Defaults to 0.",
  },
};

const transformProps = {
  position: vector3Schema("Optional local position."),
  rotation: vector3Schema("Optional local Euler rotation."),
  scale: vector3Schema("Optional local scale."),
};

// Kept out of tools/list; optional catalog consumers can import the detailed form on demand.
export const detailedPrefabBatchOperationSchema = {
  oneOf: [
    {
      type: "object",
      description: "Add a component to a GameObject inside the prefab.",
      properties: {
        type: typeProp("addComponent"),
        prefabPath: prefabPathProp,
        componentType: {
          type: "string",
          description: "Component type name or full name.",
        },
        properties: {
          type: "object",
          description: "Optional serialized properties to set on the new component.",
        },
      },
      required: ["type", "componentType"],
      additionalProperties: true,
    },
    {
      type: "object",
      description: "Set serialized properties on an existing component.",
      properties: {
        type: typeProp("setProperty"),
        prefabPath: prefabPathProp,
        componentType: {
          type: "string",
          description: "Component type name or full name.",
        },
        ...componentIndexProps,
        propertyName: {
          type: "string",
          description: "Single serialized property name or path to set.",
        },
        value: {
          description: "Value for propertyName.",
        },
        properties: {
          type: "object",
          description: "Map of serialized property names to values.",
        },
      },
      required: ["type", "componentType"],
      additionalProperties: true,
    },
    {
      type: "object",
      description: "Set an ObjectReference property on an existing component.",
      properties: {
        type: typeProp("setReference"),
        prefabPath: prefabPathProp,
        componentType: {
          type: "string",
          description: "Component type name or full name. Optional when propertyName can identify the component.",
        },
        ...componentIndexProps,
        propertyName: {
          type: "string",
          description: "ObjectReference serialized property name or path.",
        },
        referenceAssetPath: {
          type: "string",
          description: "Project asset path to assign.",
        },
        referencePrefabPath: {
          type: "string",
          description: "Path of a GameObject inside the same prefab to assign.",
        },
        referenceComponentType: {
          type: "string",
          description: "When using referencePrefabPath, assign this component instead of the GameObject.",
        },
        clear: {
          type: "boolean",
          description: "Clear the ObjectReference.",
        },
      },
      required: ["type", "propertyName"],
      additionalProperties: true,
    },
    {
      type: "object",
      description: "Create a new child GameObject inside the prefab.",
      properties: {
        type: typeProp("addGameObject"),
        parentPrefabPath: {
          type: "string",
          description: "Parent path inside the prefab. Empty means root.",
        },
        name: {
          type: "string",
          description: "Name of the new child GameObject.",
        },
        primitiveType: {
          type: "string",
          description: "Optional Unity PrimitiveType to create, e.g. Cube or Sphere.",
        },
        ...transformProps,
      },
      required: ["type", "name"],
      additionalProperties: true,
    },
    {
      type: "object",
      description: "Instantiate a prefab asset as a child inside the target prefab asset.",
      properties: {
        type: typeProp("instantiatePrefab"),
        sourcePrefabPath: {
          type: "string",
          description: "Prefab asset path to instantiate into the target prefab.",
        },
        parentPrefabPath: {
          type: "string",
          description: "Parent path inside the target prefab. Empty means root.",
        },
        name: {
          type: "string",
          description: "Optional name override for the created GameObject.",
        },
        siblingIndex: {
          type: "number",
          description: "Optional sibling index under the parent.",
        },
        ...transformProps,
      },
      required: ["type", "sourcePrefabPath"],
      additionalProperties: true,
    },
    {
      type: "object",
      description: "Remove a component from a GameObject inside the prefab.",
      properties: {
        type: typeProp("removeComponent"),
        prefabPath: prefabPathProp,
        componentType: {
          type: "string",
          description: "Component type name or full name.",
        },
        ...componentIndexProps,
      },
      required: ["type", "componentType"],
      additionalProperties: true,
    },
    {
      type: "object",
      description: "Remove a child GameObject from inside the prefab. The root cannot be removed.",
      properties: {
        type: typeProp("removeGameObject"),
        prefabPath: {
          type: "string",
          description: "Child GameObject path to remove.",
        },
      },
      required: ["type", "prefabPath"],
      additionalProperties: true,
    },
    {
      type: "object",
      description: "Move or reorder a child GameObject inside the prefab.",
      properties: {
        type: typeProp("moveGameObject"),
        prefabPath: {
          type: "string",
          description: "GameObject path to move.",
        },
        newParentPrefabPath: {
          type: "string",
          description: "New parent path inside the prefab. Empty means root.",
        },
        siblingIndex: {
          type: "number",
          description: "Optional sibling index under the new parent.",
        },
        worldPositionStays: {
          type: "boolean",
          description: "Preserve world transform while reparenting. Defaults to false.",
        },
      },
      required: ["type", "prefabPath"],
      additionalProperties: true,
    },
  ],
};

const compactBatchOperationSchema = {
  type: "object",
  description: "Prefab edit operation. Use type plus fields accepted by the matching prefab-asset route.",
  properties: {
    type: {
      type: "string",
      enum: [
        "addComponent",
        "setProperty",
        "setReference",
        "addGameObject",
        "instantiatePrefab",
        "removeComponent",
        "removeGameObject",
        "moveGameObject",
      ],
    },
  },
  required: ["type"],
  additionalProperties: true,
};

const executionSchema = ({ includeContinueOnError = true } = {}) => {
  const properties = {
    mode: {
      type: "string",
      enum: ["auto", "immediate", "batched"],
      description: "Execution mode. auto batches multi-operation requests, immediate runs in one frame, and batched yields across frames.",
    },
    operationsPerFrame: {
      type: "number",
      description: "Maximum operations processed in one editor frame. Defaults to 25.",
    },
    frameBudgetMs: {
      type: "number",
      description: "Soft per-frame execution budget in milliseconds. Defaults to 8.",
    },
    timeoutMs: {
      type: "number",
      description: "Maximum total execution time in milliseconds. Defaults to 90000.",
    },
  };
  if (includeContinueOnError) {
    properties.continueOnError = {
      type: "boolean",
      description: "Continue processing later operations after one fails. Defaults to false.",
    };
  }
  return { type: "object", properties };
};

const prefabBatchSchema = () => ({
  type: "object",
  properties: {
    assetPath: {
      type: "string",
      description: "Prefab asset path to edit.",
    },
    waitForTypes: {
      type: "boolean",
      description: "Wait for all referenced component types before editing. Defaults to true.",
    },
    typeResolveTimeoutMs: {
      type: "number",
      description: "Maximum type wait time in milliseconds. Defaults to 30000.",
    },
    typeResolveStableMs: {
      type: "number",
      description: "Continuous idle time after type resolution before editing. Defaults to 500.",
    },
    refreshAssets: {
      type: "boolean",
      description: "Call AssetDatabase.Refresh once before waiting. Defaults to true.",
    },
    includePrefabFileDiff: {
      type: "boolean",
      description: "Return before/after prefab YAML diff. Defaults to true.",
    },
    prefabFileDiffMode: {
      type: "string",
      description: "Diff return mode: summary, minimal, or full. Defaults to summary.",
    },
    prefabFileDiffContextLines: {
      type: "number",
      description: "Context lines around prefab YAML changes. Defaults to 2.",
    },
    prefabFileDiffMaxLines: {
      type: "number",
      description: "Maximum diff lines returned. Defaults to 200.",
    },
    prefabFileDiffIgnoreContains: {
      type: "array",
      description: "Optional substrings used to hide noisy diff lines.",
      items: { type: "string" },
    },
    prefabFileDiffIgnoreYamlProperties: {
      type: "array",
      description: "Optional YAML property names used to hide noisy diff lines.",
      items: { type: "string" },
    },
    execution: executionSchema({ includeContinueOnError: false }),
    operations: {
      type: "array",
      description: "Ordered prefab asset edit operations.",
      items: compactBatchOperationSchema,
    },
  },
  required: ["assetPath", "operations"],
});

const componentSetReferenceSchema = () => ({
  type: "object",
  properties: {
    path: { type: "string", description: "Default target GameObject inherited by reference items." },
    instanceId: { type: "string", description: "Default target instance ID inherited by reference items." },
    componentType: { type: "string", description: "Default component type inherited by reference items." },
    execution: executionSchema(),
    references: {
      type: "array",
      description: "Reference assignments. Every item requires propertyName and one reference source or clear=true.",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Target scene GameObject path or name." },
          instanceId: { type: "string", description: "Target scene GameObject instance ID." },
          componentType: { type: "string", description: "Component containing the property." },
          propertyName: { type: "string", description: "ObjectReference property to assign." },
          assetPath: { type: "string", description: "Asset path to assign." },
          referenceGameObject: { type: "string", description: "Scene GameObject path or name to assign." },
          referenceComponentType: { type: "string", description: "Component type on the referenced GameObject." },
          referenceInstanceId: { type: "number", description: "Unity object instance ID to assign." },
          clear: { type: "boolean", description: "Clear the reference." },
        },
        required: ["propertyName"],
      },
    },
  },
  required: ["references"],
});

const assetMoveSchema = () => ({
  type: "object",
  properties: {
    dryRun: { type: "boolean", description: "Validate every move and return expected paths without moving." },
    execution: executionSchema(),
    moves: {
      type: "array",
      description: "Move requests. Every item needs a source path and one destination path or folder field.",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Current asset path." },
          destinationPath: { type: "string", description: "Destination asset path, or an existing folder path to keep the same file name." },
          destinationFolder: { type: "string", description: "Existing folder path to keep the same file name." },
        },
      },
    },
  },
  required: ["moves"],
});

const localizationUpsertEntrySchema = () => ({
  type: "object",
  properties: {
    collection: { type: "string", description: "Table Collection name or GUID." },
    type: { type: "string", enum: ["string", "asset"], description: "Collection type. Defaults to string." },
    createTables: { type: "boolean", description: "Create missing Locale tables. Defaults to true." },
    execution: executionSchema(),
    entries: {
      type: "array",
      description: "Up to 500 Locale entry writes. The entire request is validated before changes are made.",
      items: {
        type: "object",
        properties: {
          key: { type: "string", description: "Shared localization key." },
          locale: { type: "string", description: "Target Locale code." },
          value: { type: "string", description: "String or Smart String value when type is string." },
          smart: { type: "boolean", description: "Optional Smart String flag when type is string." },
          assetPath: { type: "string", description: "Asset path when type is asset." },
          subAssetName: { type: "string", description: "Optional exact sub-asset name at assetPath." },
        },
        required: ["key", "locale"],
      },
    },
  },
  required: ["collection", "entries"],
});

const firstClassPluginRoutes = [
  "packages/update-git",
  "wait/editor-idle",
  "serialized-object/get",
  "serialized-object/set",
  "prefab-asset/add-component",
  "prefab-asset/add-gameobject",
  "prefab-asset/get-properties",
  "prefab-asset/hierarchy",
  "prefab-asset/instantiate-prefab",
  "prefab-asset/move-component",
  "prefab-asset/move-gameobject",
  "prefab-asset/find",
  "prefab-asset/remove-component",
  "prefab-asset/remove-gameobject",
  "prefab-asset/set-property",
  "prefab-asset/set-reference",
  "prefab-asset/transaction-edit",
  "component/set-reference",
  "asset/refresh",
  "asset/get-refresh-job",
  "asset/rename",
  "asset/move",
  "asset/export-unitypackage",
  "localization/upsert-entry",
  "console/query",
  "uitoolkit/asset-inspect",
  "uitoolkit/runtime-documents",
  "uitoolkit/runtime-tree",
  "uitoolkit/runtime-query",
  "uitoolkit/runtime-style",
  "uitoolkit/runtime-repaint",
  "uitoolkit/refresh",
  "uitoolkit/wait-refresh",
  "uitoolkit/assert-layout",
  "uitoolkit/locate-element",
  "uitoolkit/capture-element",
  "uitoolkit/compare-element",
  "uitoolkit/builder-preview",
  "testing/list-tests",
  "testing/run-tests",
  "testing/get-job",
  "testing/run-package-tests",
  "testing/get-package-job",
  "project-tools/list",
  "project-tools/execute",
];

function routeToToolName(route) {
  return "unity_" + route.replace(/\//g, "_").replace(/-/g, "_");
}

function routeToDescription(route) {
  return `Direct Unity route: ${route}. Schema is loaded from Unity metadata when available.`;
}

const detailedStaticFirstClassPluginTools = [
  {
    toolName: "unity_project_tools_execute",
    route: "project-tools/execute",
    category: "project-tools",
    description:
      "Execute a project-defined Unity MCP tool by toolName with args. Prefer direct unity_project_tool_* tools when they are available.",
    inputSchema: {
      type: "object",
      properties: {
        toolName: {
          type: "string",
          description: "Project tool name from unity_project_tools_list, e.g. battleidle/get-runtime-ready-state.",
        },
        args: {
          type: "object",
          description: "Arguments passed to the project tool.",
          additionalProperties: true,
        },
      },
      required: ["toolName"],
    },
  },
  {
    toolName: "unity_scene_instantiate_prefab",
    route: "scene/instantiate-prefab",
    category: "scene",
    description: "Instantiate a prefab asset into the current scene.",
    inputSchema: {
      type: "object",
      properties: {
        assetPath: {
          type: "string",
          description: "Prefab asset path to instantiate.",
        },
        parentPath: {
          type: "string",
          description: "Optional scene parent GameObject path.",
        },
        name: {
          type: "string",
          description: "Optional scene instance name override.",
        },
        ...transformProps,
      },
      required: ["assetPath"],
    },
  },
  {
    toolName: "unity_serialized_object_get",
    route: "serialized-object/get",
    category: "serialized-object",
    description: "Read serialized properties from a scene object, prefab asset object, component, or asset.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Scene hierarchy path or object name." },
        instanceId: { type: "string", description: "Unity object instance ID." },
        assetPath: { type: "string", description: "Project asset path." },
        componentType: { type: "string", description: "Component type to inspect." },
        propertyPath: { type: "string", description: "Optional serialized property path filter." },
        offset: { type: "number", description: "Visible property offset. Defaults to 0." },
        maxProperties: { type: "number", description: "Property limit. Defaults to 50; capped at 500." },
        includeChildren: { type: "boolean", description: "Walk child properties. Defaults to false." },
        maxDepth: { type: "number", description: "Nested value depth. Defaults to 3; capped at 8." },
        maxArrayElements: { type: "number", description: "Elements per serialized array. Defaults to 50; capped at 500." },
      },
    },
  },
  {
    toolName: "unity_serialized_object_set",
    route: "serialized-object/set",
    category: "serialized-object",
    description: "Set a serialized property on a scene object, prefab asset object, component, or asset.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Scene hierarchy path or object name." },
        instanceId: { type: "string", description: "Unity object instance ID." },
        assetPath: { type: "string", description: "Project asset path." },
        componentType: { type: "string", description: "Component type to edit." },
        propertyName: { type: "string", description: "Serialized property name/path to set." },
        value: { description: "Serialized value to assign." },
      },
      required: ["propertyName", "value"],
    },
  },
  {
    toolName: "unity_prefab_asset_hierarchy",
    route: "prefab-asset/hierarchy",
    category: "prefab-asset",
    description: "Get the full hierarchy tree of a prefab asset directly from disk.",
    inputSchema: {
      type: "object",
      properties: {
        assetPath: { type: "string", description: "Prefab asset path to inspect." },
        prefabPath: { type: "string", description: "Optional GameObject path used as the hierarchy root." },
        maxDepth: { type: "number", description: "Maximum hierarchy depth to traverse." },
        maxNodes: { type: "number", description: "Maximum returned nodes. Defaults to 250; capped at 2000." },
      },
      required: ["assetPath"],
    },
  },
  {
    toolName: "unity_prefab_asset_get_properties",
    route: "prefab-asset/get-properties",
    category: "prefab-asset",
    description: "Read serialized properties from a component on a GameObject inside a prefab asset.",
    inputSchema: {
      type: "object",
      properties: {
        assetPath: { type: "string", description: "Prefab asset path to inspect." },
        prefabPath: prefabPathProp,
        componentType: { type: "string", description: "Component type name or full name." },
      },
      required: ["assetPath", "componentType"],
    },
  },
  {
    toolName: "unity_prefab_asset_set_property",
    route: "prefab-asset/set-property",
    category: "prefab-asset",
    description: "Set a serialized property on a component inside a prefab asset.",
    inputSchema: {
      type: "object",
      properties: {
        assetPath: { type: "string", description: "Prefab asset path to edit." },
        prefabPath: prefabPathProp,
        componentType: { type: "string", description: "Component type name or full name." },
        propertyName: { type: "string", description: "Serialized property name or path to set." },
        value: { description: "Serialized value to assign." },
        ...diffProperties,
      },
      required: ["assetPath", "componentType", "propertyName", "value"],
    },
  },
  {
    toolName: "unity_prefab_asset_set_reference",
    route: "prefab-asset/set-reference",
    category: "prefab-asset",
    description: "Set an ObjectReference property on a component inside a prefab asset.",
    inputSchema: {
      type: "object",
      properties: {
        assetPath: { type: "string", description: "Prefab asset path to edit." },
        prefabPath: prefabPathProp,
        componentType: { type: "string", description: "Component type name or full name." },
        propertyName: { type: "string", description: "ObjectReference serialized property name or path." },
        referenceAssetPath: { type: "string", description: "Project asset path to assign." },
        referencePrefabPath: { type: "string", description: "Path of a GameObject inside the same prefab to assign." },
        referenceComponentType: { type: "string", description: "Assign this component instead of the GameObject." },
        clear: { type: "boolean", description: "Clear the ObjectReference." },
        ...diffProperties,
      },
      required: ["assetPath", "propertyName"],
    },
  },
  {
    toolName: "unity_prefab_asset_add_component",
    route: "prefab-asset/add-component",
    category: "prefab-asset",
    description: "Add a component to a GameObject inside a prefab asset.",
    inputSchema: {
      type: "object",
      properties: {
        assetPath: { type: "string", description: "Prefab asset path to edit." },
        prefabPath: prefabPathProp,
        componentType: { type: "string", description: "Component type name or full name." },
        properties: { type: "object", description: "Optional serialized properties to set on the new component." },
        waitForType: { type: "boolean", description: "Wait for compilation/import until the component type is available." },
        ...diffProperties,
      },
      required: ["assetPath", "componentType"],
    },
  },
  {
    toolName: "unity_prefab_asset_remove_component",
    route: "prefab-asset/remove-component",
    category: "prefab-asset",
    description: "Remove a component from a GameObject inside a prefab asset.",
    inputSchema: {
      type: "object",
      properties: {
        assetPath: { type: "string", description: "Prefab asset path to edit." },
        prefabPath: prefabPathProp,
        componentType: { type: "string", description: "Component type name or full name." },
        index: { type: "number", description: "Component index when multiple components of the same type exist." },
        ...diffProperties,
      },
      required: ["assetPath", "componentType"],
    },
  },
  {
    toolName: "unity_prefab_asset_add_gameobject",
    route: "prefab-asset/add-gameobject",
    category: "prefab-asset",
    description: "Create a child GameObject inside a prefab asset.",
    inputSchema: {
      type: "object",
      properties: {
        assetPath: { type: "string", description: "Prefab asset path to edit." },
        parentPrefabPath: { type: "string", description: "Parent path inside the prefab. Empty means root." },
        name: { type: "string", description: "Name of the new child GameObject." },
        primitiveType: { type: "string", description: "Optional Unity PrimitiveType to create." },
        ...transformProps,
        ...diffProperties,
      },
      required: ["assetPath", "name"],
    },
  },
  {
    toolName: "unity_prefab_asset_remove_gameobject",
    route: "prefab-asset/remove-gameobject",
    category: "prefab-asset",
    description: "Remove a child GameObject from inside a prefab asset.",
    inputSchema: {
      type: "object",
      properties: {
        assetPath: { type: "string", description: "Prefab asset path to edit." },
        prefabPath: { type: "string", description: "Path of the child GameObject to remove. Cannot be root." },
        ...diffProperties,
      },
      required: ["assetPath", "prefabPath"],
    },
  },
  {
    toolName: "unity_prefab_asset_move_gameobject",
    route: "prefab-asset/move-gameobject",
    category: "prefab-asset",
    description: "Move or reorder a child GameObject inside a prefab asset.",
    inputSchema: {
      type: "object",
      properties: {
        assetPath: { type: "string", description: "Prefab asset path to edit." },
        prefabPath: { type: "string", description: "GameObject path to move." },
        newParentPrefabPath: { type: "string", description: "New parent path inside the prefab. Empty means root." },
        siblingIndex: { type: "number", description: "Optional sibling index under the new parent." },
        worldPositionStays: { type: "boolean", description: "Preserve world transform while reparenting." },
        ...diffProperties,
      },
      required: ["assetPath", "prefabPath"],
    },
  },
  {
    toolName: "unity_prefab_asset_instantiate_prefab",
    route: "prefab-asset/instantiate-prefab",
    category: "prefab-asset",
    description: "Instantiate a prefab asset as a child inside another prefab asset.",
    inputSchema: {
      type: "object",
      properties: {
        assetPath: { type: "string", description: "Target prefab asset path to edit." },
        sourcePrefabPath: { type: "string", description: "Prefab asset path to instantiate into the target prefab." },
        parentPrefabPath: { type: "string", description: "Parent path inside the target prefab. Empty means root." },
        name: { type: "string", description: "Optional name override for the created GameObject." },
        siblingIndex: { type: "number", description: "Optional sibling index under the parent." },
        ...transformProps,
        ...diffProperties,
      },
      required: ["assetPath", "sourcePrefabPath"],
    },
  },
  {
    toolName: "unity_prefab_asset_find",
    route: "prefab-asset/find",
    category: "prefab-asset",
    description: "Find GameObjects inside a prefab asset by name/path, component type, or serialized property value.",
    inputSchema: {
      type: "object",
      properties: {
        assetPath: { type: "string", description: "Prefab asset path to search." },
        name: { type: "string", description: "Exact GameObject name filter." },
        nameContains: { type: "string", description: "Case-insensitive GameObject name contains filter." },
        pathContains: { type: "string", description: "Case-insensitive prefab path contains filter." },
        componentType: { type: "string", description: "Optional component type name or full name filter." },
        propertyName: { type: "string", description: "Optional serialized property name/path to require on the component." },
        propertyValue: { type: "string", description: "Optional serialized property value to match." },
        maxResults: { type: "number", description: "Maximum returned matches. Defaults to 50." },
      },
      required: ["assetPath"],
    },
  },
  {
    toolName: "unity_prefab_asset_transaction_edit",
    route: "prefab-asset/transaction-edit",
    category: "prefab-asset",
    description: "High-level prefab asset transaction edit with default summary diff for minimal-change review.",
    inputSchema: prefabBatchSchema(),
  },
  {
    toolName: "unity_component_set_reference",
    route: "component/set-reference",
    category: "component",
    description: "Assign one or more component ObjectReference properties with configurable immediate or frame-batched execution.",
    inputSchema: componentSetReferenceSchema(),
  },
  {
    toolName: "unity_asset_get_refresh_job",
    route: "asset/get-refresh-job",
    category: "asset",
    description: "Poll the current or latest reload-safe AssetDatabase refresh job.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          description: "Optional refresh job ID. Defaults to the current or latest job.",
        },
        refreshRequestId: {
          type: "string",
          description: "Optional original asset/refresh request ID used to recover the matching persistent job.",
        },
        clear: {
          type: "boolean",
          description: "Clear the persisted job after a terminal result is read. Defaults to false.",
        },
      },
    },
  },
  {
    toolName: "unity_asset_move",
    route: "asset/move",
    category: "asset",
    description: "Preflight and move one or more Unity assets with configurable execution, GUID preservation, and rollback.",
    inputSchema: assetMoveSchema(),
  },
  {
    toolName: "unity_localization_upsert_entry",
    route: "localization/upsert-entry",
    category: "localization",
    description: "Create or update one or more localized entries with configurable immediate or frame-batched execution.",
    inputSchema: localizationUpsertEntrySchema(),
  },
  {
    toolName: "unity_asset_export_unitypackage",
    route: "asset/export-unitypackage",
    category: "asset",
    description: "Export selected project assets into a .unitypackage file.",
    inputSchema: {
      type: "object",
      properties: {
        assetPaths: {
          type: "array",
          description: "Project asset paths to export.",
          items: { type: "string" },
        },
        outputPath: {
          type: "string",
          description: "Output .unitypackage path.",
        },
        includeDependencies: {
          type: "boolean",
          description: "Include dependencies in the export.",
        },
      },
      required: ["assetPaths", "outputPath"],
    },
  },
];

const firstClassRouteSet = new Set(firstClassPluginRoutes);
const enabledDetailedStaticTools = detailedStaticFirstClassPluginTools
  .filter((tool) => firstClassRouteSet.has(tool.route));
const detailedRoutes = new Set(enabledDetailedStaticTools.map((tool) => tool.route));
const genericStaticFirstClassPluginTools = firstClassPluginRoutes
  .filter((route) => !detailedRoutes.has(route))
  .map((route) => ({
    toolName: routeToToolName(route),
    route,
    category: route.split("/")[0],
    description: routeToDescription(route),
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
  }));

export const staticFirstClassPluginTools = [
  ...enabledDetailedStaticTools,
  ...genericStaticFirstClassPluginTools,
];
