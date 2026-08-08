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

The selected Editor package's live metadata is authoritative for every Unity,
package, and project tool. `manifest.json` contains only the bounded bootstrap;
typed Unity tools are discovered and activated from the selected instance.

## Architecture

```text
MCP host <-> bootstrap + active typed tools <-> canonical instance catalog
              |                                  |
              +-> Unity Hub CLI                  +-> VM Unity MCP <-> Editor
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

The initial MCP surface is deliberately limited to 12 tools: instance binding,
Unity Hub, health, and `unity_tools_list/search/get`. This keeps Codex tool
selection small without hiding any Editor capability.

For normal work:

1. Call `unity_tools_search` with the task intent. Add `moduleId`, `category`,
   `capability`, `operationKind`, `effects`, or `preconditions` only when they
   materially narrow the request. The default result is at most five compact
   candidates and never contains full schemas.
2. Call `unity_tools_get` with one exact returned `name`. If the name is already
   known, start here instead of searching.
3. Call the newly activated typed tool with its published schema.

`unity_tools_get` returns the full input/output contract and adds that exact
tool to the MCP surface. Long-running activations also make `unity_jobs_get`,
`unity_jobs_cancel`, and `unity_jobs_cleanup` available. Project-defined and
package-defined tools use the same workflow and become ordinary typed calls;
there is no generic route executor or separate project-tool envelope.

Changing the selected Unity instance binds a different catalog revision. Tools
whose contract is absent or changed are removed or refreshed and the server
emits `tools/list_changed`.

If a queued operation reaches its polling timeout, do not immediately submit
the mutation again. Activate the returned ticket-status tool through
`unity_tools_get`, then inspect the existing ticket first.

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

Run a focused Git-package reload regression by setting
`UNITY_EXPECTED_PROJECT_PATH`, `UNITY_PACKAGE_TEST_NAME`, and a JSON array in
`UNITY_PACKAGE_TEST_NAMES`, then execute `npm run test:package-job-reload`.
The script finds and activates `unity_testing_run_package_tests` through the
canonical catalog, then polls its durable Job through `unity_jobs_get`.

Regenerate the tool audit after intentionally changing the release-managed tool surface:

```bash
npm run audit:tools
```

## Release history

See [CHANGELOG.md](CHANGELOG.md).

## License

Licensed under the [AnkleBreaker Open License v1.0](LICENSE). Retain the required copyright notice and the **Made with AnkleBreaker MCP** or **Powered by AnkleBreaker MCP** attribution when distributing covered work.
