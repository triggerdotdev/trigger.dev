/**
 * Intent fixtures. An intent is a *request* to the host — emitting one is never
 * an action — so each fixture pairs the intent with the sentence the panel shows
 * once the host has honoured it ("Opened runs filtered to failed · last 24h").
 * That sentence is what the design review is judging: the user has to be able to
 * tell, after the fact, what the agent just did to their screen.
 *
 * Nothing here is honoured: the gallery renders the outcome inline instead of
 * navigating.
 */
import { isExecutableIntent, type AgentIntent } from "@internal/dashboard-agent-contracts";
import { DEMO_WORLD, demoRunUri } from "../ids";

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

/** Navigate to the runs list with filters applied — the common navigate case. */
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
  { kind: "ask", prompt: "Do you want me to compare this run against a healthy one?" },
  "Asked a follow-up"
);

/**
 * RESERVED until write actions ship. Kept as a fixture so the mockup shows the
 * host *rejecting* it explicitly rather than silently ignoring it — that
 * rejection is the behaviour we want reviewed now, while it's still cheap.
 */
export const demoProposeFixIntent = demoIntent(
  { kind: "propose_fix", investigationId: "demo:investigation-order-receipt" },
  "Rejected: proposing a fix isn't available yet"
);

export const demoIntents = {
  navigateToFailedRuns: demoNavigateToFailedRuns,
  navigateToRun: demoNavigateToRun,
  ask: demoAskIntent,
  proposeFix: demoProposeFixIntent,
} as const;
