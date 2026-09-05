import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * A regenerate as an action that returns `chat.turn()`: the answer it produces
 * is a turn's answer, so it reaches the browser, the conversation and the
 * snapshot, and a failure part-way is a turn failure.
 */

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const textStream = (text: string) =>
  simulateReadableStream<LanguageModelV3StreamPart>({
    chunks: [
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: text },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
    ],
    initialDelayInMs: 5,
  });
const textOf = (m: { parts?: unknown[] }) =>
  ((m.parts ?? []) as { type: string; text?: string }[])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");

describe("a regenerate action that returns chat.turn()", () => {
  it("puts the new answer in the conversation in place of the old one", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: textStream(calls++ === 0 ? "first answer" : "regenerated answer"),
      }),
    });
    const agent = chat.agent({
      id: "action-turn-stream",
      actionSchema: z.discriminatedUnion("type", [z.object({ type: z.literal("regenerate") })]),
      onAction: async ({ action }) => {
        if (action.type !== "regenerate") return;
        chat.history.slice(0, -1);
        return chat.turn();
      },
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "action-turn-stream" });
    try {
      await harness.sendMessage({ id: "u1", role: "user", parts: [{ type: "text", text: "ask" }] });
      await new Promise((r) => setTimeout(r, 40));
      const before = harness.allRawChunks.length;
      await harness.sendAction({ type: "regenerate" });
      await new Promise((r) => setTimeout(r, 120));

      const streamed = (harness.allRawChunks.slice(before) as { type?: string; delta?: string }[])
        .filter((c) => c.type === "text-delta")
        .map((c) => c.delta ?? "")
        .join("");
      expect(streamed).toBe("regenerated answer");
      expect(harness.getSnapshot()?.messages.map((e) => textOf(e.message))).toEqual([
        "ask",
        "regenerated answer",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("reports a mid-stream failure as a turn failure and keeps the partial", async () => {
    let calls = 0;
    const failsMidStream = new MockLanguageModelV3({
      doStream: async () => {
        if (calls++ === 0) return { stream: textStream("first answer") };
        let stage = 0;
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            pull(controller) {
              if (stage === 0) {
                controller.enqueue({ type: "text-start", id: "t1" });
                stage++;
                return;
              }
              if (stage === 1) {
                controller.enqueue({ type: "text-delta", id: "t1", delta: "half an answer" });
                stage++;
                return;
              }
              controller.error(new Error("provider exploded mid-stream"));
            },
          }),
        };
      },
    });
    const completes: { finishReason?: string }[] = [];
    const agent = chat.agent({
      id: "action-turn-stream-error",
      actionSchema: z.discriminatedUnion("type", [z.object({ type: z.literal("regenerate") })]),
      onTurnComplete: async ({ finishReason }) => {
        completes.push({ finishReason });
      },
      onAction: async ({ action }) => {
        if (action.type !== "regenerate") return;
        chat.history.slice(0, -1);
        return chat.turn();
      },
      run: async ({ messages, signal }) =>
        streamText({ model: failsMidStream, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "action-turn-stream-error" });
    try {
      await harness.sendMessage({ id: "u1", role: "user", parts: [{ type: "text", text: "ask" }] });
      await new Promise((r) => setTimeout(r, 40));
      await harness.sendAction({ type: "regenerate" }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));

      const errors = (harness.allRawChunks as { type?: string }[]).filter(
        (c) => c.type === "error"
      );
      expect(errors.length).toBeGreaterThan(0);
      // A turn failure: the hook saw it, and the partial is kept, not discarded.
      expect(completes.at(-1)?.finishReason).toBe("error");
      const lastText = harness
        .getSnapshot()
        ?.messages.map((e) => textOf(e.message))
        .at(-1);
      expect(lastText).toContain("half an answer");
    } finally {
      await harness.close();
    }
  });
});
