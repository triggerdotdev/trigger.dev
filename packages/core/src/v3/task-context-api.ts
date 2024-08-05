// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { TaskContextAPI } from "./taskContext/index.js";
/** Entrypoint for logger API */
export const taskContext = TaskContextAPI.getInstance();
