# Changelog

All notable changes to this package will be documented in this file.

## [4.4.5] - 2026-07-31

### Added
- Publish VM Unity MCP's rollback-capable `unity_asset_copy` as a
  release-managed concrete tool instead of requiring the advanced fallback.

### Fixed
- Summarize failed persistent Jobs with their structured error code and message
  while keeping detailed compiler diagnostics in `structuredContent`; the text
  channel no longer exposes a CLR dictionary type name.
- Refresh the Prefab component configuration schema with
  `createPathIfMissing`, allowing semantic child creation and component setup
  through one atomic tool call.
- Consume the plugin's concise shared project-binding descriptions, keeping the
  73-tool default catalog at 58,821 bytes under the 60 KB release gate.

## [4.4.4] - 2026-07-31

### Fixed
- Resolve parent object properties while auditing `oneOf`, `anyOf`, and
  `allOf` branches. Branches can constrain or require a parent-declared field
  without duplicating its description, while truly undeclared or undescribed
  branch-only fields still fail release validation.

## [4.4.3] - 2026-07-31

### Fixed
- Validate live and disk-cached first-class input/output schemas before merging
  them over release-managed descriptors. A stale malformed cache can no longer
  corrupt Job contracts during the cold-start window before Unity refreshes
  metadata.
- Cover malformed cold-start Job metadata through the public MCP
  `tools/list` surface.

## [4.4.2] - 2026-07-31

### Fixed
- Audit explicit output schemas as well as input schemas before a live plugin
  snapshot or release tool catalog can be published.
- Reject malformed output properties and require semantic descriptions for
  every declared output field, closing the gap that allowed persistent Job
  `tags` and `sideEffects` schemas to become string arrays.

## [4.4.1] - 2026-07-31

### Fixed
- Preserve a release-managed first-class tool's input/output schemas when live
  Unity metadata for the same route is temporarily incomplete, preventing
  `unity_build` from degrading to an undeclared argument object.
- Document and publish the compact `unity_editor_state` result schema. Stable
  snapshots now require the `idle` tag supplied by VM Unity MCP 5.5.2 instead
  of exposing no process-state fact.

## [4.4.0] - 2026-07-31

### Changed
- Consume VM Unity MCP schema-v5 presence-only `tags` instead of duplicated
  `firstClass`, `preferred`, `exposure`, and false capability booleans.
- Move live plugin metadata to the schema-v5 disk cache and include normalized
  tags and side effects in change fingerprints.
- Compact advanced-tool pagination to an optional `nextOffset`, and expose
  positive tags, side effects, and tool-specific error codes for dynamically
  discovered tools.
- Merge server-owned queue replay, transport recovery, timeout, and ticket
  booleans into the same presence-only `tags` contract.
- Omit absent media MIME types instead of returning empty strings.

## [4.3.0] - 2026-07-31

### Added
- Publish MCP `outputSchema` for every tool and return machine-composable
  `structuredContent` through one standard success/error envelope.
- Expose persistent execute-code and project-tool Job status, cancellation, and
  cleanup routes from VM Unity MCP 5.4 metadata.

### Changed
- Keep text content as a concise human summary instead of duplicating JSON that
  is already present in `structuredContent`.
- Include output schemas in live plugin fingerprints, generated descriptors,
  advanced discovery, and the schema-v4 metadata cache.
- Measure both structured and media/text response channels against the response
  budget; oversized responses become one structured `response_too_large`
  failure.

## [4.2.3] - 2026-07-30

### Fixed
- Declare the optional initial `properties` map on the prefab add-component
  compatibility tool so callers can configure nested serialized lists during
  the same atomic creation request.

### Changed
- Document the verified prefab initialization workflow and replace removed
  Dashboard instructions, stale fork installation URLs, and a manually
  duplicated optional-package table with the current settings and live
  capability contracts.

## [4.2.2] - 2026-07-30

