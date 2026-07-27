// The webapp imports the task TYPE from here for end-to-end transport typing:
//   import type { dashboardAgent } from "@internal/dashboard-agent";
//   useTriggerChatTransport<typeof dashboardAgent>({ task: "dashboard-agent", ... })
// Always import it `type`-only — a value import would pull the task's runtime
// dependencies (postgres, drizzle, ai) into the webapp bundle and try to
// register the task in the webapp's context.
export * from "./dashboard-agent.js";

// The view-catalog block types, for the webapp's render registry. They now live
// in `@internal/dashboard-agent-contracts` (a zod-only leaf) and are re-exported
// here so existing `import type { ViewBlock } from "@internal/dashboard-agent"`
// sites keep working. Type-only — no runtime enters the bundle.
export type { ChartBlock, DiagnosisBlock, ViewBlock } from "@internal/dashboard-agent-contracts";
