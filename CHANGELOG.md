# Changelog

All notable changes to this package will be documented in this file.

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
