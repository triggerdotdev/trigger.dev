// Inputs shared with `resolver.test.ts`.
import type {
  AgentPageContext,
  AgentPageSignal,
  SuggestedPrompt,
} from "@internal/dashboard-agent-contracts";
import { SUGGESTED_PROMPT_CAP } from "@internal/dashboard-agent-contracts";
import { DEMO_WORLD, demoId } from "../ids";

export const demoFreshFailureSignal: AgentPageSignal = {
  kind: "fresh_failure",
  runId: DEMO_WORLD.failedRunId,
  failedAt: "2026-07-27T10:13:41.000Z",
};

const demoWaitingRunSignal: AgentPageSignal = {
  kind: "waiting_run",
  runId: DEMO_WORLD.waitingRunId,
  queue: DEMO_WORLD.queue,
};

const demoSlowRunSignal: AgentPageSignal = {
  kind: "slow_run",
  runId: DEMO_WORLD.slowRunId,
  durationMs: 1_421_000,
  baselineP95Ms: 183_000,
};

const demoConcurrencySaturationSignal: AgentPageSignal = {
  kind: "concurrency_saturation",
  severity: "crit",
};

// Priority order. `SIGNAL_PRIORITY` in the registry mirrors this.
export const demoSignalsByPriority: AgentPageSignal[] = [
  demoFreshFailureSignal,
  demoWaitingRunSignal,
  demoSlowRunSignal,
  demoConcurrencySaturationSignal,
];

export const demoFailedRunPageContext: AgentPageContext = {
  page: {
    kind: "run",
    runId: DEMO_WORLD.failedRunId,
    status: "Failed",
    taskId: DEMO_WORLD.taskId,
    queue: DEMO_WORLD.queue,
  },
  signals: [demoFreshFailureSignal],
};

const demoWaitingRunPageContext: AgentPageContext = {
  page: {
    kind: "run",
    runId: DEMO_WORLD.waitingRunId,
    status: "Queued",
    taskId: DEMO_WORLD.taskId,
    queue: DEMO_WORLD.queue,
  },
  signals: [demoWaitingRunSignal, demoConcurrencySaturationSignal],
};

const demoSlowRunPageContext: AgentPageContext = {
  page: {
    kind: "run",
    runId: DEMO_WORLD.slowRunId,
    status: "Executing",
    taskId: DEMO_WORLD.slowTaskId,
  },
  signals: [demoSlowRunSignal],
};

const demoRunsPageContext: AgentPageContext = {
  page: { kind: "runs", filters: { statuses: ["COMPLETED_WITH_ERROR"], period: "24h" } },
  signals: [demoFreshFailureSignal],
};

const demoErrorPageContext: AgentPageContext = {
  page: { kind: "error", fingerprint: DEMO_WORLD.errorFingerprint },
  signals: [demoFreshFailureSignal],
};

const demoQueuePageContext: AgentPageContext = {
  page: { kind: "queue", name: DEMO_WORLD.queue, health: "crit" },
  signals: [demoConcurrencySaturationSignal, demoWaitingRunSignal],
};

const demoDeploymentPageContext: AgentPageContext = {
  page: { kind: "deployment", version: DEMO_WORLD.deploymentVersion },
  signals: [],
};

const demoOtherPageContext: AgentPageContext = {
  page: { kind: "other", path: "/orgs/demo/projects/demo/env/prod/settings" },
  signals: [],
};

export const demoPageContexts = {
  failedRun: demoFailedRunPageContext,
  waitingRun: demoWaitingRunPageContext,
  slowRun: demoSlowRunPageContext,
  runs: demoRunsPageContext,
  error: demoErrorPageContext,
  queue: demoQueuePageContext,
  deployment: demoDeploymentPageContext,
  other: demoOtherPageContext,
} as const;

export type DemoPageContextKey = keyof typeof demoPageContexts;

const prompt = (
  id: string,
  label: string,
  promptText: string,
  source: SuggestedPrompt["source"]
): SuggestedPrompt => ({ id: demoId(`prompt-${id}`), label, prompt: promptText, source });

