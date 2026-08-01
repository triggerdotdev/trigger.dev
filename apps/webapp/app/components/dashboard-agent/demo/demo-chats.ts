/**
 * The demo conversation registry — every v1 case as a canned transcript.
 *
 * A `DemoChat` is a script: an ordered list of items rendered through the
 * production renderers. Most items are real `UIMessage[]`; the rest are the
 * demo-only cards that stand in for view blocks that don't exist yet
 * (investigation, report) or that would otherwise need the network (chart).
 *
 * Nothing here is persisted, fetched, or sent. The state gallery
 * (`/storybook/agent-ui`) is the only consumer; the panel shows real chats.
 *
 * One rule for every case: a demo chat is one coherent story, as close to a real
 * conversation as fixtures allow. Variation matrices — the same card in four
 * states, a banner across four page kinds — belong to the state gallery, never to
 * a chat, where stacked variants read as a bug.
 */
import type { UIMessage } from "@ai-sdk/react";
import type { ReportViewModel } from "~/presenters/v3/reports/report-view-model";
import type { AgentPageContext, SuggestedPrompt } from "@internal/dashboard-agent-contracts";
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
  demoShowCodeMarkdown,
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
} from "./fixtures";

/** The flows the playbook is organised by. */
export type DemoFlow = "investigate" | "navigation" | "prompts" | "reports" | "base";

export type DemoItem =
  /** Real messages, rendered by the production message renderer. */
  | { kind: "messages"; messages: UIMessage[] }
  | { kind: "investigation"; investigation: DemoInvestigation; expanded?: boolean }
  | { kind: "report"; report: ReportViewModel; sourceUri?: string }
  | { kind: "chart"; title?: string }
  | { kind: "intent"; intent: DemoIntent }
  | {
      kind: "prompts";
      prompts: SuggestedPrompt[];
      context?: AgentPageContext;
      dismissedIds?: string[];
    }
  /** A demo-voice aside explaining what the reviewer is looking at. */
  | { kind: "note"; text: string }
  /**
   * A context banner rendered inline, full-bleed. No chat uses it now: a chat
   * gets one banner — its own, at the top — and comparing banner variants is the
   * gallery's job. Kept for a case that needs a banner mid-transcript.
   */
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
  title: "Why did this run fail?",
  flow: "investigate",
  summary:
    "The investigation card mid-flight: two revisions of the same card, three hypotheses posed and testing, then one validated, one ruled out and one still open — with the narration in between.",
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
          textPart(
            `\`${DEMO_WORLD.failedRunId}\` failed three times in 19 seconds, every attempt with the same error from the email provider. Three things could produce that, so I'll test them one at a time rather than settle on the first plausible one.`
          ),
        ]),
      ],
    },
    { kind: "investigation", investigation: demoInvestigationStreamingRev0, expanded: true },
    {
      kind: "note",
      text: "Revision 0 above, revision 1 below — the same investigation id. In the live panel the card is replaced in place; here both are shown so the change is visible.",
    },
    {
      kind: "messages",
      messages: [
        assistantMessage("inv-step2", [
          toolPart(
            "query_runs",
            { taskIdentifier: DEMO_WORLD.taskId, status: "failed", period: "1h" },
            { matches: 41, fingerprints: { [DEMO_WORLD.errorFingerprint]: 41 } },
            "query-runs-streaming-rev1"
          ),
          textPart(
            `The rate limit is confirmed and the payload is ruled out — 41 runs in the last hour share one error fingerprint, while the same payload shape succeeded 2,104 times earlier today. Still open: whether \`${DEMO_WORLD.queue}\` is bursting into the provider faster than it allows.`
          ),
        ]),
      ],
    },
    { kind: "investigation", investigation: demoInvestigationStreamingRev1, expanded: true },
  ],
};

