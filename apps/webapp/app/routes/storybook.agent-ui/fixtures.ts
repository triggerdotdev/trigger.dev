import type { UIMessage } from "@ai-sdk/react";
import {
  VIEW_BLOCK_VERSION,
  type DiagnosisBlock,
  type InvestigationBlock,
  type InvestigationCapabilities,
  type ReportViewModelPayload,
  type ViewBlock,
  type WatchResultBlock as WatchResultBlockPayload,
} from "@internal/dashboard-agent-contracts";
import * as demoFixtures from "~/components/dashboard-agent/demo/fixtures";
import { DEMO_WORLD, demoId, demoRunsUri } from "~/components/dashboard-agent/demo/ids";
import type { TurnActivity } from "~/components/dashboard-agent/DashboardAgentMessages";
import { watchConfirmationBlockBody, watchOneShotBlockBody } from "~/presenters/v3/dashboardAgent";
import {
  queueWatchRecommendation,
  runWatchRecommendation,
} from "~/components/dashboard-agent/watch-recommendations";

export function investigationBlock(
  fixture: (typeof demoFixtures.demoInvestigations)[keyof typeof demoFixtures.demoInvestigations],
  capabilities?: InvestigationCapabilities
): InvestigationBlock {
  const { investigationId, revision, ...investigation } = fixture;
  return {
    type: "investigation",
    id: investigationId,
    revision,
    version: VIEW_BLOCK_VERSION,
    investigation,
    ...(capabilities ? { capabilities } : {}),
  };
}

const {
  assistantMessage,
  demoDiagnosisBlockFirstPass,
  demoDiagnosisBlockRevised,
  demoLegacyDiagnosisBlock,
  failedToolPart,
  pendingToolPart,
  reasoningPart,
  renderViewPart,
  sourceUrlPart,
  streamingTextPart,
  textPart,
  toolPart,
  userMessage,
} = demoFixtures;

const DEMO_WATCH_ID = demoId("watch_gallery");

// A stored error_recurrence spec holds the internal id, so the demo one drops its prefix.
const DEMO_FINGERPRINT = DEMO_WORLD.errorFingerprint.replace(/^error_/, "");

/** One transcript the message gallery renders, with the turn state it belongs to. */
export type DemoTranscript = {
  messages: UIMessage[];
  activity?: TurnActivity;
  /** The turn's failure. Only the section that asks for it renders one. */
  error?: string;
};

export const demoTranscripts = {
  streamingText: {
    activity: "working",
    messages: [
      userMessage("stream-q", "What's failing right now?"),
      assistantMessage("stream-a", [
        toolPart("query_runs", { period: "1h" }, { failures: 41 }, "query-runs-streaming"),
        streamingTextPart(
          "41 runs failed in the last hour, and they're all `send-order-receipt`. The error is the same every time — a 429 from the email provider, which means"
        ),
      ]),
    ],
  },

  reasoning: {
    activity: "working",
    messages: [
      userMessage("inv-q", "Why did this run fail?"),
      assistantMessage("inv-step1", [
        reasoningPart(
          "Start from the run itself: status, attempts, and which span failed. Don't guess at a cause before reading the error."
        ),
        toolPart(
          "get_run_details",
          { runId: DEMO_WORLD.failedRunId },
          {
            runId: DEMO_WORLD.failedRunId,
            status: "COMPLETED_WITH_ERROR",
            attempts: 3,
            error: "ProviderError: 429 Too Many Requests",
          },
          "get-run-details"
        ),
        textPart(
          `\`${DEMO_WORLD.failedRunId}\` failed three times in 19 seconds, every attempt with the same error from the email provider. Three things could produce that, so I'll test them one at a time rather than settle on the first plausible one.`
        ),
      ]),
    ],
  },

  toolInFlight: {
    activity: "working",
    messages: [
      userMessage("tool-q", "Check the queue depth for me."),
      assistantMessage("tool-intro", [
        textPart(
          `Counting what's pending across the environment first, then pulling \`${DEMO_WORLD.queue}\` on its own so we can see whether the depth is one queue or all of them.`
        ),
      ]),
      assistantMessage("tool-a", [
        toolPart(
          "run_query",
          { query: "SELECT count() FROM task_runs WHERE status = 'PENDING'" },
          { rows: [{ "count()": 4812 }] },
          "run-query-done"
        ),
        pendingToolPart(
          "get_queue",
          { queue: DEMO_WORLD.queue, period: "1h" },
          "get-queue-pending"
        ),
      ]),
    ],
  },

  errorRetry: {
    error: "The chat stopped unexpectedly. Nothing was saved for this turn.",
    messages: [
      userMessage("err-q", "Chart failures by task for the last week."),
      assistantMessage("err-a", [
        failedToolPart(
          "run_query",
          { query: "SELECT task_identifier, count() FROM task_runs", period: "7d" },
          "query timed out after 30s",
          "run-query-failed"
        ),
      ]),
    ],
  },

  // Cut before the follow-up turn: this section is about the one `render_view` part,
  // which carries two revisions of a diagnosis plus an envelope-less legacy block.
  renderView: {
    messages: [
      userMessage("res-q", "Did this happen last month too?"),
      assistantMessage("res-a", [
        textPart(
          `Yes — same error, same task, three weeks ago. \`${DEMO_WORLD.taskId}\` hit the same rate limit on 6 July and it was diagnosed then too; the card below is that diagnosis, replayed from this conversation rather than re-run. The retry config hasn't changed since, which is why it came back.`
        ),
        renderViewPart(
          [demoDiagnosisBlockFirstPass, demoDiagnosisBlockRevised, demoLegacyDiagnosisBlock],
          "render-view-resumed"
        ),
      ]),
    ],
  },

  docsSources: {
    messages: [
      userMessage("docs-q", "How do retries actually work? Is the delay exponential?"),
      assistantMessage("docs-a", [
        toolPart(
          "search_docs",
          { query: "retry configuration exponential backoff" },
          { hits: 3 },
          "search-docs"
        ),
        textPart(
          `Yes — retries back off exponentially by default.

- \`maxAttempts\` counts the *first* attempt, so \`3\` means one try plus two retries.
- The delay is \`minTimeoutInMs * factor^(attempt - 1)\`, capped at \`maxTimeoutInMs\`.
- \`randomize: true\` adds jitter, which is what stops a whole batch retrying in lockstep — the thing that bit \`${DEMO_WORLD.taskId}\` above.`
        ),
        sourceUrlPart("https://trigger.dev/docs/errors-retrying", "Errors & retrying"),
        sourceUrlPart("https://trigger.dev/docs/tasks/overview", "Task options"),
      ]),
    ],
  },
} satisfies Record<string, DemoTranscript>;

