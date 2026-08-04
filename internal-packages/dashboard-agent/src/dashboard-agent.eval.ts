// Evals for the dashboard agent: they run the REAL model through the agent and
// score behavior, which unit tests (mock model) can't. Two layers, following
// common practice (DeepEval "tool correctness", Vercel AI SDK + vitest evals,
// LLM-as-judge with an analytic rubric):
//
//  1. Tool selection — does the model pick the right read tool for a question?
//     Scored as an aggregate pass rate with a threshold, since a real model is
//     nondeterministic; a single miss shouldn't red the suite, a trend should.
//  2. Answer quality — an LLM judge scores the final answer against the tool
//     data it was given (reason-before-score, structured output, grounded on
//     facts to blunt verbosity/self-enhancement bias).
//
// These hit the real Anthropic API (cost + nondeterminism), so they live in
// `*.eval.ts` (not run by `pnpm test`) and skip unless ANTHROPIC_API_KEY is set.
// Run with `pnpm --filter @internal/dashboard-agent run test:evals`.
//
// `@trigger.dev/sdk/ai/test` first so the resource catalog installs before the
// agent module registers.
import { mockChatAgent } from "@trigger.dev/sdk/ai/test";

import { anthropic } from "@ai-sdk/anthropic";
import { generateObject, tool, type ToolSet, type UIMessage, type UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  dashboardAgent,
  dashboardAgentModelKey,
  dashboardAgentStoreKey,
  dashboardAgentToolsKey,
  type DashboardAgentStore,
} from "./dashboard-agent";
import { dashboardAgentCodeToolSchemas, dashboardAgentToolSchemas } from "./tool-schemas";
import { showCodeAskPrompt } from "./tools";

const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
// The agent's real model; a capable judge (a stronger/different judge would
// further reduce self-enhancement bias).
const AGENT_MODEL = "claude-sonnet-4-6";
const JUDGE_MODEL = "claude-sonnet-4-6";

const CLIENT_DATA = {
  userId: "user_eval",
  organizationId: "org_eval",
  // navigate_to needs a project + environment to build a trigger:// URI, and
  // get_current_page reads the page context, so the eval turn carries both.
  projectRef: "proj_eval1",
  environmentId: "env_eval1",
  pageContext: {
    page: { kind: "run" as const, runId: "run_a1", status: "FAILED", taskId: "send-receipt" },
    signals: [
      { kind: "fresh_failure" as const, runId: "run_a1", failedAt: "2026-01-01T00:00:00.000Z" },
    ],
  },
};
const NOOP_STORE: DashboardAgentStore = {
  ensureChat: async () => {},
  persistMessages: async () => {},
  appendMessage: async () => {},
  persistTurn: async () => {},
  setChatTitleIfDefault: async () => {},
  upsertInvestigationRevision: async () => ({
    ok: true,
    id: "inv_eval",
    revision: 0,
    created: true,
  }),
};

