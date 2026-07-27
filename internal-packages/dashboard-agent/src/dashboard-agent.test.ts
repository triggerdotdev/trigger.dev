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
import { afterEach, describe, expect, it } from "vitest";

import {
  clientDataSchema,
  dashboardAgent,
  dashboardAgentEvalTriggerKey,
  dashboardAgentModelKey,
  dashboardAgentStoreKey,
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
};

function fakeStore(): { store: DashboardAgentStore; calls: StoreCalls } {
  const calls: StoreCalls = {
    ensureChat: [],
    persistMessages: [],
    persistTurn: [],
    setChatTitleIfDefault: [],
  };
  const store: DashboardAgentStore = {
    ensureChat: async (args) => void calls.ensureChat.push(args),
    persistMessages: async (args) => void calls.persistMessages.push(args),
    persistTurn: async (args) => void calls.persistTurn.push(args),
    setChatTitleIfDefault: async (args) => void calls.setChatTitleIfDefault.push(args),
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
      intent: { kind: "navigate", target: "trigger://proj_abc/env_abc/error/error_1" },
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
});
