// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { LoggerAPI } from "./logger/index.js";
/** Entrypoint for logger API */
export const logger = LoggerAPI.getInstance();
