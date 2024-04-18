// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { TaskCatalogAPI } from "./task-catalog";
/** Entrypoint for runtime API */
export const taskCatalog = TaskCatalogAPI.getInstance();