const investigateConcluded: DemoChat = {
  id: demoId("investigate-concluded"),
  title: "send-order-receipt failure",
  flow: "investigate",
  summary:
    "A full post-incident turn: four tools, the conclusion narrated, the card open on four tested hypotheses with verdict chips and cited evidence, then a follow-up about whether the failed runs retry themselves.",
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
          reasoningPart(
            "Four candidates: the provider's rate limit, a bad payload, the retry schedule, and yesterday's deploy. Each one has a check that can rule it out, so run all four before writing a conclusion."
          ),
          toolPart(
            "query_runs",
            { fingerprint: DEMO_WORLD.errorFingerprint, period: "1h" },
            { matches: 41, tasks: [DEMO_WORLD.taskId], firstSeen: "09:02", lastSeen: "10:11" },
            "query-runs"
          ),
          toolPart(
            "get_queue_health",
            { queue: DEMO_WORLD.queue, period: "1h" },
            { concurrency: 50, limit: 50, pinnedMinutes: 38, pending: 4_812 },
            "get-queue-health-concluded"
          ),
          toolPart(
            "list_deploys",
            { period: "48h" },
            { latest: DEMO_WORLD.deploymentVersion, deployedAt: "2026-07-26T14:11:00.000Z" },
            "list-deploys-concluded"
          ),
          toolPart(
            "read_source",
            { path: DEMO_WORLD.sourcePath, sha: DEMO_WORLD.sourceSha },
            { lines: "14-20", excerpt: "retry: { maxAttempts: 3, minTimeoutInMs: 1_000 }" },
            "read-source"
          ),
          textPart(
            `Two of the four hold up. The provider is rate limiting this key, and the retry config puts all three attempts inside the same limit window — so a run that hits the limit once is guaranteed to fail. The payload and yesterday's deploy are both ruled out.`
          ),
        ]),
      ],
    },
    { kind: "investigation", investigation: demoInvestigationConcluded, expanded: true },
    {
      kind: "messages",
      messages: [
        assistantMessage("inv-c-close", [
          textPart(
            `The fix is a config change, not a code fix — I haven't changed anything. Raising \`minTimeoutInMs\` to 30s with a factor of 2 spreads the three attempts across ~2 minutes, and capping \`${DEMO_WORLD.queue}\` at 20 stops the burst that trips the limit in the first place. The queue cap you can set from the dashboard without a deploy.`
          ),
        ]),
      ],
    },
    {
      kind: "messages",
      messages: [
        userMessage("inv-c-followup", "Do the 41 failed runs retry on their own once I fix this?"),
      ],
    },
    {
      kind: "messages",
      messages: [
        assistantMessage("inv-c-followup-a", [
          toolPart(
            "query_runs",
            { fingerprint: DEMO_WORLD.errorFingerprint, period: "1h", status: "failed" },
            { matches: 41, retriesRemaining: 0, oldest: DEMO_WORLD.priorRunId },
            "query-runs-followup"
          ),
          textPart(
            `No — all 41 used their three attempts, so they're final. They'll need re-triggering after the config change; the oldest is \`${DEMO_WORLD.priorRunId}\`, from 09:02. Fix the retry config first, otherwise a bulk replay will hit the same limit and burn its attempts the same way.`
          ),
        ]),
      ],
    },
  ],
};

