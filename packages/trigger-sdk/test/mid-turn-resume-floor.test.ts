import { mockChatAgent } from "../src/v3/test/index.js";

import { sessionStreams } from "@trigger.dev/core/v3";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { chat } from "../src/v3/ai.js";

function userMessage(text: string, id: string) {
  return { id, role: "user" as const, parts: [{ type: "text" as const, text }] };
}

function textStreamChunks(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
    },
  ];
}

/** Answers `ANSWER(<last user text>)` slowly enough for a record sent after the
 * turn starts to arrive mid-stream. */
function echoModel() {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const users = prompt.filter((m) => m.role === "user");
      const last = users[users.length - 1];
      const text = Array.isArray(last?.content)
        ? last.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("")
        : "";
      return {
        stream: simulateReadableStream({
          chunks: textStreamChunks(`ANSWER(${text})`),
          initialDelayInMs: 150,
          chunkDelayInMs: 10,
        }),
      };
    },
  });
}

function streamedText(harness: { allChunks: unknown[] }): string {
  return (harness.allChunks as { type?: string; delta?: string }[])
    .filter((c) => c.type === "text-delta")
    .map((c) => c.delta ?? "")
    .join("");
}

function turnCompletes(harness: { allRawChunks: unknown[] }) {
  return (harness.allRawChunks as { type?: string; sessionInEventId?: string }[]).filter(
    (c) => c.type === "trigger:turn-complete"
  );
}

async function waitFor(check: () => boolean, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

/**
 * A message that arrives while a turn is streaming, on an agent with no
 * `pendingMessages` config, is delivered to the turn's push handler and parked
 * in the in-memory wire buffer to become the next turn. The router treats a
 * record handed to a push handler as terminally decided, so it stops holding
 * the resume floor behind it, and the turn boundary then publishes a cursor
 * past a message that exists only in this process's memory.
 *
 * The cursor is the contract for what a later boot may skip. Publishing one
 * past an unanswered message means a crash between that boundary and the next
 * turn loses the message with nothing raised.
 */
describe("chat.agent resume floor with a message buffered mid-turn", () => {
  it("does not publish a resume cursor past a message that has not been answered", async () => {
    const chatId = "mid-turn-resume-floor";
    const agent = chat.agent({
      id: "mid-turn-resume-floor.agent",
      run: async ({ messages, signal }) =>
        streamText({ model: echoModel(), messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId });
    try {
      const firstTurn = harness.sendMessage(userMessage("m1", "u-1"));
      await waitFor(() => streamedText(harness).includes("ANSWER(m1)"));

      /**
       * m1's own record has already advanced the channel, so waiting for a
       * sequence to merely exist would pass on the first check and capture m1's
       * sequence instead of m2's. Wait for it to move.
       */
      const seqs = sessionStreams as unknown as SeqReader;
      const seqBeforeM2 = seqs.lastSeqNum(chatId, "in");
      void harness.sendMessage(userMessage("m2", "u-2"));
      await waitFor(() => {
        const now = seqs.lastSeqNum(chatId, "in");
        return now !== undefined && (seqBeforeM2 === undefined || now > seqBeforeM2);
      });
      const m2Seq = seqs.lastSeqNum(chatId, "in")!;
      expect(m2Seq).toBeGreaterThan(seqBeforeM2 ?? -1);
      await firstTurn;

      await waitFor(() => turnCompletes(harness).length >= 1);
      const firstBoundary = turnCompletes(harness)[0]!;
      expect(firstBoundary.sessionInEventId).toBeDefined();

      expect(Number(firstBoundary.sessionInEventId)).toBeLessThan(m2Seq);
    } finally {
      await harness.close();
    }
  });
});

type SeqReader = { lastSeqNum(sessionId: string, io: "in" | "out"): number | undefined };