/* ------------------------------------------------------------------ *
 * View blocks
 * ------------------------------------------------------------------ */

export const fullDiagnosis: DiagnosisBlock = {
  type: "diagnosis",
  runId: DEMO_WORLD.failedRunId,
  summary:
    "The run failed because processOrder threw on an order with no line items. The payload had an empty items array.",
  category: "user_code_error",
  likelyCause:
    "processOrder calls order.items[0] without checking length, so an empty items array throws a TypeError before any work happens.",
  confidence: "high",
  evidence: [
    {
      type: "error",
      detail: "TypeError: Cannot read properties of undefined (reading 'sku')",
      reference: DEMO_WORLD.failedRunId,
    },
    { type: "failed_span", detail: "processOrder attempt 1 failed after 42ms" },
    {
      type: "source",
      detail: "The throwing line reads order.items[0].sku with no guard.",
      reference: "src/trigger/processOrder.ts:18",
    },
    {
      type: "historical_match",
      detail: "14 runs of this task hit the same error in the last 24h.",
      reference: DEMO_WORLD.errorFingerprint,
    },
  ],
  impact:
    "14 runs of process-order failed with this error in the last 24 hours, all in production.",
  nextSteps: [
    "Guard against an empty items array at the top of processOrder and return early.",
    "Validate the payload before triggering so empty orders never reach the task.",
  ],
  actions: [
    { label: "View run", kind: "view_run", target: DEMO_WORLD.failedRunId },
    { label: "Retries docs", kind: "docs", target: "https://trigger.dev/docs/errors-retrying" },
  ],
};

export const externalServiceDiagnosis: DiagnosisBlock = {
  type: "diagnosis",
  runId: DEMO_WORLD.slowRunId,
  summary: "chargePayment timed out waiting on the Stripe API after 30 seconds.",
  category: "external_service",
  likelyCause:
    "The Stripe call has no timeout or retry, so a slow upstream response runs past the task's max duration.",
  confidence: "medium",
  evidence: [
    {
      type: "error",
      detail: "TimeoutError: Stripe API timed out after 30s",
      reference: DEMO_WORLD.slowRunId,
    },
    { type: "deploy", detail: "First seen on version 20260620.2", reference: "20260620.2" },
  ],
  impact: "Intermittent: 3 of the last 50 charge-payment runs timed out.",
  nextSteps: [
    "Wrap the Stripe call in a retry with backoff.",
    "Set an explicit request timeout shorter than the task's max duration.",
  ],
  actions: [{ label: "View run", kind: "view_run", target: DEMO_WORLD.slowRunId }],
};

export const lowConfidenceDiagnosis: DiagnosisBlock = {
  type: "diagnosis",
  runId: DEMO_WORLD.priorRunId,
  summary:
    "The run crashed without a captured error, so the cause isn't conclusive from the available signals.",
  category: "unknown",
  likelyCause:
    "The container exited without writing an error. This is consistent with an out-of-memory kill, but there's no OOM signal in the trace to confirm it.",
  confidence: "low",
  evidence: [
    { type: "failed_span", detail: "Root span ended with status CRASHED and no error payload." },
    { type: "logs", detail: "Logs stop abruptly mid-execution with no stack trace." },
  ],
  nextSteps: [
    "Re-run with a larger machine to rule out out-of-memory.",
    "Add logging around the last successful step to narrow where it stops.",
  ],
};