const investigateInconclusive: DemoChat = {
  id: demoId("investigate-inconclusive"),
  title: "Intermittent upstream timeouts",
  flow: "investigate",
  summary:
    "No cause found: What we know + What to check next, and deliberately no fix section. Two hypotheses ruled out with numbers, one still open, and a follow-up that refuses to advise on cancelling.",
  banner: { ...PROD_BANNER, currentPage: "Run detail" },
  lastMessageAt: "2026-07-27T09:41:38.000Z",
  items: [
    {
      kind: "messages",
      messages: [userMessage("inv-i-q", `Why is ${DEMO_WORLD.slowRunId} taking so long?`)],
    },
    {
      kind: "messages",
      messages: [
        assistantMessage("inv-i-tools", [
          toolPart(
            "get_run_details",
            { runId: DEMO_WORLD.slowRunId },
            {
              runId: DEMO_WORLD.slowRunId,
              status: "EXECUTING",
              attempt: 1,
              durationMs: 1_452_000,
              machine: "large-1x",
            },
            "get-run-details-slow"
          ),
          toolPart(
            "get_span_details",
            { runId: DEMO_WORLD.slowRunId, spanId: "span_demoe71f" },
            { name: "aggregate", durationMs: 1_421_000, children: 0, events: 0 },
            "get-span-details-slow"
          ),
          textPart(
            `\`${DEMO_WORLD.slowTaskId}\` has been executing for 24 minutes against a p95 of 3 minutes, and 23m41s of that sits inside a single \`aggregate\` span with no children and no events. I checked memory and queue wait to rule out the two usual suspects, but I can't see inside that span.`
          ),
        ]),
      ],
    },
    { kind: "investigation", investigation: demoInvestigationInconclusive, expanded: true },
    {
      kind: "messages",
      messages: [
        assistantMessage("inv-i-close", [
          textPart(
            "I'd rather say I don't know than guess: the time is inside a span with no children, so there's nothing in the telemetry to attribute it to. Memory peaked at 38% and the run was dequeued 40ms after it was triggered, so it isn't starved and it isn't waiting — it's genuinely working, somewhere I can't see."
          ),
        ]),
      ],
    },
    {
      kind: "messages",
      messages: [userMessage("inv-i-followup", "Should I kill it?")],
    },
    {
      kind: "messages",
      messages: [
        assistantMessage("inv-i-followup-a", [
          textPart(
            `Your call — I can't cancel runs. It's 8x its normal duration but still holding one of the 20 concurrency slots on \`${DEMO_WORLD.backlogQueue}\`, and nothing else is queued behind it, so letting it run costs you little. If you do cancel it, add a span around the aggregation step first, otherwise the next run tells you exactly as little as this one.`
          ),
        ]),
      ],
    },
  ],
};

const investigateShowCode: DemoChat = {
  id: demoId("investigate-show-code"),
  title: "Show me the failing code",
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
    {
      kind: "messages",
      messages: [
        assistantMessage("code-a2", [
          textPart(
            `This half needs a deploy. The other half — capping \`${DEMO_WORLD.queue}\` at 20 concurrency — is a dashboard setting, and it's the one that stops the burst, so it's worth doing first even if the deploy waits for your next release.`
          ),
        ]),
      ],
    },
  ],
};

const investigateDirtyCommit: DemoChat = {
  id: demoId("investigate-dirty-commit"),
  title: "Failure after yesterday's deploy",
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
    {
      kind: "messages",
      messages: [
        assistantMessage("dirty-tools", [
          toolPart(
            "list_deploys",
            { version: DEMO_WORLD.deploymentVersion },
            {
              version: DEMO_WORLD.deploymentVersion,
              gitSha: DEMO_WORLD.sourceSha,
              dirty: true,
              uncommittedFiles: 3,
            },
            "list-deploys-dirty"
          ),
          textPart(
            `\`${DEMO_WORLD.deploymentVersion}\` was built from a working tree with 3 uncommitted files, so \`${DEMO_WORLD.sourcePath}\` as I can read it is the nearest snapshot — not provably the code that ran. The conclusion is the same, but I'm dropping confidence to medium and saying which parts of the evidence that affects.`
          ),
        ]),
      ],
    },
    { kind: "investigation", investigation: demoInvestigationDirtyCommit, expanded: true },
    {
      kind: "messages",
      messages: [
        assistantMessage("dirty-close", [
          textPart(
            "The run, span and error evidence comes from telemetry, so it stands regardless. Only the retry-config citation is hedged — if you deploy from a clean tree I can confirm that line exactly rather than approximately."
          ),
        ]),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const navigateFilteredRuns: DemoChat = {
  id: demoId("navigate-filtered-runs"),
  title: "Failed runs in the last 24h",
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
          toolPart(
            "query_runs",
            { taskIdentifier: DEMO_WORLD.taskId, status: "failed", period: "24h" },
            {
              matches: 41,
              fingerprints: { [DEMO_WORLD.errorFingerprint]: 41 },
              firstSeen: "09:02",
            },
            "query-runs-nav"
          ),
          textPart(
            `41 runs of \`${DEMO_WORLD.taskId}\` failed in the last 24 hours, and they all share one error fingerprint — a 429 from the email provider. The first one was at 09:02 today; nothing failed before that. I've filtered your runs list to exactly those, so the deep link and what you see on screen agree.`
          ),
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
            `The spike starts at 09:00 and is confined to \`${DEMO_WORLD.taskId}\` — every other task on \`${DEMO_WORLD.queue}\` is flat through the same window. That shape matters: a provider-wide outage would have taken the other senders with it, so this is specific to this task's key and its retry schedule. Ask me to investigate one of those runs and I'll take it apart.`
          ),
        ]),
      ],
    },
  ],
};

