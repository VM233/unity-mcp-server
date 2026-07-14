# Changelog

All notable changes to this package will be documented in this file.

## [3.1.3] - 2026-07-14

### Fixed
- **Asset refresh job polling exposure** - `unity_asset_get_refresh_job` is now available with its concrete schema during initial MCP startup, before live Unity plugin metadata finishes refreshing.

## [3.1.2] - 2026-07-11

### Fixed
- **Domain-reload wait reconnects** - Reload-safe commands such as `unity_wait_editor_idle` now keep reconnecting for the command's full polling budget instead of exhausting four fixed submission retries and incorrectly disabling queue mode during a longer Unity domain reload.

## [3.1.1] - 2026-07-11

### Fixed
- **Concurrent tool routing** - Request agent IDs and port overrides now use `AsyncLocalStorage`, so parallel tool calls cannot overwrite each other's Unity target.
- **Concurrent first-call discovery** - Instance auto-discovery is single-flight per agent, preventing one parallel first call from routing to the default port before another call finishes selecting the live Editor.

## [3.1.0] - 2026-07-11

### Changed
- **Compact tool responses** - Tool handlers now return compact JSON instead of pretty-printed JSON.
- **Lean tool metadata** - Remove repeated server instructions, compatibility aliases, duplicate annotation titles, and false annotation defaults from the exposed tool surface.
- **Canonical request fields** - Static fallback schemas now match the plugin's canonical fields without compatibility aliases.

## [3.0.0] - 2026-07-11

### Breaking changes
- **Unified multi-operation execution** - `unity_prefab_asset_transaction_edit`, `unity_asset_move`, `unity_component_set_reference`, and `unity_localization_upsert_entry` now use a shared nested `execution` object with `mode`, `operationsPerFrame`, `frameBudgetMs`, `timeoutMs`, and supported `continueOnError` behavior.
- **Removed duplicate batch tools** - Removed the old `unity_prefab_asset_batch_edit`, `unity_asset_move_batch`, `unity_component_batch_wire`, and `unity_localization_upsert_entries` aliases. Their canonical tools now accept operation arrays directly.

### Fixed
- **Live plugin schema precedence** - Live first-class metadata reported by the Unity plugin now replaces same-named server fallbacks in both `tools/list` and execution, so package schema upgrades take effect without reconnecting.

### Added
- **Live tool-list notifications** - The server advertises `tools.listChanged`, polls live Unity plugin metadata, and sends `notifications/tools/list_changed` when first-class routes or schemas change.
- **First-class project tools** — Unity plugin tools with `projectToolName` metadata are now exposed directly in MCP `tools/list` with their declared schemas, while still remaining callable through `unity_advanced_tool` as a stale-metadata fallback.
- **`unity_asset_refresh` core tool** — Expose AssetDatabase refresh/import-specific-path refresh as a first-class MCP tool instead of requiring `unity_advanced_tool`.
- **First-class Unity plugin routes** — `_meta/tools` entries with `firstClass=true` are now exposed directly in MCP `tools/list` with their route-owned schemas and descriptions, instead of requiring `unity_advanced_tool`.
- **`unity_project_tools_execute` tool** — Adds a concrete project-tool execution fallback so agents do not need `unity_advanced_tool` while waiting for direct project tools to refresh.

### Changed
- **Bounded tool surface** - the default concrete surface stays near 100 tools, while duplicate aliases and low-frequency large-schema tools remain callable through the paginated advanced catalog.
- **Compact server instructions** - Unity routing and multi-instance guidance now lives in one short server instruction instead of adding repeated long text to every tool context.
- **Response budgets** - text responses warn at 512 KB and stop at 2 MB; high-volume Unity routes expose smaller defaults, pagination, and stack/detail opt-ins before reaching that transport guard.
- **Paginated plugin metadata** - hot refresh explicitly requests schema-bearing first-class pages, while catalog reads request only the selected category and schema detail level.

### Fixed
- **Compact hot-refresh metadata** - background tool refresh requests only compact first-class descriptors, avoiding repeated transfer of the full Unity route catalog.
- **Reload-lost queue replay** - `LostAfterReload` is handled as a failed terminal ticket immediately; reload-safe wait and test-query routes are resubmitted with a new ticket, while mutating routes remain non-replayable by default.
- **Queue success consistency** - A failed or reload-lost final ticket can no longer be wrapped in an outer `success: true` timeout recovery response.
- **Fast project-tool discovery** — `tools/list` now returns static tools and cached Unity plugin metadata without waiting on the Editor, preventing MCP clients from dropping the Unity server during startup. Live metadata refresh still happens through catalog/execution paths and updates a long-lived cache for future sessions.
- **Queue failure details** — Failed queue tickets now preserve Unity's structured `error`, `message`, `errorCode`, and `retryable` fields instead of collapsing to `Queue processing failed`.
- **Queue polling timeout diagnostics** - queue polling now performs a final ticket/status probe before returning timeout, includes final queue and Editor state diagnostics, and can recover `wait/editor-idle` as successful when the Editor is already idle even if the queue ticket did not complete before the poll timeout.

## [2.30.0] - 2026-06-02

### Added
- **`unity_screenshot_editor_window` tool** — capture any Editor window (Inspector, Project, Console, custom windows) to a PNG file. Unlike `unity_screenshot_game` / `unity_screenshot_scene` (which render a camera), it grabs the actual editor UI via the Win32 `PrintWindow` API, so it works even when the window is hidden behind others, without raising it or stealing focus. **Windows editor only** — returns a clear unsupported-platform error on macOS/Linux. Defaults to `Assets/Screenshots/`, accepts any user-chosen `.png` path; args `window` (required), `path`, `maxDimension`. Companion to the `unity-mcp-plugin` 2.32.0 change.

