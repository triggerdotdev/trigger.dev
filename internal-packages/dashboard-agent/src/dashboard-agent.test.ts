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
// Watch wakes — an action, not a turn
// ---------------------------------------------------------------------------

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

    // The streamed message carries the SAME id the read-model copy is persisted
    // under — the panel merges live stream and loaded history by message id, so
    // two ids for one narration would render it twice.
    const startChunk = first.chunks.find(
      (chunk) => (chunk as { type?: string }).type === "start"
    ) as { messageId?: string } | undefined;
    expect(startChunk?.messageId).toBe("wake:watch:watch_1:fired");

    // An action is not a turn: no turn persistence ran, but the narration is in
    // the display read-model under an id derived from the action.
    expect(calls.persistTurn).toHaveLength(0);
    expect(calls.persistMessages).toHaveLength(1);
    const persisted = (calls.persistMessages[0] as { messages: UIMessage[] }).messages;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ id: "wake:watch:watch_1:fired", role: "assistant" });

    // Same action id again (the watcher retried after appending): deduped.
    const second = await harness.sendAction(WAKE);
    expect(collectText(second.chunks)).toBe("");
    expect(calls.persistMessages).toHaveLength(1);
  });

  /**
   * A model that records the prompt it was asked with, so the wake's framing can
   * be asserted directly. The narration IS the prompt's job — what it must never
   * say is as load-bearing as what it must.
   */
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

  // §4.2 / §7.7: the narration speaks the resolution model, and a completed
  // window is an ANSWER — never "the watch expired with nothing to say".
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
    // The wire encoding is transport, not vocabulary (§7.5).
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

  // A wake from a watcher that predates the resolution model still narrates: the
  // resolution is reconstructed from the transport rather than lost.
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

  // -------------------------------------------------------------------------
  // Watch → Investigate: the one relaxation of "never a new investigation
  // unprompted" (§6). Consent is given at creation and applies to the ATTENTION
  // outcomes only — the contracts mapping decides which those are.
  // -------------------------------------------------------------------------

  // A wake needs the project's external ref to scope the investigation exactly
  // as a turn would; the watcher puts it in the wake's metadata.
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

    // The wake still lands first and says the investigation has started.
    expect(calls.persistMessages).toHaveLength(1);
    expect(wakeText(prompts)).toContain("ALREADY been started");

    // And the investigation exists: opened, not concluded — the wake has no
    // token to read with, so the findings come later in their own message.
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

  // Consent is for bad news. A drained queue is the good kind, so the same flag
  // starts nothing — the category comes from the contracts mapping, never from
  // the flag or the resolution alone.
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

    expect(calls.persistMessages).toHaveLength(1);
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

    expect(calls.persistMessages).toHaveLength(1);
    expect(calls.upsertInvestigationRevision).toHaveLength(0);
    // …and the wake is never framed as having started one.
    expect(wakeText(prompts)).not.toContain("ALREADY been started");
  });

  // Binding independence (§6): scheduling the investigation never delays,
  // retries or invalidates the wake. The watcher has already marked the delivery
  // by the time the agent runs, so the only thing this can break is the turn —
  // and it must not.
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
    expect(calls.persistMessages).toHaveLength(1);
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

    expect(calls.persistMessages).toHaveLength(2);
    const latest = (calls.persistMessages[1] as { messages: UIMessage[] }).messages;
    expect(latest.map((m) => m.id)).toEqual([
      "wake:watch:watch_1:fired",
      "wake:watch:watch_2:expired",
    ]);
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
    expect(actions.map((a: { kind: string }) => a.kind)).toEqual([
      "show_code",
      "watch_recurrence",
      "view_similar",
    ]);
    expect(actions[0].intent.kind).toBe("ask");
    // The ask is a propose-a-change request, not another explanation: a fenced
    // diff, the minimal change, anchored path:line@sha, with the dirty caveat.
    const prompt: string = actions[0].intent.prompt;
    expect(prompt).toContain("```diff");
    expect(prompt).toContain(`src/tasks/send-order-receipt.ts:1@${codeSnapshot.sha.slice(0, 7)}`);
    expect(prompt).toMatch(/minimal change/i);
    expect(prompt).toMatch(/dirty tree|branch head/i);
    expect(prompt).toMatch(/don't restate the investigation/i);

    // "Watch for a repeat" is a HANDOFF, not a question: it carries the kind and
    // the subject, so the Watch card can be pre-filled without another LLM turn.
    expect(actions[1].intent).toEqual({
      kind: "watch",
      spec: {
        kind: "error_recurrence",
        fingerprint: "error_c4b4a797397a9c43",
        checkEveryMinutes: 15,
        maxHours: 24,
        note: `A repeat of: ${concludedWithSource.title}`,
      },
    });

    // The follow-up that navigates points at the canonical error URI.
    expect(actions[2].intent).toEqual({
      kind: "navigate",
      target: "trigger://proj_abc/env_abc/error/c4b4a797397a9c43",
    });
  });

  // The handoff needs a subject a recurrence watch can be built on. A concluded
  // card that cites no error group has none, so the action is left off rather
  // than offering a button that can't pre-fill anything.
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

  // An inconclusive card has no cause to watch for a repeat OF, so the handoff
  // stays off it — "keep digging" is the follow-up that fits.
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

  // -------------------------------------------------------------------------
  // schedule_watch: the one tool that schedules future work
  // -------------------------------------------------------------------------

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

  // Runs schedule_watch against a stubbed global fetch and hands back both the
  // tool's result and the request the host would have received.
  async function scheduleWatch(
    response: { status?: number; body: unknown },
    input: unknown = { watch: RUN_WATCH },
    ctx: Record<string, unknown> = WATCH_CTX
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
      const scheduleTool = tools.schedule_watch as {
        inputSchema: { parse: (input: unknown) => unknown };
        execute: (input: unknown, opts: unknown) => Promise<any>;
      };
      const result = await scheduleTool.execute(scheduleTool.inputSchema.parse(input), {});
      return { result, requests };
    } finally {
      globalThis.fetch = original;
    }
  }

  it("schedule_watch posts the spec and the chat id as the user, and reports the created watch", async () => {
    const { result, requests } = await scheduleWatch({
      body: {
        watchId: "watch_1",
        identity: "run_finished:run_a1",
        status: "active",
        expiresAt: "2026-01-01T14:00:00.000Z",
        emailAlerts: "none",
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://localhost:3030/api/v1/dashboard-agent/watches");
    expect(requests[0]?.init?.method).toBe("POST");
    // The delegated user token — a watch is created with exactly the access of
    // the user who asked for it.
    expect((requests[0]?.init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer uat_token"
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      spec: RUN_WATCH,
      chatId: "chat_1",
    });

    expect(result).toMatchObject({
      watchId: "watch_1",
      identity: "run_finished:run_a1",
      status: "active",
      expiresAt: "2026-01-01T14:00:00.000Z",
      checkEveryMinutes: 1,
      watching: true,
      // What the model needs to decide whether to offer an email alert.
      emailAlerts: "none",
    });
  });

  it("schedule_watch passes the alert state through, and defaults to none when the host omits it", async () => {
    for (const state of ["subscribed", "unavailable"] as const) {
      const { result } = await scheduleWatch({
        body: { watchId: "watch_1", status: "active", emailAlerts: state },
      });
      expect(result.emailAlerts).toBe(state);
    }

    // An older host that doesn't send the field must not read as "already
    // subscribed" — the offer is the safe default.
    const legacy = await scheduleWatch({ body: { watchId: "watch_1", status: "active" } });
    expect(legacy.result.emailAlerts).toBe("none");
  });

  it("schedule_watch surfaces the limit and the duplicate as friendly text, naming the existing watch", async () => {
    const limit = await scheduleWatch({
      status: 400,
      body: { error: "too many", code: "limit_reached" },
    });
    expect(limit.result.error).toContain("3 active watches");

    const duplicate = await scheduleWatch({
      status: 409,
      body: { error: "already watching", code: "duplicate", existingId: "watch_existing" },
    });
    expect(duplicate.result.error).toContain("watch_existing");
    expect(duplicate.result.error).toContain("already being watched");
  });

  // §2.2/§4.1: the host answered the request outright and created no watch, so
  // the tool result is a ONE-SHOT the model must answer from in this turn.
  it("schedule_watch reports a one-shot outcome instead of a running watch", async () => {
    const { result } = await scheduleWatch({
      body: {
        watching: false,
        identity: "run_finished:run_abc",
        immediate: { result: "satisfied", facts: { status: "COMPLETED" } },
      },
    });
    expect(result.watching).toBe(false);
    expect(result.outcome).toBe("already_true");
    expect(result.immediate).toEqual({ result: "satisfied", facts: { status: "COMPLETED" } });
    // No watch id: there is nothing to cancel, and nothing will wake later.
    expect(result.watchId).toBeUndefined();

    const impossible = await scheduleWatch({
      body: {
        watching: false,
        identity: "run_finished:run_abc",
        immediate: { result: "terminal_unsatisfied", facts: {} },
      },
    });
    expect(impossible.result.outcome).toBe("no_longer_possible");
  });

  it("schedule_watch says so when the first check couldn't run", async () => {
    const { result } = await scheduleWatch({
      body: { watching: true, watchId: "watch_1", status: "active", unavailable: true },
    });
    expect(result.watching).toBe(true);
    expect(result.firstCheck).toBe("unavailable");
    expect(result.checked).toBe(false);
  });

  it("schedule_watch fails closed with no chat and rejects a cadence the contract floors", async () => {
    const noChat = await scheduleWatch({ body: {} }, { watch: RUN_WATCH }, {
      userActorToken: "uat_token",
      apiOrigin: "http://localhost:3030",
    } as Record<string, unknown>);
    expect(typeof noChat.result.error).toBe("string");
    expect(noChat.requests).toHaveLength(0);

    // Aggregate conditions are floored at 5 minutes by the contract's schema, so
    // an over-eager watch never reaches the host.
    await expect(
      scheduleWatch(
        { body: {} },
        {
          watch: {
            kind: "backlog_drain",
            queue: "task/x",
            checkEveryMinutes: 1,
            maxHours: 1,
            note: "n",
          },
        }
      )
    ).rejects.toThrow();
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

// ---------------------------------------------------------------------------
// Watch alert tools — project-level subscriptions, as the user
// ---------------------------------------------------------------------------

describe("watch alert tools", () => {
  const ALERT_CTX = {
    userActorToken: "uat_token",
    apiOrigin: "http://localhost:3030",
    projectRef: "proj_abc",
    environmentName: "prod",
    chatId: "chat_alerts",
  };

  // Runs one alert tool against a stubbed global fetch, handing back the tool's
  // result and the request the webapp would have received.
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

    // No email given: the host defaults to the user's account email, so the body
    // carries only the chat scope and the channel.
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
