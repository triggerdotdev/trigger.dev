import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { OutOfMemoryError } from "@trigger.dev/core/v3";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * The run loop writes `trigger:turn-complete` BEFORE it runs `onTurnComplete`, so a harness turn
 * method that resolved on that chunk alone returned while the hook was still running. A test that
 * asserts what the hook persisted had to sleep first. The harness now also waits for the loop to
 * finish its post-turn hooks, so these assertions run straight after the `await`, with no sleep.
 */

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const textChunks = (text: string): LanguageModelV3StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
];
const userMessage = (text: string, id: string) => ({
  id,
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});
const slow = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

function modelAnswering(text: string) {
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: textChunks(text) }) }),
  });
}

describe("mockChatAgent turn methods and post-turn hooks", () => {
  // Catches: a harness turn method that resolves on the turn-complete chunk while an async
  // onTurnComplete is still running, so the test reads state the hook has not written yet.
  it("sendMessage resolves after an async onTurnComplete has finished", async () => {
    const model = modelAnswering("hello");
    const persisted: string[] = [];
    const agent = chat.agent({
      id: "post-turn-settled-message",
      onTurnComplete: async ({ chatId }) => {
        await slow();
        persisted.push(chatId);
      },
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "post-turn-settled-message-chat" });
    try {
      await harness.sendMessage(userMessage("hi", "u-1"));
      expect(persisted).toEqual(["post-turn-settled-message-chat"]);
    } finally {
      await harness.close();
    }
  });

  // Catches: the same early return on a turn that fails, whose error-path onTurnComplete also runs
  // after the turn-complete chunk.
  it("sendMessage resolves after the error-path onTurnComplete has finished", async () => {
    const failing = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error("model down");
      },
    });
    const persisted: string[] = [];
    const agent = chat.agent({
      id: "post-turn-settled-error",
      onTurnComplete: async ({ chatId }) => {
        await slow();
        persisted.push(chatId);
      },
      run: async ({ messages, signal }) =>
        streamText({ model: failing, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "post-turn-settled-error-chat" });
    try {
      await harness.sendMessage(userMessage("hi", "u-1"));
      expect(persisted).toEqual(["post-turn-settled-error-chat"]);
    } finally {
      await harness.close();
    }
  });

  // Catches: a throw that ends the run while the post-turn latch is open, which would leave the
  // harness waiting out its 10s timeout and report "did not settle" instead of the run's error.
  it("sendMessage surfaces the error that ended the run, not the latch timeout", async () => {
    const agent = chat.agent({
      id: "post-turn-settled-run-ends",
      onTurnComplete: async () => {
        throw new OutOfMemoryError();
      },
      run: async ({ messages, signal }) =>
        streamText({ model: modelAnswering("x"), messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "post-turn-settled-run-ends-chat" });
    try {
      const started = Date.now();
      await expect(harness.sendMessage(userMessage("hi", "u-1"))).rejects.toBeInstanceOf(
        OutOfMemoryError
      );
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await harness.close().catch(() => {});
    }
  });

  // Catches: an OutOfMemoryError escaping the turn loop with the post-turn latch still open, which
  // leaves a stale module-level entry that makes a later harness for the same chat wait out its
  // 10s timeout on its first action.
  it("a later harness for the same chat is not blocked by a latch an OutOfMemoryError left open", async () => {
    const chatId = "post-turn-settled-oom-stale-chat";
    const oomAgent = chat.agent({
      id: "post-turn-settled-oom-stale-a",
      onTurnComplete: async () => {
        throw new OutOfMemoryError();
      },
      run: async ({ messages, signal }) =>
        streamText({ model: modelAnswering("x"), messages, abortSignal: signal }),
    });
    const h1 = mockChatAgent(oomAgent, { chatId });
    try {
      await expect(h1.sendMessage(userMessage("hi", "u-1"))).rejects.toBeInstanceOf(
        OutOfMemoryError
      );
    } finally {
      await h1.close().catch(() => {});
    }

    const actionAgent = chat.agent({
      id: "post-turn-settled-oom-stale-b",
      actionSchema: z.object({ type: z.string() }),
      onAction: async () => {},
      run: async ({ messages, signal }) =>
        streamText({ model: modelAnswering("x"), messages, abortSignal: signal }),
    });
    const h2 = mockChatAgent(actionAgent, { chatId });
    try {
      // Before the fix this rejected with the harness's 10s settle error.
      await h2.sendAction({ type: "noop" });
    } finally {
      await h2.close().catch(() => {});
    }
  }, 30_000);

  // Catches: an action turn that never settles the post-turn latch, which would hang the harness
  // on every action. An action that starts no turn runs no post-turn hooks, so there is nothing to
  // wait for.
  it("sendAction on an action that starts no turn returns without a hook", async () => {
    let completed = 0;
    const agent = chat.agent({
      id: "post-turn-settled-action",
      actionSchema: z.object({ type: z.string() }),
      onAction: async () => {},
      onTurnComplete: async () => {
        await slow();
        completed++;
      },
      run: async ({ messages, signal }) =>
        streamText({ model: modelAnswering("x"), messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "post-turn-settled-action-chat" });
    try {
      await harness.sendAction({ type: "noop" });
      expect(completed).toBe(0);
    } finally {
      await harness.close();
    }
  });
});
