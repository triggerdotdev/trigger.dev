import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, stepCountIs, streamText, tool, type ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * A tool error is not a failed turn. Invalid tool input and a tool that throws are
 * reported to the model as an error result, which then answers, so the turn
 * finishes normally and `onTurnComplete` must not say `"error"`.
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
async function waitFor(check: () => boolean, label = "condition", timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function modelCallingToolWith(input: unknown) {
  let step = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const first = step++ === 0;
      const chunks: LanguageModelV3StreamPart[] = first
        ? [
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "lookup",
              input: JSON.stringify(input),
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage: USAGE,
            },
          ]
        : [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "recovered" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
          ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

async function runTurn(id: string, lookup: ToolSet[string], input: unknown) {
  const completed: { finishReason?: string }[] = [];
  const agent = chat.agent({
    id,
    onTurnComplete: async ({ finishReason }) => {
      completed.push({ finishReason });
    },
    run: async ({ messages, signal }) =>
      streamText({
        model: modelCallingToolWith(input),
        messages,
        abortSignal: signal,
        ...chat.toStreamTextOptions(),
        tools: { lookup },
        stopWhen: stepCountIs(5),
      }),
  });
  const harness = mockChatAgent(agent, { chatId: id });
  try {
    void harness.sendMessage(userMessage("m1", "u-1"));
    await waitFor(() => completed.length >= 1, "turn complete fired");
  } finally {
    await harness.close();
  }
  return completed[0]!.finishReason;
}

describe("chat.agent finishReason when a tool errors", () => {
  // Catches: a tool error (reported to the model, which then answers) being mistaken
  // for a failed stream, so a normal turn reports finishReason "error".
  it("does not report error for invalid tool input the model recovers from", async () => {
    const lookup = tool({
      description: "looks something up",
      inputSchema: z.object({ q: z.string() }),
      execute: async () => "found",
    });
    expect(await runTurn("tool-invalid-input", lookup, { q: 5 })).toBe("stop");
  });

  // Catches: the same, for a tool whose execute throws.
  it("does not report error for a tool that throws and the model recovers from", async () => {
    const lookup = tool({
      description: "looks something up",
      inputSchema: z.object({ q: z.string() }),
      execute: async (): Promise<string> => {
        throw new Error("lookup failed");
      },
    });
    expect(await runTurn("tool-throws", lookup, { q: "x" })).toBe("stop");
  });
});
