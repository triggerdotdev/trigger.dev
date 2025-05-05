// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { UsageAPI } from "./usage/api.js";
/** Entrypoint for usage API */
export const usage = UsageAPI.getInstance();

export type { UsageMeasurement, UsageSample } from "./usage/types.js";
