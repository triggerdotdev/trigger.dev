import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, streamText, tool } from "ai";
import type { UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * A tool-approval continuation after compaction.
 *
 * Compaction is model-only: the model lane becomes a summary while the UI
 * lane keeps everything. A tool-approval response arrives as an update to the
 * existing assistant message, and that path rebuilds the model lane from the
 * UI lane. The summary is replaced by the full transcript, and the message
 * compaction had removed is sent to the model again.
 */

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
  totalTokens: 2,
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
const textChunks = (text: string): LanguageModelV3StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
];
const approvalToolCall = (callId: string): LanguageModelV3StreamPart[] => [
  {
    type: "tool-call",
    toolCallId: callId,
    toolName: "risky",
    input: JSON.stringify({ what: "x" }),
  },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: USAGE },
];

describe("a tool-approval turn after compaction", () => {
  it("keeps the summary in the model lane", { timeout: 30_000 }, async () => {
    const prompts: string[] = [];
    const turns: UIMessage[][] = [];
    let compacted = 0;

    const risky = tool({
      description: "needs a human to approve",
      inputSchema: z.object({ what: z.string() }),
      needsApproval: true,
      execute: async () => "done",
    });

    let step = 0;
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        prompts.push(JSON.stringify(prompt));
        const n = step++;
        // turn 0 answers; turn 1 asks for approval; the continuation answers.
        const chunks = n === 1 ? approvalToolCall("tc-1") : textChunks(`answer-${n}`);
        return { stream: simulateReadableStream({ chunks, initialDelayInMs: 5 }) };
      },
    });

    const agent = chat.agent({
      id: "hitl-uncompacts",
      compaction: {
        // Compact once, between turns 0 and 1.
        shouldCompact: ({ source }) => source === "outer" && compacted === 0,
        summarize: async () => {
          compacted++;
          return "SUMMARY-OF-EVERYTHING";
        },
      },
      onTurnComplete: async ({ uiMessages }) => {
        turns.push(uiMessages.map((m) => structuredClone(m)));
      },
      run: async ({ messages, signal }) =>
        streamText({
          model,
          messages,
          abortSignal: signal,
          tools: { risky },
          ...chat.toStreamTextOptions(),
        }),
    });

    const harness = mockChatAgent(agent, { chatId: "hitl-uncompacts" });
    try {
      await harness.sendMessage(userMessage("EARLY-SENTINEL", "u-1"));
      await waitFor(() => turns.length >= 1 && compacted > 0, "turn 0 + compaction");

      await harness.sendMessage(userMessage("please do the risky thing", "u-2"));
      await waitFor(() => turns.length >= 2, "turn 1 (approval requested)");

      // The summary is in force going into the approval turn.
      expect(prompts.at(-1)!).toContain("SUMMARY-OF-EVERYTHING");
      expect(prompts.at(-1)!).not.toContain("EARLY-SENTINEL");

      // Approve, as the browser would: a slim update to the existing assistant.
      const head = turns.at(-1)!.at(-1)!;
      const part = (
        head.parts as {
          type: string;
          toolCallId?: string;
          state?: string;
          approval?: { id: string };
        }[]
      ).find((p) => p.type === "tool-risky");
      expect(part?.state).toBe("approval-requested");
      // sendMessage resolves at turn-complete, so the continuation's prompt is
      // recorded by the time it returns; capture the index first.
      const promptsBefore = prompts.length;
      await harness.sendMessage({
        id: head.id,
        role: "assistant",
        parts: [
          {
            type: "tool-risky",
            toolCallId: part!.toolCallId!,
            state: "approval-responded",
            approval: { id: part!.approval!.id, approved: true },
          },
        ],
      } as unknown as UIMessage);
      // The continuation has to run against the compacted lane, not the
      // whole transcript that compaction had already replaced.
      const cont = prompts[promptsBefore]!;
      expect(cont).toContain("SUMMARY-OF-EVERYTHING");
      expect(cont).not.toContain("EARLY-SENTINEL");

      // And the turn after it: the continuation's own response is committed by
      // replacing the approval-requested assistant, and that path must not
      // reconvert the lane either.
      const promptsBeforeNext = prompts.length;
      await harness.sendMessage(userMessage("and then?", "u-3"));
      const next = prompts[promptsBeforeNext]!;
      expect(next).toContain("SUMMARY-OF-EVERYTHING");
      expect(next).not.toContain("EARLY-SENTINEL");
    } finally {
      await harness.close();
    }
  });
});
