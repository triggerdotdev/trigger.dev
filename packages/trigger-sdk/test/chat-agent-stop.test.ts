// Import the test harness FIRST — this installs the resource catalog so
// `chat.agent()` calls below register their task functions correctly.
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

function slowModel() {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-start", id: "t1" },
    ...["one", " two", " three", " four"].map((delta) => ({
      type: "text-delta" as const,
      id: "t1",
      delta,
    })),
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
    },
  ];
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 200 }),
    }),
  });
}

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("chat.agent stop", () => {
  it("ends a returned streamText turn without an error chunk and keeps the run alive", async () => {
    const agent = chat.agent({
      id: "stop.returned-stream-text",
      run: async ({ messages, signal }) =>
        streamText({
          ...chat.toStreamTextOptions(),
          model: slowModel(),
          messages,
          abortSignal: signal,
        }),
    });

    const harness = mockChatAgent(agent, { chatId: "stop-returned" });
    try {
      const stopped = harness.sendMessage(userMessage("hi", "u-1"));
      await waitFor(() => harness.allChunks.some((c) => c.type === "text-delta"));
      await harness.sendStop();
      const { chunks } = await stopped;

      expect(chunks.filter((c) => c.type === "error")).toEqual([]);

      const next = await harness.sendMessage(userMessage("again", "u-2"));
      expect(next.chunks.filter((c) => c.type === "error")).toEqual([]);
      expect(next.chunks.some((c) => c.type === "finish")).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("still reports a real error that run() throws after a stop", async () => {
    let runStarted = false;
    const agent = chat.agent({
      id: "stop.error-after-stop",
      run: async ({ signal }) => {
        runStarted = true;
        if (!signal.aborted) {
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        }
        throw new Error("db write failed");
      },
    });

    const harness = mockChatAgent(agent, { chatId: "stop-error-after" });
    try {
      const turn = harness.sendMessage(userMessage("hi", "u-1"));
      await waitFor(() => runStarted);
      await harness.sendStop();
      const { chunks } = await turn;

      expect(chunks.filter((c) => c.type === "error")).toEqual([
        { type: "error", errorText: "db write failed" },
      ]);
    } finally {
      await harness.close();
    }
  });
});
