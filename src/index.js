#!/usr/bin/env node

import { delimiter, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  existingWatchPaths,
  hotReloadEnabled,
  runHotReloadProxy,
} from "./hot-reload-proxy.js";

const entryPath = fileURLToPath(import.meta.url);
const sourceRoot = dirname(entryPath);
const repositoryRoot = resolve(sourceRoot, "..");
const runtimeEntry = resolve(
  process.env.UNITY_MCP_RUNTIME_ENTRY || resolve(sourceRoot, "server.js")
);
const configuredWatchPaths = String(
  process.env.UNITY_MCP_HOT_RELOAD_WATCH_PATHS || ""
)
  .split(delimiter)
  .map((path) => path.trim())
  .filter(Boolean);
const watchPaths = existingWatchPaths(
  configuredWatchPaths.length > 0
    ? configuredWatchPaths
    : [
      sourceRoot,
      resolve(repositoryRoot, "package.json"),
      resolve(repositoryRoot, "package-lock.json"),
    ]
);

const proxy = await runHotReloadProxy({
  runtimeEntry,
  cwd: repositoryRoot,
  watchPaths,
  ignoredWatchPaths: configuredWatchPaths.length > 0
    ? []
    : [entryPath, resolve(sourceRoot, "hot-reload-proxy.js")],
  watchEnabled: hotReloadEnabled(process.env.UNITY_MCP_HOT_RELOAD),
});

let stopping = false;
const stop = async (exitCode = 0) => {
  if (stopping) return;
  stopping = true;
  await proxy.stop();
  process.exit(exitCode);
};

process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));
process.once("uncaughtException", (error) => {
  console.error("Fatal hot-reload proxy error:", error);
  void stop(1);
});
process.once("unhandledRejection", (error) => {
  console.error("Fatal hot-reload proxy rejection:", error);
  void stop(1);
});
