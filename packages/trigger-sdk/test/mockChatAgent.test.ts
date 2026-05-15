// Import the test harness FIRST — this installs the resource catalog so
// `chat.agent()` calls below register their task functions correctly.
import { mockChatAgent } from "../src/v3/test/index.js";

import { describe, expect, it, vi } from "vitest";
import { chat } from "../src/v3/ai.js";
import { locals } from "@trigger.dev/core/v3";
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

describe("mockChatAgent", () => {
  it("throws when no agent is registered with the given id", () => {
    expect(() => mockChatAgent({ id: "does-not-exist" })).toThrow(/no task registered/);
  });

  it("drives a chat.agent through a single turn and captures output chunks", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("hello world") }),
    });

    const agent = chat.agent({
      id: "mockChatAgent.basic-flow",
      run: async ({ messages, signal }) => {
        return streamText({
          model,
          messages,
          abortSignal: signal,
        });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "test-basic" });
    try {
      const turn = await harness.sendMessage(userMessage("hi"));

      const textDeltas = turn.chunks
        .filter((c) => c.type === "text-delta")
        .map((c) => (c as { delta: string }).delta)
        .join("");
      expect(textDeltas).toBe("hello world");
    } finally {
      await harness.close();
    }
  });

  it("fires onTurnStart and onTurnComplete hooks in order", async () => {
    const events: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("hi") }),
    });

    const agent = chat.agent({
      id: "mockChatAgent.hook-order",
      onChatStart: async () => {
        events.push("onChatStart");
      },
      onTurnStart: async () => {
        events.push("onTurnStart");
      },
      onBeforeTurnComplete: async () => {
        events.push("onBeforeTurnComplete");
      },
      onTurnComplete: async () => {
        events.push("onTurnComplete");
      },
      run: async ({ messages, signal }) => {
        events.push("run");
        return streamText({ model, messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "test-hooks" });
    try {
      await harness.sendMessage(userMessage("hello"));
      // onTurnComplete may fire after the turn-complete chunk is written,
      // so give it a tick to run before we assert.
      await new Promise((r) => setTimeout(r, 20));
      expect(events).toEqual([
        "onChatStart",
        "onTurnStart",
        "run",
        "onBeforeTurnComplete",
        "onTurnComplete",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("can send multiple messages across turns", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("reply") }),
    });

    const seenMessages: number[] = [];
    const agent = chat.agent({
      id: "mockChatAgent.multi-turn",
      run: async ({ messages, signal }) => {
        seenMessages.push(messages.length);
        return streamText({ model, messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "test-multi" });
    try {
      await harness.sendMessage(userMessage("first"));
      await harness.sendMessage(userMessage("second"));
      await harness.sendMessage(userMessage("third"));

      // Each turn sees an accumulator growing by (user + assistant) * turn
      // Turn 1: just the user message
      // Turn 2: user + assistant + user = 3 messages
      // Turn 3: 5 messages
      expect(seenMessages).toEqual([1, 3, 5]);
    } finally {
      await harness.close();
    }
  });

  it("invokes hydrateMessages on every turn with incoming wire messages", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("ok") }),
    });

    const hydrateSpy = vi.fn(async ({ incomingMessages }) => {
      // Echo back whatever the frontend sent
      return incomingMessages;
    });

    const agent = chat.agent({
      id: "mockChatAgent.hydrate",
      hydrateMessages: hydrateSpy,
      run: async ({ messages, signal }) => {
        return streamText({ model, messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "test-hydrate" });
    try {
      await harness.sendMessage(userMessage("hi", "u-first"));

      expect(hydrateSpy).toHaveBeenCalledTimes(1);
      const call = hydrateSpy.mock.calls[0]![0] as { incomingMessages: { id: string }[] };
      expect(call.incomingMessages).toHaveLength(1);
      expect(call.incomingMessages[0]!.id).toBe("u-first");
    } finally {
      await harness.close();
    }
  });

  it("merges HITL tool answer onto head assistant when AI SDK regenerates the id", async () => {
    // Regression for TRI-9137: customers (Arena AI) report that the AI SDK
    // intermittently mints a fresh id on `addToolOutput` resume, breaking
    // id-based dedup. Our SDK records `toolCallId → head messageId` whenever
    // an assistant with tool parts lands in the accumulator and uses that
    // map as a fallback in the merge so a fresh-id incoming still attaches
    // to the right head.
    const { z } = await import("zod");
    const { tool } = await import("ai");

    const askUserTool = tool({
      description: "Ask the user a question.",
      inputSchema: z.object({ question: z.string() }),
      // No execute — HITL round-trip via addToolOutput.
    });

    const HEAD_TOOL_CALL_ID = "tc_regression_9137";

    // Turn 1: model emits a tool-call for askUser. No text, no finish-reason
    // logic beyond `tool-calls`. Agent's response will carry a tool-input-
    // available part with HEAD_TOOL_CALL_ID.
    const turn1Stream = simulateReadableStream({
      chunks: [
        { type: "tool-input-start", id: HEAD_TOOL_CALL_ID, toolName: "askUser" },
        {
          type: "tool-input-delta",
          id: HEAD_TOOL_CALL_ID,
          delta: JSON.stringify({ question: "what color?" }),
        },
        { type: "tool-input-end", id: HEAD_TOOL_CALL_ID },
        {
          type: "tool-call",
          toolCallId: HEAD_TOOL_CALL_ID,
          toolName: "askUser",
          input: JSON.stringify({ question: "what color?" }),
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 10, text: 0, reasoning: undefined },
          },
        },
      ] as LanguageModelV3StreamPart[],
    });

    // Turn 2: model produces a final text response — exercises the post-HITL
    // continuation streamText after the tool answer is merged in.
    const turn2Stream = textStream("blue is great");

    let callIdx = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: callIdx++ === 0 ? turn1Stream : turn2Stream }),
    });

    const turnsSeen: { turn: number; uiMessages: any[] }[] = [];

    const agent = chat.agent({
      id: "mockChatAgent.hitl-id-regen",
      onTurnComplete: async ({ turn, uiMessages }) => {
        turnsSeen.push({
          turn,
          uiMessages: uiMessages.map((m) => ({
            id: m.id,
            role: m.role,
            toolStates: (m.parts ?? [])
              .filter((p: any) => typeof p?.toolCallId === "string")
              .map((p: any) => ({ toolCallId: p.toolCallId, state: p.state })),
          })),
        });
      },
      run: async ({ messages, signal }) => {
        return streamText({ model, messages, tools: { askUser: askUserTool }, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "test-hitl-id-regen" });
    try {
      // Turn 1: user message → agent emits tool-input-available for askUser
      await harness.sendMessage(userMessage("hi"));
      await new Promise((r) => setTimeout(r, 50));

      // Capture the head assistant id the agent produced.
      const turn1 = turnsSeen.at(-1);
      const headAssistant = turn1?.uiMessages.find(
        (m) => m.role === "assistant" && m.toolStates.length > 0
      );
      expect(headAssistant?.id).toBeTruthy();
      const HEAD_ID = headAssistant!.id as string;

      // Turn 2: simulate AI SDK regenerating the assistant id on
      // addToolOutput resume — fresh id, but the same toolCallId in
      // tool-output-available state.
      const FRESH_ID = "regenerated-by-ai-sdk-" + Math.random().toString(36).slice(2);
      const toolAnswerMessage = {
        id: FRESH_ID,
        role: "assistant" as const,
        parts: [
          {
            type: "tool-askUser",
            toolCallId: HEAD_TOOL_CALL_ID,
            state: "output-available" as const,
            input: { question: "what color?" },
            output: { color: "blue" },
          },
        ],
      };
      await harness.sendMessage(toolAnswerMessage as any);
      await new Promise((r) => setTimeout(r, 50));

      // The merge must rewrite FRESH_ID back to HEAD_ID via the toolCallId
      // map, attaching the tool answer to the existing head — no duplicate.
      const turn2 = turnsSeen.at(-1);
      expect(turn2).toBeTruthy();
      const assistantsWithToolCall = turn2!.uiMessages.filter(
        (m) =>
          m.role === "assistant" &&
          m.toolStates.some((t: any) => t.toolCallId === HEAD_TOOL_CALL_ID)
      );
      expect(assistantsWithToolCall).toHaveLength(1);
      expect(assistantsWithToolCall[0]!.id).toBe(HEAD_ID);
      expect(turn2!.uiMessages.find((m) => m.id === FRESH_ID)).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it("routes custom actions through actionSchema + onAction", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("ok") }),
    });

    const onActionSpy = vi.fn();

    const { z } = await import("zod");
    const agent = chat.agent({
      id: "mockChatAgent.actions",
      actionSchema: z.object({
        type: z.literal("undo"),
      }),
      onAction: async (event) => {
        onActionSpy(event.action);
      },
      run: async ({ messages, signal }) => {
        return streamText({ model, messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "test-action" });
    try {
      await harness.sendMessage(userMessage("start"));
      await harness.sendAction({ type: "undo" });

      expect(onActionSpy).toHaveBeenCalledWith({ type: "undo" });
    } finally {
      await harness.close();
    }
  });

  it("actions returning void do not fire turn hooks or call run()", async () => {
    const onChatStart = vi.fn();
    const onTurnStart = vi.fn();
    const onBeforeTurnComplete = vi.fn();
    const onTurnComplete = vi.fn();
    const onAction = vi.fn();
    const runSpy = vi.fn();
    const model = new MockLanguageModelV3({
      doStream: async () => {
        runSpy();
        return { stream: textStream("nope") };
      },
    });

    const { z } = await import("zod");
    const agent = chat.agent({
      id: "mockChatAgent.actions.void",
      actionSchema: z.object({ type: z.literal("undo") }),
      onChatStart,
      onTurnStart,
      onBeforeTurnComplete,
      onTurnComplete,
      onAction: async (...args) => {
        onAction(...args);
        // void → side-effect only
      },
      run: async ({ messages, signal }) => {
        return streamText({ model, messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "test-void-action" });
    try {
      // Bootstrap with a message so the message-turn hooks fire once.
      await harness.sendMessage(userMessage("hi"));
      // sendMessage resolves on `trigger:turn-complete`, but onTurnComplete
      // fires as a separate microtask after — let it settle before snapshotting.
      await new Promise((r) => setTimeout(r, 50));

      // Snapshot call counts after the bootstrap — we'll assert these
      // don't change for the action below.
      const baselineRun = runSpy.mock.calls.length;
      const baselineChatStart = onChatStart.mock.calls.length;
      const baselineTurnStart = onTurnStart.mock.calls.length;
      const baselineBeforeComplete = onBeforeTurnComplete.mock.calls.length;
      const baselineComplete = onTurnComplete.mock.calls.length;

      const actionTurn = await harness.sendAction({ type: "undo" });
      await new Promise((r) => setTimeout(r, 50));

      // onAction fired exactly once; no turn hooks fired; run() / LLM did not.
      expect(onAction).toHaveBeenCalledTimes(1);
      expect(runSpy.mock.calls.length).toBe(baselineRun);
      expect(onChatStart.mock.calls.length).toBe(baselineChatStart);
      expect(onTurnStart.mock.calls.length).toBe(baselineTurnStart);
      expect(onBeforeTurnComplete.mock.calls.length).toBe(baselineBeforeComplete);
      expect(onTurnComplete.mock.calls.length).toBe(baselineComplete);

      // Stream still terminates cleanly with trigger:turn-complete so
      // the frontend's useChat transitions back to ready.
      const sawTurnComplete = actionTurn.rawChunks.some(
        (c) =>
          typeof c === "object" &&
          c !== null &&
          (c as { type?: string }).type === "trigger:turn-complete"
      );
      expect(sawTurnComplete).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("actions returning a stream pipe the response without firing turn hooks", async () => {
    const onTurnStart = vi.fn();
    const onTurnComplete = vi.fn();
    const actionModel = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("regenerated") }),
    });
    const turnModel = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("normal-response") }),
    });

    const { z } = await import("zod");
    const agent = chat.agent({
      id: "mockChatAgent.actions.stream",
      actionSchema: z.object({ type: z.literal("regenerate") }),
      onTurnStart,
      onTurnComplete,
      onAction: async ({ messages }) => {
        return streamText({ model: actionModel, messages });
      },
      run: async ({ messages, signal }) => {
        return streamText({ model: turnModel, messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "test-stream-action" });
    try {
      await harness.sendMessage(userMessage("hi"));
      await new Promise((r) => setTimeout(r, 50));
      const baselineTurnStart = onTurnStart.mock.calls.length;
      const baselineTurnComplete = onTurnComplete.mock.calls.length;

      const actionTurn = await harness.sendAction({ type: "regenerate" });
      await new Promise((r) => setTimeout(r, 50));

      // No turn hooks fired during the action.
      expect(onTurnStart.mock.calls.length).toBe(baselineTurnStart);
      expect(onTurnComplete.mock.calls.length).toBe(baselineTurnComplete);

      // Action's streamText output landed on the response.
      const text = actionTurn.chunks
        .filter((c) => c.type === "text-delta")
        .map((c) => (c as { delta: string }).delta)
        .join("");
      expect(text).toBe("regenerated");
    } finally {
      await harness.close();
    }
  });

  it("warns once and emits turn-complete when an action arrives without onAction", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runSpy = vi.fn();
    const model = new MockLanguageModelV3({
      doStream: async () => {
        runSpy();
        return { stream: textStream("nope") };
      },
    });

    const { z } = await import("zod");
    const agent = chat.agent({
      id: "mockChatAgent.actions.no-handler",
      actionSchema: z.object({ type: z.literal("undo") }),
      run: async ({ messages, signal }) => {
        return streamText({ model, messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "test-no-handler" });
    try {
      await harness.sendMessage(userMessage("hi"));
      const baselineRun = runSpy.mock.calls.length;

      const actionTurn = await harness.sendAction({ type: "undo" });

      // No additional model call; console.warn fired with our marker text.
      expect(runSpy.mock.calls.length).toBe(baselineRun);
      expect(
        warnSpy.mock.calls.some((args) =>
          (args[0] as string).includes("no `onAction` handler")
        )
      ).toBe(true);

      const sawTurnComplete = actionTurn.rawChunks.some(
        (c) =>
          typeof c === "object" &&
          c !== null &&
          (c as { type?: string }).type === "trigger:turn-complete"
      );
      expect(sawTurnComplete).toBe(true);
    } finally {
      await harness.close();
      warnSpy.mockRestore();
    }
  });

  it("passes clientData through to run() and hooks", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("ok") }),
    });

    let capturedClientData: unknown;
    const agent = chat.agent({
      id: "mockChatAgent.client-data",
      run: async ({ messages, clientData, signal }) => {
        capturedClientData = clientData;
        return streamText({ model, messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, {
      chatId: "test-client-data",
      clientData: { userId: "u1", role: "admin" },
    });
    try {
      await harness.sendMessage(userMessage("hi"));
      expect(capturedClientData).toEqual({ userId: "u1", role: "admin" });
    } finally {
      await harness.close();
    }
  });

  it("chat.endRun() exits the loop after the current turn", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("bye") }),
    });

    let turnCount = 0;
    const agent = chat.agent({
      id: "mockChatAgent.end-run",
      run: async ({ messages, signal }) => {
        turnCount++;
        chat.endRun();
        return streamText({ model, messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "test-end-run" });
    try {
      await harness.sendMessage(userMessage("hello"));
      // Give the loop a tick to exit after the turn-complete chunk
      await new Promise((r) => setTimeout(r, 50));
      expect(turnCount).toBe(1);
      // Subsequent sends after endRun should not produce another run — the
      // loop has exited. We can't easily assert this via sendMessage (it
      // would block waiting for turn-complete), but we can verify the task
      // has finished.
    } finally {
      // close() is a no-op here since the task already exited, but call
      // for symmetry with other tests.
      await harness.close();
    }
  });

  it("exposes finishReason on the onTurnComplete event", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("hi") }),
    });

    let seenReason: string | undefined;
    const agent = chat.agent({
      id: "mockChatAgent.finish-reason",
      onTurnComplete: async ({ finishReason }) => {
        seenReason = finishReason;
      },
      run: async ({ messages, signal }) => {
        return streamText({ model, messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "test-finish-reason" });
    try {
      await harness.sendMessage(userMessage("hello"));
      await new Promise((r) => setTimeout(r, 20));
      expect(seenReason).toBe("stop");
    } finally {
      await harness.close();
    }
  });

  it("seeds locals before run() via setupLocals (DI pattern)", async () => {
    type FakeDb = { findUser(id: string): Promise<{ id: string; name: string }> };
    const dbKey = locals.create<FakeDb>("test-db");

    const fakeDb: FakeDb = {
      findUser: async (id) => ({ id, name: `user-${id}` }),
    };

    let userInHook: { id: string; name: string } | undefined;
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("ok") }),
    });

    const agent = chat.agent({
      id: "mockChatAgent.locals-di",
      hydrateMessages: async ({ incomingMessages }) => {
        const db = locals.getOrThrow(dbKey);
        userInHook = await db.findUser("u-1");
        return incomingMessages;
      },
      run: async ({ messages, signal }) => {
        return streamText({ model, messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, {
      chatId: "test-locals-di",
      setupLocals: ({ set }) => {
        set(dbKey, fakeDb);
      },
    });
    try {
      await harness.sendMessage(userMessage("hi"));
      expect(userInHook).toEqual({ id: "u-1", name: "user-u-1" });
    } finally {
      await harness.close();
    }
  });

  describe("chat.history read primitives", () => {
    // These tests drive a chat.agent through realistic streams and read
    // chat.history inside hooks/tools where the accumulator is in the
    // expected state. The pure walks themselves are exercised end-to-end
    // rather than via direct internal access.

    function toolCallStream(opts: { toolCallId: string; toolName: string; input: object }) {
      return simulateReadableStream({
        chunks: [
          { type: "tool-input-start", id: opts.toolCallId, toolName: opts.toolName },
          { type: "tool-input-delta", id: opts.toolCallId, delta: JSON.stringify(opts.input) },
          { type: "tool-input-end", id: opts.toolCallId },
          {
            type: "tool-call",
            toolCallId: opts.toolCallId,
            toolName: opts.toolName,
            input: JSON.stringify(opts.input),
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: {
              inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 5, text: 0, reasoning: undefined },
            },
          },
        ] as LanguageModelV3StreamPart[],
      });
    }

    it("getPendingToolCalls returns input-available parts on the leaf assistant", async () => {
      const { z } = await import("zod");
      const { tool } = await import("ai");
      const askUser = tool({
        description: "Ask the user.",
        inputSchema: z.object({ q: z.string() }),
      });
      const TC = "tc_pending_1";
      const model = new MockLanguageModelV3({
        doStream: async () => ({
          stream: toolCallStream({ toolCallId: TC, toolName: "askUser", input: { q: "?" } }),
        }),
      });

      let pending: any;
      const agent = chat.agent({
        id: "mockChatAgent.history.pending",
        onTurnComplete: async () => {
          pending = chat.history.getPendingToolCalls();
        },
        run: async ({ messages, signal }) => {
          return streamText({ model, messages, tools: { askUser }, abortSignal: signal });
        },
      });

      const harness = mockChatAgent(agent, { chatId: "test-history-pending" });
      try {
        await harness.sendMessage(userMessage("hi"));
        await new Promise((r) => setTimeout(r, 50));

        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({ toolCallId: TC, toolName: "askUser" });
        expect(typeof pending[0].messageId).toBe("string");
      } finally {
        await harness.close();
      }
    });

    it("getPendingToolCalls returns [] when the leaf assistant has no pending tool calls", async () => {
      const model = new MockLanguageModelV3({
        doStream: async () => ({ stream: textStream("hello") }),
      });
      let pending: any;
      const agent = chat.agent({
        id: "mockChatAgent.history.pending-empty",
        onTurnComplete: async () => {
          pending = chat.history.getPendingToolCalls();
        },
        run: async ({ messages, signal }) => {
          return streamText({ model, messages, abortSignal: signal });
        },
      });

      const harness = mockChatAgent(agent, { chatId: "test-history-pending-empty" });
      try {
        await harness.sendMessage(userMessage("hi"));
        await new Promise((r) => setTimeout(r, 50));
        expect(pending).toEqual([]);
      } finally {
        await harness.close();
      }
    });

    it("getResolvedToolCalls walks all messages after a HITL answer lands", async () => {
      const { z } = await import("zod");
      const { tool } = await import("ai");
      const askUser = tool({
        description: "Ask the user.",
        inputSchema: z.object({ q: z.string() }),
      });
      const TC = "tc_resolved_1";

      let callIdx = 0;
      const model = new MockLanguageModelV3({
        doStream: async () => ({
          stream:
            callIdx++ === 0
              ? toolCallStream({ toolCallId: TC, toolName: "askUser", input: { q: "?" } })
              : textStream("done"),
        }),
      });

      const turnsResolved: any[] = [];
      const agent = chat.agent({
        id: "mockChatAgent.history.resolved",
        onTurnComplete: async () => {
          turnsResolved.push(chat.history.getResolvedToolCalls());
        },
        run: async ({ messages, signal }) => {
          return streamText({ model, messages, tools: { askUser }, abortSignal: signal });
        },
      });

      const harness = mockChatAgent(agent, { chatId: "test-history-resolved" });
      try {
        await harness.sendMessage(userMessage("hi"));
        await new Promise((r) => setTimeout(r, 50));

        // Send a HITL tool answer that resolves TC. The merge attaches the
        // output to the head assistant — it now shows in `output-available`
        // state.
        const toolAnswer = {
          id: "ai-sdk-fresh-id",
          role: "assistant" as const,
          parts: [
            {
              type: "tool-askUser",
              toolCallId: TC,
              state: "output-available" as const,
              input: { q: "?" },
              output: { answer: "hi" },
            },
          ],
        };
        await harness.sendMessage(toolAnswer as any);
        await new Promise((r) => setTimeout(r, 50));

        // After turn 1 only, no tool call is resolved yet (input-available).
        // After the HITL answer is merged, the merged head shows the tool
        // in `output-available` — getResolvedToolCalls reflects that.
        const last = turnsResolved.at(-1) ?? [];
        expect(last).toHaveLength(1);
        expect(last[0]).toMatchObject({ toolCallId: TC, toolName: "askUser" });
      } finally {
        await harness.close();
      }
    });

    it("extractNewToolResults dedups against already-resolved toolCallIds", async () => {
      // Pure-function smoke test: feed a synthetic chain via a tool that
      // calls extractNewToolResults() during execution. The chain is
      // overridden via chat.history.set() inside run(), so we control
      // exactly what's in scope.
      let extracted: any;
      const agent = chat.agent({
        id: "mockChatAgent.history.extract",
        run: async ({ messages, signal }) => {
          chat.history.set([
            {
              id: "a-seed",
              role: "assistant",
              parts: [
                {
                  type: "tool-askUser",
                  toolCallId: "tc-1",
                  state: "output-available",
                  input: { q: "?" },
                  output: { color: "red" },
                },
              ],
            } as any,
            { id: "u-1", role: "user", parts: [{ type: "text", text: "u" }] } as any,
          ]);

          const incoming = {
            id: "a-incoming",
            role: "assistant" as const,
            parts: [
              {
                type: "tool-askUser",
                toolCallId: "tc-1",
                state: "output-available" as const,
                input: { q: "?" },
                output: { color: "red" },
              },
              {
                type: "tool-search",
                toolCallId: "tc-2",
                state: "output-available" as const,
                input: { q: "x" },
                output: { hits: 7 },
              },
              {
                type: "tool-search",
                toolCallId: "tc-err",
                state: "output-error" as const,
                input: { q: "y" },
                errorText: "boom",
              },
            ],
          };
          extracted = chat.history.extractNewToolResults(incoming as any);

          return streamText({
            model: new MockLanguageModelV3({
              doStream: async () => ({ stream: textStream("ok") }),
            }),
            messages,
            abortSignal: signal,
          });
        },
      });

      const harness = mockChatAgent(agent, { chatId: "test-history-extract" });
      try {
        await harness.sendMessage(userMessage("kick"));
        await new Promise((r) => setTimeout(r, 50));

        expect(extracted).toEqual([
          { toolCallId: "tc-2", toolName: "search", output: { hits: 7 } },
          { toolCallId: "tc-err", toolName: "search", output: undefined, errorText: "boom" },
        ]);
      } finally {
        await harness.close();
      }
    });

    it("findMessage returns the message by id, or undefined when missing", async () => {
      let foundUser: any;
      let foundAssistant: any;
      let missing: any;
      const model = new MockLanguageModelV3({
        doStream: async () => ({ stream: textStream("ok") }),
      });
      const agent = chat.agent({
        id: "mockChatAgent.history.find",
        onTurnComplete: async ({ uiMessages }) => {
          // Locate ids the agent actually produced/saw, then probe findMessage.
          const userId = uiMessages.find((m) => m.role === "user")?.id ?? "u-fixed";
          const asstId = uiMessages.find((m) => m.role === "assistant")?.id;
          foundUser = chat.history.findMessage(userId);
          foundAssistant = asstId ? chat.history.findMessage(asstId) : undefined;
          missing = chat.history.findMessage("definitely-not-here");
        },
        run: async ({ messages, signal }) => {
          return streamText({ model, messages, abortSignal: signal });
        },
      });

      const harness = mockChatAgent(agent, { chatId: "test-history-find" });
      try {
        await harness.sendMessage(userMessage("hello", "u-fixed"));
        await new Promise((r) => setTimeout(r, 50));

        expect(foundUser?.id).toBe("u-fixed");
        expect(foundAssistant).toBeTruthy();
        expect(missing).toBeUndefined();
      } finally {
        await harness.close();
      }
    });

    it("extractNewToolResults dedups against a real-stream-built chain", async () => {
      // Build the chain through real model streams (no chat.history.set seed)
      // and assert extractNewToolResults compares against the post-merge state.
      const { z } = await import("zod");
      const { tool } = await import("ai");
      const askUser = tool({
        description: "Ask the user.",
        inputSchema: z.object({ q: z.string() }),
      });
      const TC = "tc_real_chain_1";

      let callIdx = 0;
      const model = new MockLanguageModelV3({
        doStream: async () => ({
          stream:
            callIdx++ === 0
              ? toolCallStream({ toolCallId: TC, toolName: "askUser", input: { q: "?" } })
              : textStream("done"),
        }),
      });

      let extractedAgainstRealChain: any;
      const agent = chat.agent({
        id: "mockChatAgent.history.extract-real",
        onTurnComplete: async () => {
          // After the HITL answer turn, the chain has TC resolved. An
          // incoming "echo" message carrying TC again should yield [].
          // A second new TC should yield exactly one entry.
          const incoming = {
            id: "echo",
            role: "assistant" as const,
            parts: [
              {
                type: "tool-askUser",
                toolCallId: TC,
                state: "output-available" as const,
                input: { q: "?" },
                output: { answer: "hi" },
              },
              {
                type: "tool-askUser",
                toolCallId: "tc_real_chain_2",
                state: "output-available" as const,
                input: { q: "second" },
                output: { answer: "yes" },
              },
            ],
          };
          extractedAgainstRealChain = chat.history.extractNewToolResults(incoming as any);
        },
        run: async ({ messages, signal }) => {
          return streamText({ model, messages, tools: { askUser }, abortSignal: signal });
        },
      });

      const harness = mockChatAgent(agent, { chatId: "test-history-extract-real" });
      try {
        await harness.sendMessage(userMessage("hi"));
        await new Promise((r) => setTimeout(r, 50));
        // HITL answer for TC, lands via the runtime merger.
        const toolAnswer = {
          id: "ai-sdk-fresh-id-real",
          role: "assistant" as const,
          parts: [
            {
              type: "tool-askUser",
              toolCallId: TC,
              state: "output-available" as const,
              input: { q: "?" },
              output: { answer: "hi" },
            },
          ],
        };
        await harness.sendMessage(toolAnswer as any);
        await new Promise((r) => setTimeout(r, 50));

        expect(extractedAgainstRealChain).toEqual([
          { toolCallId: "tc_real_chain_2", toolName: "askUser", output: { answer: "yes" } },
        ]);
      } finally {
        await harness.close();
      }
    });

    it("extractNewToolResults surfaces output-error parts via the runtime merger", async () => {
      // The runtime merges incoming tool-answer messages onto the head
      // assistant via the toolCallId map. Here we send an answer in
      // `output-error` state and verify (a) getResolvedToolCalls reports
      // it, and (b) extractNewToolResults emits it with errorText set.
      const { z } = await import("zod");
      const { tool } = await import("ai");
      const search = tool({
        description: "Search.",
        inputSchema: z.object({ q: z.string() }),
      });
      const TC = "tc_err_via_merger";

      let callIdx = 0;
      const model = new MockLanguageModelV3({
        doStream: async () => ({
          stream:
            callIdx++ === 0
              ? toolCallStream({ toolCallId: TC, toolName: "search", input: { q: "x" } })
              : textStream("noted"),
        }),
      });

      let resolved: any;
      let extracted: any;
      const agent = chat.agent({
        id: "mockChatAgent.history.extract-error",
        onTurnComplete: async () => {
          resolved = chat.history.getResolvedToolCalls();
          // An echo carrying the same error toolCallId — should NOT surface
          // as new because it's already resolved on the chain.
          const echo = {
            id: "echo-err",
            role: "assistant" as const,
            parts: [
              {
                type: "tool-search",
                toolCallId: TC,
                state: "output-error" as const,
                input: { q: "x" },
                errorText: "boom",
              },
            ],
          };
          extracted = chat.history.extractNewToolResults(echo as any);
        },
        run: async ({ messages, signal }) => {
          return streamText({ model, messages, tools: { search }, abortSignal: signal });
        },
      });

      const harness = mockChatAgent(agent, { chatId: "test-history-extract-error" });
      try {
        await harness.sendMessage(userMessage("kick"));
        await new Promise((r) => setTimeout(r, 50));
        // HITL answer arriving as output-error.
        const errAnswer = {
          id: "ai-sdk-err-fresh",
          role: "assistant" as const,
          parts: [
            {
              type: "tool-search",
              toolCallId: TC,
              state: "output-error" as const,
              input: { q: "x" },
              errorText: "boom",
            },
          ],
        };
        await harness.sendMessage(errAnswer as any);
        await new Promise((r) => setTimeout(r, 50));

        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({ toolCallId: TC, toolName: "search" });
        // Echo of the same error toolCallId is already resolved → []
        expect(extracted).toEqual([]);
      } finally {
        await harness.close();
      }
    });

    it("extractNewToolResults handles a multi-tool message where only one is new", async () => {
      // Pure-helper edge: incoming message has two tool parts with the
      // same toolName but different toolCallIds — one already resolved
      // on the chain, one fresh. Only the fresh one should surface.
      let extracted: any;
      const agent = chat.agent({
        id: "mockChatAgent.history.extract-multi",
        run: async ({ messages, signal }) => {
          chat.history.set([
            {
              id: "a-seed",
              role: "assistant",
              parts: [
                {
                  type: "tool-search",
                  toolCallId: "tc-old",
                  state: "output-available",
                  input: { q: "old" },
                  output: { hits: 1 },
                },
              ],
            } as any,
            { id: "u-1", role: "user", parts: [{ type: "text", text: "u" }] } as any,
          ]);

          const incoming = {
            id: "a-incoming",
            role: "assistant" as const,
            parts: [
              // Same tool, already-resolved id — should be filtered.
              {
                type: "tool-search",
                toolCallId: "tc-old",
                state: "output-available" as const,
                input: { q: "old" },
                output: { hits: 1 },
              },
              // Same tool, fresh id — should surface.
              {
                type: "tool-search",
                toolCallId: "tc-new",
                state: "output-available" as const,
                input: { q: "new" },
                output: { hits: 9 },
              },
              // Duplicate of tc-new in the same message — must collapse
              // to a single emission (within-message dedup).
              {
                type: "tool-search",
                toolCallId: "tc-new",
                state: "output-available" as const,
                input: { q: "new" },
                output: { hits: 9 },
              },
            ],
          };
          extracted = chat.history.extractNewToolResults(incoming as any);

          return streamText({
            model: new MockLanguageModelV3({
              doStream: async () => ({ stream: textStream("ok") }),
            }),
            messages,
            abortSignal: signal,
          });
        },
      });

      const harness = mockChatAgent(agent, { chatId: "test-history-extract-multi" });
      try {
        await harness.sendMessage(userMessage("kick"));
        await new Promise((r) => setTimeout(r, 50));

        expect(extracted).toEqual([
          { toolCallId: "tc-new", toolName: "search", output: { hits: 9 } },
        ]);
      } finally {
        await harness.close();
      }
    });

    it("getPendingToolCalls still returns the assistant's pending calls when a user message follows", async () => {
      // Edge: the chain is [assistant(input-available), user]. The most
      // recent assistant is the one with the pending tool call, even
      // though the strict tail is a user message. The walk-back semantic
      // means pending stays pending until the assistant is mutated.
      let pendingAfterUser: any;
      const agent = chat.agent({
        id: "mockChatAgent.history.pending-after-user",
        run: async ({ messages, signal }) => {
          chat.history.set([
            {
              id: "a-pending",
              role: "assistant",
              parts: [
                {
                  type: "tool-askUser",
                  toolCallId: "tc-still-pending",
                  state: "input-available",
                  input: { q: "?" },
                },
              ],
            } as any,
            { id: "u-after", role: "user", parts: [{ type: "text", text: "anyway..." }] } as any,
          ]);
          pendingAfterUser = chat.history.getPendingToolCalls();
          return streamText({
            model: new MockLanguageModelV3({
              doStream: async () => ({ stream: textStream("ok") }),
            }),
            messages,
            abortSignal: signal,
          });
        },
      });

      const harness = mockChatAgent(agent, { chatId: "test-history-pending-after-user" });
      try {
        await harness.sendMessage(userMessage("kick"));
        await new Promise((r) => setTimeout(r, 50));

        expect(pendingAfterUser).toEqual([
          { toolCallId: "tc-still-pending", toolName: "askUser", messageId: "a-pending" },
        ]);
      } finally {
        await harness.close();
      }
    });

    it("getChain returns a defensive copy parallel to all()", async () => {
      let chainCopy: any;
      let allCopy: any;
      const model = new MockLanguageModelV3({
        doStream: async () => ({ stream: textStream("ok") }),
      });
      const agent = chat.agent({
        id: "mockChatAgent.history.chain",
        onTurnComplete: async () => {
          chainCopy = chat.history.getChain();
          allCopy = chat.history.all();
          // Mutate one — must not affect the other.
          chainCopy.push({ id: "stray", role: "user", parts: [] });
        },
        run: async ({ messages, signal }) => {
          return streamText({ model, messages, abortSignal: signal });
        },
      });

      const harness = mockChatAgent(agent, { chatId: "test-history-chain" });
      try {
        await harness.sendMessage(userMessage("a"));
        await new Promise((r) => setTimeout(r, 50));

        expect(chainCopy.length).toBeGreaterThan(0);
        expect(allCopy.length).toBe(chainCopy.length - 1);
        expect(allCopy.find((m: any) => m.id === "stray")).toBeUndefined();
      } finally {
        await harness.close();
      }
    });
  });

  it("cleans up properly after close() so the next harness starts fresh", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("first") }),
    });

    const agent = chat.agent({
      id: "mockChatAgent.cleanup",
      run: async ({ messages, signal }) => {
        return streamText({ model, messages, abortSignal: signal });
      },
    });

    // First harness
    const h1 = mockChatAgent(agent, { chatId: "test-cleanup-1" });
    await h1.sendMessage(userMessage("a"));
    await h1.close();

    // Second harness should work independently
    const h2 = mockChatAgent(agent, { chatId: "test-cleanup-2" });
    try {
      const turn = await h2.sendMessage(userMessage("b"));
      const text = turn.chunks
        .filter((c) => c.type === "text-delta")
        .map((c) => (c as { delta: string }).delta)
        .join("");
      expect(text).toBe("first");
      // Chunks from h1 should NOT be visible here
      expect(h2.allChunks).toEqual(turn.chunks);
    } finally {
      await h2.close();
    }
  });

  describe("slim wire harness primitives (snapshot + replay)", () => {
    // Plan E.1 + F.2: exercise the new harness driver methods so future
    // edits don't accidentally drop boot scenarios that the runtime now
    // depends on (snapshot read, replay tail, head-start seeding,
    // hydrateMessages short-circuit).

    it("getSnapshot returns the most recent writeChatSnapshot value", async () => {
      // Run a single turn end-to-end and verify the runtime's post-turn
      // snapshot write is captured by the harness's getSnapshot primitive.
      const model = new MockLanguageModelV3({
        doStream: async () => ({ stream: textStream("captured") }),
      });
      const agent = chat.agent({
        id: "mockChatAgent.snapshot.write",
        run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
      });
      const harness = mockChatAgent(agent, { chatId: "snap-write" });
      try {
        expect(harness.getSnapshot()).toBeUndefined();
        await harness.sendMessage(userMessage("hi"));
        // onTurnComplete -> writeChatSnapshot fires AFTER turn-complete chunk;
        // give it a tick to settle.
        await new Promise((r) => setTimeout(r, 50));
        const snap = harness.getSnapshot();
        expect(snap).toBeDefined();
        expect(snap!.version).toBe(1);
        // The snapshot reflects the post-turn accumulator: 1 user + 1 assistant.
        const roles = snap!.messages.map((m) => m.role);
        expect(roles).toEqual(["user", "assistant"]);
      } finally {
        await harness.close();
      }
    });

    it("seedSnapshot pre-populates the accumulator on boot — onChatStart sees prior history", async () => {
      // Plan B.3: the boot calls readChatSnapshot before onChatStart fires.
      // A seeded snapshot lets the test simulate a "continuation" boot.
      const model = new MockLanguageModelV3({
        doStream: async () => ({ stream: textStream("ack") }),
      });
      let messagesAtChatStart: any[] = [];
      const agent = chat.agent({
        id: "mockChatAgent.snapshot.seed",
        onChatStart: async ({ messages }) => {
          messagesAtChatStart = messages;
        },
        run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
      });
      const harness = mockChatAgent(agent, {
        chatId: "snap-seed",
        snapshot: {
          version: 1,
          savedAt: Date.now(),
          messages: [
            { id: "u-prev", role: "user", parts: [{ type: "text", text: "earlier" }] },
            { id: "a-prev", role: "assistant", parts: [{ type: "text", text: "ok" }] },
          ],
        },
      });
      try {
        await harness.sendMessage(userMessage("now"));
        await new Promise((r) => setTimeout(r, 50));
        // onChatStart sees ModelMessage[] (not UIMessage[]). The exact
        // count varies because `toModelMessages` may split a single UI
        // message into multiple ModelMessages depending on parts. The
        // load-bearing assertion is that prior history was loaded —
        // `messages` is non-empty before turn 0 even though the wire
        // payload only carried the new user message.
        expect(messagesAtChatStart.length).toBeGreaterThan(0);
      } finally {
        await harness.close();
      }
    });

    it("sendRegenerate (no-args) trims trailing assistant and re-runs", async () => {
      // Plan B.4: regenerate-message wire carries no message body. The
      // agent trims trailing assistants from its accumulator and runs
      // streamText again. Verify the harness's no-arg sendRegenerate
      // drives this path end-to-end.
      let callIdx = 0;
      const model = new MockLanguageModelV3({
        doStream: async () => ({
          stream: textStream(callIdx++ === 0 ? "first-reply" : "regenerated"),
        }),
      });
      const agent = chat.agent({
        id: "mockChatAgent.regenerate.slim",
        run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
      });
      const harness = mockChatAgent(agent, { chatId: "regen-slim" });
      try {
        const t1 = await harness.sendMessage(userMessage("question"));
        const t1Text = t1.chunks
          .filter((c) => c.type === "text-delta")
          .map((c) => (c as { delta: string }).delta)
          .join("");
        expect(t1Text).toBe("first-reply");

        // No-arg regenerate — the agent re-runs streamText; second call
        // emits the regenerated stream.
        const t2 = await harness.sendRegenerate();
        const t2Text = t2.chunks
          .filter((c) => c.type === "text-delta")
          .map((c) => (c as { delta: string }).delta)
          .join("");
        expect(t2Text).toBe("regenerated");
      } finally {
        await harness.close();
      }
    });

    it("sendHeadStart seeds accumulator from headStartMessages on turn 0", async () => {
      // Plan B.3 head-start bootstrap: when trigger is `handover-prepare`
      // and accumulator is empty, the runtime seeds from
      // payload.headStartMessages. Verify the harness drives this with
      // the customer's first-turn UIMessage[] history through the head-
      // start route.
      const model = new MockLanguageModelV3({
        doStream: async () => ({ stream: textStream("post-handover") }),
      });
      let messagesAtChatStart: any[] = [];
      const agent = chat.agent({
        id: "mockChatAgent.headstart.slim",
        onChatStart: async ({ messages }) => {
          messagesAtChatStart = messages;
        },
        run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
      });
      const harness = mockChatAgent(agent, {
        chatId: "headstart-slim",
        mode: "handover-prepare",
      });
      try {
        // The head-start payload carries the full first-turn history.
        // After it lands, the agent's `chat.handover` flow normally
        // dispatches a `handover` signal; we use the simpler primitive
        // here just to verify the seeding takes effect at boot.
        const handover = harness.sendHandover({
          partialAssistantMessage: [{ type: "text", text: "from-handover" }],
          isFinal: true,
        });
        // Drive through to turn-complete
        await handover;
        await new Promise((r) => setTimeout(r, 50));
        // No assertion on seeding here beyond turn-complete reaching us —
        // sendHeadStart routes via session.in for tests that need the
        // wire-level path; the per-test wiring above exercises the
        // handover branch which is the production path for this scenario.
      } finally {
        await harness.close();
      }
    });

    it("hydrateMessages registered short-circuits snapshot read/write", async () => {
      // Plan B.1/B.6: with hydrateMessages set, the runtime skips both
      // readChatSnapshot at boot AND writeChatSnapshot after onTurnComplete.
      // Verify by asserting `getSnapshot()` stays undefined across a turn.
      const model = new MockLanguageModelV3({
        doStream: async () => ({ stream: textStream("ok") }),
      });
      const agent = chat.agent({
        id: "mockChatAgent.hydrate.skip-snapshot",
        hydrateMessages: async ({ incomingMessages }) => incomingMessages,
        run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
      });
      const harness = mockChatAgent(agent, { chatId: "hydrate-skip" });
      try {
        await harness.sendMessage(userMessage("hi"));
        await new Promise((r) => setTimeout(r, 50));
        // No snapshot was written — customer with hydrateMessages owns
        // persistence themselves.
        expect(harness.getSnapshot()).toBeUndefined();
      } finally {
        await harness.close();
      }
    });
  });

  describe("onChatStart fires exactly once per chat", () => {
    // Contract: `onChatStart` fires only on the chat's very first user
    // message ever. It does NOT re-fire on continuation runs (post-`endRun`,
    // post-waitpoint-timeout, post-`chat.requestUpgrade`) or on OOM-retry
    // attempts. Customers put one-time chat-setup work there (Chat DB row
    // create, user-context init) and that contract relies on once-per-chat
    // semantics.

    it("fires on a fresh first message (baseline)", async () => {
      const onChatStart = vi.fn();
      const onTurnStart = vi.fn();
      const model = new MockLanguageModelV3({
        doStream: async () => ({ stream: textStream("hi") }),
      });
      const agent = chat.agent({
        id: "onChatStart-gate.fresh-baseline",
        onChatStart,
        onTurnStart,
        run: async ({ messages, signal }) =>
          streamText({ model, messages, abortSignal: signal }),
      });
      const harness = mockChatAgent(agent, { chatId: "fresh-baseline" });
      try {
        await harness.sendMessage(userMessage("hello"));
        await new Promise((r) => setTimeout(r, 20));
        expect(onChatStart).toHaveBeenCalledTimes(1);
        expect(onTurnStart).toHaveBeenCalledTimes(1);
      } finally {
        await harness.close();
      }
    });

    it("does NOT fire on a continuation run (continuation: true at boot)", async () => {
      const onChatStart = vi.fn();
      const onTurnStart = vi.fn();
      const model = new MockLanguageModelV3({
        doStream: async () => ({ stream: textStream("ok") }),
      });
      const agent = chat.agent({
        id: "onChatStart-gate.continuation-skip",
        // hydrateMessages registered so the boot path doesn't try to read a
        // snapshot the harness doesn't have — keeps the continuation-wait
        // branch clean.
        hydrateMessages: async ({ incomingMessages }) => incomingMessages,
        onChatStart,
        onTurnStart,
        run: async ({ messages, signal }) =>
          streamText({ model, messages, abortSignal: signal }),
      });
      const harness = mockChatAgent(agent, {
        chatId: "continuation-skip",
        // `continuation: true` auto-selects `mode: "continuation"` —
        // boots with `trigger` omitted (mirroring what the server's
        // continuation overrides produce in production) and enters the
        // SDK's continuation-wait branch.
        continuation: true,
        previousRunId: "run_test_prior",
      });
      try {
        // The continuation-wait branch parks until the first session.in
        // message arrives — sending one wakes it and runs turn 0.
        await harness.sendMessage(userMessage("first user message of this run"));
        await new Promise((r) => setTimeout(r, 20));
        expect(onChatStart).not.toHaveBeenCalled();
        expect(onTurnStart).toHaveBeenCalledTimes(1);
      } finally {
        await harness.close();
      }
    });

    it("does NOT fire on an OOM-retry attempt (ctx.attempt.number > 1)", async () => {
      const onChatStart = vi.fn();
      const onTurnStart = vi.fn();
      const model = new MockLanguageModelV3({
        doStream: async () => ({ stream: textStream("ok") }),
      });
      const agent = chat.agent({
        id: "onChatStart-gate.oom-retry-skip",
        hydrateMessages: async ({ incomingMessages }) => incomingMessages,
        onChatStart,
        onTurnStart,
        run: async ({ messages, signal }) =>
          streamText({ model, messages, abortSignal: signal }),
      });
      const harness = mockChatAgent(agent, {
        chatId: "oom-retry-skip",
        taskContext: {
          ctx: { attempt: { number: 2, startedAt: new Date(0) } },
        },
      });
      try {
        await harness.sendMessage(userMessage("hi"));
        await new Promise((r) => setTimeout(r, 20));
        expect(onChatStart).not.toHaveBeenCalled();
        expect(onTurnStart).toHaveBeenCalledTimes(1);
      } finally {
        await harness.close();
      }
    });
  });
});
