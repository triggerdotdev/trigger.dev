// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { RealtimeStreamsAPI } from "./realtimeStreams/index.js";

export const realtimeStreams = RealtimeStreamsAPI.getInstance();

export * from "./realtimeStreams/types.js";
