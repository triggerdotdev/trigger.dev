// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { TraceContextAPI } from "./traceContext/api.js";
/** Entrypoint for trace context API */
export const traceContext = TraceContextAPI.getInstance();
