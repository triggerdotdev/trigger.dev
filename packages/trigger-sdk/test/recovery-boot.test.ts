// Import the test harness FIRST — installs the resource catalog so
// `chat.agent()` calls register their task functions correctly.
import { mockChatAgent } from "../src/v3/test/index.js";

import { describe, expect, it, vi } from "vitest";
import { chat, __setReplaySessionOutTailImplForTests } from "../src/v3/ai.js";
import type { RecoveryBootEvent, RecoveryBootResult } from "../src/v3/ai.js";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

// ── Helpers ────────────────────────────────────────────────────────────

function userMessage(text: string, id = "u-" + Math.random().toString(36).slice(2)) {
  return {
    id,
    role: "user" as const,
    parts: [{ type: "text" as const, text }],
  };
}

function assistantMessage(text: string, id = "a-" + Math.random().toString(36).slice(2)) {
  return {
    id,
    role: "assistant" as const,
    parts: [{ type: "text" as const, text }],
  };
}

function partialAssistantWithToolCall(id: string, toolCallId: string, toolName: string) {
  return {
    id,
    role: "assistant" as const,
    parts: [
      {
        type: `tool-${toolName}` as const,
        toolCallId,
        state: "input-available" as const,
        input: { q: "search" },
      },
    ],
  } as unknown as ReturnType<typeof assistantMessage>;
}

