// The webapp imports the task type from here for end-to-end transport typing. Always
// `type`-only: a value import would pull the task's runtime dependencies (postgres,
// drizzle, ai) into the webapp bundle and try to register the task in the webapp's
// context.
export * from "./dashboard-agent.js";

// The watch tasks, type-only for the same reason. The webapp triggers them by id
// (`dashboard-agent-watch`, `dashboard-agent-watch-batch`), never by importing the
// task value.
export type {
  WatchBatchCheckEntry,
  WatchBatchCheckResponse,
  WatchBatchTickPayload,
  watchBatchTick,
  WatchTickPayload,
  watchTick,
} from "./watch-tick.js";

// The view-catalog block types live in `@internal/dashboard-agent-contracts` and are
// re-exported here so existing import sites keep working.
export type { ChartBlock, DiagnosisBlock, ViewBlock } from "@internal/dashboard-agent-contracts";
