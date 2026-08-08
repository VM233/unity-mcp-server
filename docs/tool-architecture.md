# Canonical tool architecture

The MCP server advertises a bounded 12-tool bootstrap surface: instance binding, Unity Hub,
health, and `unity_tools_list/search/get`. Unity Editor and project/package tools are loaded
from the selected Editor's canonical `_meta/tools` catalog.

`unity_tools_search` ranks a small set of candidates from intent, module, category,
capability, operation kind, preconditions, and side effects. `unity_tools_get` returns the
complete contract and activates exactly that typed tool. Activated tools remain callable
until the selected instance catalog removes them; schema changes emit `tools/list_changed`.

There is no generic route executor, first-class allowlist, static plugin snapshot, or
three-stage project-tool execution API. The selected Unity instance owns one catalog
revision and one set of tool bindings for the MCP connection.

## Ownership boundaries

- `catalog/` normalizes the Unity catalog, enforces required contracts, binds it to one
  instance, and computes the revision.
- `discovery/` implements compact list/search/get responses and deterministic ranking.
- `exposure/` owns the bootstrap plus activated typed tools and reconciles catalog changes.
- `tools/` contains only server-owned bootstrap implementations such as health and Hub.
- `unity-editor-bridge.js` owns transport, queue polling, binding, and reload recovery; it
  does not define the tool catalog.

## Query contract

Search consumes intent plus optional exact filters for module, category, capability,
operation kind, effects, and preconditions. Ranking uses normalized Unicode text, so CJK
intent remains searchable, and tie-breaking is stable. Results default to five and cap at
ten. They include only the fields needed to choose a tool.

Get requires one exact canonical tool name. It returns the complete input/output schema and
activates the typed MCP tool. Unknown names fail with search guidance; route strings are not
accepted as a second authority.

The MCP server instructions keep this workflow within the first 512 characters so hosts
that truncate instructions still give Codex a complete query path.
