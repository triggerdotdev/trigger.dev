// `@trigger.dev/sdk/ai/test` MUST be imported before the agent module so the
// resource catalog is installed before `chat.agent({ id })` / `prompts.define`
// register at module load.
import { mockChatAgent, type MockChatAgentHarness } from "@trigger.dev/sdk/ai/test";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";

import { investigationSettlementMessage, watchInvestigationId } from "@internal/dashboard-agent-db";

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
  finish,
  type FakeInvestigation,
  mockModel,
  textStep,
  toolCallStep,
  USAGE,
} from "./test-support";

/**
 * Stands in for `chats` + `chat_messages`, as `appendOneMessage`'s upsert sees them: the
 * insert is scoped to the owning user and — when the caller passes one — the owning
 * organization, and keyed on (chat_id, message_id) with nothing done on conflict. So a
 * repeat is never a second row and a foreign tenancy is no row at all. Row counts are
 * what the History panel reads, which is why these tests assert those, not call counts.
 */
function transcriptTable(owner: { userId: string; organizationId: string }) {
  const rows: { chatId: string; messageId: string }[] = [];
  const countOf = (chatId: string, messageId: string) =>
    rows.filter((row) => row.chatId === chatId && row.messageId === messageId).length;
  return {
    countOf,
    insert(args: { chatId: string; userId: string; organizationId?: string; message: UIMessage }) {
      if (args.userId !== owner.userId) return false;
      if (args.organizationId !== undefined && args.organizationId !== owner.organizationId) {
        return false;
      }
      if (countOf(args.chatId, args.message.id) > 0) return false;
      rows.push({ chatId: args.chatId, messageId: args.message.id });
      return true;
    },
  };
}

// A store that writes into `table`, failing the appends `failWhen` selects.
function appendingStore(
  table: ReturnType<typeof transcriptTable>,
  failWhen: (message: UIMessage) => boolean,
  options?: Parameters<typeof fakeStore>[0]
) {
  const { store, calls } = fakeStore(options);
  const wrapped: DashboardAgentStore = {
    ...store,
    appendMessage: async (args) => {
      await store.appendMessage(args);
      const message = args.message as UIMessage;
      if (failWhen(message)) throw new Error("the append lost the connection");
      return table.insert({ ...args, message });
    },
  };
  return { store: wrapped, calls };
}

