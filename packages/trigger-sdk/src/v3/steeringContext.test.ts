import { simulateReadableStream, stepCountIs, streamText, tool, type ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { retainStepMessages } from "./steeringContext.js";
import { withToolResultsInCallOrder } from "./toolResultOrder.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const toolName = (id: string) => id.split("-")[0]!;

const toolCalls = (ids: string[]): LanguageModelV3StreamPart[] => [
  ...ids.map((id): LanguageModelV3StreamPart => ({
    type: "tool-call",
    toolCallId: id,
    toolName: toolName(id),
    input: "{}",
  })),
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];

const answer: LanguageModelV3StreamPart[] = [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "done" },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
];

function toolResultIds(prompt: LanguageModelV3Prompt): string[] {
  return prompt.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : []))
      : []
  );
}

const handedOver = (ids: string[]): ModelMessage[] => [
  { role: "user", content: "is it working again?" },
  {
    role: "assistant",
    content: [
      ...ids.map((id) => ({
        type: "tool-call" as const,
        toolCallId: id,
        toolName: toolName(id),
        input: {},
      })),
      ...ids.map((id, i) => ({
        type: "tool-approval-request" as const,
        approvalId: `handover-approval-${i + 1}`,
        toolCallId: id,
      })),
    ],
  },
  {
    role: "tool",
    content: ids.map((_, i) => ({
      type: "tool-approval-response" as const,
      approvalId: `handover-approval-${i + 1}`,
      approved: true,
    })),
  },
];

describe("retainStepMessages after a head-start handover", () => {
  it("sends each handed-over tool result once when parallel results finish out of call order", async () => {
    const delayed = (ms: number) =>
      tool({
        inputSchema: z.object({}),
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, ms));
          return { ms };
        },
      });

    const prompts: LanguageModelV3Prompt[] = [];
    const responses = [toolCalls(["runs-2", "errors-2"]), answer];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        prompts.push(prompt);
        const chunks = responses[prompts.length - 1] ?? answer;
        return { stream: simulateReadableStream({ chunks }) };
      },
    });

    const result = streamText({
      model,
      messages: handedOver(["runs-1", "errors-1"]),
      tools: { runs: delayed(30), errors: delayed(1) },
      stopWhen: stepCountIs(4),
      prepareStep: retainStepMessages(async ({ messages }) => {
        const ordered = withToolResultsInCallOrder(messages);
        return ordered !== messages ? { messages: ordered } : undefined;
      }),
    });
    await result.consumeStream();

    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      const ids = toolResultIds(prompt);
      expect(ids).toEqual([...new Set(ids)]);
    }
    expect(toolResultIds(prompts[1]!)).toEqual(["runs-1", "errors-1", "runs-2", "errors-2"]);
  });
});
