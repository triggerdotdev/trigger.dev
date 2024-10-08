// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { TimeoutAPI } from "./timeout/api.js";
/** Entrypoint for timeout API */
export const timeout = TimeoutAPI.getInstance();
