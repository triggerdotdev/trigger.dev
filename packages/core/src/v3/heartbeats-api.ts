// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { HeartbeatsAPI } from "./heartbeats/api.js";
/** Entrypoint for heartbeats API */
export const heartbeats = HeartbeatsAPI.getInstance();
