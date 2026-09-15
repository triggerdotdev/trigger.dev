import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { chat } from "../src/v3/ai.js";

function userMessage(text: string, id: string) {
  return { id, role: "user" as const, parts: [{ type: "text" as const, text }] };
}

function textStream(text: string) {
  const chunks: LanguageModelV3StreamPart[] = [
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
  ];
  return simulateReadableStream({ chunks });
}

function lastUserText(prompt: unknown): string {
  const msgs = Array.isArray(prompt) ? prompt : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role?: string; content?: unknown };
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content))
      return (m.content as Array<{ text?: string }>).map((p) => p?.text ?? "").join("");
  }
  return "";
}

describe("TRI-13752: chat.agent version handover duplicates messages and turns", () => {
  it("effect #1: a continuation boot answers a handed-over session.in message exactly once", async () => {
    const answered: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        answered.push(lastUserText((options as { prompt?: unknown }).prompt));
        return { stream: textStream("ok") };
      },
    });
    const u1 = userMessage("the handed-over message", "u-1");
    const agent = chat.agent({
      id: "tri-13752.continuation-double-dispatch",
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, {
      chatId: "tri-13752-cont",
      continuation: true,
      previousRunId: "run_prior",
    });
    harness.seedSessionInTail([u1 as never]);
    try {
      await harness.deliverSessionInAtSeq(u1 as never, 1);
      await new Promise((r) => setTimeout(r, 200));
      const u1Answers = answered.filter((t) => t.includes("the handed-over message"));
      expect(u1Answers).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("N>1: the floor published after the first recovered turn must not cover the un-dispatched second message", async () => {
    const answered: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        answered.push(lastUserText((options as { prompt?: unknown }).prompt));
        return { stream: textStream("ok") };
      },
    });
    const u1 = userMessage("first in-flight", "u-1");
    const u2 = userMessage("second in-flight", "u-2");
    const agent = chat.agent({
      id: "tri-13752.n-gt-1-recovery-floor",
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, {
      chatId: "tri-13752-nrec",
      continuation: true,
      previousRunId: "run_prior",
    });
    harness.seedSessionInTail([u1 as never, u2 as never]);
    try {
      const deadline = Date.now() + 2000;
      while (
        harness.allRawChunks.filter(
          (c) => (c as { type?: string }).type === "trigger:turn-complete"
        ).length < 2 &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(answered.filter((t) => t.includes("first in-flight"))).toHaveLength(1);
      expect(answered.filter((t) => t.includes("second in-flight"))).toHaveLength(1);

      const firstTurnComplete = harness.allRawChunks.find(
        (c) => (c as { type?: string }).type === "trigger:turn-complete"
      ) as { sessionInEventId?: string } | undefined;
      const publishedFloor = Number(firstTurnComplete?.sessionInEventId);
      expect(publishedFloor).toBeLessThan(2);
    } finally {
      await harness.close();
    }
  });

  it("does not advance the resume cursor past a recovered message whose turn errors", async () => {
    const attempted: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("ok") }),
    });
    const u1 = userMessage("first in-flight", "u-1");
    const u2 = userMessage("second in-flight", "u-2");
    const agent = chat.agent({
      id: "tri-13752.recovered-turn-error-floor",
      run: async ({ messages, signal }) => {
        const text = lastUserText(messages);
        attempted.push(text);
        if (text.includes("second in-flight")) {
          throw new Error("boom on the second recovered turn");
        }
        return streamText({ model, messages, abortSignal: signal });
      },
    });
    const harness = mockChatAgent(agent, {
      chatId: "tri-13752-errfloor",
      continuation: true,
      previousRunId: "run_prior",
    });
    harness.seedSessionInTail([u1 as never, u2 as never]);
    try {
      const deadline = Date.now() + 2000;
      while (!attempted.some((t) => t.includes("second in-flight")) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 150));
      const persistedCursor = Number(harness.getSnapshot()?.lastInEventId);
      expect(persistedCursor).toBeLessThan(2);
    } finally {
      await harness.close();
    }
  });

  it("holds the resume cursor behind a duplicate-id recovered record dispatched via onRecoveryBoot", async () => {
    const answered: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        answered.push(lastUserText((options as { prompt?: unknown }).prompt));
        return { stream: textStream("ok") };
      },
    });
    const m1 = userMessage("first dup", "dup-id");
    const m2 = userMessage("second dup", "dup-id");
    const partial = {
      id: "a-partial",
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "partial" }],
    };
    const agent = chat.agent({
      id: "tri-13752.dup-id-hook-floor",
      onRecoveryBoot: async (event) =>
        ({
          chain: (event as { settledMessages: unknown[] }).settledMessages,
          recoveredTurns: [m1, m2],
        }) as never,
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, {
      chatId: "tri-13752-dupid",
      continuation: true,
      previousRunId: "run_prior",
    });
    harness.seedSessionInTail([m1 as never, m2 as never]);
    harness.seedSessionOutPartial(partial as never);
    try {
      const deadline = Date.now() + 2000;
      while (
        harness.allRawChunks.filter(
          (c) => (c as { type?: string }).type === "trigger:turn-complete"
        ).length < 2 &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const firstTurnComplete = harness.allRawChunks.find(
        (c) => (c as { type?: string }).type === "trigger:turn-complete"
      ) as { sessionInEventId?: string } | undefined;
      const publishedFloor = Number(firstTurnComplete?.sessionInEventId);
      expect(publishedFloor).toBeLessThan(2);
    } finally {
      await harness.close();
    }
  });
});
