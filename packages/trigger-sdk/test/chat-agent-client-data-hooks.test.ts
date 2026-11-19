import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * A test injects its mock model through `clientData`, so every callback the SDK invokes has to
 * receive it: one that does not reaches the real provider from an otherwise offline suite. These
 * pin the callbacks that carried a `chatId` but no `clientData`.
 */

const CLIENT_DATA = { marker: "mock-model-lives-here" };

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const textChunks = (text: string): LanguageModelV3StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
];
const toolCallChunks = (callId: string): LanguageModelV3StreamPart[] => [
  { type: "tool-call", toolCallId: callId, toolName: "lookup", input: "{}" },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: USAGE },
];
const userMessage = (text: string, id: string) => ({
  id,
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});

const lookup = tool({
  description: "answers instantly",
  inputSchema: z.object({}),
  execute: async () => "found",
});

/** A tool call, then a text answer: one step boundary for `prepareStep` to compact at. */
function toolThenAnswer() {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: call++ === 0 ? toolCallChunks("call_1") : textChunks("done"),
      }),
    }),
  });
}

function answering() {
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: textChunks("done") }) }),
  });
}

type Seen = { source?: string; chatId?: string; turn?: number; clientData?: unknown };

describe("clientData reaches every SDK-invoked callback", () => {
  // Catches: the inner summarize of a createSession turn's prepareStep being called with no
  // chatId, turn or clientData, so a summarizer that reads its model from clientData hits the
  // real provider.
  it("createSession turn.prepareStep() passes them to the inner summarize", async () => {
    const summarized: Seen[] = [];
    const agent = chat.customAgent({
      id: "client-data-session-inner",
      run: async (payload, { signal }) => {
        const session = chat.createSession(payload, {
          signal,
          idleTimeoutInSeconds: 1,
          compaction: {
            shouldCompact: (event) => event.source === "inner",
            summarize: async (event) => {
              summarized.push(event);
              return "summary";
            },
          },
        });
        for await (const turn of session) {
          await turn.complete(
            streamText({
              model: toolThenAnswer(),
              messages: turn.messages,
              abortSignal: turn.signal,
              prepareStep: turn.prepareStep(),
              tools: { lookup },
              stopWhen: stepCountIs(3),
            })
          );
        }
      },
    });

    const harness = mockChatAgent(agent, {
      chatId: "client-data-session-inner-chat",
      clientData: CLIENT_DATA,
    });
    try {
      await harness.sendMessage(userMessage("hi", "u-1"));
      expect(summarized).toHaveLength(1);
      expect(summarized[0]).toMatchObject({
        source: "inner",
        chatId: "client-data-session-inner-chat",
        turn: 0,
        clientData: CLIENT_DATA,
      });
    } finally {
      await harness.close();
    }
  });

  // Catches: the inner summarize of a chat.MessageAccumulator's prepareStep being called with no
  // chatId, turn or clientData, the same gap as the session turn's.
  it("MessageAccumulator.prepareStep() passes them to the inner summarize", async () => {
    const summarized: Seen[] = [];
    const agent = chat.agent({
      id: "client-data-accumulator-inner",
      run: async ({ messages, signal }) => {
        const conversation = new chat.MessageAccumulator({
          compaction: {
            shouldCompact: (event) => event.source === "inner",
            summarize: async (event) => {
              summarized.push(event);
              return "summary";
            },
          },
        });
        return streamText({
          model: toolThenAnswer(),
          messages,
          abortSignal: signal,
          prepareStep: conversation.prepareStep(),
          tools: { lookup },
          stopWhen: stepCountIs(3),
        });
      },
    });

    const harness = mockChatAgent(agent, {
      chatId: "client-data-accumulator-inner-chat",
      clientData: CLIENT_DATA,
    });
    try {
      await harness.sendMessage(userMessage("hi", "u-1"));
      expect(summarized).toHaveLength(1);
      expect(summarized[0]).toMatchObject({
        source: "inner",
        chatId: "client-data-accumulator-inner-chat",
        turn: 0,
        clientData: CLIENT_DATA,
      });
    } finally {
      await harness.close();
    }
  });

  // Catches: the onCompacted event of a compaction between tool steps and one between turns
  // carrying a chatId and turn but not the clientData.
  it("onCompacted gets them for inner and outer compaction", async () => {
    const compacted: {
      stepNumber: number;
      chatId?: string;
      turn?: number;
      clientData?: unknown;
    }[] = [];
    let innerModelCalls = 0;
    const agent = chat.agent({
      id: "client-data-on-compacted",
      compaction: {
        shouldCompact: () => true,
        summarize: async () => "summary",
      },
      onCompacted: (event) => {
        compacted.push(event);
      },
      run: async ({ messages, signal }) => {
        innerModelCalls++;
        return streamText({
          ...chat.toStreamTextOptions({ tools: { lookup } }),
          model: innerModelCalls === 1 ? toolThenAnswer() : answering(),
          messages,
          abortSignal: signal,
          stopWhen: stepCountIs(3),
        });
      },
    });

    const harness = mockChatAgent(agent, {
      chatId: "client-data-on-compacted-chat",
      clientData: CLIENT_DATA,
    });
    try {
      // Turn 1 has a tool step, so compaction runs between steps (stepNumber >= 0).
      await harness.sendMessage(userMessage("hi", "u-1"));
      // Turn 2 is a single step, so only the outer loop compacts it (stepNumber -1).
      await harness.sendMessage(userMessage("again", "u-2"));

      const inner = compacted.find((event) => event.stepNumber >= 0);
      const outer = compacted.find((event) => event.stepNumber === -1);
      expect(inner).toMatchObject({
        chatId: "client-data-on-compacted-chat",
        turn: 0,
        clientData: CLIENT_DATA,
      });
      expect(outer).toMatchObject({
        chatId: "client-data-on-compacted-chat",
        turn: 1,
        clientData: CLIENT_DATA,
      });
    } finally {
      await harness.close();
    }
  });

  // Catches: onValidateMessages receiving a chatId and turn but not the clientData, so a
  // moderation hook that calls a model from there cannot be pointed at a mock.
  it("onValidateMessages gets the clientData", async () => {
    const seen: { chatId: string; turn: number; clientData?: unknown }[] = [];
    const agent = chat.agent({
      id: "client-data-validate",
      onValidateMessages: async (event) => {
        seen.push(event);
        return event.messages;
      },
      run: async ({ messages, signal }) =>
        streamText({ model: answering(), messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, {
      chatId: "client-data-validate-chat",
      clientData: CLIENT_DATA,
    });
    try {
      await harness.sendMessage(userMessage("hi", "u-1"));
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        chatId: "client-data-validate-chat",
        turn: 0,
        clientData: CLIENT_DATA,
      });
    } finally {
      await harness.close();
    }
  });

  // Catches: the pendingMessages onReceived and onInjected events carrying a chatId and turn but
  // not the clientData, so a hook that classifies a steering message with a model cannot be
  // pointed at a mock.
  it("pendingMessages onReceived and onInjected get the clientData", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let toolEntered = false;
    const gated = tool({
      description: "holds the turn open until the test releases it",
      inputSchema: z.object({}),
      execute: async () => {
        toolEntered = true;
        await gate;
        return "found";
      },
    });
    const received: { clientData?: unknown }[] = [];
    const injected: { clientData?: unknown }[] = [];

    const agent = chat.agent({
      id: "client-data-pending",
      pendingMessages: {
        shouldInject: () => true,
        onReceived: (event) => {
          received.push(event);
        },
        onInjected: (event) => {
          injected.push(event);
        },
      },
      run: async ({ messages, signal }) =>
        streamText({
          ...chat.toStreamTextOptions({ tools: { lookup: gated } }),
          model: toolThenAnswer(),
          messages,
          abortSignal: signal,
          stopWhen: stepCountIs(3),
        }),
    });

    const harness = mockChatAgent(agent, {
      chatId: "client-data-pending-chat",
      clientData: CLIENT_DATA,
    });
    try {
      const first = harness.sendMessage(userMessage("hi", "u-1"));
      const deadline = Date.now() + 5_000;
      while (!toolEntered && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await harness.sendPendingMessage(userMessage("steer", "u-2"));
      release();
      await first;

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ clientData: CLIENT_DATA });
      expect(injected).toHaveLength(1);
      expect(injected[0]).toMatchObject({ clientData: CLIENT_DATA });
    } finally {
      release();
      await harness.close();
    }
  });

  // Catches: onAction being built without the clientData the action's metadata carried, so a mock
  // model injected through clientData is unreachable from an action handler (and from the turn
  // its `chat.turn()` starts).
  it("onAction, and the turn it starts, get the clientData", async () => {
    const actions: Seen[] = [];
    const completed: Seen[] = [];
    const agent = chat.agent({
      id: "client-data-action",
      actionSchema: z.object({ type: z.literal("regenerate") }),
      onAction: async (event) => {
        actions.push(event);
        return chat.turn();
      },
      onTurnComplete: async (event) => {
        completed.push(event);
      },
      run: async ({ messages, signal }) =>
        streamText({ model: answering(), messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, {
      chatId: "client-data-action-chat",
      clientData: CLIENT_DATA,
    });
    try {
      await harness.sendMessage(userMessage("hi", "u-1"));
      await harness.sendAction({ type: "regenerate" });

      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        chatId: "client-data-action-chat",
        clientData: CLIENT_DATA,
      });
      expect(completed).toHaveLength(2);
      expect(completed[1]).toMatchObject({
        chatId: "client-data-action-chat",
        clientData: CLIENT_DATA,
      });
    } finally {
      await harness.close();
    }
  });

  // Catches: the onTurnComplete event carrying a chatId and turn but not the clientData, so
  // persistence code that calls a model from there cannot be pointed at a mock. Read straight
  // after sendMessage resolves, so it also fails if the turn stops waiting for post-turn hooks.
  it("onTurnComplete gets the clientData once sendMessage resolves", async () => {
    const completed: Seen[] = [];
    const agent = chat.agent({
      id: "client-data-turn-complete",
      onTurnComplete: async (event) => {
        completed.push(event);
      },
      run: async ({ messages, signal }) =>
        streamText({ model: answering(), messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, {
      chatId: "client-data-turn-complete-chat",
      clientData: CLIENT_DATA,
    });
    try {
      await harness.sendMessage(userMessage("hi", "u-1"));

      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({
        chatId: "client-data-turn-complete-chat",
        turn: 0,
        clientData: CLIENT_DATA,
      });
    } finally {
      await harness.close();
    }
  });
});
