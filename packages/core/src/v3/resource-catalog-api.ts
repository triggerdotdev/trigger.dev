// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { ResourceCatalogAPI } from "./resource-catalog/index.js";
/** Entrypoint for runtime API */
export const resourceCatalog = ResourceCatalogAPI.getInstance();
