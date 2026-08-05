/**
 * Intent fixtures. An intent is a request to the host, never an action, so each
 * fixture pairs the intent with the past-tense sentence the panel shows once the
 * host has honoured it. Nothing here is honoured: the gallery renders the outcome
 * inline instead of navigating.
 */
import { isExecutableIntent, type AgentIntent } from "@internal/dashboard-agent-contracts";
import { DEMO_WORLD, demoRunUri } from "../ids";
import { demoBacklogDrainWatch } from "./watches";

export type DemoIntent = {
  intent: AgentIntent;
  /** Past-tense summary of what the host did, as shown in the transcript. */
  outcome: string;
  /** The deep link the bubble renders, as the user-visible path. */
  deepLinkLabel?: string;
  /** True when a host may act on this intent today (`propose_fix` may not). */
  executable: boolean;
};

const demoIntent = (intent: AgentIntent, outcome: string, deepLinkLabel?: string): DemoIntent => ({
  intent,
  outcome,
  deepLinkLabel,
  executable: isExecutableIntent(intent),
});

/** Navigate to the runs list with filters applied. */
export const demoNavigateToFailedRuns = demoIntent(
  {
    kind: "navigate",
    target: demoRunUri(DEMO_WORLD.failedRunId),
    filters: {
      statuses: ["COMPLETED_WITH_ERROR"],
      period: "24h",
      tasks: [DEMO_WORLD.taskId],
    },
  },
  "Opened runs filtered to failed · last 24h · send-order-receipt",
  "/runs?statuses=COMPLETED_WITH_ERROR&period=24h&tasks=send-order-receipt"
);

/** Navigate straight to one run. */
export const demoNavigateToRun = demoIntent(
  { kind: "navigate", target: demoRunUri(DEMO_WORLD.failedRunId) },
  `Opened ${DEMO_WORLD.failedRunId}`,
  `/runs/${DEMO_WORLD.failedRunId}`
);

/** Hand a follow-up question back into the conversation. */
export const demoAskIntent = demoIntent(
  { kind: "ask", prompt: "Do you want me to watch the retry and tell you when it finishes?" },
  "Asked a follow-up"
);

/** Start a watch. */
export const demoWatchIntent = demoIntent(
  { kind: "watch", spec: demoBacklogDrainWatch.spec },
  `Watching ${DEMO_WORLD.backlogQueue} · checking every 5 min for up to 6h`
);

/**
 * Reserved until write actions ship. Kept so the mockup shows the host rejecting
 * it explicitly rather than silently ignoring it.
 */
export const demoProposeFixIntent = demoIntent(
  { kind: "propose_fix", investigationId: "demo:investigation-order-receipt" },
  "Rejected: proposing a fix isn't available yet"
);

export const demoIntents = {
  navigateToFailedRuns: demoNavigateToFailedRuns,
  navigateToRun: demoNavigateToRun,
  ask: demoAskIntent,
  watch: demoWatchIntent,
  proposeFix: demoProposeFixIntent,
} as const;
