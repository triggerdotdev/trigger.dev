import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * The snapshot cursor after a failed turn.
 *
 * The error path writes its snapshot with the failed turn's completion cursor
 * but does not update the shared cursor holder, so a later action's snapshot,
 * which is cursor-neutral and reuses the holder, writes the cursor from
 * BEFORE the failed turn. A continuation then resumes from there and replays
 * output the failed turn's snapshot had already superseded.
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
const textChunks = (text: string): LanguageModelV3StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
];
function erroringStream(): ReadableStream<LanguageModelV3StreamPart> {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "partial" },
  ];
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) return void c.enqueue(chunks[i++]!);
      c.error(new Error("UND_ERR_BODY_TIMEOUT"));
    },
  });
}

describe("the snapshot an action writes after a failed turn", () => {
  it("carries the failed turn's cursor, not the one before it", { timeout: 30_000 }, async () => {
    const completes: { finishReason?: string }[] = [];
    let step = 0;
    const model = new MockLanguageModelV3({
      doStream: async () =>
        step++ === 0
          ? { stream: simulateReadableStream({ chunks: textChunks("first"), initialDelayInMs: 5 }) }
          : { stream: erroringStream() },
    });

    const agent = chat.agent({
      id: "error-snapshot-cursor",
      actionSchema: z.discriminatedUnion("type", [z.object({ type: z.literal("undo") })]),
      onTurnComplete: async ({ finishReason }) => {
        completes.push({ finishReason });
      },
      onAction: async ({ action }) => {
        if (action.type === "undo") chat.history.slice(0, -2);
      },
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "error-snapshot-cursor" });
    try {
      await harness.sendMessage(userMessage("m1", "u-1"));
      await waitFor(() => harness.getSnapshot()?.lastOutEventId !== undefined, "turn 0 snapshot");
      const afterTurn0 = harness.getSnapshot()?.lastOutEventId;

      await harness.sendMessage(userMessage("m2", "u-2"));
      await waitFor(() => completes.length >= 2, "turn 1 (failed)");
      expect(completes[1]!.finishReason).toBe("error");
      await waitFor(
        () => harness.getSnapshot()?.lastOutEventId !== afterTurn0,
        "failed turn snapshot"
      );
      const afterFailedTurn = harness.getSnapshot()?.lastOutEventId;
      expect(afterFailedTurn).toBeDefined();
      // The failed turn moved the cursor: it wrote an error and a completion.
      expect(afterFailedTurn).not.toBe(afterTurn0);

      await harness.sendAction({ type: "undo" });
      await new Promise((r) => setTimeout(r, 60));

      // An action's write is cursor-neutral, so it has to keep the CURRENT
      // cursor, which is the failed turn's, not the one from before it.
      expect(harness.getSnapshot()?.lastOutEventId).toBe(afterFailedTurn);
    } finally {
      await harness.close();
    }
  });
});
