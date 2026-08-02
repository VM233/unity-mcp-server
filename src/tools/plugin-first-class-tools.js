import { createRequire } from "node:module";

import { STATIC_FIRST_CLASS_PLUGIN_ROUTES } from "../plugin-tool-policy.js";

const require = createRequire(import.meta.url);
const generatedTools = require("./plugin-first-class-tools.generated.json");
const allowedRoutes = new Set(STATIC_FIRST_CLASS_PLUGIN_ROUTES);

export const staticFirstClassPluginTools = generatedTools
  .filter((tool) => allowedRoutes.has(tool.route));

const replaySafeReadRoutes = new Set(staticFirstClassPluginTools
  .filter((tool) =>
    tool.annotations?.readOnlyHint === true &&
    tool.annotations?.idempotentHint === true)
  .map((tool) => tool.route));

export function isReleaseManagedReplaySafeReadRoute(route) {
  return replaySafeReadRoutes.has(route);
}