// Realistic, fixed tool results so the model has something concrete to act on
// and the judge has a ground truth to check the answer against.
const FIXTURES: Record<string, unknown> = {
  list_projects: {
    projects: [{ ref: "proj_eval1", name: "Checkout", slug: "checkout", organization: "Acme" }],
  },
  list_environments: {
    environments: [
      { slug: "dev", type: "DEVELOPMENT", paused: false },
      { slug: "prod", type: "PRODUCTION", paused: false },
    ],
  },
  list_tasks: {
    tasks: [
      { slug: "send-receipt", filePath: "src/trigger/receipt.ts", triggerSource: "STANDARD" },
      { slug: "nightly-rollup", filePath: "src/trigger/rollup.ts", triggerSource: "SCHEDULED" },
    ],
  },
  list_runs: {
    runs: [
      { id: "run_a1", status: "FAILED", taskIdentifier: "send-receipt", durationMs: 0 },
      { id: "run_a2", status: "COMPLETED", taskIdentifier: "send-receipt", durationMs: 1200 },
    ],
    nextCursor: undefined,
  },
  get_run: {
    id: "run_a1",
    status: "FAILED",
    taskIdentifier: "send-receipt",
    durationMs: 0,
    error: { name: "TimeoutError", message: "Stripe API timed out after 30s" },
  },
  get_run_trace: {
    traceId: "trace_a1",
    spans: [
      { depth: 0, task: "send-receipt", durationMs: 30010, isError: true, message: "run" },
      { depth: 1, durationMs: 30000, isError: true, message: "POST api.stripe.com/charges" },
    ],
    truncated: false,
  },
  list_errors: {
    errors: [
      {
        id: "error_stripe",
        taskIdentifier: "send-receipt",
        errorType: "TimeoutError",
        errorMessage: "Stripe API timed out after 30s",
        status: "unresolved",
        count: 37,
      },
      {
        id: "error_oom",
        taskIdentifier: "nightly-rollup",
        errorType: "OutOfMemoryError",
        errorMessage: "JS heap out of memory",
        status: "ignored",
        count: 4,
      },
    ],
    nextCursor: undefined,
  },
  get_error: {
    id: "error_stripe",
    taskIdentifier: "send-receipt",
    errorType: "TimeoutError",
    errorMessage: "Stripe API timed out after 30s",
    status: "unresolved",
    count: 37,
    affectedVersions: ["20260101.1", "20260102.1"],
    resolvedAt: null,
  },
  // The curated health report (curateReport's shape): a degraded environment
  // whose data IS trustworthy, so action advice is allowed.
  get_report: {
    title: "health",
    scope: "prod",
    period: "last 1h",
    baselineLabel: "vs your 7d normal",
    generatedAt: "2026-01-01T00:00:00.000Z",
    windowMinutes: 60,
    summary: {
      severity: "crit",
      statements: [
        { findingType: "flow", severity: "crit" },
        { findingType: "execution", severity: "ok" },
        { findingType: "liveness", severity: "ok" },
      ],
    },
    findings: [
      {
        type: "flow",
        severity: "crit",
        reason: "env_limit_saturation",
        read: "saturation_chain",
        metricIds: ["pending", "concurrency"],
        recommendation: { code: "raise_env_limit" },
        attribution: { dim: "queue", key: "task/send-receipt", share: 0.82, of: "pending" },
      },
      {
        type: "execution",
        severity: "ok",
        reason: "healthy",
        read: "runs_are_fine",
        metricIds: [],
      },
      { type: "liveness", severity: "ok", reason: "fresh", metricIds: ["liveness"] },
    ],
    metrics: [
      {
        id: "start_latency_p95",
        value: 41000,
        unit: "ms",
        aggregation: "p95",
        normal: 900,
        severity: "crit",
      },
      { id: "pending", value: 4210, unit: "count", severity: "crit" },
      {
        id: "throughput",
        value: -180,
        unit: "perMin",
        aggregation: "rate",
        breakdown: { done: 120, triggered: 300 },
        severity: "warn",
      },
      {
        id: "failures",
        value: 0.01,
        unit: "ratio",
        aggregation: "ratio",
        normal: 0.012,
        severity: "ok",
      },
      { id: "concurrency", value: 50, unit: "count", breakdown: { limit: 50 }, severity: "ok" },
    ],
    facts: {
      trustworthy: true,
      flowSource: "queue_metrics_v1",
      pendingEstimated: false,
      throughput: { donePerMin: 120, triggeredPerMin: 300, normalTriggeredPerMin: 140 },
      flowEvidence: {
        envLimit: 50,
        throttledShare: 0.61,
        worstQueue: { name: "task/send-receipt", share: 0.82 },
        dlqDelta: 0,
      },
    },
    footer: [{ code: "raise_env_limit" }],
    seriesOmitted: true,
  },
  get_queue: {
    queue: "task/send-email",
    period: "1h",
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T01:00:00.000Z",
    waitMs: { p50: 12000, p95: 41000 },
    peakQueued: 4210,
    startedCount: 7200,
    startedPerMin: 120,
    throttledCount: 37,
    bucketIntervalMs: 300000,
    depthTrend: [10, 120, 900, 2400, 4210],
  },
  list_deploys: {
    deploys: [
      {
        id: "deployment_1",
        version: "20260102.1",
        shortCode: "abc1234",
        status: "DEPLOYED",
        deployedAt: "2026-01-02T09:00:00.000Z",
        commitMessage: "Batch the receipt sends",
        commitRef: "main",
        pullRequestNumber: 412,
      },
    ],
  },
  get_deploy: {
    deploy: {
      id: "deployment_1",
      version: "20260102.1",
      shortCode: "abc1234",
      status: "DEPLOYED",
      deployedAt: "2026-01-02T09:00:00.000Z",
      commitMessage: "Batch the receipt sends",
    },
    isCurrent: true,
  },
  correlate_version: {
    runId: "run_a1",
    version: "20260102.1",
    sha: "cafebabecafebabecafebabecafebabecafebabe",
    dirty: false,
    shortCode: "abc1234",
    git: {
      commitMessage: "Batch the receipt sends",
      commitRef: "main",
      pullRequestNumber: 412,
      pullRequestTitle: "Batch the receipt sends",
    },
  },
  search_docs: {
    results:
      "batchTrigger() triggers many runs of the same task in one call. It takes an array of payloads and returns a batch handle; use batchTriggerAndWait() inside a task to wait for all of them.",
  },
};

// The investigation id the fixture render_view hands back, mirroring the real
// executor (which returns the id the store assigned). A golden case asserts the
// model passes it back on the next render instead of opening a second card.
const EVAL_INVESTIGATION_ID = "inv_eval1";

// Real schemas (so the model sees the real tool descriptions) + stubbed executes
// that record each call (a spy) and return the fixture. This is the seam that
// lets us observe tool selection and judge answers with no live API.
// One recorded tool call. The output is recorded too: the judge's ground truth
// has to be what the model actually saw, not the fixture overrides for the case
// (base FIXTURES fill in every tool an override doesn't mention).
type RecordedCall = { tool: string; input: unknown; output: unknown };

function makeFixtureTools(
  calls: RecordedCall[],
  options: { code?: boolean; fixtures?: Record<string, unknown> } = {}
): ToolSet {
  const schemas = options.code ? dashboardAgentCodeToolSchemas : dashboardAgentToolSchemas;
  const fixtures = { ...FIXTURES, ...(options.fixtures ?? {}) };
  const entries = Object.entries(schemas).map(([name, schema]) => {
    const s = schema as { description?: string; inputSchema: z.ZodTypeAny };
    const withExecute = tool({
      description: s.description,
      inputSchema: s.inputSchema,
      execute: async (input: unknown) => {
        const output = ((): unknown => {
          // navigate_to doesn't fetch anything: the real one echoes the intent it
          // built, so the fixture does too.
          if (name === "navigate_to") return input;
          // schedule_watch creates nothing either: it hands the spec back as the
          // intent that opens the pre-filled card.
          if (name === "schedule_watch") {
            return { intent: { kind: "watch", spec: (input as { watch?: unknown }).watch } };
          }
          // render_view echoes the spec and — for an investigation — reports the
          // identity the store assigned, which is what the model carries forward.
          if (name === "render_view") {
            const spec = input as { blocks?: Array<{ type?: string }> };
            const hasInvestigation = (spec.blocks ?? []).some((b) => b?.type === "investigation");
            return hasInvestigation
              ? { blocks: spec.blocks, investigationId: EVAL_INVESTIGATION_ID }
              : input;
          }
          if (name === "get_current_page") return CLIENT_DATA.pageContext;
          return fixtures[name] ?? {};
        })();
        calls.push({ tool: name, input, output });
        return output;
      },
    });
    return [name, withExecute] as const;
  });
  return Object.fromEntries(entries) as ToolSet;
}

