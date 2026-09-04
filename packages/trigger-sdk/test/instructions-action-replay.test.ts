import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * A one-shot instruction and an action in between.
 *
 * `turn--` marks an action as not-a-turn, so an action and the message after
 * it share a turn number. The consumed-instruction stash is keyed on that
 * number, so an action that builds options consumes the injection and the next
 * real turn reads the same stash back.
 */

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function userMessage(text: string, id: string) {
  return { id, role: "user" as const, parts: [{ type: "text" as const, text }] };
}

async function waitFor(check: () => boolean, label = "condition", timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function textChunks(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
  ];
}

describe("a one-shot instruction across an action", () => {
  it(
    "reaches each turn once and is not replayed by the turn after an action",
    { timeout: 30_000 },
    async () => {
      /** One entry per model call, in order, saying whether it carried the instruction. */
      const sawInstruction: { label: string; saw: boolean }[] = [];

      const makeModel = (label: string) =>
        new MockLanguageModelV3({
          doStream: async ({ prompt }) => {
            sawInstruction.push({
              label,
              saw: JSON.stringify(prompt).includes("INSTRUCTION-ONE-SHOT"),
            });
            return {
              stream: simulateReadableStream({ chunks: textChunks("ok"), initialDelayInMs: 5 }),
            };
          },
        });

      const turnModel = makeModel("turn");
      const actionModel = makeModel("action");

      const agent = chat.agent({
        id: "instructions-action-replay",
        actionSchema: z.discriminatedUnion("type", [z.object({ type: z.literal("ping") })]),
        onTurnComplete: async ({ turn }) => {
          // Injecting from inside the run, because the lane lives in run locals.
          if (turn === 0)
            chat.inject([{ role: "system", content: "INSTRUCTION-ONE-SHOT" }] as never);
        },
        onAction: async ({ action, streamText: bound }) => {
          if (action.type !== "ping") return;
          return bound({
            model: actionModel,
            messages: [{ role: "user", content: "regenerate" }],
          });
        },
        run: async ({ messages, signal, streamText: bound }) =>
          bound({ model: turnModel, messages, abortSignal: signal }),
      });

      const harness = mockChatAgent(agent, { chatId: "instructions-action-replay" });
      try {
        // Turn 1, nothing injected yet, then inject for the next turn.
        await harness.sendMessage(userMessage("m1", "u-1"));
        await waitFor(() => sawInstruction.length >= 1, "turn 1");

        // An action lands before the next message.
        await harness.sendAction({ type: "ping" });
        await waitFor(() => sawInstruction.length >= 2, "action");

        // Then the real turn the injection was meant for.
        await harness.sendMessage(userMessage("m2", "u-2"));
        await waitFor(() => sawInstruction.length >= 3, "turn 2");

        // And one more, which must not see it again.
        await harness.sendMessage(userMessage("m3", "u-3"));
        await waitFor(() => sawInstruction.length >= 4, "turn 3");

        const carriers = sawInstruction.filter((e) => e.saw).map((e) => e.label);
        // The action sees it: it is pending context, and an action is not a turn,
        // so the action reading it must not use it up.
        expect(sawInstruction[1]!).toEqual({ label: "action", saw: true });
        // And the turn it was actually injected for still gets it.
        expect(sawInstruction[2]!).toEqual({ label: "turn", saw: true });
        // The turn after that does not: one-shot means one turn.
        expect(sawInstruction[3]!).toEqual({ label: "turn", saw: false });
        // And it is never carried by more than one real turn.
        expect(carriers.filter((l) => l === "turn")).toHaveLength(1);
      } finally {
        await harness.close();
      }
    }
  );
});
