import { isExecutableIntent, type AgentIntent } from "@internal/dashboard-agent-contracts";
import { DEMO_WORLD, demoRunUri, demoRunsUri } from "../ids";
import { demoBacklogDrainWatch } from "./watches";

export type DemoIntent = {
  intent: AgentIntent;
  outcome: string;
  deepLinkLabel?: string;
  executable: boolean;
};

const demoIntent = (intent: AgentIntent, outcome: string, deepLinkLabel?: string): DemoIntent => ({
  intent,
  outcome,
  deepLinkLabel,
  executable: isExecutableIntent(intent),
});

const demoNavigateToFailedRuns = demoIntent(
  {
    kind: "navigate",
    target: demoRunsUri(),
    filters: {
      statuses: ["COMPLETED_WITH_ERROR"],
      period: "24h",
      tasks: [DEMO_WORLD.taskId],
    },
  },
  "Opened runs filtered to failed · last 24h · send-order-receipt",
  "/runs?statuses=COMPLETED_WITH_ERROR&period=24h&tasks=send-order-receipt"
);

const demoNavigateToRun = demoIntent(
  { kind: "navigate", target: demoRunUri(DEMO_WORLD.failedRunId) },
  `Opened ${DEMO_WORLD.failedRunId}`,
  `/runs/${DEMO_WORLD.failedRunId}`
);

const demoAskIntent = demoIntent(
  { kind: "ask", prompt: "Do you want me to watch the retry and tell you when it finishes?" },
  "Asked a follow-up"
);

const demoWatchIntent = demoIntent(
  { kind: "watch", spec: demoBacklogDrainWatch.spec },
  `Watching ${DEMO_WORLD.backlogQueue} · checking every 5 min for up to 6h`
);

const demoProposeFixIntent = demoIntent(
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
