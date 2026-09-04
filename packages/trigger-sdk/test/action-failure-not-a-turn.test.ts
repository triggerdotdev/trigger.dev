import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * An action whose stream fails is still an action, not a turn.
 *
 * Reporting the failure by throwing lands in the shared turn-error path,
 * which fires `onTurnComplete`, advances the turn counter and consumes the
 * one-shot instruction lane, none of which an action is supposed to do. The
 * failure still has to be reported to the client and the partial kept.
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

describe("an action whose stream fails", () => {
  it("is reported without being counted as a turn", { timeout: 30_000 }, async () => {
    const turnCompletes: { turn: number; finishReason?: string }[] = [];
    const turnPrompts: string[] = [];

    const turnModel = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        turnPrompts.push(JSON.stringify(prompt));
        return {
          stream: simulateReadableStream({ chunks: textChunks("answer"), initialDelayInMs: 5 }),
        };
      },
    });
    const failingActionModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          pull(c) {
            c.error(new Error("provider exploded mid-stream"));
          },
        }),
      }),
    });

    const agent = chat.agent({
      id: "action-failure-not-a-turn",
      actionSchema: z.discriminatedUnion("type", [z.object({ type: z.literal("regenerate") })]),
      onTurnComplete: async ({ turn, finishReason }) => {
        turnCompletes.push({ turn, finishReason });
        // Injected after turn 0, meant for the next real turn.
        if (turn === 0)
          chat.inject([{ role: "system", content: "INSTRUCTION-FOR-NEXT-TURN" }] as never);
      },
      onAction: async ({ action, messages }) => {
        if (action.type !== "regenerate") return;
        chat.history.slice(0, -1);
        return streamText({ model: failingActionModel, messages, ...chat.toStreamTextOptions() });
      },
      run: async ({ messages, signal }) =>
        streamText({
          model: turnModel,
          messages,
          abortSignal: signal,
          ...chat.toStreamTextOptions(),
        }),
    });

    const harness = mockChatAgent(agent, { chatId: "action-failure-not-a-turn" });
    try {
      await harness.sendMessage(userMessage("m1", "u-1"));
      await waitFor(() => turnCompletes.length >= 1, "turn 0");

      await harness.sendAction({ type: "regenerate" }).catch(() => {});
      await new Promise((r) => setTimeout(r, 200));

      // The failure reached the client.
      const errors = (harness.allRawChunks as { type?: string }[]).filter(
        (c) => c.type === "error"
      );
      expect(errors.length).toBeGreaterThan(0);

      // But it was not a turn: no turn lifecycle for it.
      expect(turnCompletes).toHaveLength(1);

      await harness.sendMessage(userMessage("m2", "u-2"));
      await waitFor(() => turnCompletes.length >= 2, "turn 1");

      // The next real turn is turn 1, not turn 2, and it still gets the
      // instruction the failed action must not have consumed.
      expect(turnCompletes[1]!.turn).toBe(1);
      expect(turnPrompts.at(-1)!).toContain("INSTRUCTION-FOR-NEXT-TURN");
    } finally {
      await harness.close();
    }
  });
});