// The judge's ground truth: every tool result the turn actually received, in
// order. Using the case's fixture overrides instead would hide the base fixtures
// that filled in for tools the override doesn't mention.
function toolTranscript(calls: RecordedCall[]): unknown {
  return calls
    .filter((c) => c.tool !== "render_view")
    .map((c) => ({ tool: c.tool, input: c.input, result: c.output }));
}

function userMessage(text: string, id = "u1"): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function collectText(chunks: UIMessageChunk[]): string {
  return chunks
    .filter((c): c is Extract<UIMessageChunk, { type: "text-delta" }> => c.type === "text-delta")
    .map((c) => c.delta)
    .join("");
}

let caseCounter = 0;

// A repo snapshot in clientData puts the turn in code mode: the code system
// prompt (source guidelines + grounding degradation) and the source tools.
const REPO_SNAPSHOT = {
  tarballUrl: "https://example.invalid/eval.tar.gz",
  owner: "acme",
  repo: "checkout",
  sha: "cafebabecafebabecafebabecafebabecafebabe",
  defaultBranch: "main",
};

async function runCase(
  question: string,
  options: { code?: boolean; fixtures?: Record<string, unknown> } = {}
): Promise<{
  calls: RecordedCall[];
  answer: string;
}> {
  const calls: RecordedCall[] = [];
  const harness = mockChatAgent(dashboardAgent, {
    chatId: `eval_${caseCounter++}`,
    clientData: options.code ? { ...CLIENT_DATA, repoSnapshot: REPO_SNAPSHOT } : CLIENT_DATA,
    setupLocals: ({ set }) => {
      set(dashboardAgentStoreKey, NOOP_STORE);
      set(dashboardAgentModelKey, anthropic(AGENT_MODEL));
      set(dashboardAgentToolsKey, makeFixtureTools(calls, options));
    },
  });
  try {
    const turn = await harness.sendMessage(userMessage(question));
    return { calls, answer: collectText(turn.chunks) };
  } finally {
    await harness.close();
  }
}

// ---------------------------------------------------------------------------
// LLM-as-judge: analytic rubric, reason-before-score, structured output.
// ---------------------------------------------------------------------------

const Verdict = z.object({
  reasoning: z.string().describe("One or two sentences of reasoning, written BEFORE the scores."),
  grounded: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe(
      "Is every fact in the answer present in the tool data? Penalize any run id, error name, count, status, version, or metric not in the data. 5 = fully grounded, 1 = fabricated."
    ),
  answersQuestion: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe("Does the answer directly address the user's question? 5 = fully, 1 = not at all."),
  concise: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe("Direct and free of padding. Do not reward length."),
});

const JUDGE_SYSTEM = [
  "You are a strict evaluator of a Trigger.dev dashboard assistant.",
  "You are given the user's question, the data the assistant retrieved through its tools (treat this as the only ground truth), and the assistant's answer.",
  "Reason briefly first, then score each criterion from 1 to 5.",
  "Judge only on factual grounding and whether the question is answered. Do NOT reward verbosity, confidence, or style. Penalize any value (run id, error name, count, status, version, metric) that does not appear in the tool data.",
].join(" ");

async function judge(args: {
  question: string;
  toolData: unknown;
  answer: string;
}): Promise<z.infer<typeof Verdict>> {
  const { object } = await generateObject({
    model: anthropic(JUDGE_MODEL),
    schema: Verdict,
    system: JUDGE_SYSTEM,
    prompt: [
      `User question:\n${args.question}`,
      `Tool data (ground truth):\n${JSON.stringify(args.toolData, null, 2)}`,
      `Assistant answer:\n${args.answer}`,
      "Score the answer.",
    ].join("\n\n"),
  });
  return object;
}

/**
 * A single yes/no judgement about the answer, for the honesty rules a numeric
 * rubric can't express ("makes no absence claim", "the cause is config, not
 * code"). Reason-before-verdict, same as the rubric judge.
 */
const ClaimVerdict = z.object({
  reasoning: z.string().describe("One or two sentences of reasoning, written BEFORE the verdict."),
  holds: z.boolean().describe("True only if the claim about the answer is fully true."),
});

async function judgeClaim(args: {
  question: string;
  toolData: unknown;
  answer: string;
  /**
   * The investigation card's final state, when the turn rendered one. The design
   * puts the conclusion on the card and forbids restating it in prose, so the
   * user-visible output is card + closing line — judging the prose alone would
   * demand the duplication the prompt bans.
   */
  card?: unknown;
  claim: string;
}): Promise<z.infer<typeof ClaimVerdict>> {
  const { object } = await generateObject({
    model: anthropic(JUDGE_MODEL),
    schema: ClaimVerdict,
    system: [
      "You are a strict evaluator of a Trigger.dev dashboard assistant.",
      "You are given the user's question, the data the assistant retrieved through its tools (the only ground truth), what the assistant told the user, and a claim about it.",
      "What the assistant told the user may come in two parts: a structured card it rendered in the dashboard panel, and a short closing line of prose. The card is the primary answer and the prose deliberately does not repeat it, so judge them together as one answer.",
      "Reason briefly, then decide whether the claim is fully true. Be strict: if any part of what the user was told violates it, the claim does not hold.",
    ].join(" "),
    prompt: [
      `User question:\n${args.question}`,
      `Tool data (ground truth):\n${JSON.stringify(args.toolData, null, 2)}`,
      ...(args.card ? [`Card the assistant rendered:\n${JSON.stringify(args.card, null, 2)}`] : []),
      `Assistant closing prose:\n${args.answer || "(none)"}`,
      `Claim to evaluate:\n${args.claim}`,
    ].join("\n\n"),
  });
  return object;
}

