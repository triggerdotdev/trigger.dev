// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { IdempotencyKeyCatalogAPI } from "./idempotency-key-catalog/index.js";
/** Entrypoint for idempotency key catalog API */
export const idempotencyKeyCatalog = IdempotencyKeyCatalogAPI.getInstance();
