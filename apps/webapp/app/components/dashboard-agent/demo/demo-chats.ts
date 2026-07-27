/**
 * The demo conversation registry — every v1 case as a canned transcript.
 *
 * A `DemoChat` is a script: an ordered list of items the panel replays through
 * the production renderers. Most items are real `UIMessage[]`; the rest are the
 * demo-only cards that stand in for view blocks that don't exist yet
 * (investigation, report) or that would otherwise need the network (chart).
 *
 * Nothing here is persisted, fetched, or sent. `DemoChatView` renders these and
 * intercepts every affordance.
 */
import type { UIMessage } from "@ai-sdk/react";
import type { ReportViewModel } from "~/presenters/v3/reports/report-view-model";
import type { AgentPageContext, SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import type { DashboardAgentChat as DashboardAgentChatListItem } from "../DashboardAgentHistory";
import type { TurnActivity } from "../DashboardAgentMessages";
import { DEMO_WORLD, demoId, demoInvestigationUri, demoReportUri } from "./ids";
import {
  assistantMessage,
  demoChartBlock,
  demoDegradedReport,
  demoDiagnosisBlockFirstPass,
  demoDiagnosisBlockRevised,
  demoHealthyReport,
  demoIntents,
  demoInvestigationConcluded,
  demoInvestigationDirtyCommit,
  demoInvestigationInconclusive,
  demoInvestigationStreamingRev0,
  demoInvestigationStreamingRev1,
  demoLegacyDiagnosisBlock,
  demoPageContexts,
  demoPromptSets,
  demoDismissedPromptIds,
  demoShowCodeMarkdown,
  demoWatchNarration,
  demoWatches,
  failedToolPart,
  pendingToolPart,
  reasoningPart,
  renderViewPart,
  sourceUrlPart,
  streamingTextPart,
  textPart,
  toolPart,
  userMessage,
  type DemoIntent,
  type DemoInvestigation,
  type DemoWatch,
} from "./fixtures";

/** The flows the playbook is organised by. */
export type DemoFlow = "investigate" | "navigation" | "prompts" | "watch" | "reports" | "base";

export type DemoItem =
  /** Real messages, rendered by the production message renderer. */
  | { kind: "messages"; messages: UIMessage[] }
  | { kind: "investigation"; investigation: DemoInvestigation; expanded?: boolean }
  | { kind: "report"; report: ReportViewModel; sourceUri?: string }
  | { kind: "chart"; title?: string }
  | { kind: "intent"; intent: DemoIntent }
  | { kind: "watches"; watches: DemoWatch[] }
  | {
      kind: "prompts";
      prompts: SuggestedPrompt[];
      context?: AgentPageContext;
      dismissedIds?: string[];
    }
  /** A demo-voice aside explaining what the reviewer is looking at. */
  | { kind: "note"; text: string }
  /** A context banner variant, rendered inline so several can be compared. */
  | { kind: "banner"; projectSlug: string; environmentSlug: string; currentPage: string };

export type DemoChat = {
  /** Always `demo:`-prefixed. */
  id: string;
  /** History-list title. */
  title: string;
  flow: DemoFlow;
  /** One line: what the reviewer should be looking at. */
  summary: string;
  items: DemoItem[];
  /**
   * What the turn is doing, or absent when nothing is in flight — the same
   * `activity` prop the production message renderer takes.
   */
  activity?: TurnActivity;
  /** Render the error row, with a retry affordance. */
  error?: string;
  /** Text the composer starts with. */
  draft?: string;
  /** Context banner for this chat. Defaults to the panel's real one. */
  banner?: { projectSlug: string; environmentSlug: string; currentPage: string };
  /** Watch chips shown under the banner, as the panel header would. */
  headerWatches?: DemoWatch[];
  /** Marks the transcript as replayed from the store rather than live. */
  resumed?: boolean;
  lastMessageAt: string;
};

// `currentPage` is the human label the banner shows (see `page-label.ts`), not
// a path segment.
const PROD_BANNER = {
  projectSlug: "demo-storefront",
  environmentSlug: "prod",
  currentPage: "Runs",
};

// ---------------------------------------------------------------------------
// Investigate
// ---------------------------------------------------------------------------

const investigateStreaming: DemoChat = {
  id: demoId("investigate-streaming"),
  title: "Demo · Investigate: card streaming",
  flow: "investigate",
  summary:
    "The investigation card mid-flight: two revisions of the same card, hypotheses marked testing, one settling to validated.",
  banner: { ...PROD_BANNER, currentPage: "Run detail" },
  activity: "working",
  lastMessageAt: "2026-07-27T10:14:11.000Z",
  items: [
    { kind: "messages", messages: [userMessage("inv-q", "Why did this run fail?")] },
    {
      kind: "messages",
      messages: [
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
        ]),
      ],
    },
    { kind: "investigation", investigation: demoInvestigationStreamingRev0 },
    {
      kind: "note",
      text: "Revision 0 above, revision 1 below — the same investigation id. In the live panel the card is replaced in place; here both are shown so the change is visible.",
    },
    { kind: "investigation", investigation: demoInvestigationStreamingRev1 },
  ],
};

