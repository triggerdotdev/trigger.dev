// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { UsageAPI } from "./usage/api";
/** Entrypoint for usage API */
export const usage = UsageAPI.getInstance();
