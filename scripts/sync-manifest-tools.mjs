import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { contextTools } from "../src/tools/context-tools.js";
import { editorTools } from "../src/tools/editor-tools.js";
import { hubTools } from "../src/tools/hub-tools.js";
import { instanceTools } from "../src/tools/instance-tools.js";
import { staticFirstClassPluginTools } from "../src/tools/plugin-first-class-tools.js";
import {
  sanitizeToolMetadata,
  splitToolTiers,
} from "../src/tool-tiers.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);
const manifestPath = join(repositoryRoot, "manifest.json");
const packagePath = join(repositoryRoot, "package.json");
const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8"));

const { coreTools, metaTools } = splitToolTiers(editorTools);
const toolsByName = new Map();
for (const tool of [
  ...instanceTools,
  ...hubTools,
  ...coreTools,
  ...metaTools,
  ...contextTools,
]) {
  toolsByName.set(tool.name, {
    name: tool.name,
    description: sanitizeToolMetadata(tool.description),
  });
}

for (const tool of staticFirstClassPluginTools) {
  toolsByName.set(tool.toolName, {
    name: tool.toolName,
    description: sanitizeToolMetadata(tool.description),
  });
}

const expectedTools = [...toolsByName.values()];
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const currentTools = manifest.tools || [];
const isCurrent =
  manifest.version === packageMetadata.version &&
  JSON.stringify(currentTools) === JSON.stringify(expectedTools);

if (process.argv.includes("--check")) {
  if (!isCurrent) {
    console.error(
      `manifest.json tool catalog is stale: expected ${expectedTools.length} generated tools, ` +
      `found ${currentTools.length}. Run npm run sync:manifest-tools.`
    );
    process.exit(1);
  }
  console.log(`manifest.json tool catalog is current (${expectedTools.length} tools).`);
  process.exit(0);
}

manifest.version = packageMetadata.version;
manifest.tools = expectedTools;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Updated manifest.json with ${expectedTools.length} generated tools.`);
