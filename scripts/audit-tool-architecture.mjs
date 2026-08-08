import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(
  new URL("../manifest.json", import.meta.url), "utf8"));
const names = manifest.tools.map((tool) => tool.name);
const expected = [
  "unity_list_instances",
  "unity_select_instance",
  "unity_hub_list_editors",
  "unity_hub_available_releases",
  "unity_hub_install_editor",
  "unity_hub_install_modules",
  "unity_hub_get_install_path",
  "unity_hub_set_install_path",
  "unity_mcp_health",
  "unity_tools_list",
  "unity_tools_search",
  "unity_tools_get",
];

assert.deepEqual(names, expected, "manifest must advertise only the bounded bootstrap surface");
assert.equal(new Set(names).size, names.length, "bootstrap tool names must be unique");
for (const tool of manifest.tools) {
  assert.equal(typeof tool.description, "string");
  assert.ok(tool.description.trim().length >= 20, tool.name);
}

console.log(`Canonical tool architecture audit passed (${names.length} bootstrap tools).`);
