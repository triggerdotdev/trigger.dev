// Import the test harness FIRST — installs the resource catalog so
// `chat.agent()` below registers its task functions correctly.
import { mockChatAgent } from "../src/v3/test/index.js";

import { describe, expect, it } from "vitest";
import { chat } from "../src/v3/ai.js";
import { simulateReadableStream, streamText } from "ai";
import type { UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { z } from "zod";

function textStream(text: string): ReadableStream<LanguageModelV3StreamPart> {
  return simulateReadableStream({
    chunks: [
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
    ],
  });
}

function textOf(message: UIMessage): string {
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("a StreamTextResult returned from onAction", () => {
  it("becomes part of the conversation, not just something the browser saw", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("regenerated answer") }),
    });

    const agent = chat.agent({
      id: "action-stream-accumulator",
      actionSchema: z.discriminatedUnion("type", [z.object({ type: z.literal("regenerate") })]),

      /**
       * The bare shape the docs show: return the stream and let the runtime pipe
       * it. The alternative — consuming it with `chat.pipeAndCapture` — is the
       * workaround, so testing that instead would prove nothing about this path.
       */
      onAction: async ({ action, messages }) => {
        if (action.type !== "regenerate") return;
        chat.history.slice(0, -1);
        return streamText({ model, messages });
      },

      run: async ({ messages, signal }) =>
        streamText({
          model: new MockLanguageModelV3({
            doStream: async () => ({ stream: textStream("first answer") }),
          }),
          messages,
          abortSignal: signal,
        }),
    });

    const harness = mockChatAgent(agent, { chatId: "action-stream-accumulator" });

    try {
      await harness.sendMessage({
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "ask" }],
      });
      await new Promise((r) => setTimeout(r, 30));

      const turn = await harness.sendAction({ type: "regenerate" });
      await new Promise((r) => setTimeout(r, 50));

      // The browser did see it — that part was never broken.
      const streamed = turn.chunks
        .filter((c) => c.type === "text-delta")
        .map((c) => (c as { delta: string }).delta)
        .join("");
      expect(streamed).toBe("regenerated answer");

      /**
       * And the conversation agrees with the screen. Before the fix the response
       * was piped and dropped: absent from the accumulator, absent from the
       * snapshot, so the next turn's model context contained the question and the
       * *old* answer that regenerate had just removed.
       */
      const snapshot = harness.getSnapshot();
      expect(snapshot?.messages.map(textOf)).toEqual(["ask", "regenerated answer"]);
    } finally {
      await harness.close();
    }
  });
});
