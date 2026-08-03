# Unity MCP Server

An MCP server that connects compatible AI clients to Unity Editor and Unity Hub. It runs as a Node.js stdio process and uses the companion [VM Unity MCP](https://github.com/VM233/VMUnityMCP) package for Editor operations.

Originally created by [AnkleBreaker Studio](https://github.com/AnkleBreaker-Studio). This repository is independently maintained and retains the attribution required by the AnkleBreaker Open License.

## Capabilities

- Unity Hub editor and module management
- Scene, GameObject, component, asset, prefab, script, package, test, and build workflows
- Animation, physics, lighting, audio, terrain, navigation, UI, profiling, and other package-dependent tools
- Multiple Unity Editor instances with explicit project binding
- Multi-agent queueing, persistent jobs, structured results, and bounded reload recovery
- Project-defined tools and project context supplied by the selected Unity project
- Server hot reload while the MCP host keeps the same stdio connection

The selected Editor package's live metadata is authoritative for available tools and schemas. `manifest.json` contains the release-managed direct tool surface; less common routes are discovered at runtime.

## Architecture

```text
MCP host <-> Node.js server <-> VM Unity MCP Editor package <-> Unity Editor
                     |
                     +-> Unity Hub CLI
```

The Node.js server owns MCP transport, tool exposure, instance discovery and binding, queue polling, and Unity Hub commands. The Unity package owns Editor-side routes, capability metadata, and Unity API execution.

## Requirements

- Node.js 18 or newer
- Unity Editor with [VM Unity MCP](https://github.com/VM233/VMUnityMCP) installed
- Unity Hub only when using Hub management tools

## Installation

### 1. Install the Unity package

In Unity, open **Window > Package Manager**, choose **Add package from git URL**, and enter:

```text
https://github.com/VM233/VMUnityMCP.git
```

### 2. Install the server

```bash
git clone https://github.com/VM233/unity-mcp-server.git
cd unity-mcp-server
npm install
```

### 3. Configure the MCP host

Add the server to the host's MCP configuration. Use an absolute path:

```json
{
  "mcpServers": {
    "unity": {
      "command": "node",
      "args": ["C:/absolute/path/unity-mcp-server/src/index.js"]
    }
  }
}
```

Set `UNITY_HUB_PATH` in `env` when Unity Hub is not installed at the platform default. Restart the MCP host once after the initial installation.

### 4. Connect to Unity

Open a Unity project containing the Editor package. The server selects the only available Editor automatically. When several Editors are open, call `unity_list_instances`, then `unity_select_instance` with the intended port.

## Tool access

Use directly exposed `unity_*` tools first.

For a route that is not directly exposed:

1. Call `unity_list_advanced_tools` with a category and pagination.
2. Request schemas only for the relevant page when needed.
3. Call `unity_advanced_tool` with the returned tool name or raw route and its `params`.

Project-defined tools use this sequence:

1. `unity_project_tools_list`
2. `unity_project_tools_get`
3. `unity_project_tools_execute`

If a queued operation reaches its polling timeout, do not immediately submit the mutation again. Follow the returned `nextTool` and `nextToolArgs` to inspect the existing ticket first.

Release-managed reads whose live plugin metadata declares them idempotent receive
one fresh submission when Unity definitively reports that a domain reload lost
the old queue ticket, including when reconnection consumed the configured
recovery budget. Mutation routes remain fail-closed.

## Server hot reload

The launcher watches the server implementation and package metadata. A valid update activates without replacing the host's stdio process; a failed candidate leaves the previous runtime active.

Restart the MCP host when changing `src/index.js`, `src/hot-reload-proxy.js`, startup environment variables, or the MCP capability envelope. Upgrading from a release older than the stable launcher also requires one restart.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `UNITY_HUB_PATH` | Platform default | Unity Hub executable |
| `UNITY_BRIDGE_HOST` | `127.0.0.1` | Editor bridge host |
| `UNITY_BRIDGE_PORT` | `7890` | Fallback Editor bridge port |
| `UNITY_PORT_RANGE_START` | `7890` | Instance discovery range start |
| `UNITY_PORT_RANGE_END` | `7899` | Instance discovery range end |
| `UNITY_BRIDGE_TIMEOUT` | `60000` | Bridge request timeout in milliseconds |
| `UNITY_QUEUE_POLL_TIMEOUT` | `120000` | Active queued-operation polling budget in milliseconds |
| `UNITY_QUEUE_RELOAD_RECOVERY_TIMEOUT` | `120000` | Bridge reload recovery budget in milliseconds |
| `UNITY_RESPONSE_HARD_LIMIT` | `2097152` | Maximum response size in bytes |
| `UNITY_MCP_HOT_RELOAD` | `true` | Enable stable-launcher hot reload |
| `LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info`, or `debug` |

Team settings are stored under **Project Settings > Unity MCP**. Local bridge, port, response, history, and category settings are stored under **Preferences > Unity MCP**.

## Troubleshooting

| Problem | Check |
|---|---|
| No Unity instance is listed | Open Unity, confirm the VM Unity MCP package is installed, and inspect the Unity Console for bridge startup errors. |
| Commands target the wrong project | Run `unity_list_instances`, select the intended instance, and use project-bound arguments when available. |
| Unity Hub is not found | Set `UNITY_HUB_PATH` to the Hub executable. |
| A category is disabled | Enable it under **Preferences > Unity MCP**. |
| A queue call times out | Query the returned ticket before deciding whether to retry. |
| A server update is not visible | Check server logs; restart the host if the launcher, environment, or MCP capability envelope changed. |

## Development

Run the static test suite:

```bash
npm test
```

Regenerate the tool audit after intentionally changing the release-managed tool surface:

```bash
npm run audit:tools
```

## Release history

See [CHANGELOG.md](CHANGELOG.md).

## License

Licensed under the [AnkleBreaker Open License v1.0](LICENSE). Retain the required copyright notice and the **Made with AnkleBreaker MCP** or **Powered by AnkleBreaker MCP** attribution when distributing covered work.
