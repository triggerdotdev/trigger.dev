import { mockChatAgent } from "../src/v3/test/index.js";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { chat } from "../src/v3/ai.js";

/**
 * The docs call `streamText({ ...chat.toStreamTextOptions() })` equivalent to
 * the `streamText` handed to `run()`. That holds only if the agent-level
 * options (`system`, `registry`, `cacheControl`, `systemProviderOptions`)
 * reach the helper too, not just the bound function.
 */
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

describe("chat.toStreamTextOptions with agent-level options", () => {
  it("carries chat.agent({ system }) in the spread form", async () => {
    const prompts: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        prompts.push(JSON.stringify(prompt));
        return {
          stream: simulateReadableStream({ chunks: textChunks("ok"), initialDelayInMs: 5 }),
        };
      },
    });
    const agent = chat.agent({
      id: "spread-form-agent-system",
      system: "AGENT-SYSTEM-VIA-SPREAD",
      run: async ({ messages, signal }) =>
        streamText({ model, messages, abortSignal: signal, ...chat.toStreamTextOptions() }),
    });
    const harness = mockChatAgent(agent, { chatId: "spread-form-agent-system" });
    try {
      await harness.sendMessage({ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] });
      expect(prompts.at(-1)!).toContain("AGENT-SYSTEM-VIA-SPREAD");
    } finally {
      await harness.close();
    }
  });
});
