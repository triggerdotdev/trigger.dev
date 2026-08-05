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
  TURN_FAILED_MESSAGE,
  turnFailureMessageId,
  type DashboardAgentEvalTrigger,
  type DashboardAgentStore,
} from "./dashboard-agent";
import { buildDashboardAgentTools } from "./tools";

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
 * Plays one stream per `streamText` step, plus a `doGenerate` for the background
 * title generation. The last entry in `steps` repeats if the model is called more
 * times than there are steps.
 */
function mockModel(
  steps: LanguageModelV3StreamPart[][],
  titleText = "Test Chat Title",
  // A test that cares whether the title is awaited has to make it take real time, or
  // it lands within the turn's own await chain either way.
  titleDelayMs = 0
) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const chunks = steps[Math.min(call, steps.length - 1)] ?? [];
      call++;
      return { stream: simulateReadableStream({ chunks }) };
    },
    doGenerate: async () => {
      if (titleDelayMs > 0) await new Promise((r) => setTimeout(r, titleDelayMs));
      return {
        content: [{ type: "text", text: titleText }],
        finishReason: { unified: "stop", raw: "stop" } as const,
        usage: USAGE,
        warnings: [],
      };
    },
  });
}

// Records the persistence the agent performs.
type StoreCalls = {
  ensureChat: unknown[];
  persistMessages: unknown[];
  appendMessage: unknown[];
  persistTurn: unknown[];
  setChatTitleIfDefault: unknown[];
  upsertInvestigationRevision: unknown[];
  findOpenInvestigation: unknown[];
};

function fakeStore(
  options: { openInvestigation?: { id: string; projectRef: string; environmentRef: string } } = {}
): { store: DashboardAgentStore; calls: StoreCalls } {
  const calls: StoreCalls = {
    ensureChat: [],
    persistMessages: [],
    appendMessage: [],
    persistTurn: [],
    setChatTitleIfDefault: [],
    upsertInvestigationRevision: [],
    findOpenInvestigation: [],
  };
  const store: DashboardAgentStore = {
    ensureChat: async (args) => void calls.ensureChat.push(args),
    persistMessages: async (args) => void calls.persistMessages.push(args),
    appendMessage: async (args) => void calls.appendMessage.push(args),
    persistTurn: async (args) => void calls.persistTurn.push(args),
    setChatTitleIfDefault: async (args) => void calls.setChatTitleIfDefault.push(args),
    upsertInvestigationRevision: async (args) => {
      calls.upsertInvestigationRevision.push(args);
      return { ok: true, id: args.id ?? "inv_fake", revision: 0, created: !args.id };
    },
    findOpenInvestigation: async (args) => {
      calls.findOpenInvestigation.push(args);
      return options.openInvestigation ?? null;
    },
  };
  return { store, calls };
}

// Records the eval enqueues, in place of tasks.trigger.
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

// On a head-start handover the tool-call is supplied by the handover partial rather
// than streamed by the model, so the output chunk is the only reliable signal that
// the call actually ran.
function executedTool(chunks: UIMessageChunk[]): boolean {
  return chunks.some((c) => (c as { type?: string }).type === "tool-output-available");
}

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

    expect(calls.ensureChat).toHaveLength(1);
    expect(calls.persistMessages).toHaveLength(1);
    // onTurnComplete persists after the turn-complete chunk, so give it a tick.
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.persistTurn).toHaveLength(1);
  });

  // The panel reloads its chat list once, when the turn settles, so the title write
  // must land before the turn-complete chunk.
  it("has written the generated chat title by the time the turn settles", async () => {
    const { store, calls } = fakeStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_title",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        // 50ms so the title outlives the response: without the await in
        // `onBeforeTurnComplete` the turn would settle before the write.
        set(dashboardAgentModelKey, mockModel([textStep("answered")], "Why orders fail", 50));
      },
    });

    await harness.sendMessage(userMessage("why do my orders fail?"));

    // Deliberately no `await setTimeout` here: that is the whole assertion.
    expect(calls.setChatTitleIfDefault).toEqual([
      { chatId: "chat_title", title: "Why orders fail" },
    ]);
  });

  it("names the chat once, not on every turn", async () => {
    const { store, calls } = fakeStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_title_once",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, mockModel([textStep("first"), textStep("second")]));
      },
    });

    await harness.sendMessage(userMessage("first question"));
    await harness.sendMessage(userMessage("second question"));

    expect(calls.setChatTitleIfDefault).toHaveLength(1);
  });

  it("executes a read tool the model calls, then answers from the result", async () => {
    const { store } = fakeStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_tool",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(
          dashboardAgentModelKey,
          mockModel([toolCallStep("list_errors"), textStep("you have no errors")])
        );
      },
    });

    const turn = await harness.sendMessage(userMessage("any errors?"));

    // No delegated token in clientData, so the tool returns its no-auth result and
    // never touches the network.
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

    const prompt = model.doStreamCalls[0]?.prompt ?? [];
    const last = prompt[prompt.length - 1] as { providerOptions?: Record<string, unknown> };
    expect(last?.providerOptions?.anthropic).toMatchObject({
      cacheControl: { type: "ephemeral" },
    });
  });

  it("Head Start handover: executes the handed-over tool call despite the cache hook (regression)", async () => {
    const { store } = fakeStore();
    // Only step 2 runs in the agent: the warm route did step 1 and hands over the
    // pending tool call.
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

    // The partial chat.headStart sends on a tool-calls finish: a tool-approval round
    // whose trailing tool message must survive prepareMessages for
    // collectToolApprovals to execute the pending call.
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

    // Without the SDK's preserveToolApprovalTail guard the bare tool_use would never
    // execute, so there would be no tool output.
    expect(executedTool(turn.chunks)).toBe(true);
    expect(collectText(turn.chunks)).toBe("resolved from the tool");
  });

  // An investigation needs a project and environment to be scoped.
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

  // The store's view after the turn: what a refresh reads.
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
        // The model opens the card and then only talks, with no verdict render.
        set(
          dashboardAgentModelKey,
          mockModel([renderViewStep(openInvestigation, "tc_open"), textStep("still looking")])
        );
      },
    });

    await harness.sendMessage(userMessage("why is send-order-receipt failing?"));
    await new Promise((r) => setTimeout(r, 30));

    expect(calls.upsertInvestigationRevision).toHaveLength(2);
    const settle = calls.upsertInvestigationRevision[1] as Record<string, any>;
    expect(settle.id).toBe("inv_fake");
    expect(settle.chatId).toBe("chat_open_investigation");
    expect(settle.projectRef).toBe("proj_abc");
    expect(settle.environmentRef).toBe("env_abc");

    const state = finalInvestigationState(calls);
    expect(state.outcome).toBe("inconclusive");
    // No spinner, no invented cause, no fix, and the facts the turn established stay.
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

