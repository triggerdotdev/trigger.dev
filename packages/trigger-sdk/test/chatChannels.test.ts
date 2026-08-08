import { mockChatAgent, recordingChannelConnector } from "../src/v3/test/index.js";

import { describe, expect, it } from "vitest";
import { chat } from "../src/v3/ai.js";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

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

describe("chat.agent channels", () => {
  it("delivers a channel event as a turn and posts the reply back through the connector", async () => {
    const seenText: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("hello world") }),
    });

    const channel = recordingChannelConnector();

    const agent = chat.agent({
      id: "chatChannels.final-roundtrip",
      channels: [channel],
      run: async ({ messages, signal }) => {
        const last = messages[messages.length - 1];
        const content = last?.content;
        seenText.push(
          typeof content === "string"
            ? content
            : (content ?? [])
                .map((p) => (typeof p === "object" && p.type === "text" ? p.text : ""))
                .join("")
        );
        return streamText({ model, messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "chan-1" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi there", threadId: "chan-1" } });

      expect(seenText).toEqual(["hi there"]);

      expect(channel.acks).toHaveLength(1);
      expect(channel.acks[0]!.message.text).toBe("...");
      expect(channel.finalText()).toBe("hello world");

      const finalSend = channel.sent[channel.sent.length - 1]!;
      expect(finalSend.ctx.final).toBe(true);
      expect(finalSend.ctx.previousRef).toBe(channel.acks[0]!.ref);
    } finally {
      await harness.close();
    }
  });

  it("posts only the final answer when ack is null", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("done") }),
    });

    const channel = recordingChannelConnector({ ack: null });

    const agent = chat.agent({
      id: "chatChannels.no-ack",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-2" });
    try {
      await harness.sendChannelEvent({ event: { text: "yo", threadId: "chan-2" } });

      expect(channel.acks).toHaveLength(0);
      expect(channel.sent).toHaveLength(1);
      expect(channel.finalText()).toBe("done");
    } finally {
      await harness.close();
    }
  });

  it("records lifecycle reactions around a channel turn", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("ok") }),
    });

    const channel = recordingChannelConnector({
      reactions: { working: "eyes", done: "white_check_mark" },
    });

    const agent = chat.agent({
      id: "chatChannels.reactions",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-3" });
    try {
      await harness.sendChannelEvent({ event: { text: "go", threadId: "chan-3" } });

      const names = channel.reactionsApplied.map((r) => ({
        name: r.reaction.name,
        remove: r.reaction.remove ?? false,
      }));
      expect(names).toEqual([
        { name: "eyes", remove: false },
        { name: "eyes", remove: true },
        { name: "white_check_mark", remove: false },
      ]);
    } finally {
      await harness.close();
    }
  });

  it("still posts an authoritative final reply in stream delivery", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("streamed answer") }),
    });

    const channel = recordingChannelConnector({ delivery: "stream" });

    const agent = chat.agent({
      id: "chatChannels.stream-final",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-4" });
    try {
      await harness.sendChannelEvent({ event: { text: "stream please", threadId: "chan-4" } });

      expect(channel.finalText()).toBe("streamed answer");
    } finally {
      await harness.close();
    }
  });
});
