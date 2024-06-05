// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { APIClientManagerAPI } from "./apiClientManager";
/** Entrypoint for logger API */
export const apiClientManager = APIClientManagerAPI.getInstance();

export type { ApiClientConfiguration } from "./apiClientManager/types";
