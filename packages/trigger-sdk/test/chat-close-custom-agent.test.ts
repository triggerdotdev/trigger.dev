// Import the test harness FIRST — this installs the resource catalog so
// `chat.customAgent()` calls below register their task functions correctly.
import { mockChatAgent } from "../src/v3/test/index.js";

import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { chat } from "../src/v3/ai.js";

function userMessage(text: string, id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function model(text: string) {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
    },
  ];
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks }) }),
  });
}

describe("chat.close in a custom agent", () => {
  it("closes the session when the loop body calls it and then breaks", async () => {
    const agent = chat.customAgent({
      id: "chat-close.custom-break",
      run: async (payload) => {
        for await (const turn of chat.createSession(payload, {
          signal: new AbortController().signal,
        })) {
          await turn.complete(streamText({ model: model("done"), messages: turn.messages }));
          // Leaving the loop early is the case an exit check inside next()
          // never sees: next() is not called again.
          chat.close({ reason: "custom agent said stop" });
          break;
        }
      },
    });

    const harness = mockChatAgent(agent, { chatId: "custom-close-break" });
    try {
      await harness.sendMessage(userMessage("hi", "u-1"));
      await harness.waitForExit();
      expect(harness.getCloseCalls()).toEqual([
        { sessionId: "custom-close-break", reason: "custom agent said stop" },
      ]);
    } finally {
      await harness.close();
    }
  });

  it("closes the session when the loop keeps iterating after the call", async () => {
    const agent = chat.customAgent({
      id: "chat-close.custom-continue",
      run: async (payload) => {
        for await (const turn of chat.createSession(payload, {
          signal: new AbortController().signal,
        })) {
          await turn.complete(streamText({ model: model("done"), messages: turn.messages }));
          chat.close({ reason: "budget" });
        }
      },
    });

    const harness = mockChatAgent(agent, { chatId: "custom-close-continue" });
    try {
      await harness.sendMessage(userMessage("hi", "u-1"));
      await harness.waitForExit();
      expect(harness.getCloseCalls()).toEqual([
        { sessionId: "custom-close-continue", reason: "budget" },
      ]);
    } finally {
      await harness.close();
    }
  });

  it("closes the session from a hand-rolled loop with no iterator", async () => {
    const agent = chat.customAgent({
      id: "chat-close.custom-handrolled",
      run: async () => {
        const conversation = new chat.MessageAccumulator();
        const next = await chat.messages.waitWithIdleTimeout({
          idleTimeoutInSeconds: 60,
          timeout: "1h",
        });
        if (!next.ok) return;
        const wire = next.output as { message?: UIMessage; trigger: string };
        const messages = await conversation.addIncoming(
          wire.message ? [wire.message] : [],
          wire.trigger,
          0
        );
        const captured = await chat.pipeAndCapture(streamText({ model: model("done"), messages }));
        if (captured.message) await conversation.addResponse(captured.message);
        await chat.writeTurnComplete();
        // No SDK-owned loop here, so the close has to be performed when run()
        // returns or it is a silent no-op.
        chat.close({ reason: "hand-rolled stop" });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "custom-close-handrolled" });
    try {
      await harness.sendMessage(userMessage("hi", "u-1"));
      await harness.waitForExit();
      expect(harness.getCloseCalls()).toEqual([
        { sessionId: "custom-close-handrolled", reason: "hand-rolled stop" },
      ]);
    } finally {
      await harness.close();
    }
  });
});
