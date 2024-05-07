import path from "path";
import { fileURLToPath } from "url";

// With the move to TSUP as a build tool, this keeps path routes in other files (installers, loaders, etc) in check more easily.
// Path is in relation to a single index.js file inside ./dist
const __filename = fileURLToPath(import.meta.url);
const distPath = path.dirname(__filename);

export const PKG_ROOT = path.join(distPath, "../");
export const COMMAND_NAME = "trigger.dev";
export const CLOUD_WEB_URL = "https://cloud.trigger.dev";
export const CLOUD_API_URL = "https://api.trigger.dev";
export const CONFIG_FILES = ["trigger.config.ts", "trigger.config.js", "trigger.config.mjs"];
