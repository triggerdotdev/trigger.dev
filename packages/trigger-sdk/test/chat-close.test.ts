// Import the test harness FIRST — this installs the resource catalog so
// `chat.agent()` calls below register their task functions correctly.
import { mockChatAgent } from "../src/v3/test/index.js";

import { describe, expect, it } from "vitest";
import { chat } from "../src/v3/ai.js";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

function userMessage(text: string, id = "u-" + Math.random().toString(36).slice(2)) {
  return {
    id,
    role: "user" as const,
    parts: [{ type: "text" as const, text }],
  };
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

describe("chat.close", () => {
  it("rejects calls outside a chat agent run", () => {
    expect(() => chat.close({ reason: "nope" })).toThrow(
      "chat.close() can only be called from inside a chat.agent() or chat.customAgent() run"
    );
  });

  it("streams the turn, closes the session row, writes a terminal record, and exits", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("goodbye") }),
    });

    let turnCount = 0;
    const agent = chat.agent({
      id: "chat-close.on-turn-complete",
      run: async ({ messages, signal }) => {
        turnCount++;
        return streamText({ model, messages, abortSignal: signal });
      },
      onTurnComplete: async () => {
        chat.close({ reason: "budget exhausted" });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "test-chat-close" });
    try {
      const turn = await harness.sendMessage(userMessage("hello"));

      // The turn's response streamed in full before anything terminal.
      expect(turn.chunks.length).toBeGreaterThan(0);

      await harness.waitForExit();
      expect(turnCount).toBe(1);

      const closed = harness.allRawChunks.find(
        (c) => (c as { type?: string }).type === "trigger:session-closed"
      ) as { reason?: string } | undefined;
      expect(closed).toBeDefined();
      expect(closed?.reason).toBe("budget exhausted");

      // The control-plane close actually happened, once, with the reason.
      expect(harness.getCloseCalls()).toEqual([
        { sessionId: "test-chat-close", reason: "budget exhausted" },
      ]);
    } finally {
      await harness.close();
    }
  });

  it("aborts an in-flight step and tells the live client on turn-complete", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("partial") }),
    });

    let sawAbort = false;
    const agent = chat.agent({
      id: "chat-close.mid-turn",
      run: async ({ messages, signal }) => {
        signal.addEventListener("abort", () => {
          sawAbort = true;
        });
        chat.close({ reason: "abuse detected" });
        return streamText({ model, messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "test-chat-close-mid" });
    try {
      const turn = await harness.sendMessage(userMessage("hello"));
      expect(sawAbort).toBe(true);

      // Closed before the turn ended, so turn-complete carries it — that is
      // the last record a live reader sees before it terminates the stream.
      const turnComplete = turn.rawChunks.find(
        (c) => (c as { type?: string }).type === "trigger:turn-complete"
      ) as { sessionClosed?: boolean; reason?: string } | undefined;
      expect(turnComplete?.sessionClosed).toBe(true);
      expect(turnComplete?.reason).toBe("abuse detected");

      await harness.waitForExit();
      expect(harness.getCloseCalls()).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("exits when closed from outside after a failed turn", async () => {
    const agent = chat.agent({
      id: "chat-close.after-error",
      run: async () => {
        throw new Error("turn blew up");
      },
    });

    const harness = mockChatAgent(agent, { chatId: "test-chat-close-after-error" });
    try {
      await harness.sendMessage(userMessage("hello"));
      // The error path writes its own turn-complete and goes back to waiting.
      // A close arriving here has to end the run, not be consumed as the next
      // turn's payload.
      await harness.sendClose();
      await harness.waitForExit();
    } finally {
      await harness.close();
    }
  });

  it("exits the run when the session is closed from outside", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("hi") }),
    });

    const agent = chat.agent({
      id: "chat-close.external",
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "test-chat-close-external" });
    try {
      await harness.sendMessage(userMessage("hello"));
      // The agent is now idling on `.in`. An external close (dashboard,
      // sessions.close(), MCP) appends a close record, which the server
      // uses to wake the run instead of leaving it to time out.
      await harness.sendClose();
      await harness.waitForExit();
      // The run closed itself out of the loop without calling the close API
      // again — the row is already closed.
      expect(harness.getCloseCalls()).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("retries the session close when the first attempt fails", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("bye") }),
    });

    const agent = chat.agent({
      id: "chat-close.retry",
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
      onTurnComplete: async () => {
        chat.close({ reason: "transient" });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "test-chat-close-retry" });
    try {
      // The close API is idempotent, so a transient failure has to be retried
      // by a later exit site. Flagging the close as done on the first attempt
      // would leave the row open with nothing willing to try again.
      harness.failNextCloseCalls(1);
      await harness.sendMessage(userMessage("hello"));
      await harness.waitForExit();

      const calls = harness.getCloseCalls();
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls[0]).toEqual({ sessionId: "test-chat-close-retry", reason: "transient" });

      // The client-visible terminal record is still written exactly once.
      const closedRecords = harness.allRawChunks.filter(
        (c) => (c as { type?: string }).type === "trigger:session-closed"
      );
      expect(closedRecords).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("bounds an oversized reason so the turn boundary still writes", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("bye") }),
    });

    // Longer than the close API's cap and far past what belongs in a stream
    // record header. Truncating at the call site keeps every consumer bounded.
    const hugeReason = "x".repeat(5000);

    const agent = chat.agent({
      id: "chat-close.long-reason",
      run: async ({ messages, signal }) => {
        chat.close({ reason: hugeReason });
        return streamText({ model, messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "test-chat-close-long" });
    try {
      const turn = await harness.sendMessage(userMessage("hello"));
      await harness.waitForExit();

      const turnComplete = turn.rawChunks.find(
        (c) => (c as { type?: string }).type === "trigger:turn-complete"
      ) as { sessionClosed?: boolean; reason?: string } | undefined;
      expect(turnComplete?.sessionClosed).toBe(true);
      expect(turnComplete?.reason).toHaveLength(256);

      const [call] = harness.getCloseCalls();
      expect(call?.reason).toHaveLength(256);
    } finally {
      await harness.close();
    }
  });

  it("does not leave half an emoji at the truncation boundary", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("bye") }),
    });

    // "\u{1F600}" is a surrogate pair, so a 255-char prefix puts the cut
    // between its halves. Keeping the orphan would encode as U+FFFD on the
    // way out to a record header.
    const reason = "x".repeat(255) + "\u{1F600}" + "tail";

    const agent = chat.agent({
      id: "chat-close.surrogate-reason",
      run: async ({ messages, signal }) => {
        chat.close({ reason });
        return streamText({ model, messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "test-chat-close-surrogate" });
    try {
      await harness.sendMessage(userMessage("hello"));
      await harness.waitForExit();

      const [call] = harness.getCloseCalls();
      expect(call?.reason).toBe("x".repeat(255));
      expect(call?.reason).not.toMatch(/[\uD800-\uDFFF]/);
    } finally {
      await harness.close();
    }
  });
});
