// `@trigger.dev/sdk/ai/test` MUST be imported before the agent module so the
// resource catalog is installed before `chat.agent({ id })` / `prompts.define`
// register at module load.
import { mockChatAgent, type MockChatAgentHarness } from "@trigger.dev/sdk/ai/test";

import type {
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { simulateReadableStream, type UIMessage, type UIMessageChunk } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { disposeRepoWorkspaces, workdirFor, type RepoSnapshot } from "./repo-tools";
import {
  clientDataSchema,
  dashboardAgent,
  dashboardAgentEvalTriggerKey,
  dashboardAgentModelKey,
  dashboardAgentStoreKey,
  sanitizeReplayedToolInputs,
  type DashboardAgentEvalTrigger,
  type DashboardAgentStore,
} from "./dashboard-agent";
import { buildDashboardAgentTools } from "./tools";

// ---------------------------------------------------------------------------
// Mock model helpers
// ---------------------------------------------------------------------------

const USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function finish(unified: LanguageModelV3FinishReason["unified"]): LanguageModelV3StreamPart {
  return { type: "finish", finishReason: { unified, raw: unified }, usage: USAGE };
}

function textStep(text: string, id = "t1"): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
    finish("stop"),
  ];
}

function toolCallStep(
  toolName: string,
  input: Record<string, unknown> = {},
  toolCallId = "tc1"
): LanguageModelV3StreamPart[] {
  return [
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
    finish("tool-calls"),
  ];
}

/**
 * A MockLanguageModelV3 that plays one stream per `streamText` step (call), plus
 * a `doGenerate` for the background title generation (`generateText`). Each
 * `doStream` call returns a fresh stream for the next entry in `steps` (the last
 * entry repeats if the model is called more times than there are steps).
 */
function mockModel(steps: LanguageModelV3StreamPart[][], titleText = "Test Chat Title") {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const chunks = steps[Math.min(call, steps.length - 1)] ?? [];
      call++;
      return { stream: simulateReadableStream({ chunks }) };
    },
    doGenerate: async () => ({
      content: [{ type: "text", text: titleText }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: USAGE,
      warnings: [],
    }),
  });
}

// ---------------------------------------------------------------------------
// Fake store — records the persistence the agent performs
// ---------------------------------------------------------------------------

type StoreCalls = {
  ensureChat: unknown[];
  persistMessages: unknown[];
  persistTurn: unknown[];
  setChatTitleIfDefault: unknown[];
  upsertInvestigationRevision: unknown[];
};

function fakeStore(): { store: DashboardAgentStore; calls: StoreCalls } {
  const calls: StoreCalls = {
    ensureChat: [],
    persistMessages: [],
    persistTurn: [],
    setChatTitleIfDefault: [],
    upsertInvestigationRevision: [],
  };
  const store: DashboardAgentStore = {
    ensureChat: async (args) => void calls.ensureChat.push(args),
    persistMessages: async (args) => void calls.persistMessages.push(args),
    persistTurn: async (args) => void calls.persistTurn.push(args),
    setChatTitleIfDefault: async (args) => void calls.setChatTitleIfDefault.push(args),
    upsertInvestigationRevision: async (args) => {
      calls.upsertInvestigationRevision.push(args);
      return { ok: true, id: "inv_fake", revision: 0, created: true };
    },
  };
  return { store, calls };
}

// Records the eval enqueues the agent performs, in place of tasks.trigger.
function fakeEvalTrigger(): { trigger: DashboardAgentEvalTrigger; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    trigger: async (payload, options) => void calls.push({ payload, options }),
    calls,
  };
}

const CLIENT_DATA = { userId: "user_1", organizationId: "org_1" };

function userMessage(text: string, id = "u1"): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function collectText(chunks: UIMessageChunk[]): string {
  return chunks
    .filter((c): c is Extract<UIMessageChunk, { type: "text-delta" }> => c.type === "text-delta")
    .map((c) => c.delta)
    .join("");
}

// A tool executed when the agent emits a `tool-output-available` chunk (carries
// the result, keyed by toolCallId). On a head-start handover the tool-call is
// supplied by the handover partial rather than streamed by the model, so the
// output chunk is the only reliable signal that the call actually ran.
function executedTool(chunks: UIMessageChunk[]): boolean {
  return chunks.some((c) => (c as { type?: string }).type === "tool-output-available");
}

// ---------------------------------------------------------------------------
// Harness tests
// ---------------------------------------------------------------------------