// ---------------------------------------------------------------------------
// Investigation helpers — read the cards the turn actually rendered
// ---------------------------------------------------------------------------

type InvestigationRender = { state: Record<string, any>; investigationId?: string };

function investigationRenders(calls: RecordedCall[]): InvestigationRender[] {
  return calls
    .filter((c) => c.tool === "render_view")
    .flatMap((c) => {
      const input = c.input as {
        blocks?: Array<{ type?: string; investigation?: Record<string, any> }>;
        investigationId?: string;
      };
      return (input.blocks ?? [])
        .filter((b) => b?.type === "investigation" && b.investigation)
        .map((b) => ({ state: b.investigation!, investigationId: input.investigationId }));
    });
}

// The turn's card history, as a compact log so a failing case is diagnosable.
function describeRenders(renders: InvestigationRender[]): string {
  if (renders.length === 0) return "  (no investigation blocks rendered)";
  return renders
    .map(
      (r, i) =>
        `  render ${i}: outcome=${r.state.outcome} confidence=${r.state.confidence} ` +
        `hypotheses=${(r.state.hypotheses ?? []).length} id=${r.investigationId ?? "(new)"}`
    )
    .join("\n");
}

// The tool-call sequence, with just enough of each input to see what was asked.
// Printed on every case so diagnosing behavior never needs a rerun.
function describeCalls(calls: RecordedCall[]): string {
  if (calls.length === 0) return "  (no tool calls)";
  return calls
    .map((c, i) => {
      const input = JSON.stringify(c.input) ?? "";
      const shown =
        c.tool === "render_view"
          ? `blocks=${((c.input as { blocks?: unknown[] }).blocks ?? [])
              .map((b) => (b as { type?: string })?.type)
              .join(
                "+"
              )} id=${(c.input as { investigationId?: string }).investigationId ?? "(new)"}`
          : input.length > 160
            ? `${input.slice(0, 160)}…`
            : input;
      return `  ${i + 1}. ${c.tool} ${shown}`;
    })
    .join("\n");
}

// One diagnosable block per case: what it called, what it rendered, what it said.
function report(
  label: string,
  calls: RecordedCall[],
  answer: string,
  renders?: InvestigationRender[]
): void {
  // process.stdout.write (not console.log) so it survives vitest's console intercept.
  process.stdout.write(
    `\n=== ${label} (${calls.length} tool calls) ===\n` +
      `${describeCalls(calls)}\n` +
      (renders ? `${describeRenders(renders)}\n` : "") +
      `--- answer ---\n${answer || "(empty)"}\n`
  );
}

/**
 * Run a golden case, and on failure run it exactly once more.
 *
 * These are single real-model samples, so a case can miss for reasons that have
 * nothing to do with the behavior under test: the turn wanders into the step
 * ceiling, the provider rejects a malformed tool-call payload, the judge reads a
 * borderline sentence the strict way. The tool-selection eval already handles
 * this by scoring a rate instead of a single sample; a golden case can't average,
 * so it gets one retry instead. The assertions themselves are untouched — two
 * misses in a row still reds the suite, which is the trend we care about — and
 * both attempts print their transcript, so a real regression is visible as a
 * repeated failure rather than hidden by the retry.
 */
