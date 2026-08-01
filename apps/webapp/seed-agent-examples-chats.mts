/**
 * The example conversations, as stored transcripts over really-seeded entities.
 *
 * These are ports of the demo-mode fixtures in
 * `app/components/dashboard-agent/demo/demo-chats.ts`, rewritten so every id,
 * queue name, version and citation refers to something the seeder actually
 * created. The panel renders them through the production renderer with no demo
 * code involved, so what a reviewer sees here is what a real chat looks like.
 *
 * Three translation rules, because the store is narrower than the mockup:
 *
 * 1. Only what the production renderer handles survives: `text`, `reasoning`,
 *    `tool-render_view` (real cards), `tool-get_report` (the report card) and
 *    `source-url`. Investigation cards, intent bubbles and prompt rows have no
 *    stored representation yet, so those beats become assistant
 *    text — and where a card carried the diagnosis, a real `diagnosis` view
 *    block carries it instead.
 * 2. A landed tool call renders NOTHING. Completed `tool-*` parts are still
 *    stored — they are what the answer was grounded on, and cards read them —
 *    but no prose may point at one, because there is no row on screen to point
 *    at. Only a failed call keeps a row, so a failure can still be seen.
 * 3. Chats that exist only to show a transient UI state (streaming text, a tool
 *    mid-call, an unsent draft) are not ported: a stored transcript can't be
 *    mid-flight, and storing one would render as a turn that never finishes.
 *    `SKIPPED_DEMO_CHATS` records them.
 */
import { formatTriggerUri } from "@internal/dashboard-agent-contracts";

/** Everything the transcripts need to know about the seeded world. */
export type AgentExamplesWorld = {
  organizationSlug: string;
  projectSlug: string;
  projectRef: string;
  environmentId: string;
  environmentSlug: string;
  /** Absolute dashboard origin, for the clickable `source-url` citations. */
  appOrigin: string;

  failedRunId: string;
  failedSpanId: string;
  waitingRunId: string;
  slowRunId: string;
  priorRunId: string;

  taskId: string;
  slowTaskId: string;
  queue: string;
  backlogQueue: string;
  errorFingerprint: string;
  deploymentVersion: string;
  sourceSha: string;
  sourcePath: string;

  /** The story's numbers, so prose and cards can never disagree. */
  envConcurrencyLimit: number;
  pinnedMinutes: number;
  pending: number;
  worstQueueShare: number;
  failureCount: number;
  /** The report's own failure ratio, so the prose can quote the card. */
  failureRatePct: string;
  donePerMin: number;
  triggeredPerMin: number;
  drainMinutes: number;

  /** `HH:MM` UTC labels derived from the seeded timestamps. */
  firstFailureClock: string;
  lastFailureClock: string;

  /** Report view models: one live from ClickHouse, one from the calm window. */
  degradedReport: unknown;
  healthyReport: unknown;
};

export type SeedMessage = {
  id: string;
  role: "user" | "assistant";
  parts: unknown[];
};

export type SeedChat = {
  /** Stable across re-seeds so the seeder can upsert rather than duplicate. */
  slug: string;
  title: string;
  /** Minutes before "now" — becomes `last_message_at`, which orders the history. */
  minutesAgo: number;
  messages: SeedMessage[];
};

/** Demo chats with no stored equivalent, and why. */
export const SKIPPED_DEMO_CHATS: ReadonlyArray<{ id: string; reason: string }> = [
  {
    id: "demo:investigate-streaming",
    reason:
      "Its subject is the investigation card being revised in place; investigations have no stored block yet (M5 owns it).",
  },
  {
    id: "demo:prompts-page-aware",
    reason: "Suggested-prompt chips are panel chrome, not transcript items — nothing to store.",
  },
  {
    id: "demo:base-streaming",
    reason: "A half-arrived text part. Stored, it would render as a turn that never completes.",
  },
  {
    id: "demo:base-tool-in-flight",
    reason: "A tool mid-call. Stored, it would render as a pending pill that never resolves.",
  },
  {
    id: "demo:base-composer-draft",
    reason:
      "An empty transcript plus a composer draft. The panel treats empty `messages` as nothing stored.",
  },
  {
    id: "demo:base-investigation-uri",
    reason:
      "Built on an investigation URI, which has no dashboard page — the citation could not resolve.",
  },
];