describe("dashboardAgent (mock harness)", () => {
  let harness: MockChatAgentHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("streams the model's response and persists the turn", async () => {
    const { store, calls } = fakeStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_text",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, mockModel([textStep("hello from the agent")]));
      },
    });

    const turn = await harness.sendMessage(userMessage("hi"));

    expect(collectText(turn.chunks)).toBe("hello from the agent");

    // Persistence ran through the injected store, not a real database.
    expect(calls.ensureChat).toHaveLength(1);
    expect(calls.persistMessages).toHaveLength(1);
    // onTurnComplete persists after the turn-complete chunk; give it a tick.
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.persistTurn).toHaveLength(1);
  });

  it("executes a read tool the model calls, then answers from the result", async () => {
    const { store } = fakeStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_tool",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        // Step 1: the model calls list_errors. Step 2: it answers.
        set(
          dashboardAgentModelKey,
          mockModel([toolCallStep("list_errors"), textStep("you have no errors")])
        );
      },
    });

    const turn = await harness.sendMessage(userMessage("any errors?"));

    // The tool executed inside the agent (no delegated token in clientData, so it
    // returns its graceful no-auth result — no network), and the model answered.
    expect(executedTool(turn.chunks)).toBe(true);
    expect(collectText(turn.chunks)).toBe("you have no errors");
  });

  it("rolls an Anthropic cache breakpoint onto the last message", async () => {
    const { store } = fakeStore();
    const model = mockModel([textStep("cached")]);
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_cache",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    await harness.sendMessage(userMessage("hi"));

    // The prepareMessages hook should have placed a cacheControl breakpoint on
    // the last message of the prompt the model received.
    const prompt = model.doStreamCalls[0]?.prompt ?? [];
    const last = prompt[prompt.length - 1] as { providerOptions?: Record<string, unknown> };
    expect(last?.providerOptions?.anthropic).toMatchObject({
      cacheControl: { type: "ephemeral" },
    });
  });

  it("Head Start handover: executes the handed-over tool call despite the cache hook (regression)", async () => {
    const { store } = fakeStore();
    // Only step 2 runs in the agent — the warm route already did step 1 and hands
    // over the pending tool call.
    const model = mockModel([textStep("resolved from the tool")]);
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_headstart",
      clientData: CLIENT_DATA,
      mode: "handover-prepare",
      headStartMessages: [userMessage("what errors are happening?")],
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    // The reshaped partial the SDK's chat.headStart sends on a tool-calls finish:
    // a tool-approval round whose trailing tool message must survive prepareMessages
    // for collectToolApprovals to execute the pending call.
    const toolCallId = "tc_hs";
    const approvalId = "ap_hs";
    const turn = await harness.sendHandover({
      partialAssistantMessage: [
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId, toolName: "list_errors", input: {} },
            { type: "tool-approval-request", approvalId, toolCallId },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool-approval-response", approvalId, approved: true }],
        },
      ],
      isFinal: false,
    });

    // With the SDK guard (preserveToolApprovalTail) the handed-over tool executes
    // and the model answers from its result. Without it, the bare tool_use would
    // never execute (no tool output) — this is the regression guard.
    expect(executedTool(turn.chunks)).toBe(true);
    expect(collectText(turn.chunks)).toBe("resolved from the tool");
  });

  // -------------------------------------------------------------------------
  // The settle guard: a card left in_progress when the turn ends is a defect
  // -------------------------------------------------------------------------

  // The turn needs a project + environment for an investigation to be scoped.
  const INVESTIGATION_CLIENT_DATA = {
    ...CLIENT_DATA,
    projectRef: "proj_abc",
    environmentId: "env_abc",
  };

  const openInvestigation = {
    outcome: "in_progress",
    severity: "warn",
    confidence: "medium",
    runId: "run_abc123",
    title: "Why is send-order-receipt failing?",
    headline: "Every attempt came back 429 from the email provider.",
    progress: "Reading the run's spans",
    hypotheses: [
      {
        id: "hyp_rate_limit",
        statement: "The provider is rate limiting this API key.",
        verdict: "testing",
        evidence: [],
      },
    ],
    evidence: [],
  };

  const renderViewStep = (investigation: Record<string, unknown>, toolCallId: string) =>
    toolCallStep("render_view", { blocks: [{ type: "investigation", investigation }] }, toolCallId);

  // The store's view of the investigation after the turn: what a refresh reads.
  const finalInvestigationState = (calls: StoreCalls) =>
    (calls.upsertInvestigationRevision[calls.upsertInvestigationRevision.length - 1] as {
      state: Record<string, any>;
    })!.state;

  it("settles an investigation the turn left in progress", async () => {
    const { store, calls } = fakeStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_open_investigation",
      clientData: INVESTIGATION_CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        // The model opens the card and then just talks — no verdict render, the
        // failure this guard exists for.
        set(
          dashboardAgentModelKey,
          mockModel([renderViewStep(openInvestigation, "tc_open"), textStep("still looking")])
        );
      },
    });

    await harness.sendMessage(userMessage("why is send-order-receipt failing?"));
    await new Promise((r) => setTimeout(r, 30));

    // The turn wrote the open card; the guard wrote the settle on top of it.
    expect(calls.upsertInvestigationRevision).toHaveLength(2);
    const settle = calls.upsertInvestigationRevision[1] as Record<string, any>;
    expect(settle.id).toBe("inv_fake");
    expect(settle.chatId).toBe("chat_open_investigation");
    expect(settle.projectRef).toBe("proj_abc");
    expect(settle.environmentRef).toBe("env_abc");

    const state = finalInvestigationState(calls);
    expect(state.outcome).toBe("inconclusive");
    // No spinner, no invented cause, no fix — and the facts the turn did
    // establish are kept.
    expect(state.progress).toBeUndefined();
    expect(state.remediation).toBeUndefined();
    expect(state.confidence).toBe("low");
    expect(state.headline).toContain("didn't conclude within this turn");
    expect(state.headline).toContain("429");
    expect(state.hypotheses).toHaveLength(1);
  });

  it("leaves a concluded investigation alone", async () => {
    const { store, calls } = fakeStore();
    const concluded = {
      ...openInvestigation,
      outcome: "concluded",
      confidence: "high",
      progress: undefined,
      remediation: "Raise minTimeoutInMs to 30s with a factor of 2.",
      hypotheses: [
        {
          ...openInvestigation.hypotheses[0]!,
          verdict: "validated",
          finding: "All three attempts returned 429 inside 20 seconds.",
        },
      ],
    };
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_concluded_investigation",
      clientData: INVESTIGATION_CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(
          dashboardAgentModelKey,
          mockModel([
            renderViewStep(openInvestigation, "tc_open"),
            renderViewStep(concluded, "tc_verdict"),
            textStep("Rate limited — the retries all land in one window."),
          ])
        );
      },
    });

    await harness.sendMessage(userMessage("why is send-order-receipt failing?"));
    await new Promise((r) => setTimeout(r, 30));

    // Two renders, no third write: a turn that settled its own card is untouched.
    expect(calls.upsertInvestigationRevision).toHaveLength(2);
    const state = finalInvestigationState(calls);
    expect(state.outcome).toBe("concluded");
    expect(state.remediation).toBe("Raise minTimeoutInMs to 30s with a factor of 2.");
  });
});

