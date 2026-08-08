import { mockChatAgent, recordingChannelConnector } from "../src/v3/test/index.js";

import { describe, expect, it, vi } from "vitest";
import {
  chat,
  __makeChannelStreamEditorForTests,
  __makeChannelStreamTapForTests,
} from "../src/v3/ai.js";
import { simulateReadableStream, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { z } from "zod";

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

  it("edits the placeholder to the error when a channel turn throws", async () => {
    const channel = recordingChannelConnector();

    const agent = chat.agent({
      id: "chatChannels.error-egress",
      channels: [channel],
      run: async () => {
        throw new Error("turn exploded");
      },
    });

    const harness = mockChatAgent(agent, { chatId: "chan-5" });
    try {
      await harness.sendChannelEvent({ event: { text: "cause an error", threadId: "chan-5" } });

      expect(channel.acks).toHaveLength(1);
      const finalSend = channel.sent[channel.sent.length - 1]!;
      expect(finalSend.ctx.final).toBe(true);
      expect(finalSend.ctx.previousRef).toBe(channel.acks[0]!.ref);
      expect(finalSend.message.text).toBe("turn exploded");
    } finally {
      await harness.close();
    }
  });
});

describe("chat.agent channel interactions", () => {
  function toolCallStream(toolCallId: string, toolName: string, input: unknown) {
    return simulateReadableStream({
      chunks: [
        { type: "tool-input-start", id: toolCallId, toolName },
        { type: "tool-input-delta", id: toolCallId, delta: JSON.stringify(input) },
        { type: "tool-input-end", id: toolCallId },
        { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
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
  }

  it("resumes a pending tool from an interaction callback and finalizes the controls", async () => {
    const TC = "tc_approve_1";
    const requestApproval = tool({
      description: "Request human approval before acting.",
      inputSchema: z.object({ action: z.string() }),
    });

    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream:
          call++ === 0
            ? toolCallStream(TC, "requestApproval", { action: "refund" })
            : textStream("refund issued"),
      }),
    });

    const channel = recordingChannelConnector<{ text?: string; callback?: boolean }>({
      renderInteraction: (pending) => ({
        text: `Approve ${(pending[0]!.input as { action: string }).action}?`,
      }),
      onInteraction: (event) =>
        event?.callback ? { toolCallId: TC, output: { approved: true } } : null,
    });

    const agent = chat.agent({
      id: "chatChannels.hitl-resolve",
      channels: [channel],
      run: async ({ messages, signal }) =>
        streamText({ model, messages, tools: { requestApproval }, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-hitl-1" });
    try {
      await harness.sendChannelEvent({ event: { text: "please refund", threadId: "chan-hitl-1" } });
      expect(channel.finalText()).toBe("Approve refund?");
      expect(channel.finalized).toHaveLength(0);

      await harness.sendChannelEvent({ event: { callback: true } });
      expect(channel.finalized).toHaveLength(1);
      expect(channel.finalText()).toBe("refund issued");
    } finally {
      await harness.close();
    }
  });

  it("drops a stale interaction callback and runs no turn", async () => {
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        return { stream: textStream("should not run") };
      },
    });

    const interactionEvents: unknown[] = [];
    const channel = recordingChannelConnector<{ text?: string; callback?: boolean }>({
      onInteraction: (event) => {
        interactionEvents.push(event);
        return event?.callback ? { toolCallId: "does-not-exist", output: {} } : null;
      },
    });

    const agent = chat.agent({
      id: "chatChannels.hitl-stale",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-hitl-2" });
    try {
      await harness.deliverChannelEvent({ event: { callback: true } });

      expect(interactionEvents).toHaveLength(1);
      expect(modelCalls).toBe(0);
      expect(channel.sent).toHaveLength(0);
      expect(channel.finalized).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe("makeChannelStreamEditor", () => {
  function streamConnector(send: (message: { text: string }) => Promise<{ ref?: string }>) {
    return { delivery: "stream" as const, send } as never;
  }

  it("re-arms the debounce timer so text buffered during an in-flight edit still lands", async () => {
    vi.useFakeTimers();
    try {
      const sends: string[] = [];
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let call = 0;
      const editor = __makeChannelStreamEditorForTests(
        streamConnector(async (message) => {
          sends.push(message.text);
          call += 1;
          if (call === 1) await firstGate;
          return { ref: "r1" };
        }),
        { event: {}, deliveryId: "d1" },
        "r1"
      );

      editor.observe({ type: "text-delta", delta: "a" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sends).toEqual(["a"]);

      editor.observe({ type: "text-delta", delta: "b" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sends).toEqual(["a"]);

      releaseFirst();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sends).toEqual(["a", "ab"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire a pending edit after stop()", async () => {
    vi.useFakeTimers();
    try {
      const sends: string[] = [];
      const editor = __makeChannelStreamEditorForTests(
        streamConnector(async (message) => {
          sends.push(message.text);
          return { ref: "r1" };
        }),
        { event: {}, deliveryId: "d1" },
        "r1"
      );

      editor.observe({ type: "text-delta", delta: "a" });
      editor.stop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(sends).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("makeChannelStreamTap", () => {
  it("stops the editor when the stream completes (flush)", async () => {
    let stops = 0;
    const tap = __makeChannelStreamTapForTests({ observe: () => {}, stop: () => (stops += 1) });
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-delta", delta: "x" });
        controller.close();
      },
    });
    const reader = source.pipeThrough(tap).getReader();
    let done = false;
    while (!done) {
      done = (await reader.read()).done;
    }
    expect(stops).toBeGreaterThan(0);
  });

  it("stops the editor when the stream is cancelled mid-flight (abort)", async () => {
    let stops = 0;
    const tap = __makeChannelStreamTapForTests({ observe: () => {}, stop: () => (stops += 1) });
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-delta", delta: "x" });
      },
    });
    const reader = source.pipeThrough(tap).getReader();
    await reader.read();
    await reader.cancel("aborted");
    expect(stops).toBeGreaterThan(0);
  });
});
