// `@trigger.dev/sdk/ai/test` MUST be imported before the agent module so the
// resource catalog is installed before `chat.agent({ id })` / `prompts.define`
// register at module load.
import { mockChatAgent, type MockChatAgentHarness } from "@trigger.dev/sdk/ai/test";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";

import {
  dashboardAgent,
  dashboardAgentModelKey,
  dashboardAgentStoreKey,
  type DashboardAgentStore,
} from "./dashboard-agent";
import {
  CLIENT_DATA,
  collectText,
  executedTool,
  fakeStore,
  mockModel,
  textStep,
  toolCallStep,
  USAGE,
} from "./test-support";

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