// ---------------------------------------------------------------------------
// Part builders. Shapes match what the production renderer reads.
// ---------------------------------------------------------------------------

let messageCounter = 0;
function messageId(slug: string): string {
  messageCounter += 1;
  return `msg_seed_${slug}_${messageCounter}`;
}

function user(slug: string, text: string): SeedMessage {
  return { id: messageId(slug), role: "user", parts: [{ type: "text", text }] };
}

function assistant(slug: string, parts: unknown[]): SeedMessage {
  return { id: messageId(slug), role: "assistant", parts };
}

function text(value: string) {
  return { type: "text", text: value, state: "done" };
}

function reasoning(value: string) {
  return { type: "reasoning", text: value, state: "done" };
}

let toolCounter = 0;
function toolCallId(name: string): string {
  toolCounter += 1;
  return `call_seed_${name}_${toolCounter}`;
}

function tool(name: string, input: unknown, output: unknown) {
  return {
    type: `tool-${name}`,
    toolCallId: toolCallId(name),
    state: "output-available",
    input,
    output,
  };
}

function failedTool(name: string, input: unknown, errorText: string) {
  return {
    type: `tool-${name}`,
    toolCallId: toolCallId(name),
    state: "output-error",
    input,
    errorText,
  };
}

/** A real card: the renderer feeds `output.blocks` to the view catalog. */
function renderView(blocks: unknown[]) {
  return {
    type: "tool-render_view",
    toolCallId: toolCallId("render_view"),
    state: "output-available",
    input: { blocks },
    output: { blocks },
  };
}

/**
 * The report card. This path is strict: `state`, a non-empty `toolCallId` and a
 * `vm.generatedAt` string are all required or it degrades to a plain tool row.
 */
function reportCard(vm: unknown, reportUri: string) {
  return {
    type: "tool-get_report",
    toolCallId: toolCallId("get_report"),
    state: "output-available",
    input: { report: "health", period: "1h" },
    output: { vm, uri: reportUri },
  };
}

