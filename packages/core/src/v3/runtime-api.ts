// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { RuntimeAPI } from "./runtime";
/** Entrypoint for runtime API */
export const runtime = RuntimeAPI.getInstance();
