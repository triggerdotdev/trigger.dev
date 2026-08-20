// Import the test harness FIRST — installs the resource catalog so
// `chat.agent()` calls below register their task functions correctly.
import { mockChatAgent } from "../src/v3/test/index.js";

import { describe, expect, it } from "vitest";
import { chat } from "../src/v3/ai.js";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { z } from "zod";

function textStream(text: string): ReadableStream<LanguageModelV3StreamPart> {
  return simulateReadableStream({
    chunks: [
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: text },
      { type: "text-end", id: "t1" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 10, text: 10, reasoning: undefined },
        },
      },
    ],
  });
}

function agentWithUndo(id: string) {
  return chat.agent({
    id,
    actionSchema: z.discriminatedUnion("type", [z.object({ type: z.literal("undo") })]),
    onAction: async ({ action }) => {
      if (action.type === "undo") {
        // The documented way to roll history back — see /ai-chat/actions.
        chat.history.slice(0, -2);
      }
    },
    run: async ({ messages, signal }) =>
      streamText({
        model: new MockLanguageModelV3({ doStream: async () => ({ stream: textStream("answer") }) }),
        messages,
        abortSignal: signal,
      }),
  });
}

describe("snapshot durability of history mutated by an action", () => {
  it("persists an undo, so a continuation does not resurrect the undone turn", async () => {
    const harness = mockChatAgent(agentWithUndo("action-snapshot-undo"), {
      chatId: "action-snapshot-undo",
    });

    try {
      await harness.sendMessage({
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "first" }],
      });
      await new Promise((r) => setTimeout(r, 30));

      // After a turn the snapshot holds the exchange.
      expect(harness.getSnapshot()?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

      await harness.sendAction({ type: "undo" });
      await new Promise((r) => setTimeout(r, 30));

      /**
       * An action is not a turn, so it never reaches the turn-complete path where
       * the snapshot is written. The rollback lives in the accumulator only, and
       * the next continuation boots from a snapshot that still holds the undone
       * exchange — the user's undo silently reverts, minutes later, with no error.
       */
      expect(harness.getSnapshot()?.messages ?? []).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