function textStream(text: string) {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
      },
    },
  ];
  return simulateReadableStream({ chunks });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("onRecoveryBoot — chat.agent recovery hook", () => {
  it("does NOT fire on a clean continuation with no recovered state", async () => {
    const onRecoveryBoot = vi.fn();
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("ok") }),
    });
    const agent = chat.agent({
      id: "recovery-boot.no-state",
      onRecoveryBoot,
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, {
      chatId: "no-state",
      continuation: true,
      previousRunId: "run_prior",
    });
    try {
      // Snapshot is empty, no in-flight users, no partial — guard
      // (partialAssistant !== undefined || inFlightUsers.length > 0) is false.
      await harness.sendMessage(userMessage("fresh message"));
      await new Promise((r) => setTimeout(r, 20));
      expect(onRecoveryBoot).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("fires when there's a partial assistant and surfaces it on the ctx", async () => {
    const captured: { event?: RecoveryBootEvent<ReturnType<typeof userMessage>> } = {};
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("recovered") }),
    });
    const partial = partialAssistantWithToolCall("a-orphan", "tc-1", "search");
    const agent = chat.agent({
      id: "recovery-boot.partial-fires-hook",
      onRecoveryBoot: async (event) => {
        captured.event = event as never;
        return {};
      },
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, {
      chatId: "partial-fires-hook",
      continuation: true,
      previousRunId: "run_prior",
    });
    harness.seedSessionOutPartial(partial as never);
    try {
      await harness.sendMessage(userMessage("next user message"));
      await new Promise((r) => setTimeout(r, 20));
      expect(captured.event).toBeDefined();
      expect(captured.event!.partialAssistant?.id).toBe("a-orphan");
      expect(captured.event!.pendingToolCalls).toHaveLength(1);
      expect(captured.event!.pendingToolCalls[0]!.toolCallId).toBe("tc-1");
      expect(captured.event!.pendingToolCalls[0]!.toolName).toBe("search");
      expect(captured.event!.previousRunId).toBe("run_prior");
      expect(captured.event!.cause).toBe("unknown");
    } finally {
      await harness.close();
    }
  });

  it("pendingToolCalls is extracted from the RAW partial (pre-cleanupAbortedParts)", async () => {
    // Real-world scenario: cancel-mid-tool-call. Session.out has tool-call
    // chunks but the tool never returned. cleanupAbortedParts strips the
    // input-available tool part from the partial used for the chain (you
    // don't want orphan tool calls poisoning the model context), but
    // `pendingToolCalls` should still surface what was happening.
    const cleanedPartial = {
      id: "a-orphan",
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "Let me look that up" }],
    };
    const rawPartial = {
      id: "a-orphan",
      role: "assistant" as const,
      parts: [
        { type: "text" as const, text: "Let me look that up" },
        {
          type: "tool-search" as const,
          toolCallId: "tc-pending",
          state: "input-available" as const,
          input: { q: "vietnamese pho" },
        },
      ],
    } as unknown as typeof cleanedPartial;

    const captured: { event?: RecoveryBootEvent } = {};
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("ok") }),
    });
    const u1 = userMessage("buffered", "u-1");
    const agent = chat.agent({
      id: "recovery-boot.pending-tool-from-raw",
      onRecoveryBoot: async (event) => {
        captured.event = event;
        return {};
      },
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, {
      chatId: "pending-tool-from-raw",
      continuation: true,
      previousRunId: "run_prior",
    });
    harness.seedSessionInTail([u1 as never]);
    // Install AFTER mockChatAgent — its constructor sets its own default
    // override that we want to replace for this test.
    __setReplaySessionOutTailImplForTests(
      async () =>
        ({
          settled: [],
          partial: cleanedPartial,
          partialRaw: rawPartial,
        }) as never
    );
    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(captured.event).toBeDefined();
      // Cleaned partial → chain (no input-available tool part)
      expect(captured.event!.partialAssistant?.parts).toHaveLength(1);
      // pendingToolCalls → from raw (input-available tool part visible)
      expect(captured.event!.pendingToolCalls).toHaveLength(1);
      expect(captured.event!.pendingToolCalls[0]!.toolCallId).toBe("tc-pending");
      expect(captured.event!.pendingToolCalls[0]!.toolName).toBe("search");
    } finally {
      await harness.close();
    }
  });

  it("does NOT fire when there are in-flight users but no partial (graceful exit path)", async () => {
    // chat.requestUpgrade(), chat.endRun() before processing, and similar
    // graceful exits leave an unacknowledged user on session.in but no
    // partial assistant on session.out. That's not recovery — the next
    // run just dispatches the message normally.
    const onRecoveryBoot = vi.fn();
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("ok") }),
    });
    const u1 = userMessage("buffered while dead", "u-buffered");
    const agent = chat.agent({
      id: "recovery-boot.inflight-users-no-partial",
      onRecoveryBoot,
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, {
      chatId: "inflight-users-no-partial",
      continuation: true,
      previousRunId: "run_prior",
    });
    harness.seedSessionInTail([u1 as never]);
    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(onRecoveryBoot).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("default behavior re-dispatches each in-flight user as a turn", async () => {
    let turnCount = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        turnCount++;
        return { stream: textStream(`reply ${turnCount}`) };
      },
    });
    const u1 = userMessage("first buffered", "u-1");
    const u2 = userMessage("second buffered", "u-2");
    const agent = chat.agent({
      id: "recovery-boot.default-dispatch",
      // NO onRecoveryBoot — exercise the default path
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, {
      chatId: "default-dispatch",
      continuation: true,
      previousRunId: "run_prior",
    });
    harness.seedSessionInTail([u1 as never, u2 as never]);
    try {
      await new Promise((r) => setTimeout(r, 100));
      expect(turnCount).toBe(2);
    } finally {
      await harness.close();
    }
  });

  it("smart default: partial + first user spliced into chain, rest dispatched", async () => {
    let observedChain: Array<{ role: string; idHead: string }> = [];
    let turnCount = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        turnCount++;
        return { stream: textStream("ok") };
      },
    });
    const partial = assistantMessage("partial answer in progress", "a-partial");
    const u1 = userMessage("original question", "u-1");
    const u2 = userMessage("follow-up", "u-2");
    const agent = chat.agent({
      id: "recovery-boot.smart-default",
      // NO onRecoveryBoot — exercise the smart default
      onTurnStart: async ({ uiMessages }) => {
        if (turnCount === 0) {
          observedChain = uiMessages.map((m) => ({
            role: m.role,
            idHead: m.id.slice(0, 10),
          }));
        }
      },
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, {
      chatId: "smart-default",
      continuation: true,
      previousRunId: "run_prior",
    });
    harness.seedSessionOutPartial(partial as never);
    harness.seedSessionInTail([u1 as never, u2 as never]);
    try {
      await new Promise((r) => setTimeout(r, 100));
      // Turn 1 fires with the follow-up user (u2). Its chain should
      // include [u1 (original), a-partial, u2 (follow-up)].
      expect(turnCount).toBe(1);
      expect(observedChain.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
      expect(observedChain[0]!.idHead).toBe("u-1");
      expect(observedChain[1]!.idHead).toBe("a-partial");
      expect(observedChain[2]!.idHead).toBe("u-2");
    } finally {
      await harness.close();
    }
  });

  it("hook's recoveredTurns: [] suppresses re-dispatch of in-flight users", async () => {
    let turnCount = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        turnCount++;
        return { stream: textStream(`reply ${turnCount}`) };
      },
    });
    const partial = assistantMessage("partial answer", "a-partial");
    const u1 = userMessage("buffered", "u-1");
    const agent = chat.agent({
      id: "recovery-boot.suppress-dispatch",
      onRecoveryBoot: async (): Promise<RecoveryBootResult> => ({ recoveredTurns: [] }),
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, {
      chatId: "suppress-dispatch",
      continuation: true,
      previousRunId: "run_prior",
    });
    harness.seedSessionOutPartial(partial as never);
    harness.seedSessionInTail([u1 as never]);
    try {
      // No turn should fire from the boot-injected queue.
      // Send a fresh user message to confirm the agent is alive.
      await harness.sendMessage(userMessage("real next message"));
      await new Promise((r) => setTimeout(r, 20));
      expect(turnCount).toBe(1); // only the explicit sendMessage turn
    } finally {
      await harness.close();
    }
  });

  it("hook's chain override seeds the accumulator", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("acked") }),
    });
    const custom = assistantMessage("custom-recovered-history", "a-custom");
    const partial = assistantMessage("partial", "a-partial");
    const u1 = userMessage("buffered", "u-1");
    let observedMessageCount = 0;
    const agent = chat.agent({
      id: "recovery-boot.chain-override",
      onRecoveryBoot: async (): Promise<RecoveryBootResult> => ({
        chain: [custom as never],
        recoveredTurns: [u1 as never],
      }),
      onTurnStart: async ({ uiMessages }) => {
        observedMessageCount = uiMessages.length;
      },
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, {
      chatId: "chain-override",
      continuation: true,
      previousRunId: "run_prior",
    });
    harness.seedSessionOutPartial(partial as never);
    harness.seedSessionInTail([u1 as never]);
    try {
      await new Promise((r) => setTimeout(r, 50));
      // Chain seeded with [custom] before the recovered user message
      // arrives — onTurnStart sees [custom, u1] when the first
      // recovered turn fires.
      expect(observedMessageCount).toBe(2);
    } finally {
      await harness.close();
    }
  });

  it("does NOT fire when hydrateMessages is registered", async () => {
    const onRecoveryBoot = vi.fn();
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("ok") }),
    });
    const u1 = userMessage("buffered", "u-1");
    const agent = chat.agent({
      id: "recovery-boot.hydrate-skips",
      hydrateMessages: async ({ incomingMessages }) => incomingMessages,
      onRecoveryBoot,
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, {
      chatId: "hydrate-skips",
      continuation: true,
      previousRunId: "run_prior",
    });
    harness.seedSessionInTail([u1 as never]);
    try {
      await harness.sendMessage(userMessage("fresh"));
      await new Promise((r) => setTimeout(r, 20));
      expect(onRecoveryBoot).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("beforeBoot runs before the first recovered turn fires", async () => {
    const order: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => {
        order.push("turn");
        return { stream: textStream("ok") };
      },
    });
    const partial = assistantMessage("partial", "a-partial");
    const u1 = userMessage("buffered original", "u-1");
    const u2 = userMessage("followup", "u-2");
    const agent = chat.agent({
      id: "recovery-boot.before-boot",
      onRecoveryBoot: async (): Promise<RecoveryBootResult> => ({
        beforeBoot: async () => {
          order.push("beforeBoot");
        },
      }),
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, {
      chatId: "before-boot",
      continuation: true,
      previousRunId: "run_prior",
    });
    harness.seedSessionOutPartial(partial as never);
    // Two users — smart default consumes u1 into the chain, leaves u2 for dispatch
    harness.seedSessionInTail([u1 as never, u2 as never]);
    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(order).toEqual(["beforeBoot", "turn"]);
    } finally {
      await harness.close();
    }
  });

  it("hook throwing falls back to defaults without sinking the run", async () => {
    let turnCount = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        turnCount++;
        return { stream: textStream("ok") };
      },
    });
    const partial = assistantMessage("partial", "a-partial");
    const u1 = userMessage("buffered original", "u-1");
    const u2 = userMessage("followup", "u-2");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = chat.agent({
      id: "recovery-boot.hook-throws",
      onRecoveryBoot: async () => {
        throw new Error("kaboom");
      },
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, {
      chatId: "hook-throws",
      continuation: true,
      previousRunId: "run_prior",
    });
    harness.seedSessionOutPartial(partial as never);
    // Two users so smart default leaves u2 to dispatch (u1 spliced into chain)
    harness.seedSessionInTail([u1 as never, u2 as never]);
    try {
      await new Promise((r) => setTimeout(r, 100));
      // Default behavior: the in-flight user is re-dispatched as a turn
      // even though the hook threw.
      expect(turnCount).toBe(1);
    } finally {
      await harness.close();
      warnSpy.mockRestore();
    }
  });
});