// ---------------------------------------------------------------------------
// Replayed tool-input sanitizing
// ---------------------------------------------------------------------------

describe("sanitizeReplayedToolInputs", () => {
  it("coerces empty-string and null tool inputs to {} and leaves everything else alone", () => {
    const messages = [
      { role: "user", content: "investigate this" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "get_report", input: "" },
          // `typeof null === "object"` — the case the original check let through,
          // which the Anthropic API rejects with "Input should be an object".
          { type: "tool-call", toolCallId: "tc2", toolName: "list_errors", input: null },
          { type: "tool-call", toolCallId: "tc3", toolName: "get_run", input: { runId: "r1" } },
          { type: "text", text: "looking..." },
        ],
      },
    ] as Parameters<typeof sanitizeReplayedToolInputs>[0];

    const [user, assistant] = sanitizeReplayedToolInputs(messages);
    expect(user).toBe(messages[0]);
    const parts = (assistant as { content: Array<{ input?: unknown }> }).content;
    expect(parts[0]!.input).toEqual({});
    expect(parts[1]!.input).toEqual({});
    expect(parts[2]!.input).toEqual({ runId: "r1" });
    expect(parts[3]).toBe((messages[1] as { content: unknown[] }).content[3]);
  });
});

// ---------------------------------------------------------------------------
// Eval sampling
// ---------------------------------------------------------------------------