export const revisedDiagnosisBlocks: ViewBlock[] = [
  {
    ...lowConfidenceDiagnosis,
    id: `diagnosis-${DEMO_WORLD.failedRunId}`,
    revision: 1,
    version: VIEW_BLOCK_VERSION,
    summary: "Revision 1 — first guess, before the logs came back. Should not render.",
  },
  {
    ...externalServiceDiagnosis,
    id: `diagnosis-${DEMO_WORLD.failedRunId}`,
    revision: 2,
    version: VIEW_BLOCK_VERSION,
    summary: "Revision 2 — narrowed to the payload, still unconfirmed. Should not render.",
  },
  {
    ...fullDiagnosis,
    id: `diagnosis-${DEMO_WORLD.failedRunId}`,
    revision: 3,
    version: VIEW_BLOCK_VERSION,
    summary:
      "Revision 3 — the only card that should render: processOrder threw on an order with no line items.",
  },
];

export const offerActionsBlock: ViewBlock = {
  type: "actions",
  id: "actions-offer",
  revision: 0,
  version: VIEW_BLOCK_VERSION,
  actions: [
    {
      label: "Set up a watch",
      intent: {
        kind: "watch",
        spec: {
          kind: "error_recurrence",
          fingerprint: DEMO_FINGERPRINT,
          checkEveryMinutes: 15,
          maxHours: 6,
          note: "the TypeError in send-order-receipt",
        },
      },
    },
    {
      label: "See its failed runs",
      intent: { kind: "navigate", target: demoRunsUri() },
    },
  ],
};

/* ------------------------------------------------------------------ *
 * Watch result blocks
 * ------------------------------------------------------------------ */

const WATCH_BLOCK_ENVELOPE = {
  id: `watch:${DEMO_WATCH_ID}`,
  revision: 0,
  version: VIEW_BLOCK_VERSION,
} as const;

/** Both opt-ins took effect: the happy path a submit with `notifyExternally` produces. */
export const watchConfirmationBlock: WatchResultBlockPayload = {
  ...watchConfirmationBlockBody({
    spec: queueWatchRecommendation(DEMO_WORLD.queue),
    watchId: DEMO_WATCH_ID,
    followUp: { investigateOnAttention: true, external: { status: "enabled" } },
  }),
  ...WATCH_BLOCK_ENVELOPE,
};

/**
 * The same submit, degraded: the creation-time check couldn't run and the email
 * subscription failed. Neither fails the watch — both are said out loud instead.
 */
export const watchDegradedConfirmationBlock: WatchResultBlockPayload = {
  ...watchConfirmationBlockBody({
    spec: queueWatchRecommendation(DEMO_WORLD.queue),
    watchId: DEMO_WATCH_ID,
    unavailable: true,
    followUp: {
      investigateOnAttention: true,
      external: { status: "unavailable", reason: "email_alerts_not_configured" },
    },
  }),
  ...WATCH_BLOCK_ENVELOPE,
};

export const watchSatisfiedBlock: WatchResultBlockPayload = {
  ...watchOneShotBlockBody({
    spec: runWatchRecommendation(DEMO_WORLD.failedRunId),
    result: "satisfied",
  }),
  ...WATCH_BLOCK_ENVELOPE,
};

/* ------------------------------------------------------------------ *
 * Reports
 * ------------------------------------------------------------------ */

/** Every number is informational: the verdict stands but the card must say why. */
export const untrustworthyReport: ReportViewModelPayload = {
  ...demoFixtures.demoDegradedReport,
  summary: {
    severity: "crit",
    statements: [
      { findingType: "flow", severity: "crit", reason: "unknown" },
      { findingType: "execution", severity: "crit", reason: "unknown" },
      { findingType: "liveness", severity: "crit" },
    ],
  },
  findings: demoFixtures.demoDegradedReport.findings.map((finding) =>
    finding.type === "liveness"
      ? {
          ...finding,
          severity: "crit",
          reason: "stale",
          recommendation: { code: "check_control_plane", link: "status" },
        }
      : {
          ...finding,
          severity: "crit",
          reason: "unknown",
          recommendation: undefined,
          attribution: undefined,
          exclusions: undefined,
          observations: undefined,
          hedge: undefined,
          anomalyWindow: undefined,
        }
  ),
  metrics: demoFixtures.demoDegradedReport.metrics.map((metric) =>
    metric.id === "liveness"
      ? { ...metric, value: 21 * 60_000, severity: "crit" }
      : { ...metric, annotation: undefined }
  ),
  facts: { trustworthy: false, untrustworthyReason: "telemetry_stale" },
  links: [{ key: "status", label: "status.trigger.dev", url: "https://status.trigger.dev" }],
  footer: [{ code: "check_control_plane", link: "status" }],
};
