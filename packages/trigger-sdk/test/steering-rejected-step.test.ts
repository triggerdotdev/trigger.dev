import { mockChatAgent } from "../src/v3/test/index.js";

import { sessionStreams } from "@trigger.dev/core/v3";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * A step that AI SDK rejects before the model is called, after a steer was drained.
 *
 * A caller that opts back into AI SDK 7's strict default
 * (`allowSystemInMessages: false`) gets an invalid-prompt error for the system-role
 * steer. The turn has to end and say it failed, rather than complete as if it had
 * finished normally. AI SDK 5 and 6 accept system messages, so nothing is rejected
 * there and the test runs on AI SDK 7 only.
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
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
async function waitFor(check: () => boolean, label = "condition", timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
}
const toolCallChunks = (callId: string): LanguageModelV3StreamPart[] => [
  { type: "tool-call", toolCallId: callId, toolName: "gate", input: JSON.stringify({ q: "go" }) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: USAGE },
];
type SeqReader = { lastSeqNum: (chatId: string, dir: "in" | "out") => number | undefined };
async function sendAndLand(
  harness: { sendMessage: (m: ReturnType<typeof userMessage>) => Promise<unknown> },
  chatId: string,
  text: string,
  id: string
) {
  const seqs = sessionStreams as unknown as SeqReader;
  const before = seqs.lastSeqNum(chatId, "in") ?? -1;
  void harness.sendMessage(userMessage(text, id));
  await waitFor(() => (seqs.lastSeqNum(chatId, "in") ?? -1) > before, `append ${id}`);
}

describe("chat.agent when a step is rejected after a steer", () => {
  // Catches: a step rejected before the model call (an invalid prompt) ending the
  // turn with no finishReason, instead of "error", so callers cannot branch on it.
  it.skipIf(process.env.AI_SDK_MAJOR !== "7")(
    "ends the turn with finishReason error instead of never completing",
    {
      timeout: 30_000,
    },
    async () => {
      const chatId = "steer-rejected-step";
      const toolGate = deferred();
      let toolEntered = false;
      const completed: { finishReason?: string }[] = [];

      const gateTool = tool({
        description: "blocks until the test opens it",
        inputSchema: z.object({ q: z.string() }),
        execute: async () => {
          toolEntered = true;
          await toolGate.promise;
          return "ok";
        },
      });

      const model = new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: toolCallChunks("tc-1"),
            initialDelayInMs: 10,
            chunkDelayInMs: 2,
          }),
        }),
      });

      const agent = chat.agent({
        id: "steer-rejected-step",
        pendingMessages: {
          shouldInject: () => true,
          prepare: async ({ messages }) => [
            {
              role: "system",
              content: `[OPERATOR-NOTE] ${messages
                .map((m) => (m.parts as { text?: string }[]).map((p) => p.text ?? "").join(""))
                .join(" ")}`,
            },
          ],
        },
        onTurnComplete: async ({ finishReason }) => {
          completed.push({ finishReason });
        },
        run: async ({ messages, signal }) =>
          streamText({
            model,
            messages,
            abortSignal: signal,
            ...chat.toStreamTextOptions(),
            // Only AI SDK 7 types this option, and this test only runs there.
            ...({ allowSystemInMessages: false } as object),
            tools: { gate: gateTool },
            stopWhen: stepCountIs(5),
          }),
      });

      const harness = mockChatAgent(agent, { chatId });
      try {
        void harness.sendMessage(userMessage("m1", "u-1"));
        await waitFor(() => toolEntered, "tool entered");
        await sendAndLand(harness, chatId, "steer-me", "u-2");
        toolGate.resolve();

        await waitFor(() => completed.length >= 1, "turn complete fired");
        expect(completed[0]!.finishReason).toBe("error");
      } finally {
        toolGate.resolve();
        await harness.close();
      }
    }
  );

  // Catches: a caller prepareStep that throws on the first step ending the turn
  // with no finishReason (or a stale one) instead of "error" on the automatic pipe.
  it(
    "ends the turn with finishReason error when a prepareStep throws on step 1",
    {
      timeout: 30_000,
    },
    async () => {
      const completed: { finishReason?: string }[] = [];
      const model = new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "hi" },
              { type: "text-end", id: "t1" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
            ] as LanguageModelV3StreamPart[],
          }),
        }),
      });

      const agent = chat.agent({
        id: "step-throws",
        onTurnComplete: async ({ finishReason }) => {
          completed.push({ finishReason });
        },
        run: async ({ messages, signal }) =>
          streamText({
            model,
            messages,
            abortSignal: signal,
            ...chat.toStreamTextOptions(),
            prepareStep: async () => {
              throw new Error("step rejected");
            },
            stopWhen: stepCountIs(3),
          }),
      });

      const harness = mockChatAgent(agent, { chatId: "step-throws" });
      try {
        void harness.sendMessage(userMessage("m1", "u-1"));
        await waitFor(() => completed.length >= 1, "turn complete fired");
        expect(completed[0]!.finishReason).toBe("error");
      } finally {
        await harness.close();
      }
    }
  );
});
