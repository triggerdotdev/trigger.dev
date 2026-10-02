import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * Parallel tool calls finish in whatever order they finish. The next turn's
 * history lists their results in call order, so the step that answers them has
 * to see call order too, or a model that binds its thinking to the exact history
 * finds the earlier turn changed under it.
 */

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const userMessage = (text: string, id: string) => ({
  id,
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});
const textChunks = (text: string): LanguageModelV3StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
];
const parallelCallChunks: LanguageModelV3StreamPart[] = [
  { type: "tool-call", toolCallId: "call_slow", toolName: "slow", input: "{}" },
  { type: "tool-call", toolCallId: "call_fast", toolName: "fast", input: "{}" },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: USAGE },
];

const tools = {
  slow: tool({
    description: "finishes second",
    inputSchema: z.object({}),
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return "slow result";
    },
  }),
  fast: tool({
    description: "finishes first",
    inputSchema: z.object({}),
    execute: async () => "fast result",
  }),
};

function toolResultOrder(prompt: LanguageModelV3Prompt): string[] {
  return prompt
    .filter((message) => message.role === "tool")
    .flatMap((message) =>
      message.content.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : []))
    );
}

function recordingModel(prompts: LanguageModelV3Prompt[]) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      prompts.push(prompt);
      const chunks = call++ === 0 ? parallelCallChunks : textChunks("done");
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

describe("parallel tool results", () => {
  it(
    "reach the answering step in call order, the order the next turn replays",
    { timeout: 30_000 },
    async () => {
      const prompts: LanguageModelV3Prompt[] = [];
      const model = recordingModel(prompts);
      const agent = chat.agent({
        id: "tool-result-order-spread",
        run: async ({ messages, signal }) =>
          streamText({
            ...chat.toStreamTextOptions({ tools }),
            model,
            messages,
            abortSignal: signal,
            stopWhen: stepCountIs(3),
          }),
      });

      const harness = mockChatAgent(agent, { chatId: "tool-result-order-spread" });
      try {
        await harness.sendMessage(userMessage("look both up", "u-1"));
        await harness.sendMessage(userMessage("and now?", "u-2"));

        expect(prompts).toHaveLength(3);
        expect(toolResultOrder(prompts[1]!)).toEqual(["call_slow", "call_fast"]);
        expect(toolResultOrder(prompts[2]!)).toEqual(toolResultOrder(prompts[1]!));
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "are ordered the same way through the streamText run() is given",
    { timeout: 30_000 },
    async () => {
      const prompts: LanguageModelV3Prompt[] = [];
      const model = recordingModel(prompts);
      const agent = chat.agent({
        id: "tool-result-order-bound",
        tools,
        run: async ({ messages, signal, streamText: boundStreamText }) =>
          boundStreamText({ model, messages, abortSignal: signal, stopWhen: stepCountIs(3) }),
      });

      const harness = mockChatAgent(agent, { chatId: "tool-result-order-bound" });
      try {
        await harness.sendMessage(userMessage("look both up", "u-1"));
        await harness.sendMessage(userMessage("and now?", "u-2"));

        expect(prompts).toHaveLength(3);
        expect(toolResultOrder(prompts[1]!)).toEqual(["call_slow", "call_fast"]);
        expect(toolResultOrder(prompts[2]!)).toEqual(toolResultOrder(prompts[1]!));
      } finally {
        await harness.close();
      }
    }
  );
});