const investigateConcluded: DemoChat = {
  id: demoId("investigate-concluded"),
  title: "Demo · Investigate: concluded",
  flow: "investigate",
  summary:
    "The concluded card collapsed: What happened (severity + cause) and How to fix. Expand it for three tested hypotheses, verdict chips, cited evidence and a source excerpt.",
  banner: { ...PROD_BANNER, currentPage: "Run detail" },
  lastMessageAt: "2026-07-27T10:14:24.000Z",
  items: [
    {
      kind: "messages",
      messages: [userMessage("inv-c-q", `Investigate why ${DEMO_WORLD.failedRunId} failed.`)],
    },
    {
      kind: "messages",
      messages: [
        assistantMessage("inv-c-tools", [
          toolPart(
            "query_runs",
            { fingerprint: DEMO_WORLD.errorFingerprint, period: "1h" },
            { matches: 41, tasks: [DEMO_WORLD.taskId] },
            "query-runs"
          ),
          toolPart(
            "read_source",
            { path: DEMO_WORLD.sourcePath, sha: DEMO_WORLD.sourceSha },
            { lines: "14-20", excerpt: "retry: { maxAttempts: 3, minTimeoutInMs: 1_000 }" },
            "read-source"
          ),
        ]),
      ],
    },
    { kind: "investigation", investigation: demoInvestigationConcluded },
    {
      kind: "messages",
      messages: [
        assistantMessage("inv-c-close", [
          textPart(
            "The fix is a config change, not a code fix — I haven't changed anything. Want me to watch the next retry?"
          ),
        ]),
      ],
    },
  ],
};

const investigateInconclusive: DemoChat = {
  id: demoId("investigate-inconclusive"),
  title: "Demo · Investigate: inconclusive",
  flow: "investigate",
  summary:
    "No cause found: What we know + What to check next, and deliberately no fix section. One hypothesis ruled out, one still open.",
  banner: { ...PROD_BANNER, currentPage: "Run detail" },
  lastMessageAt: "2026-07-27T09:41:38.000Z",
  items: [
    {
      kind: "messages",
      messages: [userMessage("inv-i-q", `Why is ${DEMO_WORLD.slowRunId} taking so long?`)],
    },
    { kind: "investigation", investigation: demoInvestigationInconclusive, expanded: true },
    {
      kind: "messages",
      messages: [
        assistantMessage("inv-i-close", [
          textPart(
            "I'd rather say I don't know than guess: the time is inside a span with no children, so there's nothing in the telemetry to attribute it to."
          ),
        ]),
      ],
    },
  ],
};

const investigateShowCode: DemoChat = {
  id: demoId("investigate-show-code"),
  title: "Demo · Investigate: show me the code",
  flow: "investigate",
  summary:
    "Follow-up turn after a conclusion: a fenced diff citing file:line@sha, with an explicit 'I haven't applied anything'.",
  banner: { ...PROD_BANNER, currentPage: "Run detail" },
  lastMessageAt: "2026-07-27T10:16:02.000Z",
  items: [
    { kind: "investigation", investigation: demoInvestigationConcluded },
    { kind: "messages", messages: [userMessage("code-q", "Show me the code change.")] },
    {
      kind: "messages",
      messages: [
        assistantMessage("code-a", [
          toolPart(
            "read_source",
            { path: DEMO_WORLD.sourcePath, sha: DEMO_WORLD.sourceSha, lines: "14-20" },
            { sha: DEMO_WORLD.sourceSha, path: DEMO_WORLD.sourcePath },
            "read-source-again"
          ),
          textPart(demoShowCodeMarkdown),
        ]),
      ],
    },
  ],
};