describe("watch wake narration", () => {
  let harness: MockChatAgentHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  const WAKE = {
    type: "watch.fired" as const,
    id: "watch:watch_1:fired",
    watchId: "watch_1",
    identity: "backlog_drain:task/send-receipt",
    spec: {
      kind: "backlog_drain",
      queue: "task/send-receipt",
      checkEveryMinutes: 5,
      maxHours: 2,
      note: "tell me when the backlog drains",
    },
    facts: { pending: 0, peakPending: 412, drainedAt: "2026-01-01T12:40:00.000Z" },
  };

  it("narrates the wake once and persists it, and a redelivered wake narrates nothing", async () => {
    const { store, calls } = fakeStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_wake",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, mockModel([textStep("The backlog drained — 0 pending now.")]));
      },
    });

    const first = await harness.sendAction(WAKE);
    expect(collectText(first.chunks)).toBe("The backlog drained — 0 pending now.");

    // The streamed message must carry the same id the read-model copy is persisted
    // under, or the panel renders the narration twice.
    const startChunk = first.chunks.find(
      (chunk) => (chunk as { type?: string }).type === "start"
    ) as { messageId?: string } | undefined;
    expect(startChunk?.messageId).toBe("wake:watch:watch_1:fired");

    // An action is not a turn, so no turn persistence ran. The narration lands in the
    // read-model as an id-deduped append, never a wholesale write: a card-born chat's
    // transcript holds host blocks the session view can't see.
    expect(calls.persistTurn).toHaveLength(0);
    expect(calls.persistMessages).toHaveLength(0);
    expect(calls.appendMessage).toHaveLength(1);
    const appended = calls.appendMessage[0] as { userId: string; message: UIMessage };
    expect(appended.userId).toBe(CLIENT_DATA.userId);
    expect(appended.message).toMatchObject({ id: "wake:watch:watch_1:fired", role: "assistant" });

    // Same action id again (the watcher retried after appending): deduped.
    const second = await harness.sendAction(WAKE);
    expect(collectText(second.chunks)).toBe("");
    expect(calls.appendMessage).toHaveLength(1);
  });

  // Records the prompt it was asked with, so the wake's framing can be asserted.
  function recordingModel(text: string) {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        prompts.push(options.prompt);
        return { stream: simulateReadableStream({ chunks: textStep(text) }) };
      },
      doGenerate: async () => ({
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE,
        warnings: [],
      }),
    });
    return { model, prompts };
  }

  function wakeText(prompts: unknown[]): string {
    return JSON.stringify(prompts);
  }

  // A completed window is an answer, never "the watch expired with nothing to say".
  it("frames a completed window as the answer the user asked for", async () => {
    const { store } = fakeStore();
    const { model, prompts } = recordingModel("The backlog still hasn't drained — 42 pending.");
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_wake_window",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    await harness.sendAction({
      ...WAKE,
      type: "watch.expired" as const,
      id: "watch:watch_1:expired",
      resolution: "window_completed" as const,
      observed: { kind: "backlog_drain", verified: true, depth: 42 },
      facts: { verified: true, reason: "not_met_by_expiry", depth: 42 },
    });

    const prompt = wakeText(prompts);
    expect(prompt).toContain("window_completed");
    expect(prompt).toContain("this is the answer the user asked for");
    expect(prompt).toContain("reports once");
    // The wire encoding is transport, not vocabulary.
    expect(prompt).not.toContain("the watch ended without firing");
  });

  it("hands the observed outcome to the narration, not just the resolution", async () => {
    const { store } = fakeStore();
    const { model, prompts } = recordingModel("Run run_abc123 failed after 4.2s.");
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_wake_failed",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    await harness.sendAction({
      ...WAKE,
      identity: "run_finished:run_abc123",
      spec: { ...WAKE.spec, kind: "run_finished", runId: "run_abc123" },
      resolution: "condition_met" as const,
      observed: {
        kind: "run_finished",
        verified: true,
        finalStatus: "COMPLETED_WITH_ERRORS",
        durationMs: 4200,
      },
      facts: { outcome: "COMPLETED_WITH_ERRORS", durationMs: 4200 },
    });

    const prompt = wakeText(prompts);
    expect(prompt).toContain("What the final check observed");
    expect(prompt).toContain("COMPLETED_WITH_ERRORS");
  });

  // A wake from a watcher predating the resolution model still narrates.
  it("falls back to the transport encoding when a wake carries no resolution", async () => {
    const { store } = fakeStore();
    const { model, prompts } = recordingModel("That can't happen any more.");
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_wake_legacy",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    await harness.sendAction({
      ...WAKE,
      type: "watch.expired" as const,
      id: "watch:watch_1:expired",
      facts: { reason: "terminal_unsatisfied" },
    });

    expect(wakeText(prompts)).toContain("condition_impossible");
  });

  // A wake needs the project's external ref to scope the investigation the way a turn
  // would; the watcher puts it in the wake's metadata.
  const WAKE_CLIENT_DATA = {
    ...CLIENT_DATA,
    projectRef: "proj_abc",
    environmentId: "env_abc",
  };

  const FAILED_RUN_WAKE = {
    ...WAKE,
    identity: "run_finished:run_abc123",
    spec: { ...WAKE.spec, kind: "run_finished", runId: "run_abc123" },
    resolution: "condition_met" as const,
    observed: {
      kind: "run_finished",
      verified: true,
      finalStatus: "COMPLETED_WITH_ERRORS",
      durationMs: 4200,
    },
    facts: { outcome: "COMPLETED_WITH_ERRORS", durationMs: 4200 },
  };

  it("opens the pre-approved investigation on an attention outcome, in the same wake turn", async () => {
    const { store, calls } = fakeStore();
    const { model, prompts } = recordingModel(
      "Run run_abc123 failed — I've started looking into why."
    );
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_wake_investigate",
      clientData: WAKE_CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    await harness.sendAction({ ...FAILED_RUN_WAKE, investigateOnAttention: true });

    // The wake lands first and says the investigation has started.
    expect(calls.appendMessage).toHaveLength(1);
    expect(wakeText(prompts)).toContain("ALREADY been started");

    // Opened, not concluded: the wake has no token to read with, so the findings come
    // later in their own message.
    expect(calls.upsertInvestigationRevision).toHaveLength(1);
    const opened = calls.upsertInvestigationRevision[0] as {
      chatId: string;
      projectRef: string;
      environmentRef: string;
      state: { outcome: string; runId?: string };
    };
    expect(opened.chatId).toBe("chat_wake_investigate");
    expect(opened.projectRef).toBe("proj_abc");
    expect(opened.environmentRef).toBe("env_abc");
    expect(opened.state.outcome).toBe("in_progress");
    expect(opened.state.runId).toBe("run_abc123");
  });

  // Consent is for bad news, and the category comes from the contracts mapping rather
  // than the flag or the resolution alone.
  it("starts nothing on a positive outcome, consent or not", async () => {
    const { store, calls } = fakeStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_wake_positive",
      clientData: WAKE_CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, mockModel([textStep("The backlog drained.")]));
      },
    });

    await harness.sendAction({
      ...WAKE,
      resolution: "condition_met" as const,
      observed: { kind: "backlog_drain", verified: true, depth: 0 },
      investigateOnAttention: true,
    });

    expect(calls.appendMessage).toHaveLength(1);
    expect(calls.upsertInvestigationRevision).toHaveLength(0);
  });

  it("starts nothing on an attention outcome without consent", async () => {
    const { store, calls } = fakeStore();
    const { model, prompts } = recordingModel("Run run_abc123 failed after 4.2s.");
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_wake_no_consent",
      clientData: WAKE_CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    await harness.sendAction(FAILED_RUN_WAKE);

    expect(calls.appendMessage).toHaveLength(1);
    expect(calls.upsertInvestigationRevision).toHaveLength(0);
    expect(wakeText(prompts)).not.toContain("ALREADY been started");
  });

  // Opening the investigation must never delay, retry or invalidate the wake. The
  // watcher has already marked the delivery by the time the agent runs, so the only
  // thing this can break is the turn.
  it("delivers the wake even when opening the investigation fails", async () => {
    const { store, calls } = fakeStore();
    const failing: DashboardAgentStore = {
      ...store,
      upsertInvestigationRevision: async () => {
        throw new Error("investigations are down");
      },
    };
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_wake_inv_fails",
      clientData: WAKE_CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, failing);
        set(dashboardAgentModelKey, mockModel([textStep("Run run_abc123 failed.")]));
      },
    });

    const wake = await harness.sendAction({ ...FAILED_RUN_WAKE, investigateOnAttention: true });

    expect(collectText(wake.chunks)).toBe("Run run_abc123 failed.");
    expect(calls.appendMessage).toHaveLength(1);
  });

  it("a different outcome on the same watch is a different wake", async () => {
    const { store, calls } = fakeStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_wake_two",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, mockModel([textStep("first"), textStep("second")]));
      },
    });

    await harness.sendAction(WAKE);
    await harness.sendAction({
      ...WAKE,
      type: "watch.expired",
      id: "watch:watch_2:expired",
      watchId: "watch_2",
      facts: { verified: false, reason: "unverified_at_expiry" },
    });

    expect(calls.appendMessage).toHaveLength(2);
    expect(calls.appendMessage.map((call) => (call as { message: UIMessage }).message.id)).toEqual([
      "wake:watch:watch_1:fired",
      "wake:watch:watch_2:expired",
    ]);
  });
});