## [2.29.0] - 2026-05-21

### Added
- **MPPM virtual player & scenario tools** — `unity_mppm_list_players`, `unity_mppm_activate_player`, `unity_mppm_deactivate_player` (manage Multiplayer Play Mode virtual players) and `unity_mppm_create_scenario` (create a ScenarioConfig asset). Companion to the `unity-mcp-plugin` 2.31.0 MPPM changes; the existing `unity_mppm_*` scenario tools also got clearer descriptions.

## [2.28.3] - 2026-05-21

### Changed
- **`instanceId` tool parameters declared as `string`** — Unity 6.5 entity ids are 64-bit values that exceed JavaScript's safe-integer range; sent as JSON numbers they were rounded, breaking object-by-`instanceId` resolution. All 26 `instanceId` input schemas in `editor-tools.js` are now `string`. Companion to the `unity-mcp-plugin` 2.28.0 change. Fixes [#24](https://github.com/AnkleBreaker-Studio/unity-mcp-server/issues/24).

## [2.28.2] - 2026-04-22

### Fixed
- **MCP JSON-RPC framing corrupted by debug logs on stdout** — Two `console.debug(...)` call sites in `src/unity-editor-bridge.js` and `src/tool-tiers.js` wrote diagnostic lines to stdout, which the MCP stdio transport reserves exclusively for JSON-RPC messages. Strict clients (Codex CLI) closed the transport on the first non-JSON chunk; lenient clients (Claude Desktop, Claude Code) tolerated it, which is why the bug escaped earlier detection. Both call sites now use `console.error(...)` so logs go to stderr. Fixes [#11](https://github.com/AnkleBreaker-Studio/unity-mcp-server/issues/11).

## [2.28.1] - 2026-04-02

### Fixed
- **npm publish workflow** — Added `--allow-same-version` to `npm version` command to prevent CI failure when `package.json` already matches the release tag

## [2.28.0] - 2026-04-02

### Added
- **SpriteAtlas tools** — 7 new tools for Unity SpriteAtlas management (contributed by [@zaferdace](https://github.com/zaferdace)):
  - `spriteatlas/create` — Create a new SpriteAtlas asset
  - `spriteatlas/info` — Get SpriteAtlas details (packed sprites, settings)
  - `spriteatlas/add` — Add sprites/folders to a SpriteAtlas
  - `spriteatlas/remove` — Remove entries from a SpriteAtlas
  - `spriteatlas/settings` — Configure packing, texture, and platform settings
  - `spriteatlas/delete` — Delete a SpriteAtlas asset
  - `spriteatlas/list` — List all SpriteAtlases in the project
- New `spriteatlas-bridge.js` and `spriteatlas-tools.js` modules

### Added
- **npm auto-publish** — GitHub Action that automatically publishes to npm whenever a new GitHub release is created (contributed by [@vatanaksoytezer](https://github.com/vatanaksoytezer) in [#8](https://github.com/AnkleBreaker-Studio/unity-mcp-server/pull/8))

### Changed
- **npm package renamed** — Package renamed from `unity-mcp-server` to `anklebreaker-unity-mcp` to avoid name conflict on npm. Install via `npx anklebreaker-unity-mcp@latest`

### Fixed
- **UTF-8 encoding** — Fixed mojibake characters (corrupted em-dashes, arrows, section headers) across all comments in `unity-editor-bridge.js`; removed stale BOM
- **package-lock.json** — Synced version field to 2.27.0

## [2.27.0] - 2026-03-25

### Added
- **UMA (Unity Multipurpose Avatar) integration** — 13 new tools for the complete UMA asset pipeline:
  - `uma/inspect-fbx` — Inspect FBX meshes for UMA compatibility
  - `uma/create-slot` — Create SlotDataAsset from mesh data
  - `uma/create-overlay` — Create OverlayDataAsset with texture assignments
  - `uma/create-wardrobe-recipe` — Create WardrobeRecipe combining slots and overlays
  - `uma/create-wardrobe-from-fbx` — Atomic FBX-to-wardrobe pipeline (inspect → slot → overlay → recipe in one call)
  - `uma/wardrobe-equip` — Equip/unequip wardrobe items on DynamicCharacterAvatar
  - `uma/list-global-library` — Browse the UMA Global Library contents
  - `uma/list-wardrobe-slots` — List available wardrobe slots
  - `uma/list-uma-materials` — List UMA-compatible materials
  - `uma/get-project-config` — Get UMA project configuration
  - `uma/verify-recipe` — Validate a WardrobeRecipe for missing references
  - `uma/rebuild-global-library` — Force rebuild the Global Library index
  - `uma/register-assets` — Register Slot/Overlay/Recipe assets in the Global Library
- New `uma-bridge.js` module — UMA bridge functions extracted into a dedicated module
- New `uma-tools.js` — Full tool definitions and schemas for all UMA tools

## [2.26.0] - 2026-03-25

### Added
- **Compilation error detection** — New `unity_get_compilation_errors` tool retrieves C# compilation errors and warnings via `CompilationPipeline` API, independent of console log buffer
- **Test Runner integration** — Run EditMode/PlayMode tests, poll results, list available tests via Unity Test Runner API

## [2.25.0] - 2026-03-09

### Added
- **Parallel-safe instance routing** — Per-request `port` parameter on every `unity_*` tool call for multi-agent safety
- **Per-request port override** — Stateless routing mechanism bypassing shared per-agent state
- **Schema injection** — Optional `port` parameter auto-injected into every `unity_*` tool schema
- **Enhanced select_instance response** — Explicit routing instructions for AI assistants
