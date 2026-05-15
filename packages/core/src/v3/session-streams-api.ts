// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { SessionStreamsAPI } from "./sessionStreams/index.js";

export const sessionStreams = SessionStreamsAPI.getInstance();

export * from "./sessionStreams/types.js";
