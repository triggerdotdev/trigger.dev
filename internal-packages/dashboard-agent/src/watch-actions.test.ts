// `@trigger.dev/sdk/ai/test` MUST be imported before the agent module so the
// resource catalog is installed before `chat.agent({ id })` / `prompts.define`
// register at module load.
import { mockChatAgent, type MockChatAgentHarness } from "@trigger.dev/sdk/ai/test";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";

import { isAgentRequestMessageId } from "@internal/dashboard-agent-contracts";
import { investigationSettlementMessage, watchInvestigationId } from "@internal/dashboard-agent-db";

import {
  dashboardAgent,
  dashboardAgentEvalPolicyKey,
  dashboardAgentEvalTriggerKey,
  dashboardAgentModelKey,
  dashboardAgentStoreKey,
  type DashboardAgentStore,
} from "./dashboard-agent";
import {
  CLIENT_DATA,
  collectText,
  executedTool,
  fakeEvalPolicy,
  fakeEvalTrigger,
  fakeStore,
  waitForEvals,
  finish,
  mockModel,
  savedPuts,
  savedTranscript,
  saveReasons,
  seedTranscript,
  textStep,
  toolCallStep,
  type FakeInvestigation,
  USAGE,
  userMessage,
} from "./test-support";

/**
 * A watch action that returns `chat.turn()` resolves for the caller when the
 * turn-complete chunk is written, and the runtime saves the turn's answer right after
 * that. Wait for that save before reading the transcript back. `since` is the number
 * of saves already made (a seeded transcript is one), so a seed's own turn-complete
 * save is not mistaken for the turn's.
 */