const DEFAULT_PROMPTS: SuggestedPrompt[] = [
  prompt("what-can-you-do", "What can you help me with?", "What can you help me with?", "default"),
  prompt("retries", "How do retries work?", "How do retries work in Trigger.dev?", "default"),
  prompt(
    "health",
    "How's my environment?",
    "Give me a health report for this environment.",
    "default"
  ),
];

export const demoPromptSets: Record<DemoPageContextKey, SuggestedPrompt[]> = {
  failedRun: [
    prompt(
      "investigate-failure",
      "Why did this run fail?",
      `Investigate why ${DEMO_WORLD.failedRunId} failed.`,
      "promoted"
    ),
    prompt(
      "same-error",
      "Is this happening to other runs?",
      "How many other runs failed with this error in the last hour?",
      "contextual"
    ),
    prompt(
      "watch-retry",
      "Tell me when it retries",
      `Watch ${DEMO_WORLD.failedRunId} and tell me when it finishes.`,
      "contextual"
    ),
    DEFAULT_PROMPTS[1]!,
  ],
  waitingRun: [
    prompt(
      "why-waiting",
      "Why hasn't this started?",
      `Why is ${DEMO_WORLD.waitingRunId} still queued?`,
      "promoted"
    ),
    prompt(
      "backlog-drain",
      "When will the backlog clear?",
      `When will the ${DEMO_WORLD.queue} backlog drain?`,
      "contextual"
    ),
    DEFAULT_PROMPTS[2]!,
  ],
  slowRun: [
    prompt(
      "why-slow",
      "Why is this run slow?",
      `Why is ${DEMO_WORLD.slowRunId} taking so long?`,
      "promoted"
    ),
    prompt(
      "compare-baseline",
      "Compare to a normal run",
      `How does ${DEMO_WORLD.slowRunId} compare to a normal run of this task?`,
      "contextual"
    ),
    DEFAULT_PROMPTS[0]!,
  ],
  runs: [
    prompt(
      "failure-pattern",
      "What's failing most?",
      "Which tasks are failing most in the last 24 hours?",
      "promoted"
    ),
    prompt(
      "chart-failures",
      "Chart the failures",
      "Chart failed runs per hour by task over the last 24 hours.",
      "contextual"
    ),
    DEFAULT_PROMPTS[2]!,
  ],
  error: [
    prompt(
      "explain-error",
      "Explain this error",
      "Explain this error and what usually causes it.",
      "promoted"
    ),
    prompt(
      "watch-recurrence",
      "Tell me if it comes back",
      "Watch this error and tell me if it happens again.",
      "contextual"
    ),
    DEFAULT_PROMPTS[1]!,
  ],
  queue: [
    prompt(
      "why-saturated",
      "Why is this queue backed up?",
      `Why is ${DEMO_WORLD.queue} backed up?`,
      "promoted"
    ),
    prompt(
      "raise-limit",
      "Should I raise the limit?",
      "Should I raise the concurrency limit on this queue?",
      "contextual"
    ),
    DEFAULT_PROMPTS[2]!,
  ],
  deployment: [
    prompt(
      "deploy-diff",
      "What changed in this deploy?",
      "What changed in this deployment?",
      "contextual"
    ),
    ...DEFAULT_PROMPTS.slice(0, 2),
  ],
  other: DEFAULT_PROMPTS,
};

export const demoDismissedPromptIds: string[] = [demoId("prompt-watch-retry")];

/**
 * Ids the resolver itself emits, for dismissing against a live resolve. Dismissing the
 * fresh-failure chip on `demoFailedRunPageContext` falls back to `sp:run-investigate`.
 */
export const demoResolvedDismissedPromptIds: string[] = ["sp:fresh-failure"];

export const demoPromptsAfterDismissal: SuggestedPrompt[] = demoPromptSets.failedRun
  .filter((p) => !demoDismissedPromptIds.includes(p.id))
  .slice(0, SUGGESTED_PROMPT_CAP);


