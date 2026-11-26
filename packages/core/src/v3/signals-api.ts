// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { SignalsAPI } from "./signals/index.js";
/** Entrypoint for signals API */
export const signals = SignalsAPI.getInstance();

export * from "./signals/types.js";