### Changed
- Refresh the 39 release-managed Unity tool descriptors from VM Unity MCP 5.3.0 so project/preference default sources and explicit-value precedence remain visible in startup and offline fallback schemas.
- Keep the public tool surface unchanged; live metadata remains authoritative after connection.

## [4.2.1] - 2026-07-30

### Fixed
- Align the live metadata-refresh integration test with the bounded release policy: verify the six 5.2 P0 routes as concrete tools and verify specialized package-test and prefab transaction routes remain available lazily.
- Pair unbound read-only metadata refresh with VM Unity MCP 5.2.1, which defers project-binding validation from the outer queue envelope to its inner route.

## [4.2.0] - 2026-07-30

### Added
- Publish the six VM Unity MCP 5.2 P0 routes as release-managed concrete tools: persistent-job cancellation, semantic importer get/set, multi-scene workspace management, and typed Material property get/set.

### Changed
- Refresh the generated plugin descriptor snapshot from the live, exact-SHA Unity package so schemas, annotations, descriptions, and project-binding fields remain authoritative.
- Keep VFX Graph, Audio Mixer, Build Profile, Addressables, Timeline, and Cinemachine integrations in the lazy catalog, gated by the Editor package's live capabilities and package versions.

## [4.1.0] - 2026-07-30

### Changed
- Bound the direct plugin catalog to a release-managed set of common routes and keep specialized or project-defined routes behind the advanced and three-stage discovery contracts.
- Replace five overlapping scene-search tools with one paginated `unity_search_scene` surface while preserving compatibility routes lazily.
- Remove repeated instance/context blocks and successful bridge envelopes from ordinary tool replies; large replies now produce one structured, byte-accurate error.
- Return stable structured errors for discovery, selection, advanced dispatch, bridge transport, and queue control without leaking implementation stacks.
- Validate schemas, array item contracts, numeric configuration, ports, and project binding metadata before publishing a tool.

### Fixed
- Re-discover an Editor in the same call after a stale persisted selection is invalidated.
- Keep queue polling timeouts non-replayable for mutations and point callers to the existing ticket instead of risking duplicate work.
- Generate the MCP manifest version and tool list from package sources so release metadata cannot drift.

## [4.0.0] - 2026-07-30

### Changed
- Replace project-tool discovery with `unity_project_tools_list`, `unity_project_tools_get`, and `unity_project_tools_execute`; list results no longer contain parameter schemas.
- Remove the generic `project-tool:<name>` execution shortcut so lazy project tools use the canonical three-stage contract.
- Invalidate persisted plugin metadata caches for the breaking catalog contract.

### Removed
- Remove all UMA tools, bridge code, catalog categories, documentation, and test registration.

## [3.3.8] - 2026-07-30

### Fixed
- Keep the Editor transport queue-only: a failed queue submission never enables or caches a legacy direct-command mode that the current VM Unity MCP plugin rejects.
- Treat HTTP 404 from `queue/submit` as a transient package/domain-reload response and retry it with the same idempotency key for a bounded reconnect budget.
- Separate safe pre-ticket queue submission retries from post-ticket replay policy, preserving strict replay controls once Unity may already have executed a command.

## [3.3.7] - 2026-07-29

### Fixed
- Parse Unity's UTF-8 BOM-prefixed instance registry instead of silently treating it as empty, so fresh reload leases remain available to `unity_list_instances`.

## [3.3.6] - 2026-07-29

### Fixed
- Give transient queue-poll disconnects their own bounded reload-recovery budget, so Editor downtime no longer consumes the active operation timeout for `unity_wait_editor_idle` or test/job polling.
- Keep fresh heartbeat-backed registry leases in `unity_list_instances` while their Editor bridge is temporarily unreachable; results now expose `status`, `isReloading`, and `isReachable`.

## [3.3.5] - 2026-07-28

### Fixed
- Expose modal-free scene open/new behavior and explicit-path scene saving, so dirty or untitled scenes return actionable errors instead of blocking every subsequent MCP command behind a Unity dialog.