describe("per-turn eval sampling", () => {
  let harness: MockChatAgentHarness | undefined;
  const originalRate = process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    if (originalRate === undefined) {
      delete process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE;
    } else {
      process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE = originalRate;
    }
  });

  // Runs a turn at the given sample rate and returns the recorded eval enqueues.
  async function turnAtRate(rate: string, chatId: string): Promise<unknown[]> {
    process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE = rate;
    const { store } = fakeStore();
    const { trigger, calls } = fakeEvalTrigger();
    harness = mockChatAgent(dashboardAgent, {
      chatId,
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, mockModel([textStep("answered")]));
        set(dashboardAgentEvalTriggerKey, trigger);
      },
    });

    await harness.sendMessage(userMessage("hi"));
    // onTurnComplete enqueues after the turn-complete chunk; give it a tick.
    await new Promise((r) => setTimeout(r, 30));
    return calls;
  }

  it("does not enqueue the eval task at rate 0", async () => {
    expect(await turnAtRate("0", "chat_rate_zero")).toHaveLength(0);
  });

  it("enqueues the eval task at rate 1", async () => {
    const calls = (await turnAtRate("1", "chat_rate_one")) as Array<{
      options: { idempotencyKey: string };
    }>;
    expect(calls).toHaveLength(1);
    // The idempotency key still keys off chat + turn, so a retried turn is scored once.
    expect(calls[0]?.options.idempotencyKey).toBe("eval:chat_rate_one:0");
  });

  it("falls back to sampling every turn when the rate is unparseable", async () => {
    expect(await turnAtRate("not-a-number", "chat_rate_bad")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// clientData back-compat — resumed chats replay their original metadata shape
// ---------------------------------------------------------------------------

describe("clientDataSchema", () => {
  it("accepts the old shape a chat created before pageContext replays", () => {
    const parsed = clientDataSchema.safeParse({
      userId: "user_1",
      organizationId: "org_1",
      projectId: "proj_1",
      currentPage: "/orgs/acme/projects/p/env/dev/runs",
      apiOrigin: "http://localhost:3030",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts only the org + user pair", () => {
    expect(clientDataSchema.safeParse({ userId: "user_1", organizationId: "org_1" }).success).toBe(
      true
    );
  });

  it("accepts the new shape with environmentId and pageContext", () => {
    const parsed = clientDataSchema.safeParse({
      userId: "user_1",
      organizationId: "org_1",
      environmentId: "env_1",
      pageContext: {
        page: {
          kind: "run",
          runId: "run_1",
          status: "FAILED",
          taskId: "my-task",
          queue: "default",
        },
        signals: [
          { kind: "fresh_failure", runId: "run_1", failedAt: "2026-07-27T00:00:00.000Z" },
          { kind: "slow_run", runId: "run_2", durationMs: 9000, baselineP95Ms: 1200 },
          { kind: "concurrency_saturation", severity: "crit" },
        ],
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.pageContext?.signals).toHaveLength(3);
  });

  it("rejects a pageContext with an unknown page kind", () => {
    const parsed = clientDataSchema.safeParse({
      userId: "user_1",
      organizationId: "org_1",
      pageContext: { page: { kind: "nope" }, signals: [] },
    });
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tool unit tests (no harness) — the data lane fails closed without a token
// ---------------------------------------------------------------------------

describe("buildDashboardAgentTools", () => {
  it("exposes the read tools plus render_view, and the data tools fail closed with no token", async () => {
    const tools = buildDashboardAgentTools({});
    expect(Object.keys(tools).sort()).toEqual(
      [
        "ask_support",
        "correlate_version",
        "get_current_page",
        "get_deploy",
        "get_error",
        "get_query_schema",
        "get_queue",
        "get_report",
        "get_run",
        "get_run_trace",
        "list_deploys",
        "list_environments",
        "list_errors",
        "list_projects",
        "list_runs",
        "list_tasks",
        "navigate_to",
        "run_query",
        "render_view",
        "search_docs",
      ].sort()
    );

    // No userActorToken / apiOrigin => every data tool returns a graceful
    // error, never throws and never hits the network. The exempt ones don't
    // read the user's data at all: render_view and navigate_to echo/validate a
    // spec, get_current_page reads the turn's own context, and ask_support and
    // search_docs are public knowledge lanes gated on their own config.
    const EXEMPT = ["render_view", "ask_support", "search_docs", "get_current_page"];
    for (const name of Object.keys(tools)) {
      if (EXEMPT.includes(name)) continue;
      const tool = tools[name] as { execute?: (input: unknown, opts: unknown) => Promise<unknown> };
      const result = (await tool.execute?.({}, {})) as { error?: string };
      expect(result).toHaveProperty("error");
      expect(typeof result.error).toBe("string");
    }
  });

  it("render_view echoes a validated view spec back as its output", async () => {
    const tools = buildDashboardAgentTools({});
    const renderView = tools.render_view as {
      execute: (input: unknown, opts: unknown) => Promise<unknown>;
    };
    const spec = {
      blocks: [
        {
          type: "diagnosis",
          runId: "run_abc123",
          summary: "The task threw because the order had no line items.",
          category: "user_code_error",
          likelyCause: "processOrder throws when items is empty.",
          confidence: "high",
          evidence: [
            { type: "error", detail: "Error: order has no items", reference: "run_abc123" },
          ],
          nextSteps: ["Validate the payload before triggering."],
        },
      ],
    };
    const output = await renderView.execute(spec, {});
    expect(output).toEqual(spec);
  });

  // navigate_to / get_current_page: no fetch, no auth — they turn the turn's own
  // context into a trigger:// intent the host can act on.
  const SCOPE = { projectRef: "proj_abc", environmentId: "env_abc" };
  const callTool = (name: string, input: unknown, ctx: Record<string, unknown> = SCOPE) => {
    const tools = buildDashboardAgentTools(ctx);
    const tool = tools[name] as { execute: (input: unknown, opts: unknown) => Promise<any> };
    return tool.execute(input, {});
  };

  it("navigate_to emits a trigger:// navigate intent for each addressable kind", async () => {
    await expect(
      callTool("navigate_to", { destination: { kind: "run", runId: "run_1" } })
    ).resolves.toEqual({
      intent: { kind: "navigate", target: "trigger://proj_abc/env_abc/run/run_1" },
    });

    await expect(
      callTool("navigate_to", { destination: { kind: "error", fingerprint: "error_1" } })
    ).resolves.toEqual({
      intent: { kind: "navigate", target: "trigger://proj_abc/env_abc/error/1" },
    });

    // A queue name's `/` is percent-encoded, so a task queue round-trips.
    await expect(
      callTool("navigate_to", { destination: { kind: "queue", name: "task/send-receipt" } })
    ).resolves.toEqual({
      intent: { kind: "navigate", target: "trigger://proj_abc/env_abc/queue/task%2Fsend-receipt" },
    });

    await expect(
      callTool("navigate_to", { destination: { kind: "deployment", version: "20260101.1" } })
    ).resolves.toEqual({
      intent: { kind: "navigate", target: "trigger://proj_abc/env_abc/deployment/20260101.1" },
    });
  });

  it("navigate_to carries runs-list filters and never emits a dashboard path", async () => {
    const filters = { tasks: ["send-receipt"], statuses: ["FAILED"], period: "1d" };
    const result = await callTool("navigate_to", { destination: { kind: "runs", filters } });
    expect(result.intent).toEqual({
      kind: "navigate",
      target: "trigger://proj_abc/env_abc/runs",
      filters,
    });
    expect(result.appliedFilters).toEqual(filters);
    expect(JSON.stringify(result)).not.toContain("/orgs/");
  });

  it("navigate_to fails closed when the turn has no project or environment", async () => {
    const result = await callTool(
      "navigate_to",
      { destination: { kind: "run", runId: "run_1" } },
      {}
    );
    expect(typeof result.error).toBe("string");
  });

  // -------------------------------------------------------------------------
  // render_view: the investigation executor owns identity
  // -------------------------------------------------------------------------

  // A fake of the `investigations` capability that behaves like the real query:
  // no id creates at revision 0, an id bumps the revision atomically, and a
  // foreign id reports a context mismatch without writing.
  function fakeInvestigations(overrides: { mismatch?: boolean } = {}) {
    const rows = new Map<string, { revision: number; state: unknown }>();
    const upserts: Array<Record<string, unknown>> = [];
    let next = 1;
    return {
      rows,
      upserts,
      capability: {
        upsert: async (params: {
          id?: string;
          projectRef: string;
          environmentRef: string;
          state: unknown;
        }) => {
          upserts.push(params);
          if (overrides.mismatch) return { ok: false as const, error: "context_mismatch" as const };
          if (!params.id) {
            const id = `inv_fake${next++}`;
            rows.set(id, { revision: 0, state: params.state });
            return { ok: true as const, id, revision: 0, created: true };
          }
          const row = rows.get(params.id);
          if (!row) return { ok: false as const, error: "not_found" as const };
          row.revision += 1;
          row.state = params.state;
          return { ok: true as const, id: params.id, revision: row.revision, created: false };
        },
      },
    };
  }

  const investigationState = {
    outcome: "in_progress",
    severity: "warn",
    confidence: "low",
    runId: "run_abc123",
    title: "Why is send-order-receipt failing?",
    headline: "All three attempts ended in an error from the email provider.",
    progress: "Reading the run's spans",
    hypotheses: [
      {
        id: "hyp_rate_limit",
        statement: "The provider is rate limiting this API key.",
        verdict: "testing",
        evidence: [],
      },
    ],
    evidence: [
      {
        kind: "run",
        uri: "trigger://proj_abc/env_abc/run/run_abc123",
        label: "run_abc123 · failed after 3 attempts",
      },
    ],
  };

  // Parse through the tool's own inputSchema first, the way the AI SDK does, so
  // these tests exercise the model-facing boundary and not a hand-built object.
  const renderInvestigation = async (
    tools: ReturnType<typeof buildDashboardAgentTools>,
    state: Record<string, unknown> = investigationState,
    investigationId?: string
  ) => {
    const renderView = tools.render_view as {
      inputSchema: { parse: (input: unknown) => unknown };
      execute: (input: unknown, opts: unknown) => Promise<any>;
    };
    const input = renderView.inputSchema.parse({
      blocks: [{ type: "investigation", investigation: state }],
      ...(investigationId ? { investigationId } : {}),
    });
    return renderView.execute(input, {});
  };

  const concludedState = {
    ...investigationState,
    outcome: "concluded",
    confidence: "high",
    remediation: "Raise minTimeoutInMs to 30s with a factor of 2.",
    hypotheses: [
      {
        ...investigationState.hypotheses[0]!,
        verdict: "validated",
        finding: "All three attempts returned 429 inside 20 seconds.",
      },
    ],
  };

  it("render_view assigns an investigation's identity on the first render", async () => {
    const { capability, upserts } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    const output = await renderInvestigation(tools);

    // Revision 0 was committed with the turn's own project/environment, and the
    // block that reaches the transcript carries the identity the store assigned.
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      id: undefined,
      projectRef: "proj_abc",
      environmentRef: "env_abc",
    });
    expect(output.investigationId).toBe("inv_fake1");
    expect(output.blocks[0]).toMatchObject({ id: "inv_fake1", revision: 0, version: 1 });
    expect(output.blocks[0].investigation.title).toBe(investigationState.title);
  });

  it("render_view canonicalizes bare evidence ids into trigger:// URIs", async () => {
    const { capability, upserts } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    const output = await renderInvestigation(tools, {
      ...investigationState,
      hypotheses: [
        {
          ...investigationState.hypotheses[0]!,
          evidence: [
            { kind: "error", uri: "error_c4b4a797397a9c43", label: "the error group" },
            { kind: "deployment", uri: "20260726.4", label: "the deploy before the failures" },
            // An improvised almost-URI: the bare id is salvaged from the last segment.
            { kind: "error", uri: "trigger://errors/error_c4b4a797397a9c43", label: "improvised" },
          ],
        },
      ],
      evidence: [
        // Already canonical — passes through untouched.
        ...investigationState.evidence,
        // A span carries its two parts, so the executor can build the URI. Nothing
        // was read this turn: the read gate is the source kind's alone.
        { kind: "span", runId: "run_abc123", spanId: "span_123", label: "the failing span" },
      ],
    });

    expect(output.error).toBeUndefined();
    const investigation = output.blocks[0].investigation;
    expect(investigation.hypotheses[0].evidence.map((e: { uri: string }) => e.uri)).toEqual([
      "trigger://proj_abc/env_abc/error/c4b4a797397a9c43",
      "trigger://proj_abc/env_abc/deployment/20260726.4",
      "trigger://proj_abc/env_abc/error/c4b4a797397a9c43",
    ]);
    expect(investigation.evidence.map((e: { uri: string }) => e.uri)).toEqual([
      "trigger://proj_abc/env_abc/run/run_abc123",
      "trigger://proj_abc/env_abc/run/run_abc123/span/span_123",
    ]);
    // The store received the canonical form, not the bare ids.
    expect(JSON.stringify(upserts[0])).not.toContain('"uri":"error_c4b4a797397a9c43"');
  });

  it("render_view pins a source citation to the commit the file was read at", async () => {
    await seedWorkspace();
    const { capability } = fakeInvestigations();
    const tools = buildDashboardAgentTools({
      ...SCOPE,
      investigations: capability,
      repoSnapshot: codeSnapshot,
    });
    await readFileTool(tools).execute({ path: "src/tasks/send-order-receipt.ts" }, {});

    const output = await renderInvestigation(tools, {
      ...investigationState,
      evidence: [
        {
          kind: "source",
          path: "src/tasks/send-order-receipt.ts",
          line: 42,
          label: "the retry config",
        },
        // The same commit, named explicitly: the read proves it, so it's accepted.
        {
          kind: "source",
          path: "src/tasks/send-order-receipt.ts",
          sha: codeSnapshot.sha,
          label: "the whole file",
        },
      ],
    });

    expect(output.error).toBeUndefined();
    expect(output.blocks[0].investigation.evidence.map((e: { uri: string }) => e.uri)).toEqual([
      `trigger://proj_abc/env_abc/source/${codeSnapshot.sha}/src/tasks/send-order-receipt.ts?line=42`,
      `trigger://proj_abc/env_abc/source/${codeSnapshot.sha}/src/tasks/send-order-receipt.ts`,
    ]);
  });

  it("render_view fails by name when a cited file was never read, rather than borrowing the snapshot's commit", async () => {
    const { capability, upserts } = fakeInvestigations();
    // A snapshot IS in scope — it just isn't proof that anything was opened.
    const tools = buildDashboardAgentTools({
      ...SCOPE,
      investigations: capability,
      repoSnapshot: codeSnapshot,
    });

    const output = await renderInvestigation(tools, {
      ...investigationState,
      evidence: [{ kind: "source", path: "src/a.ts", line: 3, label: "the line that throws" }],
    });

    expect(output.blocks).toBeUndefined();
    expect(output.error).toContain("src/a.ts");
    expect(output.error).toContain("read");
    expect(output.error).not.toContain(codeSnapshot.sha);
    expect(upserts).toHaveLength(0);
  });

  it("render_view rejects a model-supplied commit no read backs", async () => {
    await seedWorkspace();
    const { capability, upserts } = fakeInvestigations();
    const tools = buildDashboardAgentTools({
      ...SCOPE,
      investigations: capability,
      repoSnapshot: codeSnapshot,
    });
    // Read at the snapshot's commit, then cite a different one.
    await readFileTool(tools).execute({ path: "src/tasks/send-order-receipt.ts" }, {});

    const output = await renderInvestigation(tools, {
      ...investigationState,
      evidence: [
        {
          kind: "source",
          path: "src/tasks/send-order-receipt.ts",
          line: 1,
          sha: "b".repeat(40),
          label: "the retry config",
        },
      ],
    });

    expect(output.blocks).toBeUndefined();
    expect(output.error).toContain("src/tasks/send-order-receipt.ts");
    expect(output.error).toContain("b".repeat(7));
    expect(upserts).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // The card's typed actions, decided by the executor
  // -------------------------------------------------------------------------

  const codeSnapshot: RepoSnapshot = {
    tarballUrl: "http://unused.invalid/never-fetched",
    owner: "acme",
    repo: "orders",
    sha: "c".repeat(40),
  };

  // Pre-seed the deterministic workspace with a `.ready` marker so read_file
  // serves it offline — the same trick repo-tools.test.ts uses.
  const seedWorkspace = async () => {
    const dir = workdirFor(codeSnapshot);
    await mkdir(join(dir, "src/tasks"), { recursive: true });
    await writeFile(
      join(dir, "src/tasks/send-order-receipt.ts"),
      "export const retry = { maxAttempts: 3, minTimeoutInMs: 1000 };\n"
    );
    await writeFile(join(dir, ".ready"), codeSnapshot.sha);
  };

  const readFileTool = (tools: ReturnType<typeof buildDashboardAgentTools>) =>
    tools.read_file as { execute: (input: unknown, opts: unknown) => Promise<any> };

  const concludedWithSource = {
    ...concludedState,
    evidence: [
      { kind: "error", uri: "error_c4b4a797397a9c43", label: "the error group" },
      {
        kind: "source",
        path: "src/tasks/send-order-receipt.ts",
        line: 1,
        label: "the retry config",
      },
    ],
  };

  afterEach(async () => {
    await disposeRepoWorkspaces();
  });

  it("offers Show code only once the cited file was really read at the pinned commit", async () => {
    await seedWorkspace();
    const { capability } = fakeInvestigations();
    const tools = buildDashboardAgentTools({
      ...SCOPE,
      investigations: capability,
      repoSnapshot: codeSnapshot,
    });

    // Cited but never read: the render fails on the citation, so there is no
    // card to hang a button on.
    const unread = await renderInvestigation(tools, concludedWithSource);
    expect(unread.blocks).toBeUndefined();
    expect(unread.error).toContain("src/tasks/send-order-receipt.ts");

    // Now read it, and the same state earns the button — grounded in the
    // canonical source URI, as a canned ask the model didn't write.
    expect(
      (await readFileTool(tools).execute({ path: "src/tasks/send-order-receipt.ts" }, {})).content
    ).toContain("maxAttempts");

    const grounded = await renderInvestigation(tools, concludedWithSource);
    const actions = grounded.blocks[0].capabilities.actions;
    expect(actions.map((a: { kind: string }) => a.kind)).toEqual(["show_code", "view_similar"]);
    expect(actions[0].intent.kind).toBe("ask");
    // The ask is a propose-a-change request, not another explanation: a fenced
    // diff, the minimal change, anchored path:line@sha, with the dirty caveat.
    const prompt: string = actions[0].intent.prompt;
    expect(prompt).toContain("```diff");
    expect(prompt).toContain(`src/tasks/send-order-receipt.ts:1@${codeSnapshot.sha.slice(0, 7)}`);
    expect(prompt).toMatch(/minimal change/i);
    expect(prompt).toMatch(/dirty tree|branch head/i);
    expect(prompt).toMatch(/don't restate the investigation/i);
    // The follow-up that navigates points at the canonical error URI.
    expect(actions[1].intent).toEqual({
      kind: "navigate",
      target: "trigger://proj_abc/env_abc/error/c4b4a797397a9c43",
    });
  });

  it("offers no actions while an investigation is still in progress", async () => {
    const { capability } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });
    const output = await renderInvestigation(tools);
    expect(output.blocks[0].capabilities).toBeUndefined();
  });

  it("offers a keep-digging follow-up, and never Show code, on an inconclusive card", async () => {
    await seedWorkspace();
    const { capability } = fakeInvestigations();
    const tools = buildDashboardAgentTools({
      ...SCOPE,
      investigations: capability,
      repoSnapshot: codeSnapshot,
    });
    await readFileTool(tools).execute({ path: "src/tasks/send-order-receipt.ts" }, {});

    const output = await renderInvestigation(tools, {
      ...concludedWithSource,
      outcome: "inconclusive",
      remediation: undefined,
      checkNext: ["Add a span around the provider call."],
    });
    expect(output.blocks[0].capabilities.actions.map((a: { kind: string }) => a.kind)).toEqual([
      "ask_follow_up",
      "view_similar",
    ]);
  });

  it("render_view validates an already-full URI instead of trusting it", async () => {
    const { capability } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    // Right shape, wrong kind.
    const wrongKind = await renderInvestigation(tools, {
      ...investigationState,
      evidence: [
        { kind: "error", uri: "trigger://proj_abc/env_abc/run/run_abc123", label: "mislabelled" },
      ],
    });
    expect(wrongKind.error).toContain("cites a run URI");

    // Right shape, another tenant.
    const wrongScope = await renderInvestigation(tools, {
      ...investigationState,
      evidence: [
        { kind: "run", uri: "trigger://proj_other/env_other/run/run_abc123", label: "borrowed" },
      ],
    });
    expect(wrongScope.error).toContain("different project or environment");
  });

  it("render_view revises the same investigation on the next render", async () => {
    const { capability, rows } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    const first = await renderInvestigation(tools);
    const second = await renderInvestigation(tools, concludedState);

    // One investigation, two revisions — so the panel shows one live card.
    expect(rows.size).toBe(1);
    expect(second.investigationId).toBe(first.investigationId);
    expect(second.blocks[0].revision).toBe(1);
    expect(second.blocks[0].investigation.remediation).toBeDefined();
  });

  // A later turn gets a fresh tool set, so the closure is empty: the model
  // continues an investigation by passing back the id the tool returned to it.
  it("render_view continues a previous turn's investigation from the returned id", async () => {
    const { capability, rows } = fakeInvestigations();

    const first = await renderInvestigation(
      buildDashboardAgentTools({ ...SCOPE, investigations: capability })
    );

    // Next turn — new tool set, same chat.
    const second = await renderInvestigation(
      buildDashboardAgentTools({ ...SCOPE, investigations: capability }),
      concludedState,
      first.investigationId
    );

    expect(rows.size).toBe(1);
    expect(second.investigationId).toBe(first.investigationId);
    expect(second.blocks[0].id).toBe(first.investigationId);
    expect(second.blocks[0].revision).toBe(1);
  });

  it("render_view keeps the turn's own investigation when the model passes a different id", async () => {
    const { capability, rows, upserts } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    const first = await renderInvestigation(tools);
    const second = await renderInvestigation(tools, concludedState, "inv_somewhere_else");

    // The closure wins within a turn, so a mid-investigation redirect can't happen.
    expect(rows.size).toBe(1);
    expect(second.investigationId).toBe(first.investigationId);
    expect(upserts[1]).toMatchObject({ id: first.investigationId });
  });

  it("render_view errors on an unknown investigationId and writes nothing", async () => {
    const { capability, rows } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    const output = await renderInvestigation(tools, investigationState, "inv_never_existed");

    expect(typeof output.error).toBe("string");
    expect(output.blocks).toBeUndefined();
    expect(rows.size).toBe(0);
  });

  it("render_view errors on an investigationId from another chat and writes nothing", async () => {
    // The store owns the chat/project/env check, so a foreign id comes back as a
    // context mismatch no matter what the model claims.
    const { capability, rows } = fakeInvestigations({ mismatch: true });
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    const output = await renderInvestigation(tools, investigationState, "inv_other_chat");

    expect(typeof output.error).toBe("string");
    expect(output.blocks).toBeUndefined();
    expect(rows.size).toBe(0);
  });

  it("render_view reports a context mismatch instead of overwriting", async () => {
    const { capability } = fakeInvestigations({ mismatch: true });
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    const output = await renderInvestigation(tools);
    expect(typeof output.error).toBe("string");
    expect(output.blocks).toBeUndefined();
  });

  it("render_view fails closed when the turn can't scope an investigation", async () => {
    const { capability } = fakeInvestigations();
    // No store seam at all (an older turn), and no project/environment.
    expect(typeof (await renderInvestigation(buildDashboardAgentTools({}))).error).toBe("string");
    expect(
      typeof (await renderInvestigation(buildDashboardAgentTools({ investigations: capability })))
        .error
    ).toBe("string");
  });

  it("render_view ignores an id the model tries to supply", async () => {
    const { capability, upserts } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    const renderView = tools.render_view as {
      inputSchema: { parse: (input: unknown) => unknown };
      execute: (input: unknown, opts: unknown) => Promise<any>;
    };
    const input = renderView.inputSchema.parse({
      blocks: [
        {
          type: "investigation",
          // Everything the model could try: envelope fields on the block and
          // identity inside the payload. All stripped by the input schema.
          id: "inv_smuggled",
          revision: 42,
          version: 9,
          investigation: {
            ...investigationState,
            investigationId: "inv_smuggled",
            revision: 42,
          },
        },
      ],
    });
    const output = await renderView.execute(input, {});

    expect(output.blocks[0].id).toBe("inv_fake1");
    expect(output.blocks[0].revision).toBe(0);
    expect(output.blocks[0].version).toBe(1);
    // The state the store persisted carries no identity either.
    expect(upserts[0]?.state).not.toHaveProperty("investigationId");
    expect(upserts[0]?.state).not.toHaveProperty("revision");
  });

  it("render_view still echoes a spec with no investigation in it", async () => {
    const { capability } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });
    const renderView = tools.render_view as {
      execute: (input: unknown, opts: unknown) => Promise<any>;
    };
    const chart = {
      type: "chart",
      query: "SELECT toStartOfHour(created_at) AS bucket, count() AS runs FROM runs",
      chartType: "line",
      xAxisColumn: "bucket",
      yAxisColumns: ["runs"],
    };
    await expect(renderView.execute({ blocks: [chart] }, {})).resolves.toEqual({ blocks: [chart] });
  });

  // The env-JWT exchange is a webapp request plus DB work, so it is paid for once
  // per tool set (= once per turn) no matter how many env-scoped tools run.
  const ENV_CTX = {
    userActorToken: "uat_token",
    apiOrigin: "http://localhost:3030",
    projectRef: "proj_abc",
    environmentName: "prod",
    environmentId: "env_abc",
  };

  // Stubs global fetch with a router and records every request path, so a test can
  // count exchanges (`/jwt`) separately from the data reads.
  function stubFetch(
    respond: (url: string, init: RequestInit | undefined) => { status?: number; body: unknown }
  ) {
    const requests: Array<{ url: string; token?: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ url: String(url), token: headers.Authorization });
      const { status, body } = respond(String(url), init);
      return new Response(JSON.stringify(body ?? {}), {
        status: status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    return {
      requests,
      exchanges: () => requests.filter((r) => r.url.endsWith("/jwt")).length,
      restore: () => {
        globalThis.fetch = original;
      },
    };
  }

  it("exchanges the env JWT once per tool set, however many env-scoped tools call the API", async () => {
    const fetchStub = stubFetch((url) => {
      if (url.endsWith("/jwt")) return { body: { token: "jwt_1" } };
      return { body: { data: [], results: [], trace: { traceId: "t1" } } };
    });
    try {
      const tools = buildDashboardAgentTools(ENV_CTX);
      const call = (name: string, input: unknown) =>
        (tools[name] as { execute: (i: unknown, o: unknown) => Promise<any> }).execute(input, {});

      await call("get_run", { runId: "run_1" });
      await call("list_runs", {});
      await call("list_errors", {});
      await call("get_run_trace", { runId: "run_1" });
      await call("get_report", {});
      await call("run_query", { query: "select 1" });

      expect(fetchStub.exchanges()).toBe(1);
      // Six data reads, all carrying the one exchanged token.
      const reads = fetchStub.requests.filter((r) => !r.url.endsWith("/jwt"));
      expect(reads).toHaveLength(6);
      expect(reads.every((r) => r.token === "Bearer jwt_1")).toBe(true);

      // Concurrent calls share the one in-flight exchange too.
      const parallel = buildDashboardAgentTools(ENV_CTX);
      const parallelCall = (name: string, input: unknown) =>
        (parallel[name] as { execute: (i: unknown, o: unknown) => Promise<any> }).execute(
          input,
          {}
        );
      const before = fetchStub.exchanges();
      await Promise.all([
        parallelCall("get_run", { runId: "run_1" }),
        parallelCall("list_runs", {}),
        parallelCall("list_errors", {}),
      ]);
      // A fresh tool set is a fresh turn, so exactly one more exchange.
      expect(fetchStub.exchanges()).toBe(before + 1);
    } finally {
      fetchStub.restore();
    }
  });

  it("re-exchanges once and retries when the cached env JWT is rejected", async () => {
    let minted = 0;
    const fetchStub = stubFetch((url, init) => {
      if (url.endsWith("/jwt")) return { body: { token: `jwt_${++minted}` } };
      const token = (init?.headers as Record<string, string> | undefined)?.Authorization;
      // The first token is stale (minted at its expiry edge); the second works.
      if (token === "Bearer jwt_1") return { status: 401, body: {} };
      return { body: { id: "run_1", status: "COMPLETED" } };
    });
    try {
      const tools = buildDashboardAgentTools(ENV_CTX);
      const getRun = tools.get_run as { execute: (i: unknown, o: unknown) => Promise<any> };

      await expect(getRun.execute({ runId: "run_1" }, {})).resolves.toMatchObject({
        id: "run_1",
        status: "COMPLETED",
      });
      expect(fetchStub.exchanges()).toBe(2);
      expect(fetchStub.requests.map((r) => r.token)).toEqual([
        "Bearer uat_token",
        "Bearer jwt_1",
        "Bearer uat_token",
        "Bearer jwt_2",
      ]);

      // The refreshed token is now the cached one, so the next call pays nothing.
      await getRun.execute({ runId: "run_2" }, {});
      expect(fetchStub.exchanges()).toBe(2);
    } finally {
      fetchStub.restore();
    }
  });

  it("retries an unauthorized env call only once, then reports the failure", async () => {
    const fetchStub = stubFetch((url) => {
      if (url.endsWith("/jwt")) return { body: { token: "jwt_x" } };
      return { status: 401, body: {} };
    });
    try {
      const tools = buildDashboardAgentTools(ENV_CTX);
      const result = await (
        tools.list_runs as { execute: (i: unknown, o: unknown) => Promise<any> }
      ).execute({}, {});
      expect(result.error).toContain("401");
      // One retry, not a loop: two exchanges and two reads.
      expect(fetchStub.exchanges()).toBe(2);
      expect(fetchStub.requests).toHaveLength(4);
    } finally {
      fetchStub.restore();
    }
  });

  it("get_current_page returns the turn's structured page context", async () => {
    const pageContext = {
      page: { kind: "run" as const, runId: "run_1", status: "FAILED", taskId: "send-receipt" },
      signals: [
        { kind: "fresh_failure" as const, runId: "run_1", failedAt: "2026-01-01T00:00:00Z" },
      ],
    };
    await expect(
      callTool("get_current_page", {}, { ...SCOPE, pageContext, currentPage: "/runs/run_1" })
    ).resolves.toEqual({
      page: pageContext.page,
      signals: pageContext.signals,
      path: "/runs/run_1",
    });

    // Only a raw path (an older turn) degrades to the `other` page kind.
    await expect(callTool("get_current_page", {}, { currentPage: "/some/page" })).resolves.toEqual({
      page: { kind: "other", path: "/some/page" },
      signals: [],
    });

    // Nothing at all: say so rather than guessing.
    const blind = await callTool("get_current_page", {}, {});
    expect(blind.page).toBeNull();
    expect(typeof blind.note).toBe("string");
  });

  // The tools are rebuilt from the turn's clientData, so a user who navigates
  // mid-chat gets the new page — a stale answer can only come from the model
  // reusing an earlier turn instead of calling again.
  it("get_current_page follows the user between turns", async () => {
    const first = await callTool(
      "get_current_page",
      {},
      { ...SCOPE, pageContext: { page: { kind: "queue" as const, name: "email" }, signals: [] } }
    );
    const second = await callTool(
      "get_current_page",
      {},
      {
        ...SCOPE,
        pageContext: { page: { kind: "run" as const, runId: "run_2" }, signals: [] },
      }
    );

    expect(first.page).toEqual({ kind: "queue", name: "email" });
    expect(second.page).toEqual({ kind: "run", runId: "run_2" });
  });
});
