import type { UIMessage } from "@ai-sdk/react";
import {
  VIEW_BLOCK_VERSION,
  type InvestigationBlock,
  type InvestigationCapabilities,
} from "@internal/dashboard-agent-contracts";
import { DEMO_WORLD, demoFixtures } from "~/components/dashboard-agent/demo";
import type { TurnActivity } from "~/components/dashboard-agent/DashboardAgentMessages";

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