const navigateRejectedIntent: DemoChat = {
  id: demoId("navigate-rejected-intent"),
  title: "Take me to my deployments",
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
            `I can't change your project — I only read. Here's what needs changing and where: in \`${DEMO_WORLD.sourcePath}:18\`, raise \`minTimeoutInMs\` to 30s with a factor of 2 so the three attempts stop sharing one rate-limit window, and cap \`${DEMO_WORLD.queue}\` at 20 concurrency from the queue's settings page. The second one takes effect immediately, without a deploy. I'll walk through either if you want the diff.`
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
  title: "What should I look at here?",
  flow: "prompts",
  summary:
    "One page, one chip row: a run that failed a minute ago, the context line it was derived from, and the fresh-failure prompt promoted to the top slot.",
  banner: { ...PROD_BANNER, currentPage: "Run detail" },
  lastMessageAt: "2026-07-27T10:22:00.000Z",
  items: [
    {
      kind: "prompts",
      prompts: demoPromptSets.failedRun,
      context: demoPageContexts.failedRun,
    },
  ],
};

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const reportHealthy: DemoChat = {
  id: demoId("report-healthy"),
  title: "How is prod doing?",
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
            {
              title: "health",
              severity: "ok",
              windowMinutes: 60,
              findings: ["flow", "execution", "liveness"],
            },
            "get-report-healthy"
          ),
          textPart(
            "Short answer: prod is fine. Here's the last hour against your 7-day normal — flow, execution and telemetry freshness, each with the numbers behind the verdict."
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
          textPart(
            "Nothing needs you. Runs are starting in 6.8s at p95 against a 7s normal, 0.4% of them failed where 0.5% is usual, and 34 are pending — all inside the band you've run at for the past week. Telemetry is 21 seconds behind, so this is a current picture rather than a stale one."
          ),
        ]),
      ],
    },
  ],
};

const reportDegraded: DemoChat = {
  id: demoId("report-degraded"),
  title: "Is anything wrong right now?",
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
      kind: "messages",
      messages: [
        assistantMessage("rep-d-tool", [
          toolPart(
            "get_report",
            { report: "health", period: "1h" },
            {
              title: "health",
              severity: "crit",
              windowMinutes: 60,
              worstQueue: DEMO_WORLD.queue,
              pending: 4_812,
            },
            "get-report-degraded"
          ),
          textPart(
            "It is slow, and it's a queueing problem rather than a code problem. Work is arriving faster than the environment's concurrency limit lets it start, so runs are waiting in front of execution instead of failing inside it."
          ),
        ]),
      ],
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
            `Your code is fine — 0.6% of runs failed against a 0.5% normal and p95 duration hasn't moved. You've been pinned at the environment's concurrency ceiling of 50 for 38 of the last 60 minutes, 4,812 runs are pending, and \`${DEMO_WORLD.queue}\` accounts for 71% of them. Raising the limit clears it now; doing nothing clears it in about 27 minutes, once the 1,000-a-minute arrival spike drops back under the 820 a minute you're completing.`
          ),
        ]),
      ],
    },
  ],
};

const docsAnswer: DemoChat = {
  id: demoId("docs-answer"),
  title: "How do I use batchTrigger?",
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

const baseStreaming: DemoChat = {
  id: demoId("base-streaming"),
  title: "Summarize today's failures",
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
  title: "How deep is the email queue?",
  flow: "base",
  summary:
    "A pending pill for the call still in flight, under a finished tool row. Click the finished row to expand its input/output.",
  banner: PROD_BANNER,
  activity: "working",
  lastMessageAt: "2026-07-27T10:26:00.000Z",
  items: [
    { kind: "messages", messages: [userMessage("tool-q", "Check the queue depth for me.")] },
    {
      kind: "messages",
      messages: [
        assistantMessage("tool-intro", [
          textPart(
            `Counting what's pending across the environment first, then pulling \`${DEMO_WORLD.queue}\` on its own so we can see whether the depth is one queue or all of them.`
          ),
        ]),
      ],
    },
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
          // A real tool name, so the pending pill shows its real phrase rather
          // than the unknown-tool fallback.
          pendingToolPart(
            "get_queue",
            { queue: DEMO_WORLD.queue, period: "1h" },
            "get-queue-pending"
          ),
        ]),
      ],
    },
  ],
};