## [3.3.4] - 2026-07-28

### Fixed
- Stop advertising the removed `unity_search_assets` and `unity_asset_instantiate_prefab` tools; use the canonical `unity_asset_list` and `unity_scene_instantiate_prefab` tools backed by `asset/list` and `scene/instantiate-prefab`.
- Synchronize the remaining static tool catalog with the Editor plugin's consolidated routes, including prefab-child instantiation, UI Toolkit refresh, screenshots, selection search, graphics previews, and texture import.
- Match the startup fallback schemas for asset listing and scene prefab instantiation to the canonical Editor route schemas.

## [3.3.3] - 2026-07-28

### Fixed
- Never report `wait/editor-idle` as successful merely because a separate editor-state probe looks idle while the original queue ticket is still non-terminal.
- Route plugin-declared `queue/info`, `queue/status`, and `queue/cancel` tools through their direct queue endpoints instead of resubmitting those control routes into the queue.
- Remove the obsolete `unity_console_log` / `console/log` tool mapping; use the plugin-declared `unity_console_query` route.

## [3.3.2] - 2026-07-17

### Fixed
- Promote nested Unity Editor failures to top-level MCP bridge failures instead of returning `success: true` around `success: false` package or project-tool results.
- Resolve `expectedProjectPath` for a bounded interval during transient Editor reloads and never fall back to a different auto-selected Unity project when the requested project remains unavailable.
- Treat incomplete JSON responses from a reloading Editor as transient transport failures, allowing reload-safe polling commands to consume their real reconnect budget instead of returning an immediate false timeout.

## [3.3.1] - 2026-07-16

### Fixed
- Treat `asset/get-refresh-job` as a reload-safe replayable read and keep reconnecting for up to five minutes by default, so domain reloads and long compilation imports no longer surface as four-retry `editor_connection_failed` results.
- Expose a per-call `timeoutMs` override for refresh-job reconnection waits.

## [3.3.0] - 2026-07-15

### Added
- Added a startup fallback schema for `unity_prefab_asset_configure_component` while live Unity metadata is still loading.

### Fixed
- Keep every first-class tool already returned by `tools/list` callable for the lifetime of the MCP process. Volatile multi-instance metadata refreshes can no longer turn an advertised project tool such as `unity_pt_battle_get_runtime_ready_state` into `Unknown tool`; newer same-named metadata still replaces the remembered route and schema.

## [3.2.1] - 2026-07-15

### Added
- Exposed `expectedProjectPath` alongside `port` on every Editor-targeting first-class tool schema, including `unity_asset_refresh`, `unity_execute_code`, and `unity_play_mode`.
- Added exact request-ID recovery for persistent asset refresh jobs after queue polling or transport failures during a Unity domain reload.
- Added reusable live diagnostics for cross-project instance binding and forced outer-timeout asset refresh recovery.

### Fixed
- Resolve an explicit port against its live `/api/ping` identity before registry fallback, preventing stale registry data from producing false project-binding HTTP 409 responses.
- Preserve explicit project binding in request-local headers even when a core tool handler narrows its command body.

## [3.2.0] - 2026-07-14

### Breaking changes
- Mutating requests now carry the selected Unity instance's expected project path/name and are rejected by the Editor when no target identity is available.
- Replaced the obsolete `LostAfterReload` status with `UncertainAfterReload` for interrupted mutations; these results are non-retryable until the caller reconciles the target.

### Added
- Stable per-command idempotency keys reused across queue submission retries and legacy transport fallback.
- First-class `unity_queue_cancel` support with agent ownership enforcement.

### Changed
- Only explicitly reload-safe read routes are replayed after a lost connection; package mutations are never blindly replayed.
- Queue info, status, and context requests now forward selected-instance identity consistently.

### Fixed
- Treat `asset/refresh` as an explicitly replayable, plugin-idempotent reload workflow instead of returning a lost queue ticket when AssetDatabase refresh triggers a domain reload.

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