const investigateDirtyCommit: DemoChat = {
  id: demoId("investigate-dirty-commit"),
  title: "Demo · Investigate: dirty-commit caveat",
  flow: "investigate",
  summary:
    "The same conclusion, hedged: the deploy was built from a dirty working tree, so source citations are the nearest repository snapshot — not the exact deployed code. Confidence drops to medium.",
  banner: { ...PROD_BANNER, currentPage: "Run detail" },
  lastMessageAt: "2026-07-27T10:18:40.000Z",
  items: [
    {
      kind: "messages",
      messages: [userMessage("dirty-q", "Same question, but this deploy wasn't a clean build.")],
    },
    { kind: "investigation", investigation: demoInvestigationDirtyCommit, expanded: true },
  ],
};

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const navigateFilteredRuns: DemoChat = {
  id: demoId("navigate-filtered-runs"),
  title: "Demo · Navigation: opened filtered runs",
  flow: "navigation",
  summary:
    "The agent moved the user's screen and says so: a past-tense navigate bubble plus the deep link it used. Clicking the link is intercepted.",
  banner: PROD_BANNER,
  lastMessageAt: "2026-07-27T10:20:00.000Z",
  items: [
    {
      kind: "messages",
      messages: [
        userMessage(
          "nav-q",
          "Show me everything that failed in the last day for send-order-receipt."
        ),
      ],
    },
    {
      kind: "messages",
      messages: [
        assistantMessage("nav-a", [
          textPart("41 runs failed in the last 24 hours, all with the same rate-limit error."),
        ]),
      ],
    },
    { kind: "intent", intent: demoIntents.navigateToFailedRuns },
    { kind: "chart" },
    {
      kind: "messages",
      messages: [
        assistantMessage("nav-a2", [
          textPart(
            "The spike starts at 09:00 and is confined to `send-order-receipt` — the other tasks are flat."
          ),
        ]),
      ],
    },
  ],
};

