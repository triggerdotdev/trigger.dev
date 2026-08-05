// The webapp imports the task TYPE from here for end-to-end transport typing:
//   import type { dashboardAgent } from "@internal/dashboard-agent";
//   useTriggerChatTransport<typeof dashboardAgent>({ task: "dashboard-agent", ... })
// Always import it `type`-only — a value import would pull the task's runtime
// dependencies (postgres, drizzle, ai) into the webapp bundle and try to
// register the task in the webapp's context.
export * from "./dashboard-agent.js";

// The watcher task, for the webapp: it triggers the first tick when it creates a
// watch. TYPE-ONLY on purpose — the webapp must trigger it by id
// (`tasks.trigger<typeof watchTick>("dashboard-agent-watch", payload)`) and must
// never import the task value.
// The batch tick is the same deal: the webapp arms a chain and triggers it by id
// (`dashboard-agent-watch-batch`), never by importing the task value.
export type {
  WatchBatchCheckEntry,
  WatchBatchCheckResponse,
  WatchBatchTickPayload,
  watchBatchTick,
  WatchTickPayload,
  watchTick,
} from "./watch-tick.js";

// The view-catalog block types, for the webapp's render registry. They now live
// in `@internal/dashboard-agent-contracts` (a zod-only leaf) and are re-exported
// here so existing `import type { ViewBlock } from "@internal/dashboard-agent"`
// sites keep working. Type-only — no runtime enters the bundle.
export type { ChartBlock, DiagnosisBlock, ViewBlock } from "@internal/dashboard-agent-contracts";
