/**
 * View-block fixtures — typed against the contracts package's own schemas.
 *
 * The enveloped fixtures are typed `EnvelopedViewBlock` (the strict, emit-side
 * type) so the compiler proves the envelope is present and complete. The one
 * legacy fixture is typed `ViewBlock` (the lenient, read-side type) and
 * deliberately carries no envelope, so the mockup also covers the
 * pre-envelope-transcript path the renderer must support forever.
 */
import {
  VIEW_BLOCK_VERSION,
  type EnvelopedChartBlock,
  type EnvelopedDiagnosisBlock,
  type ViewBlock,
} from "@internal/dashboard-agent-contracts";
import { demoId, DEMO_WORLD } from "../ids";

const envelope = (id: string, revision = 0) => ({
  id: demoId(id),
  revision,
  version: VIEW_BLOCK_VERSION,
});

/**
 * The failure card as it lands on the first pass: a plausible cause, medium
 * confidence, thin evidence.
 */
export const demoDiagnosisBlockFirstPass: EnvelopedDiagnosisBlock = {
  ...envelope("diagnosis-order-receipt", 0),
  type: "diagnosis",
  runId: DEMO_WORLD.failedRunId,
  summary: `${DEMO_WORLD.taskId} failed while calling the email provider. The call came back 429 and the run exhausted its 3 retries.`,
  category: "rate_limit",
  likelyCause:
    "The email provider is rate limiting this API key. All three attempts landed inside the same 20-second window, so the retries never had a chance to clear the limit.",
  confidence: "medium",
  evidence: [
    {
      type: "error",
      detail: "ProviderError: 429 Too Many Requests (rate_limit_exceeded)",
      reference: DEMO_WORLD.failedRunId,
    },
    {
      type: "failed_span",
      detail: "sendEmail span failed after 412ms on attempt 3 of 3",
      reference: DEMO_WORLD.failedSpanId,
    },
  ],
  nextSteps: [
    "Spread the retries out: raise the retry delay so attempts don't land in the same rate-limit window.",
    "Cap concurrency on the queue so the task can't burst past the provider's per-second limit.",
  ],
};

/**
 * The same block, re-emitted with better information. Same `id`, higher
 * `revision` — the renderer collapses it latest-wins, which is the behaviour the
 * streaming-card case is there to show.
 */
export const demoDiagnosisBlockRevised: EnvelopedDiagnosisBlock = {
  ...demoDiagnosisBlockFirstPass,
  ...envelope("diagnosis-order-receipt", 1),
  summary: `${DEMO_WORLD.taskId} failed because the email provider rate limited it. 41 runs on this queue hit the same 429 in the last hour — this run isn't special.`,
  confidence: "high",
  impact: `41 runs of ${DEMO_WORLD.taskId} failed the same way in the last hour, all on the ${DEMO_WORLD.queue} queue.`,
  evidence: [
    ...demoDiagnosisBlockFirstPass.evidence,
    {
      type: "historical_match",
      detail: "41 runs failed with the same error fingerprint in the last hour",
      reference: DEMO_WORLD.errorFingerprint,
    },
    {
      type: "source",
      detail: "retry.maxAttempts is 3 with a 1s base delay and no jitter",
      reference: `${DEMO_WORLD.sourcePath}:18`,
    },
  ],
  nextSteps: [
    "Raise the retry delay (or add jitter) so attempts don't all land inside one rate-limit window.",
    `Cap concurrency on ${DEMO_WORLD.queue} to stay under the provider's per-second limit.`,
    "Consider a queue-level rate limit so a backlog can't burst into the provider.",
  ],
  actions: [
    { label: "View run", kind: "view_run", target: DEMO_WORLD.failedRunId },
    {
      label: "Read the retries docs",
      kind: "docs",
      target: "https://trigger.dev/docs/errors-retrying",
    },
  ],
};

/** A chart block, exactly as the agent would emit one. */
export const demoChartBlock: EnvelopedChartBlock = {
  ...envelope("chart-failures-by-task", 0),
  type: "chart",
  title: "Failed runs per hour, by task",
  query:
    "SELECT toStartOfHour(created_at) AS hour, task_identifier, countIf(status = 'COMPLETED_WITH_ERROR') AS failures FROM task_runs GROUP BY hour, task_identifier ORDER BY hour",
  period: "24h",
  chartType: "line",
  xAxisColumn: "hour",
  yAxisColumns: ["failures"],
  groupByColumn: "task_identifier",
  stacked: false,
  aggregation: "sum",
};

/**
 * A block replayed from a transcript written before the envelope existed: no
 * `id`, no `revision`, no `version`. It must still parse and still render, and
 * it can never be revised — that's the frozen rule this fixture pins.
 */
export const demoLegacyDiagnosisBlock: ViewBlock = {
  type: "diagnosis",
  runId: DEMO_WORLD.priorRunId,
  summary:
    "This run failed the same way three weeks ago, before the panel stamped identity onto its cards.",
  category: "rate_limit",
  likelyCause: "The email provider rate limited the same API key.",
  confidence: "medium",
  evidence: [{ type: "error", detail: "ProviderError: 429 Too Many Requests" }],
  nextSteps: ["Nothing to do — kept as a fixture for the pre-envelope render path."],
};

/** Every block fixture, for the schema test and the storybook gallery. */
export const demoViewBlocks = {
  diagnosisFirstPass: demoDiagnosisBlockFirstPass,
  diagnosisRevised: demoDiagnosisBlockRevised,
  chart: demoChartBlock,
  legacyDiagnosis: demoLegacyDiagnosisBlock,
} as const;
