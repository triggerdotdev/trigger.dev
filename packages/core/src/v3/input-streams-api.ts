// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { InputStreamsAPI } from "./inputStreams/index.js";

export const inputStreams = InputStreamsAPI.getInstance();

export * from "./inputStreams/types.js";
