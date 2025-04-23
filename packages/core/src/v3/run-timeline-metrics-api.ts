// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { RunTimelineMetricsAPI } from "./runTimelineMetrics/index.js";

export const runTimelineMetrics = RunTimelineMetricsAPI.getInstance();
