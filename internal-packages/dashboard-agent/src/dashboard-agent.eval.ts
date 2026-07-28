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
import { dashboardAgentToolSchemas } from "./tool-schemas";

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

// Real schemas (so the model sees the real tool descriptions) + stubbed executes
// that record each call (a spy) and return the fixture. This is the seam that
// lets us observe tool selection and judge answers with no live API.
function makeFixtureTools(calls: Array<{ tool: string; input: unknown }>): ToolSet {
  const entries = Object.entries(dashboardAgentToolSchemas).map(([name, schema]) => {
    const s = schema as { description?: string; inputSchema: z.ZodTypeAny };
    const withExecute = tool({
      description: s.description,
      inputSchema: s.inputSchema,
      execute: async (input: unknown) => {
        calls.push({ tool: name, input });
        // render_view and navigate_to don't fetch anything: the real ones echo
        // back the spec / the intent they built, so the fixtures do too.
        if (name === "render_view" || name === "navigate_to") return input;
        if (name === "get_current_page") return CLIENT_DATA.pageContext;
        return FIXTURES[name] ?? {};
      },
    });
    return [name, withExecute] as const;
  });
  return Object.fromEntries(entries) as ToolSet;
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

async function runCase(question: string): Promise<{
  calls: Array<{ tool: string; input: unknown }>;
  answer: string;
}> {
  const calls: Array<{ tool: string; input: unknown }> = [];
  const harness = mockChatAgent(dashboardAgent, {
    chatId: `eval_${caseCounter++}`,
    clientData: CLIENT_DATA,
    setupLocals: ({ set }) => {
      set(dashboardAgentStoreKey, NOOP_STORE);
      set(dashboardAgentModelKey, anthropic(AGENT_MODEL));
      set(dashboardAgentToolsKey, makeFixtureTools(calls));
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

// ---------------------------------------------------------------------------
// Tool-selection cases
// ---------------------------------------------------------------------------

const TOOL_CASES: Array<{ question: string; expect: string }> = [
  { question: "What errors are happening in this environment?", expect: "list_errors" },
  { question: "What's broken right now?", expect: "list_errors" },
  { question: "Are there any unresolved errors?", expect: "list_errors" },
  { question: "Give me the full detail for error_stripe.", expect: "get_error" },
  { question: "Show me the runs behind the error error_stripe.", expect: "list_runs" },
  { question: "Show me the failed runs in this environment.", expect: "list_runs" },
  { question: "List the most recent runs of the send-receipt task.", expect: "list_runs" },
  { question: "What's the status of run run_a1?", expect: "get_run" },
  { question: "Why did run run_a1 fail? Walk me through what happened.", expect: "get_run_trace" },
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
];

// 20 cases; tolerate ~3 misses. A single nondeterministic miss shouldn't red the
// suite, a trend should.
const TOOL_SELECTION_THRESHOLD = 0.83;

describe.skipIf(!HAS_KEY)("dashboardAgent evals (real model)", () => {
  it("tool selection: picks the right tool for the question", async () => {
    const results: Array<{ question: string; expected: string; got: string; ok: boolean }> = [];
    for (const c of TOOL_CASES) {
      const { calls } = await runCase(c.question);
      const got = calls[0]?.tool ?? "(none)";
      results.push({ question: c.question, expected: c.expect, got, ok: got === c.expect });
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
  }, 180_000);

  it("answer quality: grounded and on-question (LLM judge)", async () => {
    const question = "What errors are happening in this environment? Summarize the top ones.";
    const { calls, answer } = await runCase(question);

    expect(calls[0]?.tool).toBe("list_errors");
    expect(answer.length).toBeGreaterThan(0);

    const verdict = await judge({ question, toolData: FIXTURES.list_errors, answer });
    process.stdout.write(`\nanswer:\n${answer}\n\njudge: ${JSON.stringify(verdict)}\n`);

    expect(verdict.grounded).toBeGreaterThanOrEqual(4);
    expect(verdict.answersQuestion).toBeGreaterThanOrEqual(4);
  }, 120_000);
});
