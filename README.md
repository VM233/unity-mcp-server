<p align="center">
  <img src="icon.png" alt="AnkleBreaker MCP" width="180" />
</p>

# Unity MCP Server AI-Powered Unity Editor & Hub Control

> **The most comprehensive [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for Unity game development.** Connect Claude, Cursor, Windsurf, or any MCP-compatible AI assistant to **Unity Editor** and **Unity Hub** with hundreds of tools across **30+ categories**. Built and maintained by [AnkleBreaker Studio](https://github.com/AnkleBreaker-Studio).

**AnkleBreaker Unity MCP** turns your AI assistant into a full Unity co-pilot — create scenes, manipulate GameObjects, manage components, run builds, profile performance, edit Shader Graphs, sculpt terrain, bake NavMesh, manage animations, run multiplayer playmode scenarios, and much more — all without leaving your AI chat. Works with Claude Desktop, Claude Cowork, Cursor, Windsurf, and any tool that supports the Model Context Protocol.

### Neon Brick Breaker — Built from scratch by AI in under 5 minutes
> Claude creates the entire game: scene setup, neon materials with bloom post-processing, brick grid layout, game scripts, VFX, and UI — all through Unity MCP commands.

<p align="center">
  <img src="docs/unity-mcp-showcase-brickbreaker.gif" alt="Unity MCP AI building a neon brick breaker game in Unity Editor" width="800" />
</p>

### 3D Medieval Village — AI-generated terrain, houses, and environment
> From an empty scene to a fully decorated village: terrain sculpting, material creation, procedural house building via C# editor scripts, trees, fences, and pathways.

<p align="center">
  <img src="docs/unity-mcp-showcase-village.gif" alt="Unity MCP — AI building a 3D medieval village with houses, trees, and terrain" width="800" />
</p>

### 3D Castle — Complete level with FPS walkthrough
> AI builds a multi-room castle with courtyard, throne room, armory, and guard room. Adjusts lighting, spawns the player, and runs an FPS walkthrough to verify the result.

<p align="center">
  <img src="docs/unity-mcp-showcase-castle.gif" alt="Unity MCP — AI building a 3D castle with FPS walkthrough in Unity Editor" width="800" />
</p>

### How It Works — AI → MCP Server → Unity Plugin → Unity Editor
> The Model Context Protocol connects your AI assistant to Unity through a lightweight bridge. Commands flow from your AI chat directly into the editor in real-time.

<p align="center">
  <img src="docs/unity-mcp-architecture.gif" alt="Unity MCP Architecture — AI Assistant → MCP Server → Unity Plugin → Unity Editor" width="800" />
</p>

## Features

**Hundreds of tools** covering the full Unity workflow:

| Category | Tools |
|----------|-------|
| **Unity Hub** | List/install editors, manage modules, set install paths |
| **Scenes** | Open, save, create scenes, get full hierarchy tree with pagination |
| **GameObjects** | Create (primitives/empty), delete, duplicate, reparent, activate/deactivate, transform (world/local) |
| **Components** | Add, remove, get/set serialized properties, and wire one or many object references |
| **Assets** | List, import, delete, search, move one or many assets, run reload-safe refresh jobs, poll refresh completion, create prefabs, create & assign materials |
| **Scripts** | Create, read, update C# scripts |
| **Builds** | Multi-platform builds (Windows, macOS, Linux, Android, iOS, WebGL) |
| **Console & Compilation** | Read/clear Unity console logs (errors, warnings, info); get C# compilation errors via CompilationPipeline (independent of console buffer) |
| **Testing** | Run EditMode/PlayMode tests, poll results, list available tests via Unity Test Runner API |
| **Play Mode** | Play, pause, stop |
| **Editor** | Execute menu items, run C# code, get editor state, undo/redo |
| **Project** | Project info, packages (list/add/remove/search), render pipeline, build settings |
| **Animation** | List clips & controllers, get parameters, play animations |
| **Prefab** | Open/close prefab mode, get overrides, apply/revert changes |
| **Physics** | Raycasts, sphere/box casts, overlap tests, physics settings |
| **Lighting** | Manage lights, environment, skybox, lightmap baking, reflection probes |
| **Audio** | AudioSources, AudioListeners, AudioMixers, play/stop, mixer params |
| **Terrain** | Create/modify terrains, paint heightmaps/textures, manage terrain layers, trees, details |
| **Navigation** | NavMesh baking, agents, obstacles, off-mesh links |
| **Particles** | Particle system creation, inspection, module editing |
| **UI** | Canvas, UI elements, layout groups, event system |
| **Tags & Layers** | List/add/remove tags, assign tags & layers |
| **Selection** | Get/set editor selection, find by name/tag/component/layer/tag |
| **Graphics** | Scene/game capture plus asset and material previews as inline images |
| **Input Actions** | Action maps, actions, bindings (Input System package) |
| **Assembly Defs** | List, inspect, create, update .asmdef files |
| **ScriptableObjects** | Create, inspect, modify ScriptableObject assets |
| **Constraints** | Position, rotation, scale, aim, parent constraints |
| **LOD** | LOD group management and configuration |
| **Profiler** | Start/stop profiling, stats, deep profiles, save profiler data |
| **Frame Debugger** | Enable/disable, draw call list & details, render targets |
| **Memory Profiler** | Memory breakdown, top consumers, snapshots (`com.unity.memoryprofiler`) |
| **Shader Graph** | List, inspect, create, open Shader Graphs & Sub Graphs; VFX Graphs |
| **MPPM Scenarios** | List, activate, start, stop multiplayer playmode scenarios; get status & player info |
| **Multi-Instance** | Discover and switch between multiple running Unity Editor instances |
| **Multi-Agent** | List active agents, get agent action logs, queue monitoring |
| **SpriteAtlas** | Create, inspect, add/remove sprites, configure settings, delete, list SpriteAtlases |
| **Project Context** | Auto-inject project-specific docs and guidelines for AI agents |

## Architecture

```
Claude / AI Assistant ←→ MCP Server (this repo) ←→ Unity Editor Plugin (HTTP bridge)
                                ↕
                          Unity Hub CLI
```

This server communicates with:
- **Unity Hub** via its current `--headless` CLI
- **Unity Editor** via the companion [VM Unity MCP](https://github.com/VM233/VMUnityMCP) package, which runs a queue-only HTTP bridge inside the editor

### Hundreds of Tools Across 30+ Categories
> Scene management, GameObjects, components, physics, terrain, Shader Graph, profiling, animation, NavMesh, builds, multiplayer, and more.

<p align="center">
  <img src="docs/unity-mcp-features.gif" alt="Unity MCP Features — hundreds of tools across 30+ categories for AI-powered game development" width="800" />
</p>

### Two-Tier Tool System

To avoid overwhelming MCP clients with hundreds of tools, the server uses a two-tier architecture:
- **Core and high-frequency plugin tools** stay in a bounded release-managed concrete surface
- **Advanced tools** are accessed through `unity_advanced_tool` with lazy metadata loading

This keeps the tool count manageable while preserving access to every Unity feature. `unity_list_advanced_tools` returns compact category counts by default; pass `category`, `offset`, `limit`, and optional `includeSchema` to inspect one paginated category.

`unity_advanced_tool` is also the stable generic fallback when tool metadata is stale. Its `tool` field accepts:
- A registered MCP tool name, such as `unity_animation_create_controller`
- A raw Unity route, such as `packages/update-git`

Use `params` for the tool or route arguments. This lets new Unity plugin routes run before the MCP client's tool list has refreshed.

If automatic queue polling reaches its bounded timeout, do not resubmit the
original operation while its ticket is still active. The timeout result returns
`nextTool: "unity_advanced_tool"` and exact `nextToolArgs` that query the
internal `unity_queue_ticket_status` control through the callable advanced
entrypoint. Inspect that ticket first, then decide whether any retry is needed.

Project-defined tools use a separate three-stage contract:

1. `unity_project_tools_list` returns compact names, descriptions,
   presence-only `tags`, and exact `sideEffects` without schemas.
2. `unity_project_tools_get` returns the complete descriptor and input schema for one selected tool.
3. `unity_project_tools_execute` executes that tool with validated arguments.

Every advertised MCP tool includes an `outputSchema`. Calls return the
machine-readable value in `structuredContent` using one stable
`{ success, result }` or `{ success:false, errorCode, error, retryable }`
envelope. The text content is intentionally only a short human-readable
summary, so clients no longer need to parse JSON out of a text block.
Media-producing tools return standard MCP `image` or `audio` content blocks
alongside structured metadata. A required media payload that is absent or
malformed becomes a structured tool error instead of an invalid content block.
Release validation audits every declared input and output schema, including
array item shapes and property descriptions; malformed live metadata cannot be
promoted into the static first-class tool catalog. Release-managed schemas also
remain authoritative when a cold-start disk cache belongs to an older release
snapshot, even if that cached schema is otherwise valid. The cache is bound to
the generated release fingerprint, so callers never need to wait for background
metadata refresh to obtain newly published arguments. Composition branches
inherit the containing object's
declared property contracts during release auditing, so conditional schemas do
not need to duplicate descriptions merely to constrain or require a field.

Tool metadata uses schema-v5 presence semantics: positive capabilities are
sorted strings in `tags`, missing tags mean false, and mutations are described
once in `sideEffects`. Empty/default metadata and completed pagination aliases
are omitted instead of being returned as false, null, or empty strings.
Server-owned queue recovery state follows the same rule: replay, recovery,
timeout, and ticket lifecycle markers are merged into `tags`, while numeric
evidence such as `replayCount` remains explicit.

`unity_editor_state` follows the same compact contract but never returns an
ambiguous state-less snapshot: a stable Editor includes `idle`, while active
states add `playing`, `paused`, `compiling`, `updating`, or
`changingPlayMode`. Release-managed first-class schemas such as `unity_build`
also remain the fallback authority when temporarily incomplete live metadata
arrives during a package reload.

Project-defined tools are deliberately not promoted to concrete Node-server tools, even when the Editor package marks one first-class. This prevents a tool from one open Unity project remaining advertised after the MCP session switches to another project.

The server advertises MCP tool-list change notifications and refreshes live plugin metadata in the background. When a package update changes one of the release-managed concrete routes, compatible MCP clients automatically request the updated tool list without reconnecting. Metadata refresh requests compact schema-bearing first-class pages only; they do not transfer the full plugin route catalog.

The current VM Unity MCP package publishes common semantic workflows directly
and keeps package-specific VFX Graph, Audio Mixer, Build Profile, Addressables,
Timeline, and Cinemachine routes lazily discoverable. The Editor's live
capability metadata, rather than this README, is authoritative for availability
and schemas.
The generated `manifest.json` and `docs/tool-audit-report.md` are authoritative
for the current tool count and exposure tiers; this README intentionally avoids
maintaining a second numeric catalog that can drift.

For prefab creation, `unity_prefab_asset_add_component` accepts an optional
`properties` map. The Editor applies those serialized values before the first
save and verifies them by readback; use
`unity_prefab_asset_configure_component` for idempotent ensure/update work or
ObjectReference wiring. Its optional `createPathIfMissing` flag creates a
missing semantic GameObject path in the same atomic transaction. Routine asset
duplication uses the concrete rollback-capable `unity_asset_copy` tool rather
than arbitrary Editor code.

### Multi-Instance Support

The server automatically discovers all running Unity Editor instances on startup. If only one instance is found, it auto-connects. If multiple instances are running (e.g., main editor + ParrelSync clones), it prompts you to select which one to work with.

**Port Resilience** — The server includes a multi-layer protection system for reliable multi-project workflows:

- **Port Identity Validation** — When restoring a saved connection, the server verifies the instance identity (project name + path) matches the expected target. If Unity restarts and a different project grabs the port, the server detects this and re-discovers the correct instance. An in-flight call whose port was derived from `expectedProjectPath` follows that same verified project to its newly registered port; a caller-supplied `port` remains immutable.
- **Bound Mutations** — Every mutating request carries the selected instance's expected project path/name; the Editor rejects unbound or misrouted writes.
- **Idempotent Queue Control** — Stable request keys survive retries, and `unity_queue_cancel` cancels queued work owned by the current agent without preempting an executing Unity API call.
- **Persistent Code and Project Tools** — Execute-code and long project tools
  return durable Jobs with `jobs/get`, `jobs/cancel`, exact-argument
  `idempotencyKey` reuse, and explicit `jobs/cleanup` contracts.
- **Queue-Only Reload Recovery** — Transient queue submission and status failures during package or domain reload first refresh a derived project-path binding, then retry with the same idempotency key. Initial project discovery keeps its own bounded timeout; it does not consume a long-running operation's reload budget before a target exists. The server never switches later commands to unsupported direct execution endpoints.
- **Compile-Time Resilience** — During long Unity compiles (when the editor is unresponsive), the server checks the shared instance registry. If the registry entry is fresh (updated within the last 5 minutes via heartbeat), the connection is preserved instead of dropped.
- **Reload Discovery Lease** — A fresh registered Editor remains listed with `status: "reloading"` and `isReachable: false` while its HTTP bridge restarts.
- **Crash Detection** — The plugin sends a heartbeat every 30 seconds to the instance registry. If Unity crashes and the heartbeat stops, the server detects the stale registry entry (>5 minutes old) and clears it, allowing proper re-discovery.
- **Port Affinity** — The plugin remembers its last-used port via EditorPrefs and reclaims it on restart, minimizing port swaps across editor restarts.

## Quick Start

### 1. Install the Unity Plugin

In Unity: **Window > Package Manager > + > Add package from git URL:**
```
https://github.com/VM233/VMUnityMCP.git
```

### 2. Install this MCP Server

```bash
git clone https://github.com/VM233/unity-mcp-server.git
cd unity-mcp-server
npm install
```

### 3. Add to Claude Desktop

Open Claude Desktop > Settings > Developer > Edit Config, and add:

```json
{
  "mcpServers": {
    "unity": {
      "command": "node",
      "args": ["C:/path/to/unity-mcp-server/src/index.js"],
      "env": {
        "UNITY_HUB_PATH": "C:\\Program Files\\Unity Hub\\Unity Hub.exe",
        "UNITY_BRIDGE_PORT": "7890"
      }
    }
  }
}
```

Restart Claude Desktop. Done!

### 4. Try It

- *"List my installed Unity editors"*
- *"Show me the scene hierarchy"*
- *"Create a red cube at position (0, 2, 0) and add a Rigidbody"*
- *"Profile my scene and show the top memory consumers"*
- *"List all Shader Graphs in my project"*
- *"Build my project for Windows"*
- *"List and start my MPPM multiplayer scenarios"*
- *"Capture a screenshot of my scene view"*
- *"Show me the active agent sessions"*

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `UNITY_HUB_PATH` | `C:\Program Files\Unity Hub\Unity Hub.exe` | Unity Hub executable path |
| `UNITY_BRIDGE_HOST` | `127.0.0.1` | Editor bridge host |
| `UNITY_BRIDGE_PORT` | `7890` | Editor bridge port (auto-discovered when using multi-instance) |
| `UNITY_BRIDGE_TIMEOUT` | `30000` | Request timeout in ms |
| `UNITY_QUEUE_POLL_TIMEOUT` | `120000` | Active Editor processing-time budget for a queued request |
| `UNITY_QUEUE_RELOAD_RECOVERY_TIMEOUT` | `120000` | Separate bounded budget for transient bridge outages during reload |
| `UNITY_PORT_RANGE_START` | `7890` | Start of port scan range for multi-instance discovery |
| `UNITY_PORT_RANGE_END` | `7899` | End of port scan range |
| `UNITY_REGISTRY_STALENESS_TIMEOUT` | `300000` | Registry entry staleness timeout in ms (crash detection) |
| `UNITY_RESPONSE_SOFT_LIMIT` | `2097152` | Response size threshold that emits a server-side diagnostic |
| `UNITY_RESPONSE_HARD_LIMIT` | `4194304` | Response size limit; oversized payloads become a structured error |
| `UNITY_MCP_DEBUG` | `false` | Enable debug logging for troubleshooting |

The Unity package stores team defaults under **Project Settings > Unity MCP**
and local bridge, port, response, history, and category choices under
**Preferences > Unity MCP**.

## Optional Package Support

Optional integrations are capability- and version-gated by the Editor package.
Use the live `_meta/capabilities` metadata through the advanced catalog to see
what the selected project currently supports. Keeping that response
authoritative avoids duplicating a package table here that would drift as Unity
packages are installed, removed, or upgraded.

## Requirements

- Node.js 18+
- Unity Hub (for Hub tools)
- Unity Editor with [VM Unity MCP](https://github.com/VM233/VMUnityMCP) installed (for Editor tools)

## Troubleshooting

**"Connection failed" errors** — Make sure Unity Editor is open and the plugin is installed. Check the Unity Console for `[MCP Bridge] Server started on port 7890`.

**"Unity Hub not found"** — Update `UNITY_HUB_PATH` in your config to match your installation.

**"Category disabled" errors** — A feature category may be toggled off. Open
**Preferences > Unity MCP** in Unity to check local category settings.

**Port conflicts** — Change `UNITY_BRIDGE_PORT` in the MCP server environment
or update the manual/automatic port settings under
**Preferences > Unity MCP**.

## Why AnkleBreaker Unity MCP?

AnkleBreaker Unity MCP is the most comprehensive MCP integration for Unity, purpose-built to leverage the full power of **Claude Cowork** and other AI assistants. Here's how it compares to alternatives:

### Feature Comparison

| Feature | **AnkleBreaker MCP** | **Bezi** | **Coplay MCP** | **Unity AI** |
|---------|:-------------------:|:--------:|:--------------:|:------------:|
| **Total Tools** | **Hundreds (lazy catalog)** | ~30 | 34 | Limited (built-in) |
| **Feature Categories** | **30+** | ~5 | ~5 | N/A |
| **Non-Blocking Editor** | ✅ Full background operation | ❌ Freezes Unity during tasks | ✅ | ✅ |
| **Open Source** | ✅ AnkleBreaker Open License | ❌ Proprietary | ✅ MIT License | ❌ Proprietary |
| **Claude Cowork Optimized** | ✅ Two-tier lazy loading | ❌ Not MCP-based | ⚠️ Basic | ❌ Not MCP-based |
| **Multi-Instance Support** | ✅ Auto-discovery | ❌ | ❌ | ❌ |
| **Multi-Agent Support** | ✅ Session tracking + queuing | ❌ | ❌ | ❌ |
| **Unity Hub Control** | ✅ Install editors & modules | ❌ | ❌ | ❌ |
| **Scene Hierarchy** | ✅ Full tree + pagination | ⚠️ Limited | ⚠️ Basic | ⚠️ Limited |
| **Physics Tools** | ✅ Raycasts, overlap, settings | ❌ | ❌ | ❌ |
| **Terrain Tools** | ✅ Full terrain pipeline | ❌ | ❌ | ❌ |
| **Shader Graph** | ✅ Create, inspect, open | ❌ | ❌ | ❌ |
| **Profiling & Debugging** | ✅ Profiler + Frame Debugger + Memory | ❌ | ❌ | ⚠️ Basic |
| **Animation System** | ✅ Controllers, clips, parameters | ⚠️ Basic | ⚠️ Basic | ⚠️ Basic |
| **NavMesh / Navigation** | ✅ Bake, agents, obstacles | ❌ | ❌ | ❌ |
| **Particle Systems** | ✅ Full module editing | ❌ | ❌ | ❌ |
| **MPPM Multiplayer** | ✅ Scenarios, start/stop | ❌ | ❌ | ❌ |
| **Visual Inspection** | ✅ Scene + Game view capture | ❌ | ⚠️ Limited | ❌ |
| **Play Mode Resilient** | ✅ Survives domain reload | ❌ | ❌ | N/A |
| **Port Resilience** | ✅ Identity validation + crash detection | ❌ | ❌ | N/A |
| **Project Context** | ✅ Custom docs for AI agents | ❌ | ❌ | ⚠️ Built-in only |

### Cost Comparison

> **AnkleBreaker Unity MCP is completely free and open source.** The prices below reflect only the cost of the AI assistant (Claude) itself — the MCP plugin and server are $0.

| Solution | Monthly Cost | What You Get |
|----------|:----------:|--------------| 
| **AnkleBreaker MCP (free) + Claude Pro** | **$20/mo** | Hundreds of tools, full Unity control, open source — MCP is free, price is Claude only |
| **AnkleBreaker MCP (free) + Claude Max 5x** | **$100/mo** | Same + 5x usage for heavy workflows — MCP is free, price is Claude only |
| **AnkleBreaker MCP (free) + Claude Max 20x** | **$200/mo** | Same + 20x usage for teams/studios — MCP is free, price is Claude only |
| **Bezi Pro** | $20/mo | ~30 tools, 800 credits/mo, freezes Unity |
| **Bezi Advanced** | $60/mo | ~30 tools, 2400 credits/mo, freezes Unity |
| **Bezi Team** | $200/mo | 3 seats, 8000 credits, still freezes Unity |
| **Unity AI** | Included with Unity Pro/Enterprise | Limited AI tools, Unity Points system, no MCP |
| **Coplay MCP** | Free (beta) | 34 tools, basic categories |

### Key Advantages

**vs. Bezi:**
Bezi runs as a proprietary Unity plugin with its own credit-based billing — $20–$200/mo on top of your AI subscription. It has historically suffered from freezing the Unity Editor during AI tasks, blocking your workflow. AnkleBreaker MCP is completely free and open source, runs entirely in the background with zero editor impact, and offers 8x more tools — the only cost is your existing Claude subscription.

**vs. Coplay MCP:**
Coplay MCP provides 34 tools across ~5 categories. AnkleBreaker MCP delivers hundreds of tools across 30+ categories including advanced features like physics raycasts, terrain editing, shader graph management, profiling, NavMesh, particle systems, and MPPM multiplayer — none of which exist in Coplay. Our two-tier lazy loading system is specifically optimized for Claude Cowork's tool limits.

**vs. Unity AI:**
Unity AI (successor to Muse) is built into Unity 6.2+ but limited to Unity's own AI models and a credit-based "Unity Points" system. It cannot be used with Claude or any external AI assistant, has no MCP support, and offers a fraction of the automation capabilities. AnkleBreaker MCP works with any MCP-compatible AI while giving you full control over which AI models you use.

## Support the Project

If Unity MCP helps your workflow, consider supporting its development! Your support helps fund new features, bug fixes, documentation, and more open-source game dev tools.

<a href="https://github.com/sponsors/AnkleBreaker-Studio">
  <img src="https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-ea4aaa?logo=github&style=for-the-badge" alt="GitHub Sponsors" />
</a>
<a href="https://www.patreon.com/AnkleBreakerStudio">
  <img src="https://img.shields.io/badge/Support-Patreon-f96854?logo=patreon&style=for-the-badge" alt="Patreon" />
</a>

**Sponsor tiers include priority feature requests** — your ideas get bumped up the roadmap! Check out the tiers on [GitHub Sponsors](https://github.com/sponsors/AnkleBreaker-Studio) or [Patreon](https://www.patreon.com/AnkleBreakerStudio).

## Release History

See [CHANGELOG.md](CHANGELOG.md) for versioned release notes. Keeping the
history in one file avoids stale duplicate “What's New” sections in this README.

## Frequently Asked Questions

**What is Unity MCP?**
Unity MCP (Model Context Protocol) is an open-source integration that connects AI assistants like Claude, Cursor, and Windsurf to the Unity Editor and Unity Hub. It allows AI to directly control Unity — creating scenes, placing objects, writing scripts, running builds, profiling, and more — through a standardized protocol.

**How does AnkleBreaker Unity MCP compare to other Unity AI tools?**
AnkleBreaker Unity MCP offers hundreds of tools across 30+ categories, making it the most comprehensive Unity MCP integration available. Competitors like Bezi (~30 tools) and Coplay MCP (34 tools) cover a fraction of Unity's features. Unlike Bezi, AnkleBreaker MCP is free, open source, and doesn't freeze the Unity Editor during AI operations.

**Does it work with Claude Desktop / Claude Cowork?**
Yes. AnkleBreaker Unity MCP is purpose-built for Claude Desktop and Claude Cowork. It uses a two-tier lazy loading system to stay within MCP client tool limits while exposing hundreds of tools on demand.

**Does it work with Cursor, Windsurf, or other MCP clients?**
Yes. Any AI tool that supports the Model Context Protocol can connect to this server. This includes Cursor, Windsurf, Claude Desktop, Claude Cowork, and any other MCP-compatible client.

**What Unity versions are supported?**
Unity 2021.3 LTS and newer, including Unity 2022.3 LTS and Unity 6. The plugin is installed via Unity Package Manager (UPM).

**Is it free?**
Yes. Both the MCP server and the Unity plugin are completely free and open source under the AnkleBreaker Open License. The only cost is your AI assistant subscription (e.g., Claude Pro at $20/month).

**Can multiple AI agents use it simultaneously?**
Yes. The server supports multi-agent operation with session tracking, action logging, and queued execution to prevent conflicts. It also supports multiple Unity Editor instances running side-by-side.

## Related Projects

- **[VM Unity MCP](https://github.com/VM233/VMUnityMCP)** — The companion Unity Editor package that this server connects to
- **[Model Context Protocol](https://modelcontextprotocol.io)** — The open standard that powers this integration
- **[Claude Desktop](https://claude.ai/download)** — Anthropic's AI assistant with built-in MCP support
- **[AnkleBreaker Studio](https://github.com/AnkleBreaker-Studio)** — The game studio behind this project

---

<details>
<summary><strong>Keywords</strong> (for search engines)</summary>

Unity MCP, Unity MCP Server, Unity MCP Plugin, Unity AI, AI game development, AI Unity Editor, Claude Unity, Cursor Unity, Windsurf Unity, Model Context Protocol Unity, MCP server Unity, Unity automation, AI-assisted game development, Unity Editor AI control, Unity Hub AI, Unity build automation, Unity scene management AI, Unity GameObject AI, Unity component automation, Shader Graph AI, Unity terrain AI, Unity NavMesh AI, Unity physics AI, Unity profiler AI, Unity animation AI, MPPM multiplayer AI, Unity MCP integration, free Unity AI tools, open source Unity AI, AnkleBreaker Studio, AnkleBreaker MCP, Unity MCP bridge, Unity Editor plugin MCP, UPM MCP package, AI co-pilot Unity, Unity game dev AI assistant

</details>

## License

AnkleBreaker Open License v1.0 — see [LICENSE](LICENSE)

This license requires: (1) including the copyright notice, (2) displaying **"Made with AnkleBreaker MCP"** (or "Powered by AnkleBreaker MCP") attribution in any product built with it (personal/educational use is exempt), and (3) **reselling the tool is forbidden** — you may not sell, sublicense, or commercially distribute this software or derivatives of it. See the full [LICENSE](LICENSE) for details.
