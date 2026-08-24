// Import the test harness FIRST — this installs the resource catalog so
// `chat.customAgent()` calls below register their task functions correctly.
import { mockChatAgent } from "../src/v3/test/index.js";

import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { chat } from "../src/v3/ai.js";
import type { PipeAndCaptureResult } from "../src/v3/ai.js";

// ── Helpers ────────────────────────────────────────────────────────────

function userMessage(text: string, id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function textChunks(text: string, opts?: { split?: boolean }): LanguageModelV3StreamPart[] {
  const deltas = opts?.split ? text.split(" ").map((w, i) => (i === 0 ? w : ` ${w}`)) : [text];
  return [
    { type: "text-start", id: "t1" },
    ...deltas.map((delta) => ({ type: "text-delta" as const, id: "t1", delta })),
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
    },
  ];
}

/** Model that streams `text` in one fast pass with a `stop` finish. */
function fastModel(text: string) {
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: textChunks(text) }) }),
  });
}

/** Model that streams `text` word-by-word with a wide gap before the final
 *  chunk, leaving a window to abort mid-stream after the first delta. */
function slowModel(text: string) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: textChunks(text, { split: true }),
        initialDelayInMs: 0,
        chunkDelayInMs: 500,
      }),
    }),
  });
}

function extractText(message: UIMessage | undefined): string {
  if (!message) return "";
  return (message.parts as Array<{ type: string; text?: string }>)
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
}

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

function deltaCount(harness: { allChunks: unknown[] }): number {
  return (harness.allChunks as { type?: string }[]).filter((c) => c.type === "text-delta").length;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("chat.pipeAndCapture", () => {
  it("returns status 'complete' with the message and finish reason on a normal turn", async () => {
    const captures: PipeAndCaptureResult[] = [];
    const turnCompletes: Array<{ lastEventId?: string; sessionInEventId?: string }> = [];

    const agent = chat.customAgent({
      id: "pipe-capture.complete",
      run: async () => {
        const conversation = new chat.MessageAccumulator();
        const next = await chat.messages.waitWithIdleTimeout({
          idleTimeoutInSeconds: 60,
          timeout: "1h",
        });
        if (!next.ok) return;
        const wire = next.output as { message?: UIMessage; trigger: string };
        const incoming = wire.message ? [wire.message] : [];
        const messages = await conversation.addIncoming(incoming, wire.trigger, 0);
        const result = streamText({ model: fastModel("hello world"), messages });
        const captured = await chat.pipeAndCapture(result);
        captures.push(captured);
        if (captured.message) await conversation.addResponse(captured.message);
        turnCompletes.push(await chat.writeTurnComplete());
      },
    });

    const harness = mockChatAgent(agent, { chatId: "pc-complete" });
    try {
      await harness.sendMessage(userMessage("hi", "u-1"));
      await waitFor(() => captures.length >= 1 && turnCompletes.length >= 1);

      expect(captures[0]!.status).toBe("complete");
      expect(extractText(captures[0]!.message)).toBe("hello world");
      expect(captures[0]!.finishReason).toBe("stop");
      expect(captures[0]!.error).toBeUndefined();
      // chat.writeTurnComplete() surfaces the .out resume cursor for the next
      // turn. (sessionInEventId is a passthrough of the same value written to
      // the session-in-event-id header; the in-memory harness doesn't track
      // the .in dispatch cursor, so its value isn't asserted here.)
      expect(typeof turnCompletes[0]!.lastEventId).toBe("string");
      expect(turnCompletes[0]!.lastEventId!.length).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  });

  it("returns status 'error' with the thrown error and does not throw when the stream fails", async () => {
    const captures: PipeAndCaptureResult[] = [];
    let runThrew = false;

    // Synthetic source whose UI stream errors after emitting a partial. This
    // deterministically drives the pipe-failure path without depending on the
    // AI SDK's model-error handling. Chunks are delivered one-per-pull before
    // the error so they aren't discarded — calling controller.error() in the
    // same tick as enqueue() would reset the queue and drop them.
    const partialChunks = [
      { type: "start", messageId: "a-err" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "partial" },
    ];
    const erroringSource = {
      toUIMessageStream() {
        let i = 0;
        return new ReadableStream({
          pull(controller) {
            if (i < partialChunks.length) {
              controller.enqueue(partialChunks[i++]);
            } else {
              controller.error(new Error("boom"));
            }
          },
        });
      },
    };

    const agent = chat.customAgent({
      id: "pipe-capture.error",
      run: async () => {
        const next = await chat.messages.waitWithIdleTimeout({
          idleTimeoutInSeconds: 60,
          timeout: "1h",
        });
        if (!next.ok) return;
        try {
          captures.push(await chat.pipeAndCapture(erroringSource as never));
        } catch {
          runThrew = true;
        }
        await chat.writeTurnComplete();
      },
    });

    const harness = mockChatAgent(agent, { chatId: "pc-error" });
    try {
      await harness.sendMessage(userMessage("go", "u-1"));
      await waitFor(() => captures.length >= 1);

      expect(runThrew).toBe(false);
      expect(captures[0]!.status).toBe("error");
      expect(captures[0]!.error).toBeInstanceOf(Error);
      expect((captures[0]!.error as Error).message).toBe("boom");
      // The partial that streamed before the failure is reconstructed from the
      // buffered chunks even though onFinish never fired on this hard-error path.
      expect(extractText(captures[0]!.message)).toBe("partial");
    } finally {
      await harness.close();
    }
  });

  it("returns status 'aborted' and preserves the partial message on a mid-stream stop", async () => {
    const captures: PipeAndCaptureResult[] = [];

    const agent = chat.customAgent({
      id: "pipe-capture.aborted",
      run: async () => {
        const stop = chat.createStopSignal();
        const conversation = new chat.MessageAccumulator();
        const next = await chat.messages.waitWithIdleTimeout({
          idleTimeoutInSeconds: 60,
          timeout: "1h",
        });
        if (!next.ok) return;
        const wire = next.output as { message?: UIMessage; trigger: string };
        const incoming = wire.message ? [wire.message] : [];
        const messages = await conversation.addIncoming(incoming, wire.trigger, 0);
        const result = streamText({
          model: slowModel("one two three four"),
          messages,
          abortSignal: stop.signal,
        });
        captures.push(await chat.pipeAndCapture(result, { signal: stop.signal }));
        await chat.writeTurnComplete();
        stop.cleanup();
      },
    });

    const harness = mockChatAgent(agent, { chatId: "pc-aborted" });
    try {
      void harness.sendMessage(userMessage("hi", "u-1"));
      // Stop once the first delta has streamed but before the turn finishes.
      await waitFor(() => deltaCount(harness) >= 1);
      await harness.sendStop();
      await waitFor(() => captures.length >= 1);

      expect(captures[0]!.status).toBe("aborted");
      // The partial that streamed before the stop is preserved.
      expect(extractText(captures[0]!.message).startsWith("one")).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
