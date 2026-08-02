import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync, watch } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";

import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";

const INTERNAL_ERROR = -32603;
const TOOL_LIST_CHANGED = {
  jsonrpc: "2.0",
  method: "notifications/tools/list_changed",
};

function messageIdKey(id) {
  return JSON.stringify(id);
}

function isRequest(message) {
  return message && typeof message.method === "string" &&
    Object.hasOwn(message, "id");
}

function isNotification(message) {
  return message && typeof message.method === "string" &&
    !Object.hasOwn(message, "id");
}

function isResponse(message) {
  return message && !Object.hasOwn(message, "method") &&
    Object.hasOwn(message, "id");
}

function cloneMessage(message) {
  return JSON.parse(JSON.stringify(message));
}

function normalizePath(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function readPositiveInteger(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function writeMessage(stream, message) {
  if (!stream || stream.destroyed || !stream.writable) {
    return Promise.reject(new Error("MCP stdio stream is not writable"));
  }

  const payload = serializeMessage(message);
  return new Promise((resolveWrite, rejectWrite) => {
    const onError = (error) => {
      stream.off("error", onError);
      rejectWrite(error);
    };
    stream.once("error", onError);
    stream.write(payload, (error) => {
      stream.off("error", onError);
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

function collectDirectories(root, results = []) {
  results.push(root);
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      collectDirectories(resolve(root, entry.name), results);
    }
  }
  return results;
}

/**
 * Watch files and directory trees without relying on platform-specific recursive
 * fs.watch support. Atomic replacements are observed from the parent directory,
 * and newly-created directories are added after rename events.
 */
export function createSourceWatcher(paths, onChange, {
  ignoredPaths = [],
  onError = () => {},
} = {}) {
  const ignored = new Set(ignoredPaths.map(normalizePath));
  const watchers = new Map();
  let closed = false;
  let rescanTimer = null;

  const isIgnored = (path) => ignored.has(normalizePath(path));

  const addWatcher = (key, directory, filter, rescan) => {
    if (closed || watchers.has(key)) return;
    try {
      const watcher = watch(directory, { persistent: false }, (eventType, fileName) => {
        const changedPath = fileName ? resolve(directory, String(fileName)) : directory;
        if ((!filter || filter(changedPath)) && !isIgnored(changedPath)) {
          onChange(changedPath, eventType);
        }
        if (eventType === "rename" && rescan) {
          clearTimeout(rescanTimer);
          rescanTimer = setTimeout(rescan, 50);
          rescanTimer.unref?.();
        }
      });
      watcher.on("error", (error) => onError(error));
      watchers.set(key, watcher);
    } catch (error) {
      onError(error);
    }
  };

  const addDirectoryTree = (root) => {
    const scan = () => {
      for (const directory of collectDirectories(root, [])) {
        const key = `directory:${normalizePath(directory)}`;
        addWatcher(key, directory, null, scan);
      }
    };
    scan();
  };

  for (const path of paths) {
    const target = resolve(path);
    let isDirectory = false;
    try {
      isDirectory = statSync(target).isDirectory();
    } catch {
      continue;
    }

    if (isDirectory) {
      addDirectoryTree(target);
      continue;
    }

    const parent = dirname(target);
    const normalizedTarget = normalizePath(target);
    addWatcher(
      `file:${normalizedTarget}`,
      parent,
      (changedPath) => normalizePath(changedPath) === normalizedTarget,
      null
    );
  }

  return {
    close() {
      closed = true;
      clearTimeout(rescanTimer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}

export class HotReloadProxy {
  constructor({
    runtimeEntry,
    cwd = dirname(runtimeEntry),
    watchPaths = [dirname(runtimeEntry)],
    ignoredWatchPaths = [],
    watchEnabled = true,
    environment = process.env,
    input = process.stdin,
    output = process.stdout,
    errorOutput = process.stderr,
    debounceMs = readPositiveInteger(
      environment.UNITY_MCP_HOT_RELOAD_DEBOUNCE_MS, 250, 10),
    initializeTimeoutMs = readPositiveInteger(
      environment.UNITY_MCP_HOT_RELOAD_INIT_TIMEOUT_MS, 10_000, 100),
    shutdownTimeoutMs = readPositiveInteger(
      environment.UNITY_MCP_HOT_RELOAD_SHUTDOWN_TIMEOUT_MS, 2_000, 100),
  }) {
    this.runtimeEntry = resolve(runtimeEntry);
    this.cwd = resolve(cwd);
    this.watchPaths = watchPaths.map((path) => resolve(path));
    this.ignoredWatchPaths = ignoredWatchPaths.map((path) => resolve(path));
    this.watchEnabled = watchEnabled;
    this.environment = environment;
    this.input = input;
    this.output = output;
    this.errorOutput = errorOutput;
    this.debounceMs = debounceMs;
    this.initializeTimeoutMs = initializeTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;

    this.agentId = environment.UNITY_MCP_AGENT_ID ||
      `agent-${process.pid}-${randomBytes(3).toString("hex")}`;
    this.clientBuffer = new ReadBuffer();
    this.clientMessageChain = Promise.resolve();
    this.clientWriteChain = Promise.resolve();
    this.activeRuntime = null;
    this.preparingRuntime = null;
    this.generation = 0;
    this.pendingClientRequests = new Map();
    this.pendingServerRequests = new Map();
    this.queuedClientMessages = [];
    this.initializeRequest = null;
    this.initializeResult = null;
    this.initializedNotification = null;
    this.clientInitialized = false;
    this.reloadRequested = false;
    this.reloading = false;
    this.stopped = false;
    this.reloadTimer = null;
    this.sourceWatcher = null;

    this.onClientData = (chunk) => this._consumeClientData(chunk);
    this.onClientError = (error) => this._log(`Client stdio error: ${error.message}`);
    this.onClientEnd = () => void this.stop();
  }

  _log(message) {
    this.errorOutput.write(`[MCP hot reload] ${message}\n`);
  }

  async start() {
    this.activeRuntime = await this._spawnRuntime("active");
    this.input.on("data", this.onClientData);
    this.input.on("error", this.onClientError);
    this.input.on("end", this.onClientEnd);

    if (this.watchEnabled) {
      this.sourceWatcher = createSourceWatcher(
        this.watchPaths,
        (path) => this.requestReload(path),
        {
          ignoredPaths: this.ignoredWatchPaths,
          onError: (error) => this._log(`Source watcher error: ${error.message}`),
        }
      );
      this._log(`Watching ${this.watchPaths.join(", ")}`);
    } else {
      this._log("Source watching is disabled");
    }

    this._log(`Stable stdio proxy started with runtime generation ${this.generation}`);
    return this;
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.reloadTimer);
    this.sourceWatcher?.close();
    this.input.off("data", this.onClientData);
    this.input.off("error", this.onClientError);
    this.input.off("end", this.onClientEnd);
    const runtimes = [...new Set([
      this.activeRuntime,
      this.preparingRuntime,
    ].filter(Boolean))];
    this.activeRuntime = null;
    this.preparingRuntime = null;
    await Promise.all(runtimes.map((runtime) => this._shutdownRuntime(runtime)));
  }

  _consumeClientData(chunk) {
    try {
      this.clientBuffer.append(chunk);
      while (true) {
        const message = this.clientBuffer.readMessage();
        if (message === null) break;
        this.clientMessageChain = this.clientMessageChain
          .then(() => this._handleClientMessage(message))
          .catch((error) => this._log(`Client message failed: ${error.message}`));
      }
    } catch (error) {
      this._log(`Invalid client MCP message: ${error.message}`);
    }
  }

  async _handleClientMessage(message) {
    if (isRequest(message) && message.method === "initialize") {
      this.initializeRequest = cloneMessage(message);
      this.initializeResult = null;
      this.initializedNotification = null;
      this.clientInitialized = false;
    }
    if (isNotification(message) && message.method === "notifications/initialized") {
      this.initializedNotification = cloneMessage(message);
      this.clientInitialized = true;
    }

    if (isResponse(message)) {
      const key = messageIdKey(message.id);
      if (!this.pendingServerRequests.has(key)) {
        this._log(`Ignoring orphaned client response ${key}`);
        return;
      }
      this.pendingServerRequests.delete(key);
    }

    if (this.reloading || !this.activeRuntime) {
      this.queuedClientMessages.push(cloneMessage(message));
      return;
    }

    await this._forwardClientMessage(message, this.activeRuntime);
    if (this.clientInitialized) void this._attemptReload();
  }

  async _forwardClientMessage(message, runtime) {
    if (isRequest(message)) {
      this.pendingClientRequests.set(messageIdKey(message.id), {
        id: message.id,
        method: message.method,
      });
    }
    try {
      await writeMessage(runtime.child.stdin, message);
    } catch (error) {
      if (runtime === this.activeRuntime && !runtime.exited) {
        runtime.child.kill();
      }
      throw error;
    }
  }

  _consumeRuntimeData(runtime, chunk) {
    try {
      runtime.buffer.append(chunk);
      while (true) {
        const message = runtime.buffer.readMessage();
        if (message === null) break;
        runtime.messageChain = runtime.messageChain
          .then(() => this._handleRuntimeMessage(runtime, message))
          .catch((error) => this._log(
            `Runtime generation ${runtime.generation} message failed: ${error.message}`));
      }
    } catch (error) {
      this._log(
        `Runtime generation ${runtime.generation} emitted invalid MCP output: ${error.message}`);
      runtime.child.kill();
    }
  }

  async _handleRuntimeMessage(runtime, message) {
    if (runtime.initializeWaiter &&
        messageIdKey(message.id) === messageIdKey(runtime.initializeWaiter.id)) {
      const waiter = runtime.initializeWaiter;
      runtime.initializeWaiter = null;
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message || "initialize failed"));
      else waiter.resolve(message.result);
      return;
    }

    if (runtime !== this.activeRuntime) return;

    if (isResponse(message)) {
      const key = messageIdKey(message.id);
      const pending = this.pendingClientRequests.get(key);
      if (pending?.method === "initialize" && message.result) {
        this.initializeResult = cloneMessage(message.result);
      }
      this.pendingClientRequests.delete(key);
    } else if (isRequest(message)) {
      this.pendingServerRequests.set(messageIdKey(message.id), message.id);
    }

    await this._writeClientMessage(message);
    if (isResponse(message)) void this._attemptReload();
  }

  _writeClientMessage(message) {
    this.clientWriteChain = this.clientWriteChain
      .then(() => writeMessage(this.output, message));
    return this.clientWriteChain;
  }

  async _spawnRuntime(role) {
    const generation = ++this.generation;
    const child = spawn(process.execPath, [this.runtimeEntry], {
      cwd: this.cwd,
      env: {
        ...this.environment,
        UNITY_MCP_AGENT_ID: this.agentId,
        UNITY_MCP_RUNTIME_PROCESS: "1",
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    const runtime = {
      child,
      role,
      generation,
      buffer: new ReadBuffer(),
      messageChain: Promise.resolve(),
      initializeWaiter: null,
      expectedExit: false,
      exited: false,
    };

    child.stdout.on("data", (chunk) => this._consumeRuntimeData(runtime, chunk));
    child.stdout.on("error", (error) => this._log(
      `Runtime generation ${generation} stdout error: ${error.message}`));
    child.stdin.on("error", (error) => this._log(
      `Runtime generation ${generation} stdin error: ${error.message}`));
    child.stderr.on("data", (chunk) => this.errorOutput.write(chunk));
    child.stderr.on("error", (error) => this._log(
      `Runtime generation ${generation} stderr error: ${error.message}`));
    child.on("exit", (code, signal) => {
      runtime.exited = true;
      if (runtime.initializeWaiter) {
        const waiter = runtime.initializeWaiter;
        runtime.initializeWaiter = null;
        clearTimeout(waiter.timer);
        waiter.reject(new Error(
          `runtime exited during initialize (code=${code}, signal=${signal || "none"})`));
      }
      void this._handleRuntimeExit(runtime, code, signal);
    });

    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    if (runtime.exited) {
      throw new Error(
        `runtime exited during startup (generation=${generation})`);
    }
    return runtime;
  }

  async _handleRuntimeExit(runtime, code, signal) {
    if (runtime.expectedExit || this.stopped || runtime !== this.activeRuntime) return;

    this._log(
      `Runtime generation ${runtime.generation} exited unexpectedly ` +
      `(code=${code}, signal=${signal || "none"}); keeping host stdio open`);
    this.activeRuntime = null;

    for (const pending of this.pendingClientRequests.values()) {
      if (pending.method === "initialize" && this.initializeRequest) {
        this.queuedClientMessages.unshift(cloneMessage(this.initializeRequest));
        continue;
      }
      await this._writeClientMessage({
        jsonrpc: "2.0",
        id: pending.id,
        error: {
          code: INTERNAL_ERROR,
          message:
            "The Unity MCP runtime exited before this request completed. " +
            "The host connection stayed open; inspect mutation outcomes before retrying.",
          data: {
            errorCode: "runtime_restarted_during_request",
            retryable: false,
          },
        },
      });
    }
    this.pendingClientRequests.clear();
    this.pendingServerRequests.clear();
    await this._recoverRuntime();
  }

  requestReload(changedPath = "source change") {
    if (this.stopped) return;
    this.reloadRequested = true;
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this._attemptReload(), this.debounceMs);
    this.reloadTimer.unref?.();
    this._log(`Source change detected: ${changedPath}`);
  }

  async _attemptReload() {
    if (this.stopped || this.reloading || !this.reloadRequested) return;
    if (!this.activeRuntime) {
      await this._recoverRuntime();
      return;
    }
    if (!this.clientInitialized || !this.initializeRequest ||
        !this.initializeResult || !this.initializedNotification) return;
    if (this.pendingClientRequests.size > 0 || this.pendingServerRequests.size > 0) {
      return;
    }

    this.reloadRequested = false;
    this.reloading = true;
    const previousRuntime = this.activeRuntime;
    let candidate = null;
    try {
      candidate = await this._spawnRuntime("candidate");
      this.preparingRuntime = candidate;
      await this._initializeRuntime(candidate);
    } catch (error) {
      this.reloading = false;
      this.preparingRuntime = null;
      if (candidate) await this._shutdownRuntime(candidate);
      if (!previousRuntime.exited && this.activeRuntime === previousRuntime) {
        this._log(
          `Candidate runtime rejected; continuing generation ` +
          `${previousRuntime.generation}: ${error.message}`);
        try {
          await this._flushQueuedClientMessages(previousRuntime);
        } catch (resumeError) {
          this._log(
            `Runtime generation ${previousRuntime.generation} failed while resuming ` +
            `after candidate rejection: ${resumeError.message}`);
        }
      } else {
        this.activeRuntime = null;
        this.reloadRequested = true;
        this._log(
          `Candidate runtime rejected after the active runtime exited: ${error.message}`);
        await this._recoverRuntime();
      }
      if (this.reloadRequested) void this._attemptReload();
      return;
    }

    this.preparingRuntime = null;
    if (this.stopped) {
      this.reloading = false;
      await this._shutdownRuntime(candidate);
      return;
    }

    this.activeRuntime = candidate;
    candidate.role = "active";
    this.reloading = false;
    try {
      await this._flushQueuedClientMessages(candidate);
      await this._writeClientMessage(TOOL_LIST_CHANGED);
      this._log(
        `Activated runtime generation ${candidate.generation}; Codex stdio session preserved`);
    } catch (error) {
      this._log(
        `Activated runtime generation ${candidate.generation} failed while resuming traffic: ` +
        error.message);
      if (!candidate.exited) candidate.child.kill();
    }
    void this._shutdownRuntime(previousRuntime);

    if (this.reloadRequested) void this._attemptReload();
  }

  async _initializeRuntime(runtime) {
    const internalId =
      `unity-mcp-hot-reload-${runtime.generation}-${randomBytes(4).toString("hex")}`;
    const initialize = {
      ...cloneMessage(this.initializeRequest),
      id: internalId,
    };
    const resultPromise = new Promise((resolveInitialize, rejectInitialize) => {
      const timer = setTimeout(() => {
        runtime.initializeWaiter = null;
        rejectInitialize(new Error(
          `initialize timed out after ${this.initializeTimeoutMs}ms`));
      }, this.initializeTimeoutMs);
      timer.unref?.();
      runtime.initializeWaiter = {
        id: internalId,
        timer,
        resolve: resolveInitialize,
        reject: rejectInitialize,
      };
    });

    await writeMessage(runtime.child.stdin, initialize);
    const result = await resultPromise;
    if (!result || typeof result.protocolVersion !== "string") {
      throw new Error("candidate returned an invalid initialize result");
    }
    if (result.protocolVersion !== this.initializeResult.protocolVersion) {
      throw new Error(
        `candidate changed MCP protocol version from ` +
        `${this.initializeResult.protocolVersion} to ${result.protocolVersion}; ` +
        `a host reconnect is required`);
    }
    if (!isDeepStrictEqual(
      result.capabilities || {}, this.initializeResult.capabilities || {})) {
      throw new Error(
        "candidate changed the MCP capability envelope; a host reconnect is required");
    }
    await writeMessage(runtime.child.stdin, cloneMessage(this.initializedNotification));
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    if (runtime.exited) {
      throw new Error("candidate exited immediately after initialize");
    }
  }

  async _flushQueuedClientMessages(runtime) {
    while (this.queuedClientMessages.length > 0) {
      const message = this.queuedClientMessages.shift();
      await this._forwardClientMessage(message, runtime);
    }
  }

  async _recoverRuntime() {
    if (this.stopped || this.reloading || this.activeRuntime) return;
    this.reloading = true;
    let replacement = null;
    let activated = false;
    try {
      replacement = await this._spawnRuntime("candidate");
      this.preparingRuntime = replacement;
      if (this.clientInitialized) await this._initializeRuntime(replacement);
      this.preparingRuntime = null;
      if (this.stopped) {
        this.reloading = false;
        await this._shutdownRuntime(replacement);
        return;
      }
      this.activeRuntime = replacement;
      replacement.role = "active";
      activated = true;
      this.reloading = false;
      this.reloadRequested = false;
      await this._flushQueuedClientMessages(replacement);
      if (this.clientInitialized) await this._writeClientMessage(TOOL_LIST_CHANGED);
      this._log(`Recovered with runtime generation ${replacement.generation}`);
    } catch (error) {
      this.reloading = false;
      this.preparingRuntime = null;
      if (activated) {
        this._log(
          `Recovered runtime generation ${replacement.generation} failed while ` +
          `resuming traffic: ${error.message}`);
        if (!replacement.exited) replacement.child.kill();
      } else {
        this.reloadRequested = true;
        if (replacement) await this._shutdownRuntime(replacement);
        this._log(
          `Runtime recovery is waiting for the next source change: ${error.message}`);
      }
    }
  }

  async _shutdownRuntime(runtime) {
    if (!runtime || runtime.exited) return;
    runtime.expectedExit = true;
    const exitPromise = new Promise((resolveExit) => {
      runtime.child.once("exit", resolveExit);
    });
    try {
      if (runtime.child.connected) {
        runtime.child.send({ type: "unity-mcp:shutdown" });
      } else {
        runtime.child.stdin.end();
      }
    } catch {
      // The timeout fallback below owns final cleanup.
    }

    const exited = await Promise.race([
      exitPromise.then(() => true),
      new Promise((resolveTimeout) => {
        const timer = setTimeout(() => resolveTimeout(false), this.shutdownTimeoutMs);
        timer.unref?.();
      }),
    ]);
    if (!exited && !runtime.exited) runtime.child.kill();
  }
}

export async function runHotReloadProxy(options) {
  const proxy = new HotReloadProxy(options);
  await proxy.start();
  return proxy;
}

export function hotReloadEnabled(value) {
  const normalized = String(value ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

export function existingWatchPaths(paths) {
  return paths.map((path) => resolve(path)).filter((path) => existsSync(path));
}
