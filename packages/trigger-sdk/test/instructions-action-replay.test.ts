import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * One-shot instructions around actions.
 *
 * An action is a state edit and makes no model call, so it neither consumes
 * nor delays the instruction lane. One that returns `chat.turn()` IS the next
 * turn, so it consumes the lane the way any turn does.
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

function recordingModel(seen: { a: boolean; b: boolean }[]) {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const p = JSON.stringify(prompt);
      seen.push({ a: p.includes("INSTRUCTION-A"), b: p.includes("INSTRUCTION-B") });
      return { stream: simulateReadableStream({ chunks: textChunks("ok"), initialDelayInMs: 5 }) };
    },
  });
}

describe("one-shot instructions around an action", () => {
  it("an edit-only action neither consumes nor delays them", { timeout: 30_000 }, async () => {
    const seen: { a: boolean; b: boolean }[] = [];
    const model = recordingModel(seen);
    const agent = chat.agent({
      id: "instructions-edit-only-action",
      actionSchema: z.discriminatedUnion("type", [z.object({ type: z.literal("note") })]),
      onTurnComplete: async ({ turn }) => {
        if (turn === 0) chat.inject([{ role: "system", content: "INSTRUCTION-A" }] as never);
      },
      onAction: async ({ action }) => {
        if (action.type !== "note") return;
        // An action can add context for the next turn too.
        chat.inject([{ role: "system", content: "INSTRUCTION-B" }] as never);
      },
      run: async ({ messages, signal }) =>
        streamText({ model, messages, abortSignal: signal, ...chat.toStreamTextOptions() }),
    });
    const harness = mockChatAgent(agent, { chatId: "instructions-edit-only-action" });
    try {
      await harness.sendMessage(userMessage("m1", "u-1"));
      await waitFor(() => seen.length >= 1, "turn 0");
      await harness.sendAction({ type: "note" });
      await new Promise((r) => setTimeout(r, 60));
      // No model call for the action.
      expect(seen).toHaveLength(1);
      await harness.sendMessage(userMessage("m2", "u-2"));
      await waitFor(() => seen.length >= 2, "turn 1");
      await harness.sendMessage(userMessage("m3", "u-3"));
      await waitFor(() => seen.length >= 3, "turn 2");

      expect(seen[0]).toEqual({ a: false, b: false });
      // The next real turn gets both, on time.
      expect(seen[1]).toEqual({ a: true, b: true });
      // And only that turn.
      expect(seen[2]).toEqual({ a: false, b: false });
    } finally {
      await harness.close();
    }
  });

  it(
    "an action that returns chat.turn() is the turn that consumes them",
    { timeout: 30_000 },
    async () => {
      const seen: { a: boolean; b: boolean }[] = [];
      const model = recordingModel(seen);
      const agent = chat.agent({
        id: "instructions-action-turn",
        actionSchema: z.discriminatedUnion("type", [z.object({ type: z.literal("regenerate") })]),
        onTurnComplete: async ({ turn }) => {
          if (turn === 0) chat.inject([{ role: "system", content: "INSTRUCTION-A" }] as never);
        },
        onAction: async ({ action }) => {
          if (action.type !== "regenerate") return;
          chat.history.slice(0, -1);
          return chat.turn();
        },
        run: async ({ messages, signal }) =>
          streamText({ model, messages, abortSignal: signal, ...chat.toStreamTextOptions() }),
      });
      const harness = mockChatAgent(agent, { chatId: "instructions-action-turn" });
      try {
        await harness.sendMessage(userMessage("m1", "u-1"));
        await waitFor(() => seen.length >= 1, "turn 0");
        await harness.sendAction({ type: "regenerate" });
        await waitFor(() => seen.length >= 2, "the action's turn");
        await harness.sendMessage(userMessage("m2", "u-2"));
        await waitFor(() => seen.length >= 3, "the turn after");

        // The action's turn is the next turn, so it takes the instruction.
        expect(seen[1]).toEqual({ a: true, b: false });
        // One-shot: the turn after does not see it again.
        expect(seen[2]).toEqual({ a: false, b: false });
      } finally {
        await harness.close();
      }
    }
  );
});