async function turnSaved(store: DashboardAgentStore, since = 0): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (saveReasons(store).length <= since || saveReasons(store).at(-1) !== "turn-complete") {
    if (Date.now() > deadline) {
      throw new Error(`no turn-complete save; saves were ${saveReasons(store).join(",")}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The saved records the panel shows: everything but the requests the turns answered. */
function recordIds(store: DashboardAgentStore, chatId: string): string[] {
  return savedTranscript(store, chatId)
    .map((m) => m.id)
    .filter((id) => !isAgentRequestMessageId(id));
}

/** The settlements a turn's `onTurnComplete` handed to the store, flattened, in order. */
function settledIds(calls: { settleTurnInvestigations: unknown[] }): string[] {
  return calls.settleTurnInvestigations.flatMap((call) =>
    (call as { settlements: { id: string }[] }).settlements.map((s) => s.id)
  );
}

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
        set(dashboardAgentModelKey, mockModel([textStep("never asked for")]));
      },
    });

    const first = await harness.sendAction(WAKE);
    // A drained queue is a fact the check already established, so the sentence is the
    // dashboard's own wording and no model is called for it.
    expect(collectText(first.chunks)).toBe(
      "task/send-receipt queue drained\n\nNothing to do — I've stopped watching it."
    );

    // The streamed message must carry the same id the read-model copy is persisted
    // under, or the panel renders the narration twice.
    const startChunk = first.chunks.find(
      (chunk) => (chunk as { type?: string }).type === "start"
    ) as { messageId?: string } | undefined;
    expect(startChunk?.messageId).toBe("wake:watch:watch_1:fired");

    // An action is not a turn, so no turn hooks ran. The narration reaches the rows
    // through the runtime's save of the history edit, as one appended message and
    // never a wholesale write: a card-born chat's transcript holds host blocks the
    // session view can't see.
    expect(calls.settleTurnInvestigations).toHaveLength(0);
    expect(saveReasons(store)).toEqual(["action"]);
    expect(savedPuts(store)).toMatchObject([{ id: "wake:watch:watch_1:fired", role: "assistant" }]);
    expect(savedTranscript(store, "chat_wake").map((m) => m.id)).toEqual([
      "wake:watch:watch_1:fired",
    ]);

    // Same action id again (the watcher retried): nothing is narrated and nothing is
    // saved, because the history did not change.
    const second = await harness.sendAction(WAKE);
    expect(collectText(second.chunks)).toBe("");
    expect(savedPuts(store).map((m) => m.id)).toEqual(["wake:watch:watch_1:fired"]);
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

  /** Records what each model call was given: how many tools, and any output cap. */
  function capturingModel(text: string) {
    const calls: {
      tools: number;
      maxOutputTokens: number | undefined;
      effort: string | undefined;
    }[] = [];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        // The harness runs on the direct Anthropic provider, where the bounded-call
        // safeguard is `effort: "low"` (see withoutThinking).
        const effort = (options.providerOptions?.anthropic as { effort?: string })?.effort;
        calls.push({
          tools: options.tools?.length ?? 0,
          maxOutputTokens: options.maxOutputTokens,
          effort,
        });
        return { stream: simulateReadableStream({ chunks: textStep(text) }) };
      },
      doGenerate: async () => ({
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE,
        warnings: [],
      }),
    });
    return { model, calls };
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
    const { model, prompts } = recordingModel("never asked for");
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_wake_legacy",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    const wake = await harness.sendAction({
      ...WAKE,
      type: "watch.expired" as const,
      id: "watch:watch_1:expired",
      facts: { reason: "terminal_unsatisfied" },
    });

    // Read as `condition_impossible`: only that resolution says the queue is gone.
    expect(collectText(wake.chunks)).toContain("task/send-receipt queue no longer exists");
    expect(wakeText(prompts)).toBe("[]");
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
  // The narration id the panel knows this wake by.
  const FAILED_RUN_WAKE_ID = "wake:watch:watch_1:fired";

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
    await turnSaved(store);

    // The wake is the turn's answer, saved under the id the panel knows it by, and it
    // says the investigation has started.
    expect(recordIds(store, "chat_wake_investigate")).toEqual([FAILED_RUN_WAKE_ID]);
    expect(wakeText(prompts)).toContain("ALREADY been started");

    // Opened, not concluded: the wake has no token to read with, so the findings come
    // later in their own message.
    expect(calls.seedInvestigation).toHaveLength(1);
    const opened = calls.seedInvestigation[0] as {
      id: string;
      chatId: string;
      projectRef: string;
      environmentRef: string;
      state: { outcome: string; runId?: string };
    };
    // The watch's own id, so the investigating lane can name the same row later.
    expect(opened.id).toBe(watchInvestigationId("watch_1"));
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

    // Good news has fixed wording: streamed as an edit, no turn.
    expect(recordIds(store, "chat_wake_positive")).toHaveLength(1);
    expect(calls.seedInvestigation).toHaveLength(0);
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

    await turnSaved(store);
    expect(recordIds(store, "chat_wake_no_consent")).toEqual([FAILED_RUN_WAKE_ID]);
    expect(calls.seedInvestigation).toHaveLength(0);
    expect(wakeText(prompts)).not.toContain("ALREADY been started");
  });

  /**
   * The wake that needs attention was a bounded call before it became a turn; the
   * turn keeps that shape: no tools, an output cap, and thinking held down so the cap
   * is answer.
   */
  it("runs an attention wake with the bounded budget", async () => {
    const { store } = fakeStore();
    const { model, calls } = capturingModel("Run run_abc123 failed after 4.2s.");
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_wake_budget",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    await harness.sendAction(FAILED_RUN_WAKE);
    await turnSaved(store);

    expect(calls).toEqual([{ tools: 0, maxOutputTokens: 300, effort: "low" }]);
  });

  /**
   * The action marker is cleared when the action turn completes. When that hook fails
   * on both of the runtime's attempts, the marker survives into the next turn, which
   * is the user's: it must get its tools back and be judged like any typed turn.
   */
  it("a wake whose settlement keeps failing does not taint the next typed turn", async () => {
    const originalRate = process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE;
    process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE = "1";
    try {
      const { store } = fakeStore();
      // Down for the wake's turn, on every attempt; back for the typed turn.
      let settlementDown = true;
      const failing: DashboardAgentStore = {
        ...store,
        settleTurnInvestigations: async (args) => {
          if (settlementDown) throw new Error("settlement is down");
          return store.settleTurnInvestigations(args);
        },
      };
      const { trigger, calls: evals } = fakeEvalTrigger();
      const { model, calls } = capturingModel("answered");
      harness = mockChatAgent(dashboardAgent, {
        chatId: "chat_wake_stale_marker",
        clientData: CLIENT_DATA,
        setupLocals: ({ set }) => {
          set(dashboardAgentStoreKey, failing);
          set(dashboardAgentModelKey, model);
          set(dashboardAgentEvalTriggerKey, trigger);
          set(dashboardAgentEvalPolicyKey, fakeEvalPolicy());
        },
      });

      await harness.sendAction(FAILED_RUN_WAKE);
      settlementDown = false;
      await harness.sendMessage(userMessage("what happened?"));
      await waitForEvals(evals, 1);

      // The wake ran bounded; the typed turn ran at the main model's documented ceiling.
      expect(calls[0]).toEqual({ tools: 0, maxOutputTokens: 300, effort: "low" });
      expect(calls[1]?.maxOutputTokens).toBe(128_000);
      expect(calls[1]?.effort).toBeUndefined();
      // Only the typed turn is judged: the wake is the agent talking to itself.
      expect(evals).toHaveLength(1);
    } finally {
      if (originalRate === undefined) delete process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE;
      else process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE = originalRate;
    }
  });

  // Opening the investigation must never delay, retry or invalidate the wake. The
  // watcher has already marked the delivery by the time the agent runs, so the only
  // thing this can break is the turn.
  it("delivers the wake even when opening the investigation fails", async () => {
    const { store } = fakeStore();
    const failing: DashboardAgentStore = {
      ...store,
      seedInvestigation: async () => {
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
    await turnSaved(failing);
    expect(recordIds(failing, "chat_wake_inv_fails")).toEqual([FAILED_RUN_WAKE_ID]);
  });

  it("an empty narration still files the request and opens the consented investigation", async () => {
    const { store, calls } = fakeStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_wake_empty",
      clientData: WAKE_CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, mockModel([[finish("stop")]]));
      },
    });

    const turn = await harness.sendAction({ ...FAILED_RUN_WAKE, investigateOnAttention: true });
    await turnSaved(store);

    // The wake is a turn now: an answer with no text is the model's shortfall, not a
    // failed delivery. The request is in the transcript, and the investigation the
    // user consented to was opened before the answer was asked for.
    expect(collectText(turn.chunks)).toBe("");
    expect(turn.chunks.some((chunk) => (chunk as { type?: string }).type === "error")).toBe(false);
    expect(
      savedTranscript(store, "chat_wake_empty").some((m) => isAgentRequestMessageId(m.id))
    ).toBe(true);
    expect(calls.seedInvestigation).toHaveLength(1);
  });

  it("a different outcome on the same watch is a different wake", async () => {
    const { store } = fakeStore();
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
    // The expired wake needs attention, so it is a turn's answer; wait for its save.
    await turnSaved(store);

    expect(recordIds(store, "chat_wake_two")).toEqual([
      "wake:watch:watch_1:fired",
      "wake:watch:watch_2:expired",
    ]);
  });

  /**
   * The request is saved before its turn runs, so a run that dies in between leaves
   * the request without a wake. A continuation does not redispatch actions; the
   * redelivered wake is what resumes the turn, under the same id, without filing a
   * second request.
   */
  it("a redelivered wake answers a request the dead run left unanswered", async () => {
    const chatId = "chat_wake_resume";
    const { store, calls } = fakeStore();
    await seedTranscript(store, {
      chatId,
      clientData: WAKE_CLIENT_DATA,
      messages: [
        {
          id: "wake-request:watch:watch_1:fired",
          role: "user",
          parts: [{ type: "text", text: "the wake's facts" }],
        },
      ],
    });
    const { model, prompts } = recordingModel("Run run_abc123 failed after 4.2s.");
    harness = mockChatAgent(dashboardAgent, {
      chatId,
      clientData: WAKE_CLIENT_DATA,
      continuation: true,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    const seeded = saveReasons(store).length;
    const turn = await harness.sendAction(FAILED_RUN_WAKE);
    await turnSaved(store, seeded);

    expect(collectText(turn.chunks)).toBe("Run run_abc123 failed after 4.2s.");
    expect(prompts).toHaveLength(1);
    const ids = savedTranscript(store, chatId).map((m) => m.id);
    expect(ids).toEqual(["wake-request:watch:watch_1:fired", FAILED_RUN_WAKE_ID]);
    // Nobody typed anything in this chat, so nothing names it.
    expect(calls.setChatTitleIfDefault).toHaveLength(0);
  });

  /**
   * The redelivery is the retry. The wake streamed before the save failed, so the
   * retry finds it narrated and must not say it again, but the row the panel reads
   * is still owed: handing the same history back makes the runtime save it.
   */
  it("a redelivered wake repairs a row the failed save left missing", async () => {
    const { store } = fakeStore();
    let failNext = true;
    const flaky: DashboardAgentStore = {
      ...store,
      transcript: {
        ...store.transcript,
        save: async (ctx, changeset) => {
          if (failNext) {
            failNext = false;
            throw new Error("the save lost the connection");
          }
          return store.transcript.save(ctx, changeset);
        },
      },
    };
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_wake_redelivered",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, flaky);
        set(dashboardAgentModelKey, mockModel([textStep("never asked for")]));
      },
    });

    const first = await harness.sendAction(WAKE);
    expect(collectText(first.chunks)).toContain("queue drained");
    expect(savedTranscript(store, "chat_wake_redelivered")).toHaveLength(0);

    // The same action again: nothing narrated, and the row converges.
    const retry = await harness.sendAction(WAKE);
    expect(collectText(retry.chunks)).toBe("");
    expect(savedTranscript(store, "chat_wake_redelivered").map((m) => m.id)).toEqual([
      "wake:watch:watch_1:fired",
    ]);

    // A third delivery changes nothing: the runtime's diff has nothing left to write.
    await harness.sendAction(WAKE);
    expect(savedTranscript(store, "chat_wake_redelivered").map((m) => m.id)).toEqual([
      "wake:watch:watch_1:fired",
    ]);
  });

  /**
   * Same repair across a run boundary: the retry boots a new run whose history comes
   * from storage plus the durable stream, so it finds the wake narrated even though
   * storage never received it.
   */
  it("a redelivered wake on a continuation boot repairs the row from the stream tail", async () => {
    const chatId = "chat_wake_redelivered_boot";
    const wakeId = "wake:watch:watch_1:fired";
    const { store: failing } = fakeStore();
    const neverSaves: DashboardAgentStore = {
      ...failing,
      transcript: {
        ...failing.transcript,
        save: async () => {
          throw new Error("the save lost the connection");
        },
      },
    };
    harness = mockChatAgent(dashboardAgent, {
      chatId,
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, neverSaves);
        set(dashboardAgentModelKey, mockModel([textStep("never asked for")]));
      },
    });
    const first = await harness.sendAction(WAKE);
    expect(collectText(first.chunks)).toContain("queue drained");
    const durable = first.chunks;
    await harness.close();

    // The retry: a new run, an empty storage, the streamed chunks on `session.out`.
    const { store } = fakeStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId,
      clientData: CLIENT_DATA,
      continuation: true,
      previousRunId: "run_wake_failed",
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, mockModel([textStep("never asked for")]));
      },
    });
    harness.seedSessionOutTail(durable);

    const retry = await harness.sendAction(WAKE);
    expect(collectText(retry.chunks)).toBe("");
    const ids = savedTranscript(store, chatId).map((m) => m.id);
    expect(ids.filter((id) => id === wakeId)).toHaveLength(1);
  });

  /**
   * The wake is durable on `session.out` the moment it streams, which is before the
   * save lands. A save that fails is the runtime's to retry: the change folds into the
   * next changeset, so the History panel converges without the lane doing anything.
   */
  it("carries a wake whose save failed into the next save", async () => {
    const { store } = fakeStore();
    let failNext = true;
    const flaky: DashboardAgentStore = {
      ...store,
      transcript: {
        ...store.transcript,
        save: async (ctx, changeset) => {
          if (failNext) {
            failNext = false;
            throw new Error("the save lost the connection");
          }
          return store.transcript.save(ctx, changeset);
        },
      },
    };
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_wake_retry",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, flaky);
        set(dashboardAgentModelKey, mockModel([textStep("first"), textStep("second")]));
      },
    });

    // Streamed, so it is on `session.out`, while the row never landed.
    const first = await harness.sendAction(WAKE);
    expect(collectText(first.chunks)).toContain("queue drained");
    expect(savedPuts(store)).toHaveLength(0);

    // The next change to the history saves both: the runtime diffs against what was
    // last saved, and the failed save advanced nothing.
    await harness.sendAction({
      ...WAKE,
      type: "watch.expired",
      id: "watch:watch_2:expired",
      watchId: "watch_2",
      facts: { verified: false, reason: "unverified_at_expiry" },
    });
    await turnSaved(store);
    expect(recordIds(store, "chat_wake_retry")).toEqual([
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

  // The card the wake seeded, named the way both lanes name it: off the watch.
  const SEEDED = watchInvestigationId("watch_1");

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
    const { store, calls } = fakeStore();
    const { model, prompts } = recordingModel([
      renderStep(concluded, SEEDED, "tc_verdict"),
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
    await turnSaved(store);

    // A real investigating turn: the model called a tool and it executed.
    expect(executedTool(turn.chunks)).toBe(true);
    expect(collectText(turn.chunks)).toContain("order.total");

    // The card the wake opened is the one this revises: no second investigation for
    // the same news, and no id the model got to choose. The model concluded it, so
    // the turn had nothing left to settle.
    expect(calls.seedInvestigation).toHaveLength(1);
    expect(settledIds(calls)).toEqual([]);
    expect(calls.upsertInvestigationRevision).toHaveLength(1);
    const revision = calls.upsertInvestigationRevision[0] as {
      id?: string;
      chatId: string;
      state: { outcome: string };
    };
    expect(revision.id).toBe(SEEDED);
    expect(revision.chatId).toBe("chat_investigate");
    expect(revision.state.outcome).toBe("concluded");

    // The prompt names that card and frames the findings as their own message.
    const prompt = JSON.stringify(prompts);
    expect(prompt).toContain(SEEDED);
    expect(prompt).toContain("pre-approved");
    expect(prompt).toContain("its own message");

    // Findings saved once and whole: the render_view part is what the panel rebuilds
    // the card from.
    const findings = savedPuts(store).filter(
      (m) => m.id === "investigate:watch:watch_1:fired:investigate"
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.parts.some((part) => part.type === "tool-render_view")).toBe(true);

    // The same kick again: nothing runs and nothing new is saved.
    const saved = savedTranscript(store, "chat_investigate").map((m) => m.id);
    await harness.sendAction(INVESTIGATE);
    expect(savedTranscript(store, "chat_investigate").map((m) => m.id)).toEqual(saved);
    expect(calls.upsertInvestigationRevision).toHaveLength(1);
  });

  /**
   * The consented investigation gets the same ten-step budget a turn does, so without a
   * rolling breakpoint every step re-sends the accumulated tool output at full price.
   */
  it("rolls a step cache breakpoint across the investigation's steps", async () => {
    const bulky = {
      ...concluded,
      // Past the provider's minimum cacheable prefix, so a breakpoint is worth setting.
      headline: `${concluded.headline} ${"the same TypeError on order.total. ".repeat(200)}`,
    };
    const { store } = fakeStore();
    const { model, prompts } = recordingModel([
      renderStep(bulky, SEEDED, "tc_verdict"),
      textStep("The payload lost order.total."),
    ]);
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_investigate_step_cache",
      clientData: CLIENT_DATA_WITH_TOKEN,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    await harness.sendAction(INVESTIGATE);

    const ttlOf = (message: unknown) =>
      (message as { providerOptions?: { anthropic?: { cacheControl?: { ttl?: unknown } } } })
        ?.providerOptions?.anthropic?.cacheControl?.ttl;

    expect(prompts.length).toBeGreaterThan(1);
    // Step two's last message is the accumulated tool output, and it carries the short-lived
    // breakpoint — the one the next step reads back instead of re-sending.
    const second = prompts[1] as unknown[];
    expect(ttlOf(second.at(-1))).toBe("5m");
    // Never more than one: Anthropic allows four, and the prefix breakpoints take two.
    expect(second.filter((message) => ttlOf(message) === "5m")).toHaveLength(1);
    // Step one has nothing accumulated yet, so nothing short-lived is marked.
    expect((prompts[0] as unknown[]).filter((m) => ttlOf(m) === "5m")).toHaveLength(0);
  });

  it("opens the watch's card itself when the wake's seed never landed", async () => {
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
    await turnSaved(store);

    // The same id the wake would have used, so a late seed can never make a second card.
    // The model never rendered, so the turn settles the seeded row itself.
    expect(calls.seedInvestigation).toMatchObject([{ id: SEEDED }]);
    expect(calls.settleTurnInvestigations).toMatchObject([
      { settlements: [{ id: SEEDED, state: { outcome: "inconclusive" } }] },
    ]);
    expect(JSON.stringify(prompts)).toContain(SEEDED);
    expect(recordIds(store, "chat_investigate_seed")).toContain(
      "investigate:watch:watch_1:fired:investigate"
    );
  });

  /**
   * One settle, not two. The row used to be settled once on its own and then again
   * with the card, which bumped the revision twice for one outcome.
   */
  it("settles a card the investigating turn left in progress, exactly once", async () => {
    const { store, calls } = fakeStore();
    const { model } = recordingModel([
      renderStep(inProgress, SEEDED, "tc_open"),
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
    await turnSaved(store);

    // One settle, from the turn's `onTurnComplete`, with the terminal state; the
    // closing card lands in the same operation.
    expect(calls.settleTurnInvestigations).toHaveLength(1);
    expect(settledIds(calls)).toEqual([SEEDED]);
    const settlement = (
      calls.settleTurnInvestigations[0] as { settlements: { state: { outcome: string } }[] }
    ).settlements[0]!;
    expect(settlement.state.outcome).toBe("inconclusive");
  });

  function revisioningStore(options: { failClosingCard?: boolean } = {}) {
    const { store, calls } = fakeStore();
    const closedCards: UIMessage[] = [];
    let revision = 0;
    const wrapped: DashboardAgentStore = {
      ...store,
      // The real query commits the revisions and their closing cards together, so a
      // card that can't be delivered leaves the row exactly as it was.
      settleTurnInvestigations: async (args) => {
        if (options.failClosingCard) {
          calls.settleTurnInvestigations.push(args);
          throw new Error("the append lost the connection");
        }
        const result = await store.settleTurnInvestigations(args);
        closedCards.push(...(result.cards as UIMessage[]));
        return result;
      },
      upsertInvestigationRevision: async (args) => {
        await store.upsertInvestigationRevision(args);
        return {
          ok: true as const,
          id: args.id ?? "inv_fake",
          revision: revision++,
          created: !args.id,
        };
      },
    };
    return { store: wrapped, calls, closedCards };
  }

  function cardsIn(message: UIMessage) {
    return (message.parts ?? []).flatMap((part) => {
      const typed = part as { type?: string; output?: { blocks?: unknown[] } };
      if (typed.type !== "tool-render_view" || !Array.isArray(typed.output?.blocks)) return [];
      return typed.output.blocks as Array<{
        type?: string;
        id?: string;
        revision?: number;
        investigation?: { outcome?: string; progress?: string };
      }>;
    });
  }

  it("puts the settled card in the transcript, once, without opening a second investigation", async () => {
    const { store, calls, closedCards } = revisioningStore();
    const { model } = recordingModel([
      renderStep({ ...inProgress, progress: "Reading the trace" }, SEEDED, "tc_open"),
      textStep("still looking"),
    ]);
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_investigate_card",
      clientData: CLIENT_DATA_WITH_TOKEN,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    await harness.sendAction(INVESTIGATE);
    await turnSaved(store);

    // The findings message is the turn's answer; the closing card lands with the
    // terminal revision, in one operation, and the runtime saves both.
    const findingsId = "investigate:watch:watch_1:fired:investigate";
    expect(recordIds(store, "chat_investigate_card")).toContain(findingsId);
    expect(closedCards).toHaveLength(1);
    const closing = closedCards[0]!;
    expect(recordIds(store, "chat_investigate_card")).toContain(closing.id);

    const [card] = cardsIn(closing);
    expect(card?.id).toBe(SEEDED);
    expect(card?.investigation?.outcome).toBe("inconclusive");
    const [opened] = cardsIn(savedPuts(store).find((m) => m.id === findingsId)!);
    expect(card!.revision!).toBeGreaterThan(opened!.revision!);
    expect(card?.investigation?.progress).toBeUndefined();

    const revisions = calls.upsertInvestigationRevision.length;
    const saved = savedTranscript(store, "chat_investigate_card").map((m) => m.id);
    await harness.sendAction(INVESTIGATE);
    expect(savedTranscript(store, "chat_investigate_card").map((m) => m.id)).toEqual(saved);
    expect(calls.upsertInvestigationRevision).toHaveLength(revisions);
  });

  /**
   * Same resume for the investigation: the brief landed, the run died, and the
   * redelivered kick answers it under the same id and settles the card.
   */
  it("a redelivered kick answers a brief the dead run left unanswered", async () => {
    const chatId = "chat_investigate_resume";
    const { store, calls } = fakeStore();
    await seedTranscript(store, {
      chatId,
      clientData: CLIENT_DATA_WITH_TOKEN,
      messages: [
        {
          id: "investigate-request:watch:watch_1:fired:investigate",
          role: "user",
          parts: [{ type: "text", text: "the brief" }],
        },
      ],
    });
    const { model } = recordingModel([textStep("Couldn't get far — the trace is gone.")]);
    harness = mockChatAgent(dashboardAgent, {
      chatId,
      clientData: CLIENT_DATA_WITH_TOKEN,
      continuation: true,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    const seeded = saveReasons(store).length;
    await harness.sendAction(INVESTIGATE);
    await turnSaved(store, seeded);

    const ids = savedTranscript(store, chatId).map((m) => m.id);
    expect(ids.filter((id) => id.startsWith("investigate-request:"))).toHaveLength(1);
    expect(ids).toContain("investigate:watch:watch_1:fired:investigate");
    // The model never rendered, so the turn settled the seeded row it was told about.
    expect(settledIds(calls)).toEqual([SEEDED]);
  });

  /**
   * The settle is the turn's, and it commits the row and its card together. When it
   * fails, the row stays `in_progress` (nothing made it terminal ahead of the card) and
   * the redelivered kick, which finds its request already answered, closes it.
   */
  it("leaves the row open when the closing write fails, and the redelivered kick closes it", async () => {
    const { store, calls } = revisioningStore({ failClosingCard: true });
    const { model } = recordingModel([
      renderStep(inProgress, SEEDED, "tc_open"),
      textStep("still looking"),
    ]);
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_investigate_close_fails",
      clientData: CLIENT_DATA_WITH_TOKEN,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    await harness.sendAction(INVESTIGATE);
    // The settle threw (the runtime's error path retries the hook once, so it may be
    // attempted twice); no separate settle made the row terminal.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.settleTurnInvestigations.length).toBeGreaterThanOrEqual(1);
    expect(
      calls.upsertInvestigationRevision.filter(
        (call) => (call as { state: { outcome: string } }).state.outcome !== "in_progress"
      )
    ).toEqual([]);

    // The retry: the kick again, finding its request and findings in the history and
    // the card still open, closes the card on its own.
    await harness.sendAction(INVESTIGATE);
    expect(calls.settleInvestigationCard).toMatchObject([
      { id: SEEDED, state: { outcome: "inconclusive" } },
    ]);
  });

  /** A store whose atomic close refuses rather than throws, with the reason it refuses for. */
  function refusingStore(error: "not_found" | "context_mismatch" | "chat_missing") {
    const { store, calls } = fakeStore();
    const wrapped: DashboardAgentStore = {
      ...store,
      settleInvestigationCard: async (args) => {
        calls.settleInvestigationCard.push(args);
        return { ok: false as const, error };
      },
    };
    return { store: wrapped, calls };
  }

  /**
   * A redelivered kick that finds its request answered and the card still open closes
   * the card itself. Seed that history, then redeliver.
   */
  async function investigateAgainst(store: DashboardAgentStore, chatId: string) {
    await seedTranscript(store, {
      chatId,
      clientData: CLIENT_DATA_WITH_TOKEN,
      messages: [
        {
          id: "investigate-request:watch:watch_1:fired:investigate",
          role: "user",
          parts: [{ type: "text", text: "brief" }],
        },
        investigationSettlementMessage({
          investigationId: SEEDED,
          revision: 0,
          state: inProgress,
          messageId: `msg_${SEEDED}`,
        }) as UIMessage,
        {
          id: "investigate:watch:watch_1:fired:investigate",
          role: "assistant",
          parts: [{ type: "text", text: "still looking" }],
        },
      ],
    });
    harness = mockChatAgent(dashboardAgent, {
      chatId,
      clientData: CLIENT_DATA_WITH_TOKEN,
      continuation: true,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, mockModel([textStep("should never run")]));
      },
    });
    return harness.sendAction(INVESTIGATE);
  }

  function erroredWith(turn: { chunks: unknown[] }, pattern: RegExp) {
    return turn.chunks.some(
      (chunk) =>
        (chunk as { type?: string }).type === "error" &&
        pattern.test((chunk as { errorText?: string }).errorText ?? "")
    );
  }

  /**
   * A refused close is the same failure as a thrown one: the card never landed, so the
   * panel spins until the action is retried, and only a thrown error gets it retried.
   */
  it.each(["not_found", "context_mismatch"] as const)(
    "fails the redelivered kick when the close is refused with %s",
    async (error) => {
      const { store, calls } = refusingStore(error);
      const turn = await investigateAgainst(store, `chat_investigate_refused_${error}`);

      expect(calls.settleInvestigationCard).toHaveLength(1);
      expect(erroredWith(turn, new RegExp(error))).toBe(true);
    }
  );

  it("reports success on a redelivered kick when the close is refused because the chat is gone", async () => {
    const { store, calls } = refusingStore("chat_missing");
    const turn = await investigateAgainst(store, "chat_investigate_refused_chat_missing");

    expect(calls.settleInvestigationCard).toHaveLength(1);
    expect(erroredWith(turn, /chat_missing|couldn't close/)).toBe(false);
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

    expect(calls.seedInvestigation).toHaveLength(0);
    expect(calls.upsertInvestigationRevision).toHaveLength(0);
    expect(savedPuts(store)).toHaveLength(0);
  });

  /**
   * The card a watch may settle is its own, and only its own. Anything else still
   * running in this chat belongs to the user or to another watch, and settling it
   * answers a question nobody asked here while overwriting the one they did.
   */
  const MANUAL = "inv_manual";

  function tenanted(chatId: string, state: Record<string, unknown>): FakeInvestigation {
    return {
      chatId,
      projectRef: "proj_abc",
      environmentRef: "env_abc",
      state: state as FakeInvestigation["state"],
    };
  }

  it("settles its own card and leaves the user's open investigation alone", async () => {
    const chatId = "chat_investigate_beside_manual";
    // The user's card is opened after the watch's, so "the freshest card still open"
    // is theirs.
    const investigations = new Map<string, FakeInvestigation>([
      [SEEDED, tenanted(chatId, inProgress)],
      [MANUAL, tenanted(chatId, { ...inProgress, title: "Why is checkout slow?" })],
    ]);
    const { store, calls } = fakeStore({ investigations });
    const { model } = recordingModel([
      renderStep(inProgress, SEEDED, "tc_open"),
      textStep("still looking"),
    ]);
    harness = mockChatAgent(dashboardAgent, {
      chatId,
      clientData: CLIENT_DATA_WITH_TOKEN,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    await harness.sendAction(INVESTIGATE);
    await turnSaved(store);

    expect(settledIds(calls)).toEqual([SEEDED]);
    expect(investigations.get(SEEDED)?.state.outcome).toBe("inconclusive");
    expect(investigations.get(MANUAL)?.state.outcome).toBe("in_progress");
  });

  /** The redelivery path had the same reach: it closed whatever card was still open. */
  it("closes only its own card when a redelivered kick finds the user's still open", async () => {
    const chatId = "chat_investigate_redelivered_beside_manual";
    const investigations = new Map<string, FakeInvestigation>([
      [SEEDED, tenanted(chatId, inProgress)],
      [MANUAL, tenanted(chatId, { ...inProgress, title: "Why is checkout slow?" })],
    ]);
    const { store, calls } = fakeStore({ investigations });
    const card = (id: string, title: string) =>
      investigationSettlementMessage({
        investigationId: id,
        revision: 0,
        state: { ...inProgress, title },
        messageId: `msg_${id}`,
      }) as UIMessage;

    // The findings already landed, so this kick is a repair; the user's card is the
    // first one still open in the transcript the next boot loads from storage.
    await seedTranscript(store, {
      chatId,
      clientData: CLIENT_DATA_WITH_TOKEN,
      messages: [
        card(MANUAL, "Why is checkout slow?"),
        card(SEEDED, "Investigating run_abc123"),
        {
          id: "investigate:watch:watch_1:fired:investigate",
          role: "assistant",
          parts: [{ type: "text", text: "The payload lost order.total." }],
        },
      ],
    });

    harness = mockChatAgent(dashboardAgent, {
      chatId,
      clientData: CLIENT_DATA_WITH_TOKEN,
      continuation: true,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, mockModel([textStep("should never run")]));
      },
    });

    await harness.sendAction(INVESTIGATE);

    expect(calls.settleInvestigationCard).toMatchObject([{ id: SEEDED }]);
    expect(investigations.get(MANUAL)?.state.outcome).toBe("in_progress");
  });

  it("gives two watches resolving in one chat a card each", async () => {
    const chatId = "chat_investigate_two_watches";
    const second = watchInvestigationId("watch_2");
    const { store, calls, investigations } = fakeStore();
    const { model } = recordingModel([textStep("still looking")]);
    harness = mockChatAgent(dashboardAgent, {
      chatId,
      clientData: CLIENT_DATA_WITH_TOKEN,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    await harness.sendAction(INVESTIGATE);
    await harness.sendAction({
      ...INVESTIGATE,
      id: "watch:watch_2:fired:investigate",
      watchId: "watch_2",
    });

    await turnSaved(store);
    expect(settledIds(calls)).toEqual([SEEDED, second]);
    expect(investigations.get(SEEDED)?.state.outcome).toBe("inconclusive");
    expect(investigations.get(second)?.state.outcome).toBe("inconclusive");
  });
});