function sourceUrl(url: string, title: string) {
  return { type: "source-url", sourceId: `src_seed_${toolCallId("source")}`, url, title };
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

export function buildAgentExampleChats(w: AgentExamplesWorld): SeedChat[] {
  const scope = { projectRef: w.projectRef, environmentId: w.environmentId };
  const runUri = (runId: string) => formatTriggerUri({ kind: "run", ...scope, runId });
  const spanUri = (runId: string, spanId: string) =>
    formatTriggerUri({ kind: "span", ...scope, runId, spanId });
  const errorUri = formatTriggerUri({
    kind: "error",
    ...scope,
    fingerprint: w.errorFingerprint,
  });
  const queueUri = formatTriggerUri({ kind: "queue", ...scope, name: w.queue });
  const deploymentUri = formatTriggerUri({
    kind: "deployment",
    ...scope,
    version: w.deploymentVersion,
  });
  const reportUri = formatTriggerUri({ kind: "report", ...scope, key: "health" });
  const sourceUri = formatTriggerUri({
    kind: "source",
    ...scope,
    sha: w.sourceSha,
    path: w.sourcePath,
    line: 18,
  });

  // The panel does not pass a URI resolver to the renderer yet, so a `trigger://`
  // citation renders as text. Real dashboard URLs ride alongside as `source-url`
  // parts, which are clickable today — every one of them resolves to a live page
  // because the entity behind it was seeded.
  const envBase = `${w.appOrigin}/orgs/${w.organizationSlug}/projects/${w.projectSlug}/env/${w.environmentSlug}`;
  const runLink = (runId: string) => `${envBase}/runs/${runId}`;
  const failedRunsLink = `${envBase}/runs?statuses=COMPLETED_WITH_ERRORS&tasks=${w.taskId}&period=24h`;
  const queueLink = `${envBase}/dashboards/queues?query=${encodeURIComponent(w.queue)}`;
  const deploymentLink = `${envBase}/deployments/${w.deploymentVersion}`;

  // The diagnosis block that carried the concluded investigation in the mockup.
  const diagnosisEnvelope = { id: `diag_${w.failedRunId}`, version: 1 };
  const diagnosisFirstPass = {
    ...diagnosisEnvelope,
    revision: 0,
    type: "diagnosis",
    runId: w.failedRunId,
    summary: `${w.taskId} failed while calling the email provider. The call came back 429 and the run exhausted its 3 retries.`,
    category: "rate_limit",
    likelyCause:
      "The email provider is rate limiting this API key. All three attempts landed inside the same 20-second window, so the retries never had a chance to clear the limit.",
    confidence: "medium",
    evidence: [
      {
        type: "error",
        detail: "ProviderError: 429 Too Many Requests (rate_limit_exceeded)",
        reference: w.failedRunId,
      },
      {
        type: "failed_span",
        detail: "sendEmail span failed after 412ms on attempt 3 of 3",
        reference: w.failedSpanId,
      },
    ],
    nextSteps: [
      "Spread the retries out: raise the retry delay so attempts don't land in the same rate-limit window.",
      "Cap concurrency on the queue so the task can't burst past the provider's per-second limit.",
    ],
  };
  const diagnosisRevised = {
    ...diagnosisFirstPass,
    revision: 1,
    summary: `${w.taskId} failed because the email provider rate limited it. ${w.failureCount} runs on this queue hit the same 429 in the last hour — this run isn't special.`,
    confidence: "high",
    impact: `${w.failureCount} runs of ${w.taskId} failed the same way in the last hour, all on the ${w.queue} queue.`,
    evidence: [
      ...diagnosisFirstPass.evidence,
      {
        type: "historical_match",
        detail: `${w.failureCount} runs failed with the same error fingerprint in the last hour`,
        reference: w.errorFingerprint,
      },
      {
        type: "source",
        detail: "retry.maxAttempts is 3 with a 1s base delay and no jitter",
        reference: `${w.sourcePath}:18`,
      },
    ],
    nextSteps: [
      "Raise the retry delay (or add jitter) so attempts don't all land inside one rate-limit window.",
      `Cap concurrency on ${w.queue} to stay under the provider's per-second limit.`,
      "Consider a queue-level rate limit so a backlog can't burst into the provider.",
    ],
    actions: [
      { label: "View run", kind: "view_run", target: w.failedRunId },
      {
        label: "Read the retries docs",
        kind: "docs",
        target: "https://trigger.dev/docs/errors-retrying",
      },
    ],
  };
  // No envelope on purpose: the pre-envelope transcript path has to keep
  // rendering forever, and a seeded example is the cheapest way to prove it.
  const legacyDiagnosis = {
    type: "diagnosis",
    runId: w.priorRunId,
    summary: `${w.priorRunId} failed the same way earlier in the burst, before the panel stamped identity onto its cards.`,
    category: "rate_limit",
    likelyCause: "The email provider rate limited the same API key.",
    confidence: "medium",
    evidence: [{ type: "error", detail: "ProviderError: 429 Too Many Requests" }],
    nextSteps: ["Nothing to do — kept as the pre-envelope render path."],
  };

  // Both chart blocks run live against the seeded environment when rendered.
  const failuresChart = {
    id: "chart_failures_by_task",
    revision: 0,
    version: 1,
    type: "chart",
    title: "Failed runs per hour, by task",
    query:
      "SELECT timeBucket() AS hour, task_identifier, countIf(status = 'Failed') AS failures FROM runs GROUP BY hour, task_identifier ORDER BY hour",
    period: "24h",
    chartType: "line",
    xAxisColumn: "hour",
    yAxisColumns: ["failures"],
    groupByColumn: "task_identifier",
    stacked: false,
    aggregation: "sum",
  };
  const pendingChart = {
    id: "chart_pending_runs",
    revision: 0,
    version: 1,
    type: "chart",
    title: "Pending runs",
    query:
      "SELECT timeBucket() AS t, max(max_env_queued) AS pending FROM env_metrics GROUP BY t ORDER BY t",
    period: "12h",
    chartType: "line",
    xAxisColumn: "t",
    yAxisColumns: ["pending"],
    stacked: false,
    aggregation: "max",
  };

  const chats: SeedChat[] = [];

  // --- Investigate -------------------------------------------------------

  chats.push({
    slug: "investigate-concluded",
    title: `${w.taskId} failure`,
    minutesAgo: 4,
    messages: [
      user("inv-c", `Investigate why ${w.failedRunId} failed.`),
      assistant("inv-c", [
        reasoning(
          "Four candidates: the provider's rate limit, a bad payload, the retry schedule, and yesterday's deploy. Each one has a check that can rule it out, so run all four before writing a conclusion."
        ),
        tool(
          "query_runs",
          { fingerprint: w.errorFingerprint, period: "1h" },
          {
            matches: w.failureCount,
            tasks: [w.taskId],
            firstSeen: w.firstFailureClock,
            lastSeen: w.lastFailureClock,
          }
        ),
        tool(
          "get_queue_health",
          { queue: w.queue, period: "1h" },
          {
            concurrency: w.envConcurrencyLimit,
            limit: w.envConcurrencyLimit,
            pinnedMinutes: w.pinnedMinutes,
            pending: w.pending,
          }
        ),
        tool(
          "list_deploys",
          { period: "48h" },
          { latest: w.deploymentVersion, gitSha: w.sourceSha }
        ),
        tool(
          "read_source",
          { path: w.sourcePath, sha: w.sourceSha },
          { lines: "14-20", excerpt: "retry: { maxAttempts: 3, minTimeoutInMs: 1_000 }" }
        ),
        text(
          `Two of the four hold up. The provider is rate limiting this key, and the retry config puts all three attempts inside the same limit window — so a run that hits the limit once is guaranteed to fail. The payload and the last deploy are both ruled out.

Evidence: \`${runUri(w.failedRunId)}\`, \`${spanUri(w.failedRunId, w.failedSpanId)}\`, \`${errorUri}\`, \`${queueUri}\`, \`${sourceUri}\`.`
        ),
      ]),
      assistant("inv-c", [renderView([diagnosisRevised])]),
      assistant("inv-c", [
        text(
          `The fix is a config change, not a code fix — I haven't changed anything. Raising \`minTimeoutInMs\` to 30s with a factor of 2 spreads the three attempts across ~2 minutes, and capping \`${w.queue}\` at 20 stops the burst that trips the limit in the first place. The queue cap you can set from the dashboard without a deploy.`
        ),
        sourceUrl(runLink(w.failedRunId), `Run ${w.failedRunId}`),
        sourceUrl(queueLink, `Queue ${w.queue}`),
      ]),
      user("inv-c", `Do the ${w.failureCount} failed runs retry on their own once I fix this?`),
      assistant("inv-c", [
        tool(
          "query_runs",
          { fingerprint: w.errorFingerprint, period: "1h", status: "failed" },
          { matches: w.failureCount, retriesRemaining: 0, oldest: w.priorRunId }
        ),
        text(
          `No — all ${w.failureCount} used their three attempts, so they're final. They'll need re-triggering after the config change; the oldest is \`${w.priorRunId}\`, from ${w.firstFailureClock}. Fix the retry config first, otherwise a bulk replay will hit the same limit and burn its attempts the same way.`
        ),
        sourceUrl(runLink(w.priorRunId), `Run ${w.priorRunId}`),
      ]),
    ],
  });

  chats.push({
    slug: "investigate-inconclusive",
    title: "Intermittent upstream timeouts",
    minutesAgo: 26,
    messages: [
      user("inv-i", `Why is ${w.slowRunId} taking so long?`),
      assistant("inv-i", [
        tool(
          "get_run_details",
          { runId: w.slowRunId },
          { runId: w.slowRunId, status: "EXECUTING", attempt: 1, machine: "large-1x" }
        ),
        tool(
          "get_span_details",
          { runId: w.slowRunId, spanId: "aggregate" },
          { name: "aggregate", children: 0, events: 0 }
        ),
        text(
          `\`${w.slowTaskId}\` has been executing for 24 minutes against a p95 of 3 minutes, and 23m41s of that sits inside a single \`aggregate\` span with no children and no events. I checked memory and queue wait to rule out the two usual suspects, but I can't see inside that span.`
        ),
      ]),
      assistant("inv-i", [
        text(
          `I'd rather say I don't know than guess. What I established:

- **The rate limit is not involved.** This run is on \`${w.backlogQueue}\`, not \`${w.queue}\`, and it never hit the provider.
- **It isn't starved.** Memory peaked at 38% and the run was dequeued 40ms after it was triggered.
- **Still open:** where the 23m41s goes. There is nothing in the telemetry to attribute it to.

What to check next: add a span around the aggregation step, and log the row count it's working through.`
        ),
        sourceUrl(runLink(w.slowRunId), `Run ${w.slowRunId}`),
      ]),
      user("inv-i", "Should I kill it?"),
      assistant("inv-i", [
        text(
          `Your call — I can't cancel runs. It's 8x its normal duration but still holding one of the 20 concurrency slots on \`${w.backlogQueue}\`, and nothing else is queued behind it, so letting it run costs you little. If you do cancel it, add that span first, otherwise the next run tells you exactly as little as this one.`
        ),
      ]),
    ],
  });

  chats.push({
    slug: "investigate-show-code",
    title: "Show me the failing code",
    minutesAgo: 2,
    messages: [
      user("code", "Show me the code change."),
      assistant("code", [
        tool(
          "read_source",
          { path: w.sourcePath, sha: w.sourceSha, lines: "14-20" },
          { sha: w.sourceSha, path: w.sourcePath }
        ),
        text(
          `Here's the change, in \`${w.sourcePath}:18\` at \`${w.sourceSha.slice(0, 7)}\`. **I haven't applied anything** — this is the diff you'd write.

\`\`\`diff
   retry: {
     maxAttempts: 3,
-    minTimeoutInMs: 1_000,
-    factor: 1,
+    minTimeoutInMs: 30_000,
+    factor: 2,
+    randomize: true,
   },
\`\`\`

At 1s with a factor of 1, all three attempts land inside one 20-second rate-limit window. At 30s with a factor of 2 they spread across roughly two minutes, and \`randomize\` stops a whole batch retrying in lockstep.

Cited: \`${sourceUri}\`.`
        ),
      ]),
      assistant("code", [
        text(
          `This half needs a deploy. The other half — capping \`${w.queue}\` at 20 concurrency — is a dashboard setting, and it's the one that stops the burst, so it's worth doing first even if the deploy waits for your next release.`
        ),
        sourceUrl(queueLink, `Queue ${w.queue}`),
      ]),
    ],
  });

  chats.push({
    slug: "investigate-dirty-commit",
    title: "Failure after the last deploy",
    minutesAgo: 9,
    messages: [
      user("dirty", "Same question, but this deploy wasn't a clean build."),
      assistant("dirty", [
        tool(
          "list_deploys",
          { version: w.deploymentVersion },
          {
            version: w.deploymentVersion,
            gitSha: w.sourceSha,
            dirty: true,
            uncommittedFiles: 3,
          }
        ),
        text(
          `\`${w.deploymentVersion}\` was built from a working tree with 3 uncommitted files, so \`${w.sourcePath}\` as I can read it is the nearest snapshot — not provably the code that ran. The conclusion is the same, but I'm dropping confidence to medium and saying which parts of the evidence that affects.

Deployment: \`${deploymentUri}\`.`
        ),
      ]),
      assistant("dirty", [renderView([diagnosisFirstPass])]),
      assistant("dirty", [
        text(
          "The run, span and error evidence comes from telemetry, so it stands regardless. Only the retry-config citation is hedged — if you deploy from a clean tree I can confirm that line exactly rather than approximately."
        ),
        sourceUrl(deploymentLink, `Deployment ${w.deploymentVersion}`),
      ]),
    ],
  });

  // --- Navigation --------------------------------------------------------

  chats.push({
    slug: "navigate-filtered-runs",
    title: "Failed runs in the last 24h",
    minutesAgo: 12,
    messages: [
      user("nav", `Show me everything that failed in the last day for ${w.taskId}.`),
      assistant("nav", [
        tool(
          "query_runs",
          { taskIdentifier: w.taskId, status: "failed", period: "24h" },
          {
            matches: w.failureCount,
            fingerprints: { [w.errorFingerprint]: w.failureCount },
            firstSeen: w.firstFailureClock,
          }
        ),
        text(
          `${w.failureCount} runs of \`${w.taskId}\` failed in the last 24 hours, and they all share one error fingerprint — a 429 from the email provider. The first one was at ${w.firstFailureClock}; nothing failed before that. The link below is your runs list filtered to exactly those, so the deep link and what you see on screen agree.`
        ),
        sourceUrl(failedRunsLink, `Failed ${w.taskId} runs`),
      ]),
      assistant("nav", [renderView([failuresChart])]),
      assistant("nav", [
        text(
          `The spike starts at ${w.firstFailureClock} and is confined to \`${w.taskId}\` — every other task on \`${w.queue}\` is flat through the same window. That shape matters: a provider-wide outage would have taken the other senders with it, so this is specific to this task's key and its retry schedule. Ask me to investigate one of those runs and I'll take it apart.`
        ),
      ]),
    ],
  });

  chats.push({
    slug: "navigate-rejected-intent",
    title: "Just fix it for me",
    minutesAgo: 11,
    messages: [
      user("fix", "Just fix it for me."),
      assistant("fix", [
        text(
          `I can't change your project — I only read. Here's what needs changing and where: in \`${w.sourcePath}:18\`, raise \`minTimeoutInMs\` to 30s with a factor of 2 so the three attempts stop sharing one rate-limit window, and cap \`${w.queue}\` at 20 concurrency from the queue's settings page. The second one takes effect immediately, without a deploy. I'll walk through either if you want the diff.`
        ),
        sourceUrl(queueLink, `Queue ${w.queue}`),
      ]),
    ],
  });

  // --- Reports -----------------------------------------------------------

  chats.push({
    slug: "report-healthy",
    title: "How is prod doing?",
    minutesAgo: 180,
    messages: [
      user("rep-h", "How's prod doing?"),
      assistant("rep-h", [
        text(
          "Short answer: prod is fine. Here's the last hour against your 7-day normal — flow, execution and telemetry freshness, each with the numbers behind the verdict."
        ),
        reportCard(w.healthyReport, reportUri),
      ]),
      assistant("rep-h", [
        text(
          "Every reading is inside the band you've run at for the past week, and telemetry is seconds behind, so this is a current picture rather than a stale one. The one thing worth knowing: this window is quiet because the arrival rate is quiet — it is not proof the concurrency limit is high enough for a busy hour."
        ),
      ]),
    ],
  });

  chats.push({
    slug: "report-degraded",
    title: "Is anything wrong right now?",
    minutesAgo: 1,
    messages: [
      user("rep-d", "Something feels slow. What's going on?"),
      assistant("rep-d", [
        text(
          "It is slow, and it's a queueing problem rather than a code problem. Work is arriving faster than the environment's concurrency limit lets it start, so runs are waiting in front of execution instead of failing inside it."
        ),
        reportCard(w.degradedReport, reportUri),
      ]),
      assistant("rep-d", [renderView([pendingChart])]),
      assistant("rep-d", [
        text(
          `Your code is fine — ${w.failureRatePct}% of runs failed and p95 duration hasn't moved. You've been pinned at the environment's concurrency ceiling of ${w.envConcurrencyLimit} for ${w.pinnedMinutes} of the last 60 minutes, ${w.pending.toLocaleString("en-US")} runs are pending, and \`${w.queue}\` accounts for ${Math.round(
            w.worstQueueShare * 100
          )}% of them — so this is one queue's spike, not the whole environment misbehaving. Arrivals are ${w.triggeredPerMin.toLocaleString("en-US")} a minute against the ${w.donePerMin.toLocaleString("en-US")} you're completing, and that gap is already narrowing. The oldest thing still waiting is \`${w.waitingRunId}\`, if you want to see what a queued run looks like from the inside.`
        ),
        sourceUrl(runLink(w.waitingRunId), `Run ${w.waitingRunId}`),
        sourceUrl(queueLink, `Queue ${w.queue}`),
      ]),
    ],
  });

  chats.push({
    slug: "docs-answer",
    title: "How do retries actually work?",
    minutesAgo: 55,
    messages: [
      user("docs", "How do retries actually work? Is the delay exponential?"),
      assistant("docs", [
        tool("search_docs", { query: "retry configuration exponential backoff" }, { hits: 3 }),
        text(
          `Yes — retries back off exponentially by default.

- \`maxAttempts\` counts the *first* attempt, so \`3\` means one try plus two retries.
- The delay is \`minTimeoutInMs * factor^(attempt - 1)\`, capped at \`maxTimeoutInMs\`.
- \`randomize: true\` adds jitter, which is what stops a whole batch retrying in lockstep — the thing that bit \`${w.taskId}\` on \`${w.queue}\` this morning.`
        ),
        sourceUrl("https://trigger.dev/docs/errors-retrying", "Errors & retrying"),
        sourceUrl("https://trigger.dev/docs/tasks/overview", "Task options"),
      ]),
    ],
  });

  // --- Base states -------------------------------------------------------

  chats.push({
    slug: "base-resumed",
    title: "Did this happen earlier today too?",
    minutesAgo: 21,
    messages: [
      user("res", "Did this happen earlier today too?"),
      assistant("res", [
        text(
          `Yes — same error, same task, earlier in the same burst. \`${w.taskId}\` hit the same rate limit at ${w.firstFailureClock} and I diagnosed it then; both diagnoses are here — this run's, and \`${w.priorRunId}\` from the start of the burst. The retry config hasn't changed since, which is why it came back.`
        ),
        // Revisions 0 and 1 of one diagnosis (the renderer collapses to the
        // highest revision) plus one envelope-less block from an older transcript.
        renderView([diagnosisFirstPass, diagnosisRevised, legacyDiagnosis]),
      ]),
      assistant("res", [
        renderView([failuresChart]),
        text(
          `The chart is live, so it answers the same question for whatever has happened since: two clusters today, both on \`${w.taskId}\`, nothing on the other senders.`
        ),
      ]),
    ],
  });

  chats.push({
    slug: "base-page-context",
    title: "Which page am I on?",
    minutesAgo: 16,
    messages: [
      user("ctx", "Which page am I on?"),
      assistant("ctx", [
        text(
          `You're on the **Runs** list of \`${w.projectSlug}\`, in \`${w.environmentSlug}\` — the same three things the bar at the top of this panel shows. I get that with every message, so I don't have to ask where you are.

From here I can see the list you're looking at: ${w.failureCount} runs of \`${w.taskId}\` failed in the last hour, all with the same 429 from the email provider, and \`${w.failedRunId}\` is the most recent. Want me to take that one apart?`
        ),
      ]),
      user("ctx", "Does that change if I navigate somewhere else?"),
      assistant("ctx", [
        text(
          `Yes — the page is read fresh on every message, so if you open a run, or switch environment, my next answer is about that page and that environment. Nothing carries over silently: if I'm still talking about \`${w.failedRunId}\` after you've moved, it's because you asked about it, not because I didn't notice.`
        ),
      ]),
    ],
  });

  chats.push({
    slug: "base-error-retry",
    title: "Chart failures by task",
    minutesAgo: 33,
    messages: [
      user("err", "Chart failures by task for the last week."),
      assistant("err", [
        failedTool(
          "run_query",
          { query: "SELECT task_identifier, count() FROM runs", period: "7d" },
          "query timed out after 30s"
        ),
        text(
          "That query timed out. A week of runs at this volume is too much for one scan — narrow it to 24 hours, or group by hour so the aggregate does the work. Say which and I'll rerun it."
        ),
      ]),
    ],
  });

  return chats;
}
