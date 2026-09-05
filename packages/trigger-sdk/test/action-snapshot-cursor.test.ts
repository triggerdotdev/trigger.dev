// Import the test harness FIRST — installs the resource catalog so
// `chat.agent()` below registers its task functions correctly.
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

describe("the snapshot an action writes", () => {
  it("keeps the resume cursor the last turn established", async () => {
    const agent = chat.agent({
      id: "action-snapshot-cursor",
      actionSchema: z.discriminatedUnion("type", [z.object({ type: z.literal("undo") })]),
      onAction: async ({ action }) => {
        if (action.type === "undo") chat.history.slice(0, -2);
      },
      run: async ({ messages, signal }) =>
        streamText({
          model: new MockLanguageModelV3({
            doStream: async () => ({ stream: textStream("answer") }),
          }),
          messages,
          abortSignal: signal,
        }),
    });

    const harness = mockChatAgent(agent, { chatId: "action-snapshot-cursor" });

    try {
      await harness.sendMessage({
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "first" }],
      });
      await new Promise((r) => setTimeout(r, 30));

      const afterTurn = harness.getSnapshot();
      expect(afterTurn?.lastOutEventId).toBeDefined();

      await harness.sendAction({ type: "undo" });
      await new Promise((r) => setTimeout(r, 30));

      const afterAction = harness.getSnapshot();

      /**
       * An action has no turn cursor of its own. Writing the snapshot with
       * `lastOutEventId: undefined` would drop the resume point the last turn
       * established, and the next boot would replay from further back to rebuild
       * what it could have read — so an action's write has to be cursor-neutral.
       */
      expect(afterAction?.lastOutEventId).toBe(afterTurn?.lastOutEventId);

      // And the mutation itself landed, which is the point of writing at all.
      expect(afterAction?.messages ?? []).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