const baseErrorRetry: DemoChat = {
  id: demoId("base-error-retry"),
  title: "List yesterday's runs",
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
  title: "Queue health over time",
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
          textPart(
            `Yes — same error, same task, three weeks ago. \`${DEMO_WORLD.taskId}\` hit the same rate limit on 6 July and it was diagnosed then too; the card below is that diagnosis, replayed from this conversation rather than re-run. The retry config hasn't changed since, which is why it came back.`
          ),
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
  title: "Draft in the composer",
  flow: "base",
  summary:
    "A question half typed and left there: the conversation is still empty (suggested prompts on screen) and the composer holds the unsent draft, cursor mid-word.",
  banner: { ...PROD_BANNER, currentPage: "Run detail" },
  // Deliberately unfinished mid-word: the state being reviewed is a draft, not a
  // prefill, so it has to look like someone stopped typing.
  draft: "why did the send-order-receipt run from last nig",
  lastMessageAt: "2026-07-27T10:28:00.000Z",
  // Empty on purpose: an unsent draft means nothing has been said yet, so the
  // transcript is the first-open prompt panel.
  items: [],
};

const basePageContext: DemoChat = {
  id: demoId("base-page-context"),
  title: "Which page am I on?",
  flow: "base",
  summary:
    "The agent answers from page context alone: it names the page, project and environment shown in the banner, says what it can already see there, and offers the next step.",
  banner: PROD_BANNER,
  lastMessageAt: "2026-07-27T10:29:00.000Z",
  items: [
    {
      kind: "messages",
      messages: [userMessage("ctx-q", "Which page am I on?")],
    },
    {
      kind: "messages",
      messages: [
        assistantMessage("ctx-a", [
          textPart(
            `You're on the **Runs** list of \`demo-storefront\`, in \`prod\` — the same three things the bar at the top of this panel shows. I get that with every message, so I don't have to ask where you are.

From here I can see the list you're looking at: 41 runs of \`${DEMO_WORLD.taskId}\` failed in the last 24 hours, all with the same 429 from the email provider, and \`${DEMO_WORLD.failedRunId}\` is the most recent. Want me to take that one apart?`
          ),
        ]),
      ],
    },
    {
      kind: "messages",
      messages: [userMessage("ctx-followup", "Does that change if I navigate somewhere else?")],
    },
    {
      kind: "messages",
      messages: [
        assistantMessage("ctx-followup-a", [
          textPart(
            `Yes — the page is read fresh on every message, so if you open a run, or switch to \`staging\`, my next answer is about that page and that environment. Nothing carries over silently: if I'm still talking about \`${DEMO_WORLD.failedRunId}\` after you've moved, it's because you asked about it, not because I didn't notice.`
          ),
        ]),
      ],
    },
  ],
};

const baseInvestigationDeepLink: DemoChat = {
  id: demoId("base-investigation-uri"),
  title: "Follow-up on the investigation",
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
            `The full investigation is at \`${demoInvestigationUri(demoInvestigationConcluded.investigationId)}\` — that id is stable, so asking me about it again resumes the same card rather than starting over. It covers four hypotheses on \`${DEMO_WORLD.failedRunId}\`: the provider's rate limit and the retry window held up, the payload and yesterday's deploy were ruled out. I've put you on the run itself, since that's where the evidence points.`
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
  reportHealthy,
  reportDegraded,
  docsAnswer,
  baseStreaming,
  baseToolInFlight,
  baseErrorRetry,
  baseResumed,
  baseComposerDraft,
  basePageContext,
  baseInvestigationDeepLink,
];

export function demoChatById(id: string): DemoChat | undefined {
  return demoChats.find((chat) => chat.id === id);
}