const navigateRejectedIntent: DemoChat = {
  id: demoId("navigate-rejected-intent"),
  title: "Demo · Navigation: rejected intent",
  flow: "navigation",
  summary:
    "A reserved `propose_fix` intent is rejected out loud rather than silently ignored. This is the behaviour to review before write actions exist.",
  banner: PROD_BANNER,
  lastMessageAt: "2026-07-27T10:21:00.000Z",
  items: [
    { kind: "messages", messages: [userMessage("fix-q", "Just fix it for me.")] },
    { kind: "intent", intent: demoIntents.proposeFix },
    {
      kind: "messages",
      messages: [
        assistantMessage("fix-a", [
          textPart(
            "I can't change your project — I only read. Here's the change to make, and where to make it."
          ),
        ]),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const promptsPageAware: DemoChat = {
  id: demoId("prompts-page-aware"),
  title: "Demo · Prompts: page-aware chips",
  flow: "prompts",
  summary:
    "The chip row per page kind, with the promoted slot first. The last row shows what a dismissal leaves behind.",
  banner: { ...PROD_BANNER, currentPage: "Run detail" },
  lastMessageAt: "2026-07-27T10:22:00.000Z",
  items: [
    {
      kind: "note",
      text: "Fixture data for the M4 registry: one page context per kind, and the chips a good resolver should produce for it.",
    },
    {
      kind: "prompts",
      prompts: demoPromptSets.failedRun,
      context: demoPageContexts.failedRun,
    },
    {
      kind: "prompts",
      prompts: demoPromptSets.waitingRun,
      context: demoPageContexts.waitingRun,
    },
    { kind: "prompts", prompts: demoPromptSets.slowRun, context: demoPageContexts.slowRun },
    { kind: "prompts", prompts: demoPromptSets.queue, context: demoPageContexts.queue },
    { kind: "note", text: "Same page, after the user dismissed one chip." },
    {
      kind: "prompts",
      prompts: demoPromptSets.failedRun,
      context: demoPageContexts.failedRun,
      dismissedIds: demoDismissedPromptIds,
    },
  ],
};

// ---------------------------------------------------------------------------
// Watch
// ---------------------------------------------------------------------------

const watchCreatedAndWake: DemoChat = {
  id: demoId("watch-created-and-wake"),
  title: "Demo · Watch: created, then woke",
  flow: "watch",
  summary:
    "A watch is created from a conversation, shows as a chip, and later speaks unprompted when it fires.",
  banner: { ...PROD_BANNER, currentPage: "Run detail" },
  headerWatches: demoWatches.activeRow,
  lastMessageAt: "2026-07-27T10:19:30.000Z",
  items: [
    {
      kind: "messages",
      messages: [userMessage("watch-q", "Tell me when the retry finishes.")],
    },
    { kind: "intent", intent: demoIntents.watch },
    { kind: "watches", watches: demoWatches.activeRow },
    {
      kind: "note",
      text: "Everything below arrived on its own, minutes later — no user turn in between.",
    },
    {
      kind: "messages",
      messages: [assistantMessage("watch-wake", [textPart(demoWatchNarration.wake)])],
    },
    { kind: "watches", watches: [demoWatches.errorRecurrence] },
  ],
};

const watchExpiryAndCancel: DemoChat = {
  id: demoId("watch-expiry-and-cancel"),
  title: "Demo · Watch: expiry and cancel",
  flow: "watch",
  summary:
    "Three endings: expired having verified nothing happened, expired unable to verify at all, and cancelled from the chip.",
  banner: { ...PROD_BANNER, currentPage: "Queues" },
  headerWatches: demoWatches.row,
  lastMessageAt: "2026-07-27T15:02:00.000Z",
  items: [
    { kind: "watches", watches: demoWatches.row },
    {
      kind: "messages",
      messages: [assistantMessage("watch-expiry", [textPart(demoWatchNarration.expiry)])],
    },
    {
      kind: "note",
      text: "The variant that matters most: the watch could not check its condition, and says so instead of implying an answer.",
    },
    {
      kind: "messages",
      messages: [
        assistantMessage("watch-expiry-unverified", [
          textPart(demoWatchNarration.expiryUnverified),
        ]),
      ],
    },
    {
      kind: "messages",
      messages: [assistantMessage("watch-cancelled", [textPart(demoWatchNarration.cancelled)])],
    },
  ],
};

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const reportHealthy: DemoChat = {
  id: demoId("report-healthy"),
  title: "Demo · Reports: healthy",
  flow: "reports",
  summary:
    "The health report with nothing wrong: three green statements, collapsed findings, 'nothing to do' footer.",
  banner: { ...PROD_BANNER, currentPage: "Dashboard" },
  lastMessageAt: "2026-07-27T10:15:00.000Z",
  items: [
    { kind: "messages", messages: [userMessage("rep-h-q", "How's prod doing?")] },
    {
      kind: "messages",
      messages: [
        assistantMessage("rep-h-tool", [
          toolPart(
            "get_report",
            { report: "health", period: "1h" },
            { title: "health" },
            "get-report-healthy"
          ),
        ]),
      ],
    },
    {
      kind: "report",
      report: demoHealthyReport,
      sourceUri: demoReportUri(DEMO_WORLD.reportKey),
    },
    {
      kind: "messages",
      messages: [
        assistantMessage("rep-h-close", [
          textPart("Nothing needs you. Starts, failures and durations are all at their normal."),
        ]),
      ],
    },
  ],
};

const reportDegraded: DemoChat = {
  id: demoId("report-degraded"),
  title: "Demo · Reports: degraded",
  flow: "reports",
  summary:
    "Flow stalled at the env concurrency limit while execution stays healthy: causal chain, worst-queue attribution, 'not your code', and a two-entry footer including the do-nothing option.",
  banner: { ...PROD_BANNER, currentPage: "Dashboard" },
  lastMessageAt: "2026-07-27T10:15:00.000Z",
  items: [
    {
      kind: "messages",
      messages: [userMessage("rep-d-q", "Something feels slow. What's going on?")],
    },
    {
      kind: "report",
      report: demoDegradedReport,
      sourceUri: demoReportUri(DEMO_WORLD.reportKey),
    },
    { kind: "chart", title: "Pending runs, last 12h" },
    {
      kind: "messages",
      messages: [
        assistantMessage("rep-d-close", [
          textPart(
            "Your code is fine — you're at the environment's concurrency ceiling and work is queueing behind it. Raising the limit or waiting ~27 minutes both work."
          ),
        ]),
      ],
    },
  ],
};

const docsAnswer: DemoChat = {
  id: demoId("docs-answer"),
  title: "Demo · Reports: docs answer with sources",
  flow: "reports",
  summary:
    "A how-does-it-work question answered from the docs, with source links under the answer and no invented API.",
  banner: PROD_BANNER,
  lastMessageAt: "2026-07-27T10:24:00.000Z",
  items: [
    {
      kind: "messages",
      messages: [userMessage("docs-q", "How do retries actually work? Is the delay exponential?")],
    },
    {
      kind: "messages",
      messages: [
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
  ],
};

// ---------------------------------------------------------------------------
// Base states
// ---------------------------------------------------------------------------

const baseEmpty: DemoChat = {
  id: demoId("base-empty"),
  title: "Demo · Base: empty / first open",
  flow: "base",
  summary: "First open: the production suggested-prompt panel and an empty composer.",
  banner: PROD_BANNER,
  lastMessageAt: "2026-07-27T10:00:00.000Z",
  items: [],
};

const baseStreaming: DemoChat = {
  id: demoId("base-streaming"),
  title: "Demo · Base: streaming",
  flow: "base",
  summary:
    "A partial assistant message (text part still streaming) with the Thinking row underneath.",
  banner: PROD_BANNER,
  activity: "working",
  lastMessageAt: "2026-07-27T10:25:00.000Z",
  items: [
    { kind: "messages", messages: [userMessage("stream-q", "What's failing right now?")] },
    {
      kind: "messages",
      messages: [
        assistantMessage("stream-a", [
          toolPart("query_runs", { period: "1h" }, { failures: 41 }, "query-runs-streaming"),
          streamingTextPart(
            "41 runs failed in the last hour, and they're all `send-order-receipt`. The error is the same every time — a 429 from the email provider, which means"
          ),
        ]),
      ],
    },
  ],
};

const baseToolInFlight: DemoChat = {
  id: demoId("base-tool-in-flight"),
  title: "Demo · Base: tool call in flight",
  flow: "base",
  summary:
    "A tool row mid-call ('calling…') above a finished one. Click either row to expand its input/output.",
  banner: PROD_BANNER,
  activity: "working",
  lastMessageAt: "2026-07-27T10:26:00.000Z",
  items: [
    { kind: "messages", messages: [userMessage("tool-q", "Check the queue depth for me.")] },
    {
      kind: "messages",
      messages: [
        assistantMessage("tool-a", [
          toolPart(
            "run_query",
            { query: "SELECT count() FROM task_runs WHERE status = 'PENDING'" },
            { rows: [{ "count()": 4812 }] },
            "run-query-done"
          ),
          pendingToolPart(
            "get_queue_health",
            { queue: DEMO_WORLD.queue, period: "1h" },
            "get-queue-health-pending"
          ),
        ]),
      ],
    },
  ],
};

const baseErrorRetry: DemoChat = {
  id: demoId("base-error-retry"),
  title: "Demo · Base: error and retry",
  flow: "base",
  summary:
    "A turn that failed: the failed tool row, the error row the panel renders, and a retry affordance.",
  banner: PROD_BANNER,
  error: "The chat stopped unexpectedly. Nothing was saved for this turn.",
  lastMessageAt: "2026-07-27T10:27:00.000Z",
  items: [
    {
      kind: "messages",
      messages: [userMessage("err-q", "Chart failures by task for the last week.")],
    },
    {
      kind: "messages",
      messages: [
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
  ],
};

const baseResumed: DemoChat = {
  id: demoId("base-resumed"),
  title: "Demo · Base: resumed chat",
  flow: "base",
  summary:
    "A transcript replayed from the store, including one pre-envelope block that must still render (and can never be revised).",
  banner: PROD_BANNER,
  resumed: true,
  lastMessageAt: "2026-07-06T14:02:00.000Z",
  items: [
    { kind: "messages", messages: [userMessage("res-q", "Did this happen last month too?")] },
    {
      kind: "messages",
      messages: [
        assistantMessage("res-a", [
          textPart("Yes — same error, same task, three weeks ago."),
          // Two revisions of the same block plus one legacy block with no
          // envelope: the renderer keeps revision 1 and renders the legacy card
          // in transcript order.
          renderViewPart(
            [demoDiagnosisBlockFirstPass, demoDiagnosisBlockRevised, demoLegacyDiagnosisBlock],
            "render-view-resumed"
          ),
        ]),
      ],
    },
    {
      kind: "note",
      text: "The render_view part above carried three blocks: revisions 0 and 1 of one diagnosis (collapsed latest-wins) and one envelope-less block from an older transcript.",
    },
    {
      kind: "messages",
      messages: [
        assistantMessage("res-a2", [
          renderViewPart([demoChartBlock], "render-view-resumed-chart"),
          textPart(
            "The chart block runs live against your current environment, so it may be empty here."
          ),
        ]),
      ],
    },
  ],
};

const baseComposerDraft: DemoChat = {
  id: demoId("base-composer-draft"),
  title: "Demo · Base: composer with a draft",
  flow: "base",
  summary:
    "The composer pre-filled the way `openWith` fills it from a page — the user reads and edits before sending.",
  banner: { ...PROD_BANNER, currentPage: "Run detail" },
  draft: `Investigate why ${DEMO_WORLD.failedRunId} failed and tell me whether it's my code.`,
  lastMessageAt: "2026-07-27T10:28:00.000Z",
  items: [
    {
      kind: "note",
      text: "Sending is intercepted: the composer is live so the layout can be reviewed, but nothing is sent.",
    },
  ],
};

const baseBanners: DemoChat = {
  id: demoId("base-banners"),
  title: "Demo · Base: banner variants",
  flow: "base",
  summary: "The context banner across page kinds, plus the watch chip row that sits under it.",
  banner: PROD_BANNER,
  lastMessageAt: "2026-07-27T10:29:00.000Z",
  items: [
    { kind: "banner", ...PROD_BANNER },
    { kind: "banner", ...PROD_BANNER, currentPage: "Run detail" },
    {
      kind: "banner",
      projectSlug: "demo-storefront",
      environmentSlug: "staging",
      currentPage: "Queue detail",
    },
    {
      kind: "banner",
      projectSlug: "demo-storefront",
      environmentSlug: "preview/demo-branch",
      currentPage: "Deployments",
    },
    { kind: "watches", watches: demoWatches.activeRow },
  ],
};

const baseInvestigationDeepLink: DemoChat = {
  id: demoId("base-investigation-uri"),
  title: "Demo · Base: investigation deep link",
  flow: "base",
  summary:
    "An investigation cited by URI — the shape a shared or resumed investigation link takes.",
  banner: PROD_BANNER,
  lastMessageAt: "2026-07-27T10:30:00.000Z",
  items: [
    {
      kind: "messages",
      messages: [
        assistantMessage("uri-a", [
          textPart(
            `The full investigation is at \`${demoInvestigationUri(demoInvestigationConcluded.investigationId)}\` — that id is stable, so asking me about it again resumes the same card rather than starting over.`
          ),
        ]),
      ],
    },
    { kind: "intent", intent: demoIntents.navigateToRun },
  ],
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const demoChats: DemoChat[] = [
  investigateStreaming,
  investigateConcluded,
  investigateInconclusive,
  investigateShowCode,
  investigateDirtyCommit,
  navigateFilteredRuns,
  navigateRejectedIntent,
  promptsPageAware,
  watchCreatedAndWake,
  watchExpiryAndCancel,
  reportHealthy,
  reportDegraded,
  docsAnswer,
  baseEmpty,
  baseStreaming,
  baseToolInFlight,
  baseErrorRetry,
  baseResumed,
  baseComposerDraft,
  baseBanners,
  baseInvestigationDeepLink,
];

export function demoChatById(id: string): DemoChat | undefined {
  return demoChats.find((chat) => chat.id === id);
}

/**
 * The demo chats as history-list rows, shaped exactly like the real list items
 * so the panel can concatenate them onto its own history with no mapping.
 */
export const demoHistoryChats: DashboardAgentChatListItem[] = demoChats.map((chat) => ({
  id: chat.id,
  title: chat.title,
  lastMessageAt: chat.lastMessageAt,
}));

/** The empty-history state, for the playbook's history case. */
export const demoEmptyHistoryChats: DashboardAgentChatListItem[] = [];