describe("watch investigation", () => {
  let harness: MockChatAgentHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  const INVESTIGATE = {
    type: "watch.investigate" as const,
    id: "watch:watch_1:fired:investigate",
    watchId: "watch_1",
    identity: "run_finished:run_abc123",
    spec: {
      kind: "run_finished",
      runId: "run_abc123",
      checkEveryMinutes: 5,
      maxHours: 2,
      note: "tell me when the receipt run finishes",
    },
    facts: { outcome: "COMPLETED_WITH_ERRORS", durationMs: 4200 },
    resolution: "condition_met" as const,
    observed: {
      kind: "run_finished",
      verified: true,
      finalStatus: "COMPLETED_WITH_ERRORS",
      durationMs: 4200,
    },
  };

  const CLIENT_DATA_WITH_TOKEN = {
    ...CLIENT_DATA,
    projectRef: "proj_abc",
    environmentId: "env_abc",
    environmentName: "prod",
    apiOrigin: "https://api.example.com",
    // The delegated token the kick minted, arriving the way a turn's does.
    userActorToken: "uat_investigate",
  };

  const inProgress = {
    outcome: "in_progress",
    severity: "warn",
    confidence: "low",
    runId: "run_abc123",
    title: "Investigating run_abc123",
    headline: "The run finished with errors. Looking into why.",
    hypotheses: [],
    evidence: [],
  };

  const concluded = {
    ...inProgress,
    outcome: "concluded",
    confidence: "high",
    headline: "The receipt task threw on every attempt: the payload lost `order.total`.",
    remediation: "Restore the field on the producer, or guard the read.",
    hypotheses: [
      {
        id: "hyp_payload",
        statement: "The new payload no longer carries order.total.",
        verdict: "validated",
        finding: "Every attempt failed with the same TypeError.",
        evidence: [],
      },
    ],
  };

  // Records the prompts it was called with, and plays one step per call.
  function recordingModel(steps: LanguageModelV3StreamPart[][]) {
    const prompts: unknown[] = [];
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        prompts.push(options.prompt);
        const chunks = steps[Math.min(call, steps.length - 1)] ?? [];
        call++;
        return { stream: simulateReadableStream({ chunks }) };
      },
      doGenerate: async () => ({
        content: [{ type: "text", text: "" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE,
        warnings: [],
      }),
    });
    return { model, prompts };
  }

  const renderStep = (
    investigation: Record<string, unknown>,
    investigationId: string,
    toolCallId: string
  ) =>
    toolCallStep(
      "render_view",
      { blocks: [{ type: "investigation", investigation }], investigationId },
      toolCallId
    );

  it("revises the card the wake seeded, answers in its own message, and dedupes a replay", async () => {
    const { store, calls } = fakeStore({
      openInvestigation: { id: "inv_seeded", projectRef: "proj_abc", environmentRef: "env_abc" },
    });
    const { model, prompts } = recordingModel([
      renderStep(concluded, "inv_seeded", "tc_verdict"),
      textStep("The payload lost order.total — every attempt threw on the same line."),
    ]);
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_investigate",
      clientData: CLIENT_DATA_WITH_TOKEN,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    const turn = await harness.sendAction(INVESTIGATE);

    // A real investigating turn: the model called a tool and it executed.
    expect(executedTool(turn.chunks)).toBe(true);
    expect(collectText(turn.chunks)).toContain("order.total");

    // The card the wake opened is the one this revises: no second investigation for
    // the same news, and no id the model got to choose.
    expect(calls.findOpenInvestigation).toHaveLength(1);
    expect(calls.upsertInvestigationRevision).toHaveLength(1);
    const revision = calls.upsertInvestigationRevision[0] as {
      id?: string;
      chatId: string;
      state: { outcome: string };
    };
    expect(revision.id).toBe("inv_seeded");
    expect(revision.chatId).toBe("chat_investigate");
    expect(revision.state.outcome).toBe("concluded");

    // The prompt names that card and frames the findings as their own message.
    const prompt = JSON.stringify(prompts);
    expect(prompt).toContain("inv_seeded");
    expect(prompt).toContain("pre-approved");
    expect(prompt).toContain("its own message");

    // Findings appended once and whole: the render_view part is what the panel rebuilds
    // the card from.
    expect(calls.appendMessage).toHaveLength(1);
    const appended = calls.appendMessage[0] as { userId: string; message: UIMessage };
    expect(appended.userId).toBe(CLIENT_DATA.userId);
    expect(appended.message.id).toBe("investigate:watch:watch_1:fired:investigate");
    expect(appended.message.parts.some((part) => part.type === "tool-render_view")).toBe(true);

    // The same kick again: nothing runs, nothing is written.
    await harness.sendAction(INVESTIGATE);
    expect(calls.appendMessage).toHaveLength(1);
    expect(calls.upsertInvestigationRevision).toHaveLength(1);
  });

  it("opens a card of its own when the wake's seed never landed", async () => {
    const { store, calls } = fakeStore();
    const { model, prompts } = recordingModel([textStep("Couldn't get far — the trace is gone.")]);
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_investigate_seed",
      clientData: CLIENT_DATA_WITH_TOKEN,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    await harness.sendAction(INVESTIGATE);

    // No open card to find, so the turn seeded one and told the model to revise that.
    expect(calls.findOpenInvestigation).toHaveLength(1);
    expect(calls.upsertInvestigationRevision).toHaveLength(1);
    expect((calls.upsertInvestigationRevision[0] as { id?: string }).id).toBeUndefined();
    expect(JSON.stringify(prompts)).toContain("inv_fake");
    expect(calls.appendMessage).toHaveLength(1);
  });

  it("settles a card the investigating turn left in progress", async () => {
    const { store, calls } = fakeStore({
      openInvestigation: { id: "inv_seeded", projectRef: "proj_abc", environmentRef: "env_abc" },
    });
    const { model } = recordingModel([
      renderStep(inProgress, "inv_seeded", "tc_open"),
      textStep("still looking"),
    ]);
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_investigate_unsettled",
      clientData: CLIENT_DATA_WITH_TOKEN,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    await harness.sendAction(INVESTIGATE);

    // No onTurnComplete fires on an action, so the guard runs in the handler.
    expect(calls.upsertInvestigationRevision).toHaveLength(2);
    const settle = calls.upsertInvestigationRevision[1] as {
      id?: string;
      state: { outcome: string };
    };
    expect(settle.id).toBe("inv_seeded");
    expect(settle.state.outcome).toBe("inconclusive");
  });

  it("says nothing when the kick carries no tenancy to scope a card with", async () => {
    const { store, calls } = fakeStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_investigate_unscoped",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, mockModel([textStep("should never run")]));
      },
    });

    await harness.sendAction(INVESTIGATE);

    expect(calls.findOpenInvestigation).toHaveLength(0);
    expect(calls.upsertInvestigationRevision).toHaveLength(0);
    expect(calls.appendMessage).toHaveLength(0);
  });
});