// Every organization a path's appends were scoped to, in order.
function scopedTo(...stores: { calls: { appendMessage: unknown[] } }[]) {
  return stores.flatMap((store) =>
    store.calls.appendMessage.map((call) => (call as { organizationId?: string }).organizationId)
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

    // An action is not a turn, so no turn persistence ran. The narration lands in the
    // read-model as an id-deduped append, never a wholesale write: a card-born chat's
    // transcript holds host blocks the session view can't see.
    expect(calls.persistTurn).toHaveLength(0);
    expect(calls.persistMessages).toHaveLength(0);
    expect(calls.appendMessage).toHaveLength(1);
    const appended = calls.appendMessage[0] as { userId: string; message: UIMessage };
    expect(appended.userId).toBe(CLIENT_DATA.userId);
    expect(appended.message).toMatchObject({ id: "wake:watch:watch_1:fired", role: "assistant" });

    // Same action id again (the watcher retried after appending): nothing is narrated,
    // and the only write is the id-deduped repair of the same message.
    const second = await harness.sendAction(WAKE);
    expect(collectText(second.chunks)).toBe("");
    expect(calls.appendMessage.map((call) => (call as { message: UIMessage }).message.id)).toEqual([
      "wake:watch:watch_1:fired",
      "wake:watch:watch_1:fired",
    ]);
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

    expect(calls.appendMessage).toHaveLength(1);
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

    expect(calls.appendMessage).toHaveLength(1);
    expect(calls.seedInvestigation).toHaveLength(0);
    expect(wakeText(prompts)).not.toContain("ALREADY been started");
  });

  // Opening the investigation must never delay, retry or invalidate the wake. The
  // watcher has already marked the delivery by the time the agent runs, so the only
  // thing this can break is the turn.
  it("delivers the wake even when opening the investigation fails", async () => {
    const { store, calls } = fakeStore();
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
    expect(calls.appendMessage).toHaveLength(1);
  });

  it("writes nothing and fails the action when the narration comes back empty", async () => {
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

    expect(
      turn.chunks.some(
        (chunk) =>
          (chunk as { type?: string; errorText?: string }).type === "error" &&
          /produced no text/.test((chunk as { errorText?: string }).errorText ?? "")
      )
    ).toBe(true);
    expect(collectText(turn.chunks)).toBe("");
    expect(calls.appendMessage).toHaveLength(0);
    expect(calls.persistMessages).toHaveLength(0);
    expect(calls.seedInvestigation).toHaveLength(0);
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

  /**
   * The wake is durable on `session.out` the moment it streams, which is before the
   * display copy is written. So an append that fails leaves the model seeing a message
   * the History panel doesn't have — and the retry boots with that message already in
   * its history. Converging on the row is the retry's job.
   */
  it("appends the display copy on a retry that finds the wake already narrated", async () => {
    const table = transcriptTable(CLIENT_DATA);
    const chatId = "chat_wake_retry";
    const wakeId = "wake:watch:watch_1:fired";

    const failing = appendingStore(table, (message) => message.id === wakeId);
    harness = mockChatAgent(dashboardAgent, {
      chatId,
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, failing.store);
        set(dashboardAgentModelKey, mockModel([textStep("never asked for")]));
      },
    });

    const first = await harness.sendAction(WAKE);
    // Streamed — so it is on `session.out` and in the next boot's history — while the
    // row it was supposed to land alongside never arrived.
    expect(collectText(first.chunks)).toContain("queue drained");
    expect(failing.calls.appendMessage).toHaveLength(1);
    expect(table.countOf(chatId, wakeId)).toBe(0);
    const durable = first.chunks;
    await harness.close();

    // The retry is a new run picking up the session, booting its history from the
    // chunks the failed one left on `session.out`.
    const repairing = appendingStore(table, () => false);
    harness = mockChatAgent(dashboardAgent, {
      chatId,
      clientData: CLIENT_DATA,
      continuation: true,
      previousRunId: "run_wake_failed",
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, repairing.store);
        set(dashboardAgentModelKey, mockModel([textStep("never asked for")]));
      },
    });
    harness.seedSessionOutTail(durable);

    const retry = await harness.sendAction(WAKE);

    // Nothing narrated twice, and the display copy converged on exactly one row.
    expect(collectText(retry.chunks)).toBe("");
    expect(table.countOf(chatId, wakeId)).toBe(1);

    // A third delivery repairs nothing, because there is nothing left to repair.
    await harness.sendAction(WAKE);
    expect(table.countOf(chatId, wakeId)).toBe(1);

    // Every write on this path is scoped to the organization the append verifies — the
    // repair included, or the repair would be the one write that skips the check.
    expect(scopedTo(failing, repairing)).toEqual([
      CLIENT_DATA.organizationId,
      CLIENT_DATA.organizationId,
      CLIENT_DATA.organizationId,
    ]);
  });

  /**
   * The chat id comes from the watch record and the tenancy from the session's
   * `clientData`. If those ever disagree the append has to write nothing, rather than put
   * a message in another organization's transcript.
   */
  it("writes nothing when the wake's tenancy doesn't own the chat", async () => {
    const table = transcriptTable(CLIENT_DATA);
    const chatId = "chat_wake_other_org";
    const { store, calls } = appendingStore(table, () => false);
    harness = mockChatAgent(dashboardAgent, {
      chatId,
      clientData: { ...CLIENT_DATA, organizationId: "org_other" },
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, mockModel([textStep("never asked for")]));
      },
    });

    await harness.sendAction(WAKE);

    // Attempted, and refused by the scope the append carries.
    expect(calls.appendMessage).toHaveLength(1);
    expect(table.countOf(chatId, "wake:watch:watch_1:fired")).toBe(0);
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

    // A real investigating turn: the model called a tool and it executed.
    expect(executedTool(turn.chunks)).toBe(true);
    expect(collectText(turn.chunks)).toContain("order.total");

    // The card the wake opened is the one this revises: no second investigation for
    // the same news, and no id the model got to choose.
    expect(calls.seedInvestigation).toHaveLength(1);
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

    // Findings appended once and whole: the render_view part is what the panel rebuilds
    // the card from.
    expect(calls.appendMessage).toHaveLength(1);
    const appended = calls.appendMessage[0] as { userId: string; message: UIMessage };
    expect(appended.userId).toBe(CLIENT_DATA.userId);
    expect(appended.message.id).toBe("investigate:watch:watch_1:fired:investigate");
    expect(appended.message.parts.some((part) => part.type === "tool-render_view")).toBe(true);

    // The same kick again: nothing runs, and the only write is the id-deduped repair of
    // the findings message.
    await harness.sendAction(INVESTIGATE);
    expect(calls.appendMessage.map((call) => (call as { message: UIMessage }).message.id)).toEqual([
      "investigate:watch:watch_1:fired:investigate",
      "investigate:watch:watch_1:fired:investigate",
    ]);
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

    // The same id the wake would have used, so a late seed can never make a second card.
    expect(calls.seedInvestigation).toMatchObject([{ id: SEEDED }]);
    expect(calls.upsertInvestigationRevision).toHaveLength(0);
    expect(calls.settleInvestigationCard).toMatchObject([
      { id: SEEDED, state: { outcome: "inconclusive" } },
    ]);
    expect(JSON.stringify(prompts)).toContain(SEEDED);
    expect(calls.appendMessage).toHaveLength(1);
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

    // Only the turn's own render_view revision; the settle is the atomic close below.
    expect(calls.upsertInvestigationRevision).toHaveLength(1);
    expect(calls.settleInvestigationCard).toHaveLength(1);
    const settle = calls.settleInvestigationCard[0] as {
      id: string;
      messageId: string;
      state: { outcome: string };
    };
    expect(settle.id).toBe(SEEDED);
    expect(settle.state.outcome).toBe("inconclusive");
    expect(settle.messageId).toBe("investigate:watch:watch_1:fired:investigate:settled");
  });

  function revisioningStore(options: { failClosingCard?: boolean } = {}) {
    const { store, calls } = fakeStore();
    const closedCards: UIMessage[] = [];
    let revision = 0;
    const wrapped: DashboardAgentStore = {
      ...store,
      // The closing write, however the lane makes it: whether it is one atomic call or
      // a bare append, the transcript half fails here.
      appendMessage: async (args) => {
        if (options.failClosingCard && args.message.id.endsWith(":settled")) {
          throw new Error("the append lost the connection");
        }
        return store.appendMessage(args);
      },
      // The real query commits the revision and the card together, so a card that
      // can't be delivered leaves the row exactly as it was.
      settleInvestigationCard: async (args) => {
        if (options.failClosingCard) {
          calls.settleInvestigationCard.push(args);
          throw new Error("the append lost the connection");
        }
        const result = await store.settleInvestigationCard(args);
        if (result.ok) closedCards.push(result.card as UIMessage);
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

    // The findings message is the only ordinary append; the closing card lands with the
    // terminal revision, in one operation.
    expect(calls.appendMessage).toHaveLength(1);
    expect(closedCards).toHaveLength(1);
    const closing = closedCards[0]!;
    expect(closing.id).toBe("investigate:watch:watch_1:fired:investigate:settled");

    const [card] = cardsIn(closing);
    expect(card?.id).toBe(SEEDED);
    expect(card?.investigation?.outcome).toBe("inconclusive");
    const [opened] = cardsIn((calls.appendMessage[0] as { message: UIMessage }).message);
    expect(card!.revision!).toBeGreaterThan(opened!.revision!);
    expect(card?.investigation?.progress).toBeUndefined();

    const revisions = calls.upsertInvestigationRevision.length;
    await harness.sendAction(INVESTIGATE);
    expect(calls.appendMessage.map((call) => (call as { message: UIMessage }).message.id)).toEqual([
      "investigate:watch:watch_1:fired:investigate",
      "investigate:watch:watch_1:fired:investigate",
    ]);
    expect(calls.upsertInvestigationRevision).toHaveLength(revisions);
  });

  /**
   * The failure window this lane used to have: the row settled, the closing append
   * failed, the error was logged and swallowed, and the action reported success. The
   * row was then terminal, so the stale sweep no longer selected it and the panel span
   * forever. Nothing in production calls the action again on its own — only a thrown
   * error gets it retried.
   */
  it("fails the action when the closing card can't be written, instead of reporting success", async () => {
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

    const turn = await harness.sendAction(INVESTIGATE);

    expect(
      turn.chunks.some(
        (chunk) =>
          (chunk as { type?: string }).type === "error" &&
          /lost the connection/.test((chunk as { errorText?: string }).errorText ?? "")
      )
    ).toBe(true);

    // The close was attempted as one operation, so no separate settle could have made
    // the row terminal ahead of the card.
    expect(calls.settleInvestigationCard).toHaveLength(1);
    expect(
      calls.upsertInvestigationRevision.filter(
        (call) => (call as { state: { outcome: string } }).state.outcome !== "in_progress"
      )
    ).toEqual([]);
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

  async function investigateAgainst(store: DashboardAgentStore, chatId: string) {
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
    "fails the action when the close is refused with %s",
    async (error) => {
      const { store, calls } = refusingStore(error);
      const turn = await investigateAgainst(store, `chat_investigate_refused_${error}`);

      expect(calls.settleInvestigationCard).toHaveLength(1);
      expect(erroredWith(turn, new RegExp(error))).toBe(true);
    }
  );

  it("reports success when the close is refused because the chat is gone", async () => {
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
    expect(calls.appendMessage).toHaveLength(0);
  });

  /**
   * The same window the wake has: the findings stream to `session.out` before the display
   * copy is appended, so an append that fails leaves the model holding a message the
   * History panel lost. The retry finds it already answered and must still land the row.
   */
  it("appends the display copy on a retry that finds the investigation already answered", async () => {
    const table = transcriptTable(CLIENT_DATA);
    const chatId = "chat_investigate_retry";
    const findingsId = "investigate:watch:watch_1:fired:investigate";
    const steps = [
      renderStep(concluded, SEEDED, "tc_verdict"),
      textStep("The payload lost order.total."),
    ];

    const failing = appendingStore(table, (message) => message.id === findingsId);
    harness = mockChatAgent(dashboardAgent, {
      chatId,
      clientData: CLIENT_DATA_WITH_TOKEN,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, failing.store);
        set(dashboardAgentModelKey, recordingModel(steps).model);
      },
    });

    const first = await harness.sendAction(INVESTIGATE);
    // Streamed whole, card part and all, while the row it belongs to never landed.
    expect(executedTool(first.chunks)).toBe(true);
    expect(failing.calls.appendMessage).toHaveLength(1);
    expect(table.countOf(chatId, findingsId)).toBe(0);
    const durable = first.chunks;
    await harness.close();

    // The retry is a new run picking up the session, booting its history from the chunks
    // the failed one left on `session.out`.
    const repairing = appendingStore(table, () => false);
    harness = mockChatAgent(dashboardAgent, {
      chatId,
      clientData: CLIENT_DATA_WITH_TOKEN,
      continuation: true,
      previousRunId: "run_investigate_failed",
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, repairing.store);
        set(dashboardAgentModelKey, recordingModel(steps).model);
      },
    });
    harness.seedSessionOutTail(durable);

    const retry = await harness.sendAction(INVESTIGATE);

    // Nothing investigated a second time, and the display copy converged on one row.
    expect(collectText(retry.chunks)).toBe("");
    expect(table.countOf(chatId, findingsId)).toBe(1);

    // A third delivery repairs nothing, because there is nothing left to repair.
    await harness.sendAction(INVESTIGATE);
    expect(table.countOf(chatId, findingsId)).toBe(1);

    // Every write on this path is scoped to the organization the append verifies — the
    // repair included, or the repair would be the one write that skips the check.
    expect(scopedTo(failing, repairing)).toEqual([
      CLIENT_DATA.organizationId,
      CLIENT_DATA.organizationId,
      CLIENT_DATA.organizationId,
    ]);
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

    expect(calls.settleInvestigationCard).toMatchObject([{ id: SEEDED }]);
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

    harness = mockChatAgent(dashboardAgent, {
      chatId,
      clientData: CLIENT_DATA_WITH_TOKEN,
      continuation: true,
      // The findings already landed, so this kick is a repair; the user's card is the
      // first one still open in the transcript.
      snapshot: {
        version: 1,
        savedAt: Date.now(),
        messages: [
          card(MANUAL, "Why is checkout slow?"),
          card(SEEDED, "Investigating run_abc123"),
          {
            id: "investigate:watch:watch_1:fired:investigate",
            role: "assistant",
            parts: [{ type: "text", text: "The payload lost order.total." }],
          },
        ],
      },
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

    expect(calls.settleInvestigationCard.map((call) => (call as { id: string }).id)).toEqual([
      SEEDED,
      second,
    ]);
    expect(investigations.get(SEEDED)?.state.outcome).toBe("inconclusive");
    expect(investigations.get(second)?.state.outcome).toBe("inconclusive");
  });

  // Same tenancy crossing as the wake's: the kick names the chat, the session names the
  // organization, and a disagreement must not write into another organization's chat.
  it("writes nothing when the kick's tenancy doesn't own the chat", async () => {
    const table = transcriptTable(CLIENT_DATA);
    const chatId = "chat_investigate_other_org";
    const { store, calls } = appendingStore(table, () => false);
    harness = mockChatAgent(dashboardAgent, {
      chatId,
      clientData: { ...CLIENT_DATA_WITH_TOKEN, organizationId: "org_other" },
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(
          dashboardAgentModelKey,
          recordingModel([
            renderStep(concluded, SEEDED, "tc_verdict"),
            textStep("The payload lost order.total."),
          ]).model
        );
      },
    });

    await harness.sendAction(INVESTIGATE);

    expect(calls.appendMessage).toHaveLength(1);
    expect(table.countOf(chatId, "investigate:watch:watch_1:fired:investigate")).toBe(0);
  });
});
