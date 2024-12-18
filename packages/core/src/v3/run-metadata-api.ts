// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { RunMetadataAPI } from "./runMetadata/index.js";

export const runMetadata = RunMetadataAPI.getInstance();

export * from "./runMetadata/types.js";
export * from "./runMetadata/operations.js";