describe("sanitizeReplayedToolInputs", () => {
  it("coerces empty-string and null tool inputs to {} and leaves everything else alone", () => {
    const messages = [
      { role: "user", content: "investigate this" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "get_report", input: "" },
          // `typeof null === "object"`, which the API rejects with "Input should be an
          // object".
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
    // onTurnComplete enqueues after the turn-complete chunk, so give it a tick.
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
    // The key is chat + turn, so a retried turn is scored once.
    expect(calls[0]?.options.idempotencyKey).toBe("eval:chat_rate_one:0");
  });

  it("falls back to sampling every turn when the rate is unparseable", async () => {
    expect(await turnAtRate("not-a-number", "chat_rate_bad")).toHaveLength(1);
  });
});

describe("a turn that ends in an error", () => {
  let harness: MockChatAgentHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  /**
   * A store that keeps the transcript the way the real one does: `persistTurn`
   * overwrites it, `appendMessage` adds one message unless its id is already there.
   * Lets the test read history back rather than only count calls.
   */
  function transcriptStore(): { store: DashboardAgentStore; history: () => UIMessage[] } {
    let messages: UIMessage[] = [];
    const store: DashboardAgentStore = {
      ensureChat: async () => undefined,
      persistMessages: async (args) => void (messages = args.messages as UIMessage[]),
      appendMessage: async (args) => {
        const message = args.message as UIMessage;
        if (!messages.some((m) => m.id === message.id)) messages = [...messages, message];
      },
      persistTurn: async (args) => void (messages = args.messages as UIMessage[]),
      setChatTitleIfDefault: async () => undefined,
      upsertInvestigationRevision: async () => ({
        ok: true,
        id: "inv_fake",
        revision: 0,
        created: true,
      }),
      findOpenInvestigation: async () => null,
    };
    return { store, history: () => messages };
  }

  /** A model that fails the turn, the way a provider outage does. */
  function failingModel() {
    return new MockLanguageModelV3({
      doStream: async () => {
        throw new Error("upstream_connect_error: provider said no");
      },
      doGenerate: async () => {
        throw new Error("upstream_connect_error: provider said no");
      },
    });
  }

  it("records the failure in the transcript, in the user's words", async () => {
    const { store, history } = transcriptStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_turn_error",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, failingModel());
      },
    });

    const turn = await harness.sendMessage(userMessage("hi"));

    // The live chunk says the same sentence the transcript keeps, so the browser
    // and a reload never disagree, and the provider's words reach neither.
    const errorChunk = turn.chunks.find(
      (chunk) => (chunk as { type?: string }).type === "error"
    ) as { errorText?: string } | undefined;
    expect(errorChunk?.errorText).toBe(TURN_FAILED_MESSAGE);

    // onTurnComplete writes after the turn-complete chunk, so give it a tick.
    await new Promise((r) => setTimeout(r, 30));

    const stored = history();
    const failure = stored.find((message) => message.id === turnFailureMessageId(0));
    expect(failure?.role).toBe("assistant");
    expect(failure?.parts).toEqual([{ type: "text", text: TURN_FAILED_MESSAGE }]);
    // The record must never carry the provider's own words.
    expect(JSON.stringify(stored)).not.toContain("upstream_connect_error");
    // The user's question stays in the transcript next to it.
    expect(stored.some((message) => message.role === "user")).toBe(true);
  });
});

