import { mockChatAgent } from "../src/v3/test/index.js";

import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { chat } from "../src/v3/ai.js";

describe("mockChatAgent and the turn markers", () => {
  it("keeps turn markers out of the raw chunks a test asserts on, and in outRecords", async () => {
    // Catches: the markers an agent writes ahead of each turn showing up in
    // `rawChunks` / `allRawChunks`, which breaks a customer test asserting the exact
    // raw sequence (`[..., "trigger:turn-complete"]`) after upgrading.
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "hi" },
            { type: "text-end", id: "t" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            },
          ] as never,
        }),
      }),
    });
    const agent = chat.agent({
      id: "mock-chat-agent-markers",
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "markers" });

    try {
      const turn = await harness.sendMessage({
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      } as never);
      const types = (chunks: unknown[]) => chunks.map((c) => (c as { type?: string }).type);

      expect(types(turn.rawChunks)).not.toContain("trigger:turn-start");
      expect(types(harness.allRawChunks)).not.toContain("trigger:turn-start");
      expect(types(turn.rawChunks).at(-1)).toBe("trigger:turn-complete");
      expect(harness.outRecords.some((r) => r.headers.some(([, v]) => v === "turn-start"))).toBe(
        true
      );
    } finally {
      await harness.close();
    }
  });
});
