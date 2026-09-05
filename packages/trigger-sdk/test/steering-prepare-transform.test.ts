import { mockChatAgent } from "../src/v3/test/index.js";

import { sessionStreams } from "@trigger.dev/core/v3";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * `pendingMessages.prepare` decides how a steer is presented to the model.
 * The steered turn gets that form. Later turns have to get the same form,
 * or the model's memory of the instruction differs from what it acted on.
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
const textChunks = (text: string): LanguageModelV3StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
];
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

describe("a steer transformed by pendingMessages.prepare", () => {
  it("reaches later turns in the transformed form", { timeout: 30_000 }, async () => {
    const chatId = "steer-prepare-transform";
    const toolGate = deferred();
    let toolEntered = false;
    const prompts: string[] = [];
    const newModelDeltas: string[] = [];

    const gateTool = tool({
      description: "blocks until the test opens it",
      inputSchema: z.object({ q: z.string() }),
      execute: async () => {
        toolEntered = true;
        await toolGate.promise;
        return "ok";
      },
    });

    let step = 0;
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        prompts.push(JSON.stringify(prompt));
        const isToolStep = step++ % 2 === 0;
        return {
          stream: simulateReadableStream({
            chunks: isToolStep ? toolCallChunks(`tc-${step}`) : textChunks("done"),
            initialDelayInMs: 10,
            chunkDelayInMs: 2,
          }),
        };
      },
    });

    const agent = chat.agent({
      id: "steer-prepare-transform",
      pendingMessages: {
        shouldInject: () => true,
        // Present the steer to the model as an operator note, not a user turn.
        prepare: async ({ messages }) => [
          {
            role: "system",
            content: `[OPERATOR-NOTE] ${messages.map((m) => (m.parts as { text?: string }[]).map((p) => p.text ?? "").join("")).join(" ")}`,
          },
        ],
      },
      onTurnComplete: async ({ newMessages }) => {
        newModelDeltas.push(JSON.stringify(newMessages));
      },
      run: async ({ messages, signal }) =>
        streamText({
          model,
          messages,
          abortSignal: signal,
          ...chat.toStreamTextOptions(),
          tools: { gate: gateTool },
          stopWhen: stepCountIs(5),
        }),
    });

    const harness = mockChatAgent(agent, { chatId });
    try {
      const first = harness.sendMessage(userMessage("m1", "u-1"));
      await waitFor(() => toolEntered, "tool entered");
      await sendAndLand(harness, chatId, "steer-me", "u-2");
      toolGate.resolve();
      await first;
      await waitFor(() => prompts.length >= 2, "turn 1 second step");

      // The steered turn saw the transformed form.
      expect(prompts[1]!).toContain("[OPERATOR-NOTE] steer-me");
      const promptsAfterTurn1 = prompts.length;

      await harness.sendMessage(userMessage("m3", "u-3"));
      await waitFor(() => prompts.length > promptsAfterTurn1, "turn 2 prompt built");

      // And so does the next one. Reconverting the UI message gives the raw
      // user turn instead, so the model remembers a different instruction
      // from the one it acted on.
      expect(prompts[promptsAfterTurn1]!).toContain("[OPERATOR-NOTE] steer-me");

      // The per-turn model delta the hook reports carries it in the same form,
      // or append-only persistence from `newMessages` loses the model's view.
      expect(newModelDeltas[0]!).toContain("[OPERATOR-NOTE] steer-me");
    } finally {
      toolGate.resolve();
      await harness.close();
    }
  });
});