// Back-compat: resumed chats replay their original metadata shape.
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

describe("buildDashboardAgentTools", () => {
  it("exposes the read tools plus render_view, and the data tools fail closed with no token", async () => {
    const tools = buildDashboardAgentTools({});
    expect(Object.keys(tools).sort()).toEqual(
      [
        "ask_support",
        "correlate_version",
        "create_alert",
        "delete_alert",
        "get_current_page",
        "get_deploy",
        "get_error",
        "get_query_schema",
        "get_queue",
        "get_report",
        "get_run",
        "get_run_trace",
        "list_alerts",
        "list_deploys",
        "list_environments",
        "list_errors",
        "list_projects",
        "list_runs",
        "list_tasks",
        "navigate_to",
        "run_query",
        "render_view",
        "schedule_watch",
        "search_docs",
      ].sort()
    );

    // With no token every data tool returns an error, never throws and never hits the
    // network. The exempt ones read no user data: render_view and navigate_to validate
    // a spec, get_current_page reads the turn's own context, and ask_support and
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

  // Behaves like the real query: no id creates at revision 0, an id bumps the
  // revision, and a foreign id reports a context mismatch without writing.
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

  // Parsed through the tool's own inputSchema, the way the AI SDK does, so these tests
  // exercise the model-facing boundary and not a hand-built object.
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

    // Revision 0 committed with the turn's own project/environment, and the block that
    // reaches the transcript carries the identity the store assigned.
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
        // Already canonical, so it passes through untouched.
        ...investigationState.evidence,
        // A span carries its two parts, so the executor can build the URI. Nothing was
        // read this turn: the read gate belongs to the source kind alone.
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
    // A snapshot is in scope; it just isn't proof that anything was opened.
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

  const codeSnapshot: RepoSnapshot = {
    tarballUrl: "http://unused.invalid/never-fetched",
    owner: "acme",
    repo: "orders",
    sha: "c".repeat(40),
  };

  // Pre-seed the deterministic workspace with a `.ready` marker so read_file serves it
  // offline, the same way repo-tools.test.ts does.
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

    // Cited but never read: the render fails on the citation, so there is no card to
    // hang a button on.
    const unread = await renderInvestigation(tools, concludedWithSource);
    expect(unread.blocks).toBeUndefined();
    expect(unread.error).toContain("src/tasks/send-order-receipt.ts");

    // Read it, and the same state earns the button, grounded in the canonical source
    // URI as a canned ask the model didn't write.
    expect(
      (await readFileTool(tools).execute({ path: "src/tasks/send-order-receipt.ts" }, {})).content
    ).toContain("maxAttempts");

    const grounded = await renderInvestigation(tools, concludedWithSource);
    const actions = grounded.blocks[0].capabilities.actions;
    expect(actions.map((a: { kind: string }) => a.kind)).toEqual([
      "show_code",
      "watch_recurrence",
      "view_similar",
    ]);
    expect(actions[0].intent.kind).toBe("ask");
    // The ask proposes a change rather than another explanation.
    const prompt: string = actions[0].intent.prompt;
    expect(prompt).toContain("```diff");
    expect(prompt).toContain(`src/tasks/send-order-receipt.ts:1@${codeSnapshot.sha.slice(0, 7)}`);
    expect(prompt).toMatch(/minimal change/i);
    expect(prompt).toMatch(/dirty tree|branch head/i);
    expect(prompt).toMatch(/don't restate the investigation/i);

    // "Watch for a repeat" carries the kind and the subject, so the Watch card is
    // pre-filled without another model turn.
    expect(actions[1].intent).toEqual({
      kind: "watch",
      spec: {
        kind: "error_recurrence",
        fingerprint: "c4b4a797397a9c43",
        checkEveryMinutes: 15,
        maxHours: 24,
        note: `A repeat of: ${concludedWithSource.title}`,
      },
    });

    expect(actions[2].intent).toEqual({
      kind: "navigate",
      target: "trigger://proj_abc/env_abc/error/c4b4a797397a9c43",
    });
  });

  // A concluded card citing no error group has no subject to pre-fill from, so the
  // button is left off rather than offered empty.
  it("offers no repeat watch when the card cites no error group", async () => {
    const { capability } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    const output = await renderInvestigation(tools, concludedState);
    const kinds = (output.blocks[0].capabilities?.actions ?? []).map(
      (a: { kind: string }) => a.kind
    );
    expect(kinds).not.toContain("watch_recurrence");
  });

  it("offers no actions while an investigation is still in progress", async () => {
    const { capability } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });
    const output = await renderInvestigation(tools);
    expect(output.blocks[0].capabilities).toBeUndefined();
  });

  // An inconclusive card has no cause to watch for a repeat of, so the handoff stays
  // off it.
  it("offers a keep-digging follow-up, and never Show code or a repeat watch, on an inconclusive card", async () => {
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

    // One investigation, two revisions, so the panel shows one live card.
    expect(rows.size).toBe(1);
    expect(second.investigationId).toBe(first.investigationId);
    expect(second.blocks[0].revision).toBe(1);
    expect(second.blocks[0].investigation.remediation).toBeDefined();
  });

  // A later turn gets a fresh tool set, so the closure is empty and the model must
  // pass back the id the tool returned.
  it("render_view continues a previous turn's investigation from the returned id", async () => {
    const { capability, rows } = fakeInvestigations();

    const first = await renderInvestigation(
      buildDashboardAgentTools({ ...SCOPE, investigations: capability })
    );

    // Next turn: new tool set, same chat.
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
    // mismatch whatever the model claims.
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
    // No store seam at all, and no project/environment.
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
          // Envelope fields on the block and identity inside the payload, all stripped
          // by the input schema.
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

  const WATCH_CTX = {
    userActorToken: "uat_token",
    apiOrigin: "http://localhost:3030",
    chatId: "chat_1",
  };

  const RUN_WATCH = {
    kind: "run_finished" as const,
    runId: "run_a1",
    checkEveryMinutes: 1 as const,
    maxHours: 2,
    note: "tell me when the receipt run finishes",
  };

  // Records any request schedule_watch would have made. It must make none: the card
  // the intent opens is the only thing that creates a watch.
  async function scheduleWatch(
    input: unknown = { watch: RUN_WATCH },
    ctx: Record<string, unknown> = WATCH_CTX
  ) {
    const requests: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
      requests.push(String(url));
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const tools = buildDashboardAgentTools(ctx);
      const scheduleTool = tools.schedule_watch as {
        inputSchema: { parse: (input: unknown) => unknown };
        execute: (input: unknown, opts: unknown) => Promise<any>;
      };
      const result = await scheduleTool.execute(input, {});
      return { result, requests };
    } finally {
      globalThis.fetch = original;
    }
  }

  it("schedule_watch returns a watch intent and creates nothing", async () => {
    const { result, requests } = await scheduleWatch();

    expect(result).toEqual({ intent: { kind: "watch", spec: RUN_WATCH } });
    expect(requests).toEqual([]);
  });

  it("schedule_watch has no consent parameter — the card owns the opt-ins", () => {
    const tools = buildDashboardAgentTools(WATCH_CTX);
    const scheduleTool = tools.schedule_watch as {
      inputSchema: { parse: (input: unknown) => unknown };
    };
    const parsed = scheduleTool.inputSchema.parse({
      watch: RUN_WATCH,
      investigateOnAttention: true,
    });
    expect(parsed).toEqual({ watch: RUN_WATCH });
  });

  it("schedule_watch rejects a spec the contract won't accept", async () => {
    // Aggregate conditions are floored at 5 minutes by the contract's schema.
    const floored = await scheduleWatch({
      watch: {
        kind: "backlog_drain",
        queue: "task/x",
        checkEveryMinutes: 1,
        maxHours: 1,
        note: "n",
      },
    });
    expect(typeof floored.result.error).toBe("string");
    expect(floored.requests).toEqual([]);

    const nonsense = await scheduleWatch({ watch: { kind: "run_finished" } });
    expect(typeof nonsense.result.error).toBe("string");
  });

  // The env-JWT exchange is a webapp request plus DB work, so it is paid for once per
  // tool set, and so once per turn, however many env-scoped tools run.
  const ENV_CTX = {
    userActorToken: "uat_token",
    apiOrigin: "http://localhost:3030",
    projectRef: "proj_abc",
    environmentName: "prod",
    environmentId: "env_abc",
  };

  // Records every request path, so a test can count exchanges (`/jwt`) separately from
  // the data reads.
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
      // A fresh tool set is a fresh turn, so exactly one more.
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

  const CHART_SPEC = {
    blocks: [
      {
        type: "chart",
        title: "Runs per hour",
        query: "SELECT toStartOfHour(triggered_at) AS bucket, count() AS runs FROM runs",
        period: "24h",
        chartType: "line" as const,
        xAxisColumn: "bucket",
        yAxisColumns: ["runs"],
      },
    ],
  };

  const renderView = (ctx: Record<string, unknown>, spec: unknown) =>
    (
      buildDashboardAgentTools(ctx).render_view as {
        execute: (i: unknown, o: unknown) => Promise<any>;
      }
    ).execute(spec, {});

  const queryRequests = (requests: Array<{ url: string }>) =>
    requests.filter((r) => r.url.endsWith("/api/v1/query"));

  it("render_view fails with the chart query's own error, committing no blocks", async () => {
    const fetchStub = stubFetch((url) => {
      if (url.endsWith("/jwt")) return { body: { token: "jwt_1" } };
      return { status: 400, body: { error: "Unknown column createdAt" } };
    });
    try {
      const result = await renderView(ENV_CTX, {
        blocks: [{ ...CHART_SPEC.blocks[0], query: "SELECT createdAt FROM runs" }],
      });
      expect(result.error).toContain("Unknown column createdAt");
      expect(result.blocks).toBeUndefined();
      expect(queryRequests(fetchStub.requests)).toHaveLength(1);
    } finally {
      fetchStub.restore();
    }
  });

  it("render_view commits the chart when its query runs, validating it once", async () => {
    const fetchStub = stubFetch((url, init) => {
      if (url.endsWith("/jwt")) return { body: { token: "jwt_1" } };
      // The validation runs the same window the panel will render.
      expect(JSON.parse(String(init?.body))).toMatchObject({
        scope: "environment",
        period: "24h",
      });
      return { body: { results: [{ bucket: "2026-01-01T00:00:00Z", runs: 1 }] } };
    });
    try {
      // The rows aren't embedded in the block — the panel stays the runner.
      await expect(renderView(ENV_CTX, CHART_SPEC)).resolves.toEqual({ blocks: CHART_SPEC.blocks });
      expect(queryRequests(fetchStub.requests)).toHaveLength(1);
    } finally {
      fetchStub.restore();
    }
  });

  it("render_view commits the chart when the validation request itself fails", async () => {
    const fetchStub = stubFetch((url) => {
      if (url.endsWith("/jwt")) return { body: { token: "jwt_1" } };
      throw new Error("ECONNREFUSED");
    });
    try {
      await expect(renderView(ENV_CTX, CHART_SPEC)).resolves.toEqual({ blocks: CHART_SPEC.blocks });
    } finally {
      fetchStub.restore();
    }
  });

  it("render_view skips chart validation when the turn carries no delegated token", async () => {
    const fetchStub = stubFetch(() => ({ status: 400, body: { error: "never asked" } }));
    try {
      await expect(renderView({}, CHART_SPEC)).resolves.toEqual({ blocks: CHART_SPEC.blocks });
      expect(fetchStub.requests).toEqual([]);
    } finally {
      fetchStub.restore();
    }
  });

  it("render_view never runs a query for non-chart blocks", async () => {
    const fetchStub = stubFetch(() => ({ status: 400, body: { error: "never asked" } }));
    try {
      const blocks = [
        {
          type: "diagnosis",
          runId: "run_abc123",
          summary: "The task threw because the order had no line items.",
          category: "user_code_error",
          likelyCause: "processOrder throws when items is empty.",
          confidence: "high",
          evidence: [{ type: "error", detail: "Error: order has no items" }],
          nextSteps: ["Validate the payload before triggering."],
        },
      ];
      await expect(renderView(ENV_CTX, { blocks })).resolves.toEqual({ blocks });
      expect(fetchStub.requests).toEqual([]);
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

    // Only a raw path degrades to the `other` page kind.
    await expect(callTool("get_current_page", {}, { currentPage: "/some/page" })).resolves.toEqual({
      page: { kind: "other", path: "/some/page" },
      signals: [],
    });

    // Nothing at all: say so rather than guessing.
    const blind = await callTool("get_current_page", {}, {});
    expect(blind.page).toBeNull();
    expect(typeof blind.note).toBe("string");
  });

  // The tools are rebuilt from the turn's clientData, so a stale answer can only come
  // from the model reusing an earlier turn instead of calling again.
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

describe("watch alert tools", () => {
  const ALERT_CTX = {
    userActorToken: "uat_token",
    apiOrigin: "http://localhost:3030",
    projectRef: "proj_abc",
    environmentName: "prod",
    chatId: "chat_alerts",
  };

  // Hands back the tool's result and the request the webapp would have received.
  async function callAlertTool(
    name: string,
    input: unknown,
    response: { status?: number; body: unknown },
    ctx: Record<string, unknown> = ALERT_CTX
  ) {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify(response.body), {
        status: response.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const tools = buildDashboardAgentTools(ctx);
      const tool = tools[name] as {
        inputSchema: { parse: (input: unknown) => unknown };
        execute: (input: unknown, opts: unknown) => Promise<any>;
      };
      const result = await tool.execute(tool.inputSchema.parse(input), {});
      return { result, requests };
    } finally {
      globalThis.fetch = original;
    }
  }

  it("list_alerts reads the project's subscriptions as the user", async () => {
    const alerts = [{ id: "alert_1", type: "EMAIL", label: "k***@trigger.dev", enabled: true }];
    const { result, requests } = await callAlertTool("list_alerts", {}, { body: { alerts } });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "http://localhost:3030/api/v1/dashboard-agent/alerts?chatId=chat_alerts"
    );
    expect(requests[0]?.init?.method).toBe("GET");
    expect((requests[0]?.init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer uat_token"
    );
    expect(result).toEqual({ alerts });
  });

  it("create_alert posts the email channel and reports the created alert", async () => {
    const { result, requests } = await callAlertTool(
      "create_alert",
      { email: "someone@example.com" },
      { body: { ok: true, alert: { id: "alert_2", type: "EMAIL" } } }
    );

    expect(requests[0]?.url).toBe("http://localhost:3030/api/v1/dashboard-agent/alerts");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      chatId: "chat_alerts",
      channel: "email",
      email: "someone@example.com",
    });
    expect(result).toEqual({ created: true, alert: { id: "alert_2", type: "EMAIL" } });

    // With no email the host defaults to the user's account email, so the body carries
    // only the chat scope and the channel.
    const noEmail = await callAlertTool("create_alert", {}, { body: { ok: true } });
    expect(JSON.parse(String(noEmail.requests[0]?.init?.body))).toEqual({
      chatId: "chat_alerts",
      channel: "email",
    });
  });

  it("create_alert relays a 403 with the reason the host gave", async () => {
    const noEmailSetup = await callAlertTool(
      "create_alert",
      {},
      { status: 403, body: { error: "denied", reason: "email_alerts_not_configured" } }
    );
    expect(noEmailSetup.result.error).toContain("isn't set up on this instance");
    expect(noEmailSetup.result.error).toContain("dashboard");

    const flag = await callAlertTool(
      "create_alert",
      {},
      { status: 403, body: { error: "denied", reason: "dashboard_agent_disabled" } }
    );
    expect(flag.result.error).toContain("aren't enabled here");
  });

  it("create_alert relays the address refusal verbatim", async () => {
    const refused = await callAlertTool(
      "create_alert",
      { email: "someone@else.com" },
      {
        status: 400,
        body: {
          code: "email_not_allowed",
          error: "Alerts can only be sent to your own account email.",
        },
      }
    );
    expect(refused.result.error).toBe("Alerts can only be sent to your own account email.");
  });

  it("delete_alert deletes by id and surfaces a failure as text", async () => {
    const { result, requests } = await callAlertTool(
      "delete_alert",
      { alertId: "alert_1" },
      { body: { ok: true } }
    );
    expect(requests[0]?.url).toBe("http://localhost:3030/api/v1/dashboard-agent/alerts/alert_1");
    expect(requests[0]?.init?.method).toBe("DELETE");
    expect(result).toEqual({ deleted: true, alertId: "alert_1" });

    const missing = await callAlertTool(
      "delete_alert",
      { alertId: "alert_gone" },
      { status: 404, body: { error: "No such alert." } }
    );
    expect(missing.result.error).toBe("No such alert.");
  });

  it("the alert tools fail closed with no delegated token, without hitting the network", async () => {
    for (const [name, input] of [
      ["list_alerts", {}],
      ["create_alert", {}],
      ["delete_alert", { alertId: "alert_1" }],
    ] as const) {
      const { result, requests } = await callAlertTool(name, input, { body: {} }, {});
      expect(typeof result.error).toBe("string");
      expect(requests).toHaveLength(0);
    }
  });
});