async function goldenCase(body: () => Promise<void>): Promise<void> {
  // One retry for behavior. A provider-side failure (the API rejecting a
  // malformed tool-call payload mid-turn, a stream error) says nothing about the
  // behavior under test, so it doesn't spend that retry — it just runs again.
  let behaviorAttemptsLeft = 2;
  let infraAttemptsLeft = 2;
  for (;;) {
    try {
      await body();
      return;
    } catch (error) {
      const infra = error instanceof Error && error.name.includes("APICallError");
      const left = infra ? --infraAttemptsLeft : --behaviorAttemptsLeft;
      if (left <= 0) throw error;
      process.stdout.write(
        `\n(${infra ? "provider error" : "attempt failed"}: ` +
          `${error instanceof Error ? error.message.split("\n")[0] : error}) — retrying\n`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Tool-selection cases
// ---------------------------------------------------------------------------

// `expect` is the tool the first call must be. A few questions are genuinely
// ambiguous *by the prompt's own rules* — the prompt routes them two ways — so
// those list every first call the design considers correct.
const TOOL_CASES: Array<{ question: string; expect: string | string[] }> = [
  { question: "What errors are happening in this environment?", expect: "list_errors" },
  // "what's broken" is a list_errors question and "is anything wrong" is a
  // get_report question; this phrasing sits on the line, so both are correct.
  { question: "What's broken right now?", expect: ["list_errors", "get_report"] },
  { question: "Are there any unresolved errors?", expect: "list_errors" },
  { question: "Give me the full detail for error_stripe.", expect: "get_error" },
  { question: "Show me the runs behind the error error_stripe.", expect: "list_runs" },
  // A "show me" request routes to navigate_to; without a filter to carry, reading
  // the runs and answering is equally defensible.
  {
    question: "Show me the failed runs in this environment.",
    expect: ["list_runs", "navigate_to"],
  },
  { question: "List the most recent runs of the send-receipt task.", expect: "list_runs" },
  { question: "What's the status of run run_a1?", expect: "get_run" },
  // The prompt orders get_run before get_run_trace when diagnosing a run, so
  // opening on either is on-design.
  {
    question: "Why did run run_a1 fail? Walk me through what happened.",
    expect: ["get_run", "get_run_trace"],
  },
  { question: "What tasks are deployed in this environment?", expect: "list_tasks" },
  { question: "Which projects can I access?", expect: "list_projects" },
  { question: "What environments does this project have?", expect: "list_environments" },
  // M3: navigation, the health report, versions, queues, and docs.
  {
    question: "Show me the failed runs of send-receipt in the last day.",
    expect: "navigate_to",
  },
  { question: "Take me to run run_a1.", expect: "navigate_to" },
  { question: "How is prod doing?", expect: "get_report" },
  { question: "Is anything wrong right now?", expect: "get_report" },
  { question: "What commit is run run_a1 running?", expect: "correlate_version" },
  { question: "How do I use batchTrigger?", expect: "search_docs" },
  { question: "How deep is the email queue?", expect: "get_queue" },
  { question: "What was deployed recently?", expect: "list_deploys" },
  // M6: "tell me when" is a watch, never a poll.
  // Named id on purpose: "this run" would legitimately open on get_current_page.
  { question: "Tell me when run run_a1 finishes.", expect: "schedule_watch" },
];

// 21 cases; tolerate ~3 misses. A single nondeterministic miss shouldn't red the
// suite, a trend should.
const TOOL_SELECTION_THRESHOLD = 0.83;

describe.skipIf(!HAS_KEY)("dashboardAgent evals (real model)", () => {
  it("tool selection: picks the right tool for the question", async () => {
    const results: Array<{ question: string; expected: string; got: string; ok: boolean }> = [];
    // Sequential on purpose: mockChatAgent installs its stubs as process-global
    // module overrides, so two harnesses in one process clobber each other. The
    // timeout is sized for 20 real-model turns instead.
    for (const c of TOOL_CASES) {
      const started = Date.now();
      const accepted = Array.isArray(c.expect) ? c.expect : [c.expect];
      const { calls } = await runCase(c.question);
      const got = calls[0]?.tool ?? "(none)";
      const ok = accepted.includes(got);
      results.push({ question: c.question, expected: accepted.join(" | "), got, ok });
      // Progress as it goes, so a slow or hung case is visible without a rerun.
      process.stdout.write(
        `  [${results.length}/${TOOL_CASES.length}] ${ok ? "PASS" : "FAIL"} ` +
          `${got} (want ${accepted.join(" | ")}) ${Math.round((Date.now() - started) / 1000)}s\n`
      );
    }

    const passed = results.filter((r) => r.ok).length;
    const rate = passed / results.length;
    // Surface the full table so a failing case is diagnosable, not just a number.
    // process.stdout.write (not console.log) so it survives vitest's console intercept.
    process.stdout.write(
      `\ntool selection: ${passed}/${results.length} (${(rate * 100).toFixed(0)}%)\n` +
        results
          .map(
            (r) =>
              `  ${r.ok ? "PASS" : "FAIL"}  ${r.got.padEnd(18)} (want ${r.expected})  ${r.question}`
          )
          .join("\n") +
        "\n"
    );

    expect(rate).toBeGreaterThanOrEqual(TOOL_SELECTION_THRESHOLD);
    // 20 sequential real-model turns at ~10-25s each: budget generously so a
    // slow API day is a slow test, not a red suite.
  }, 900_000);

  it("answer quality: grounded and on-question (LLM judge)", async () => {
    const question = "What errors are happening in this environment? Summarize the top ones.";
    const { calls, answer } = await runCase(question);

    expect(calls[0]?.tool).toBe("list_errors");
    expect(answer.length).toBeGreaterThan(0);

    const verdict = await judge({ question, toolData: toolTranscript(calls), answer });
    report("answer quality", calls, answer);
    process.stdout.write(`judge: ${JSON.stringify(verdict)}\n`);

    expect(verdict.grounded).toBeGreaterThanOrEqual(4);
    expect(verdict.answersQuestion).toBeGreaterThanOrEqual(4);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// Golden investigation cases
//
// One canned scenario each, aimed at the rules the protocol prompt encodes:
// where the cause lands (config vs code), whether the card progresses on ONE
// investigation, whether a thin case stays inconclusive, and the two honesty
// traps (a dirty deploy, a truncated page). Deterministic assertions read the
// cards the turn rendered; the judge only rules on prose.
// ---------------------------------------------------------------------------

// Saturation: flow is crit on the env concurrency limit, execution is clean and
// there are no errors at all — so a code cause is unsupported by the evidence.
const SATURATION_FIXTURES: Record<string, unknown> = {
  list_errors: { errors: [], nextCursor: undefined },
  get_queue: {
    queue: "task/send-receipt",
    period: "1h",
    waitMs: { p50: 38000, p95: 121000 },
    peakQueued: 4210,
    startedCount: 7200,
    startedPerMin: 120,
    throttledCount: 5400,
    bucketIntervalMs: 300000,
    depthTrend: [10, 120, 900, 2400, 4210],
  },
  list_runs: {
    runs: [
      { id: "run_q1", status: "QUEUED", taskIdentifier: "send-receipt", durationMs: 0 },
      { id: "run_q2", status: "QUEUED", taskIdentifier: "send-receipt", durationMs: 0 },
      { id: "run_q3", status: "COMPLETED", taskIdentifier: "send-receipt", durationMs: 1100 },
    ],
    nextCursor: undefined,
  },
};

// Schema drift: the task reads a field the payload no longer carries, and the
// source at the run's own commit shows exactly that line.
const RECEIPT_SOURCE = [
  "export const sendReceipt = task({",
  '  id: "send-receipt",',
  "  run: async (payload: ReceiptPayload) => {",
  "    const currency = payload.order.total.currency;",
  "    return email.send({ currency });",
  "  },",
  "});",
].join("\n");

const DRIFT_FIXTURES: Record<string, unknown> = {
  get_run: {
    id: "run_a1",
    status: "FAILED",
    taskIdentifier: "send-receipt",
    version: "20260102.1",
    durationMs: 120,
    error: {
      name: "TypeError",
      message: "Cannot read properties of undefined (reading 'currency')",
      stackTrace: "at sendReceipt (src/trigger/receipt.ts:42:38)",
    },
  },
  get_run_trace: {
    traceId: "trace_a1",
    spans: [
      {
        depth: 0,
        task: "send-receipt",
        durationMs: 120,
        isError: true,
        message: "TypeError: Cannot read properties of undefined (reading 'currency')",
      },
    ],
    truncated: false,
  },
  list_errors: {
    errors: [
      {
        id: "error_drift",
        taskIdentifier: "send-receipt",
        errorType: "TypeError",
        errorMessage: "Cannot read properties of undefined (reading 'currency')",
        status: "unresolved",
        count: 128,
        firstSeen: "2026-01-02T09:04:00.000Z",
      },
    ],
    nextCursor: undefined,
  },
  search_code: {
    matches: [
      {
        path: "src/trigger/receipt.ts",
        line: 42,
        text: "    const currency = payload.order.total.currency;",
      },
    ],
    sha: "cafebabecafebabecafebabecafebabecafebabe",
  },
  read_file: {
    path: "src/trigger/receipt.ts",
    startLine: 38,
    endLine: 44,
    sha: "cafebabecafebabecafebabecafebabecafebabe",
    content: RECEIPT_SOURCE,
  },
  get_repo_info: {
    owner: "acme",
    repo: "checkout",
    sha: "cafebabecafebabecafebabecafebabecafebabe",
    defaultBranch: "main",
  },
  list_files: { files: ["src/trigger/receipt.ts", "src/trigger/rollup.ts"] },
};

// Same failure, but the deployed version came off a dirty working tree: the
// source we can read is only the nearest snapshot.
const DIRTY_FIXTURES: Record<string, unknown> = {
  ...DRIFT_FIXTURES,
  correlate_version: {
    runId: "run_a1",
    version: "20260102.1",
    sha: "cafebabecafebabecafebabecafebabecafebabe",
    dirty: true,
    shortCode: "abc1234",
    git: { commitMessage: "wip receipts", commitRef: "main" },
  },
};

// Flaky upstream: intermittent, spread across two versions, no deploy in the
// window, and the trace stops short — nothing settles either way.
const FLAKY_FIXTURES: Record<string, unknown> = {
  list_runs: {
    runs: [
      { id: "run_f1", status: "FAILED", taskIdentifier: "send-receipt", version: "20260101.1" },
      { id: "run_f2", status: "COMPLETED", taskIdentifier: "send-receipt", version: "20260101.1" },
      { id: "run_f3", status: "COMPLETED", taskIdentifier: "send-receipt", version: "20260102.1" },
      { id: "run_f4", status: "FAILED", taskIdentifier: "send-receipt", version: "20260102.1" },
    ],
    nextCursor: undefined,
  },
  get_run: {
    id: "run_f1",
    status: "FAILED",
    taskIdentifier: "send-receipt",
    error: {
      name: "FetchError",
      message: "request to https://api.upstream.test failed: ETIMEDOUT",
    },
  },
  get_run_trace: {
    traceId: "trace_f1",
    spans: [{ depth: 0, task: "send-receipt", durationMs: 30010, isError: true, message: "run" }],
    truncated: true,
    note: "Spans for this run are no longer retained.",
  },
  list_errors: {
    errors: [
      {
        id: "error_timeout",
        taskIdentifier: "send-receipt",
        errorType: "FetchError",
        errorMessage: "request to https://api.upstream.test failed: ETIMEDOUT",
        status: "unresolved",
        count: 9,
      },
    ],
    nextCursor: undefined,
  },
  get_error: {
    id: "error_timeout",
    taskIdentifier: "send-receipt",
    errorType: "FetchError",
    errorMessage: "request to https://api.upstream.test failed: ETIMEDOUT",
    status: "unresolved",
    count: 9,
    affectedVersions: ["20260101.1", "20260102.1"],
    resolvedAt: null,
  },
  list_deploys: { deploys: [] },
  get_queue: {
    queue: "task/send-receipt",
    period: "1h",
    waitMs: { p50: 40, p95: 120 },
    peakQueued: 2,
    startedCount: 300,
    throttledCount: 0,
    depthTrend: [1, 2, 1, 0, 1],
  },
};

// Symptom-only: every run fails the same way, every time, and the symptom is
// vivid — a socket hangup at exactly 30s. Nothing says WHY. The trap is the
// opposite of the flaky-upstream one: there the evidence is thin and obviously
// unsettled, here it is thick, consistent and tempting, and consistency reads as
// explanation. "The runs fail because the connection resets" restates the
// symptom with the word "because" in front of it, so the only honest verdict is
// still inconclusive.
const SYMPTOM_ONLY_FIXTURES: Record<string, unknown> = {
  list_runs: {
    runs: [
      { id: "run_s1", status: "FAILED", taskIdentifier: "send-receipt", durationMs: 30004 },
      { id: "run_s2", status: "FAILED", taskIdentifier: "send-receipt", durationMs: 30002 },
      { id: "run_s3", status: "FAILED", taskIdentifier: "send-receipt", durationMs: 30007 },
    ],
    nextCursor: undefined,
  },
  get_run: {
    id: "run_s1",
    status: "FAILED",
    taskIdentifier: "send-receipt",
    version: "20260101.1",
    durationMs: 30004,
    error: { name: "Error", message: "socket hang up (ECONNRESET)" },
  },
  get_run_trace: {
    traceId: "trace_s1",
    spans: [
      {
        depth: 0,
        task: "send-receipt",
        durationMs: 30004,
        isError: true,
        message: "Error: socket hang up (ECONNRESET)",
      },
    ],
    truncated: false,
    note: "The task emits no child spans, so there is no breakdown of the 30s.",
  },
  list_errors: {
    errors: [
      {
        id: "error_hangup",
        taskIdentifier: "send-receipt",
        errorType: "Error",
        errorMessage: "socket hang up (ECONNRESET)",
        status: "unresolved",
        count: 214,
      },
    ],
    nextCursor: undefined,
  },
  get_error: {
    id: "error_hangup",
    taskIdentifier: "send-receipt",
    errorType: "Error",
    errorMessage: "socket hang up (ECONNRESET)",
    status: "unresolved",
    count: 214,
    affectedVersions: ["20260101.1"],
    resolvedAt: null,
  },
  list_deploys: { deploys: [] },
  get_queue: {
    queue: "task/send-receipt",
    period: "1h",
    waitMs: { p50: 30, p95: 90 },
    peakQueued: 3,
    startedCount: 220,
    throttledCount: 0,
    depthTrend: [2, 3, 2, 1, 2],
  },
};

// Truncation trap: EVERY page the model can reach is explicitly incomplete, so
// nothing it reads can support a claim about what ISN'T failing. The error list
// is truncated too — with a complete one the model could legitimately answer the
// completeness question from it, and the trap wouldn't be a trap.
const TRUNCATED_FIXTURES: Record<string, unknown> = {
  list_runs: {
    runs: [
      { id: "run_t1", status: "FAILED", taskIdentifier: "send-receipt" },
      { id: "run_t2", status: "FAILED", taskIdentifier: "send-receipt" },
      { id: "run_t3", status: "FAILED", taskIdentifier: "send-receipt" },
    ],
    truncated: true,
    nextCursor: "cursor_more",
  },
  list_errors: {
    errors: [
      {
        id: "error_stripe",
        taskIdentifier: "send-receipt",
        errorType: "TimeoutError",
        errorMessage: "Stripe API timed out after 30s",
        status: "unresolved",
        count: 37,
      },
    ],
    truncated: true,
    nextCursor: "cursor_more",
  },
};

describe.skipIf(!HAS_KEY)("dashboardAgent investigation evals (real model)", () => {
  it(
    "env-limit saturation: concludes on flow/config, not code",
    () =>
      goldenCase(async () => {
        const question =
          "Runs stopped starting in production about half an hour ago. Investigate what's going on.";
        const { calls, answer } = await runCase(question, { fixtures: SATURATION_FIXTURES });
        const renders = investigationRenders(calls);
        report("saturation", calls, answer, renders);

        // The card came out early and progressed on ONE investigation.
        expect(renders.length).toBeGreaterThanOrEqual(2);
        expect(renders[0]?.state.outcome).toBe("in_progress");
        expect(renders[renders.length - 1]?.state.outcome).toBe("concluded");
        // Every render after the first points back at the id the tool returned.
        for (const render of renders.slice(1)) {
          expect(render.investigationId).toBe(EVAL_INVESTIGATION_ID);
        }
        // A concluded card carries a fix and no what-to-check-next.
        expect(renders[renders.length - 1]?.state.remediation).toBeTruthy();
        // It answered inside the step ceiling instead of dying at it.
        expect(answer.length).toBeGreaterThan(0);

        const verdict = await judgeClaim({
          question,
          toolData: toolTranscript(calls),
          answer,
          card: renders[renders.length - 1]?.state,
          claim:
            "The conclusion attributes the cause to flow/configuration — the environment or queue concurrency limit throttling runs before they start — and does NOT blame a bug in the user's task code.",
        });
        process.stdout.write(`\njudge: ${JSON.stringify(verdict)}\n`);
        expect(verdict.holds).toBe(true);
      }),
    // Two attempts of a real-model turn plus a judge call each.
    840_000
  );

  it(
    "schema drift: concludes on the source it read, citing the file",
    () =>
      goldenCase(async () => {
        const question =
          "Every send-receipt run has failed since this morning's deploy. Investigate why.";
        const { calls, answer } = await runCase(question, {
          code: true,
          fixtures: DRIFT_FIXTURES,
        });
        const renders = investigationRenders(calls);
        report("schema drift", calls, answer, renders);

        const final = renders[renders.length - 1];
        expect(final?.state.outcome).toBe("concluded");
        expect(calls.some((c) => c.tool === "read_file" || c.tool === "search_code")).toBe(true);
        // The card points at the code that ran, not just at the error text.
        expect(JSON.stringify(final?.state)).toContain("src/trigger/receipt.ts");

        const verdict = await judgeClaim({
          question,
          toolData: toolTranscript(calls),
          answer,
          card: renders[renders.length - 1]?.state,
          claim:
            "The conclusion is grounded in the source that was actually read: it names the file (src/trigger/receipt.ts) and the field access that broke, rather than speculating about code it never read.",
        });
        process.stdout.write(`\njudge: ${JSON.stringify(verdict)}\n`);
        expect(verdict.holds).toBe(true);
      }),
    // Two attempts of a real-model turn plus a judge call each.
    840_000
  );

  it(
    "show code: answers the button's ask with a fenced diff pinned to the file it read",
    () =>
      goldenCase(async () => {
        // The real canned ask the "Show code" button sends, on the file the drift
        // fixtures serve. It is a propose-a-change request, not an explanation.
        const question = showCodeAskPrompt({
          path: "src/trigger/receipt.ts",
          line: 42,
          sha: REPO_SNAPSHOT.sha,
        });
        const { calls, answer } = await runCase(question, { code: true, fixtures: DRIFT_FIXTURES });
        report("show code", calls, answer);

        // A fenced diff, citing the file at the pinned commit.
        expect(answer).toMatch(/```diff/);
        expect(answer).toContain("src/trigger/receipt.ts");
        expect(answer).toContain(REPO_SNAPSHOT.sha.slice(0, 7));

        const verdict = await judgeClaim({
          question,
          toolData: toolTranscript(calls),
          answer,
          claim:
            "The answer proposes a concrete minimal change as a fenced diff for src/trigger/receipt.ts, anchored to the line and commit the question named. It does not merely explain the code or restate the investigation.",
        });
        process.stdout.write(`\njudge: ${JSON.stringify(verdict)}\n`);
        expect(verdict.holds).toBe(true);
      }),
    // Two attempts of a real-model turn plus a judge call each.
    840_000
  );

  it(
    "flaky upstream: stays inconclusive and offers no fix",
    () =>
      goldenCase(async () => {
        const question =
          "send-receipt fails maybe one run in five and I can't see a pattern. What's causing it?";
        const { calls, answer } = await runCase(question, { fixtures: FLAKY_FIXTURES });
        const renders = investigationRenders(calls);
        report("flaky upstream", calls, answer, renders);

        const final = renders[renders.length - 1];
        expect(final?.state.outcome).toBe("inconclusive");
        // The endings are exclusive: what to check next, never a fix.
        expect(final?.state.remediation).toBeFalsy();
        expect((final?.state.checkNext ?? []).length).toBeGreaterThan(0);

        const verdict = await judgeClaim({
          question,
          toolData: toolTranscript(calls),
          answer,
          card: renders[renders.length - 1]?.state,
          claim:
            "The answer says the cause is not established and suggests what to check next. It does NOT present a fix or a remedy as if the cause were known.",
        });
        process.stdout.write(`\njudge: ${JSON.stringify(verdict)}\n`);
        expect(verdict.holds).toBe(true);
      }),
    // Two attempts of a real-model turn plus a judge call each.
    840_000
  );

  it(
    "symptom is not a cause: won't pass a restated symptom off as the verdict",
    () =>
      goldenCase(async () => {
        const question =
          "Every send-receipt run has died with a socket hang up for the last hour. What's causing it?";
        const { calls, answer } = await runCase(question, { fixtures: SYMPTOM_ONLY_FIXTURES });
        const renders = investigationRenders(calls);
        report("symptom is not a cause", calls, answer, renders);

        // Nothing in the evidence says HOW the failure happens, so there is no
        // mechanism to conclude on — and no fix to offer.
        const final = renders[renders.length - 1];
        expect(final?.state.outcome).toBe("inconclusive");
        expect(final?.state.remediation).toBeFalsy();

        const verdict = await judgeClaim({
          question,
          toolData: toolTranscript(calls),
          answer,
          card: final?.state,
          claim:
            "The answer does not present a cause. In particular it never offers a RESTATEMENT OF THE SYMPTOM as the cause — 'the runs fail because the connection is being reset / because the request times out / because of a transient network or upstream issue' is a restatement, not a mechanism, and would break this claim. A mechanism would show HOW the failure happens (a specific limit that is saturated, a specific line of code dereferencing a specific missing field); no such evidence exists here, so the answer says the cause is not established and names what to check next.",
        });
        process.stdout.write(`\njudge: ${JSON.stringify(verdict)}\n`);
        expect(verdict.holds).toBe(true);
      }),
    // Two attempts of a real-model turn plus a judge call each.
    840_000
  );

  it(
    "dirty deploy: hedges the source as the nearest snapshot",
    () =>
      goldenCase(async () => {
        const question = "Why did run run_a1 fail? It's on the version we shipped this morning.";
        const { calls, answer } = await runCase(question, { code: true, fixtures: DIRTY_FIXTURES });
        const renders = investigationRenders(calls);
        const card = JSON.stringify(renders[renders.length - 1]?.state ?? {});
        report("dirty deploy", calls, answer, renders);

        // The forbidden claim, in the prose and on the card: asserting the source it
        // read IS what ran. (Naming the phrase to deny it — "the exact deployed code
        // may differ" — is the hedge we want, so match the assertion, not the words.)
        const identityClaim =
          /(is|was|matches|reflects) (exactly )?(the )?(exact )?deployed code\b|is (exactly )?what (actually )?ran\b/i;
        expect(answer).not.toMatch(identityClaim);
        expect(card).not.toMatch(identityClaim);
        // The hedge lands somewhere the user sees it.
        expect(`${answer}\n${card}`).toMatch(/snapshot|not provably|may differ/i);

        const verdict = await judgeClaim({
          question,
          toolData: toolTranscript(calls),
          answer,
          card: renders[renders.length - 1]?.state,
          claim:
            "Because the deployed version was built from a dirty working tree, the answer treats the source it read as the nearest repository snapshot rather than the exact deployed code, and says so. It never asserts the code it read is what ran.",
        });
        process.stdout.write(`\njudge: ${JSON.stringify(verdict)}\n`);
        expect(verdict.holds).toBe(true);
      }),
    // Two attempts of a real-model turn plus a judge call each.
    840_000
  );

  it(
    "truncation trap: makes no absence claim off a truncated page",
    () =>
      goldenCase(async () => {
        const question = "Did anything other than send-receipt fail in the last hour?";
        const { calls, answer } = await runCase(question, { fixtures: TRUNCATED_FIXTURES });
        report("truncation trap", calls, answer);

        expect(answer.length).toBeGreaterThan(0);

        const verdict = await judgeClaim({
          question,
          toolData: toolTranscript(calls),
          answer,
          claim:
            'Every list the assistant read was explicitly truncated (truncated: true with a nextCursor). The answer therefore makes no claim about the WORLD: it never says that only send-receipt failed, that nothing else failed, or that no other task shows failures — not even hedged. Reporting what was on the page ("the only group on this page was send-receipt") is fine, and required, as long as the answer says the list was incomplete and that other failures can\'t be ruled out.',
        });
        process.stdout.write(`\njudge: ${JSON.stringify(verdict)}\n`);
        expect(verdict.holds).toBe(true);
      }),
    // Two attempts of a real-model turn plus a judge call each.
    840_000
  );
});
