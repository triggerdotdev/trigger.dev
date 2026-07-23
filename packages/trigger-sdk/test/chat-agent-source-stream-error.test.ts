// Import the test harness FIRST — this installs the resource catalog so
// `chat.agent()` calls below register their task functions correctly.
import { mockChatAgent } from "../src/v3/test/index.js";

import { describe, expect, it } from "vitest";
import type { ModelMessage, UIMessage } from "ai";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { chat } from "../src/v3/ai.js";
import type { TurnCompleteEvent } from "../src/v3/ai.js";

// ── Helpers ────────────────────────────────────────────────────────────

function userMessage(text: string, id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
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

/**
 * A `run()` return value that looks like a `StreamTextResult` (has
 * `toUIMessageStream()`) but whose UI stream emits a partial assistant
 * message and then errors — reproducing a source-stream transport failure
 * (e.g. `UND_ERR_BODY_TIMEOUT`) mid-turn. `onFinish` is never invoked, which
 * is exactly what happens on a hard transport error. Chunks are delivered
 * one-per-pull before the error so they aren't discarded (calling
 * `controller.error()` in the same tick as `enqueue()` resets the queue).
 */
function erroringSource(errorMessage: string) {
  const partialChunks = [
    { type: "start", messageId: "a-err" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "partial answer" },
  ];
  return {
    toUIMessageStream() {
      let i = 0;
      return new ReadableStream({
        pull(controller) {
          if (i < partialChunks.length) {
            controller.enqueue(partialChunks[i++]);
          } else {
            controller.error(new Error(errorMessage));
          }
        },
      });
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("chat.agent managed loop — source-stream failure", () => {
  it("preserves the partial assistant message on onTurnComplete when the source stream fails", async () => {
    const turnCompletes: TurnCompleteEvent<unknown, UIMessage>[] = [];

    const agent = chat.agent({
      id: "chatAgent.source-stream-error",
      run: async () => erroringSource("UND_ERR_BODY_TIMEOUT") as never,
      onTurnComplete: async (event) => {
        turnCompletes.push(event);
      },
    });

    const harness = mockChatAgent(agent, { chatId: "cae-source-error" });
    try {
      await harness.sendMessage(userMessage("hi", "u-1"));
      await waitFor(() => turnCompletes.length >= 1);

      const evt = turnCompletes[0]!;

      // The turn is reported as errored, carrying the thrown transport error.
      expect(evt.finishReason).toBe("error");
      expect(evt.error).toBeInstanceOf(Error);
      expect((evt.error as Error).message).toBe("UND_ERR_BODY_TIMEOUT");

      // The partial assistant output that streamed before the failure must be
      // preserved so persistence / recovery can keep it, instead of being
      // dropped (responseMessage: undefined).
      expect(evt.responseMessage).toBeDefined();
      expect(extractText(evt.responseMessage)).toBe("partial answer");
    } finally {
      await harness.close();
    }
  });

  it("carries the recovered partial into the next turn's accumulated messages", async () => {
    let turn = 0;
    let turn2Messages: ModelMessage[] | undefined;

    const okStream = () =>
      simulateReadableStream({
        chunks: [
          { type: "text-start", id: "t2" },
          { type: "text-delta", id: "t2", delta: "second answer" },
          { type: "text-end", id: "t2" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 5, text: 5, reasoning: undefined },
            },
          },
        ] as LanguageModelV3StreamPart[],
      });

    const agent = chat.agent({
      id: "chatAgent.source-stream-error-continuation",
      run: async ({ messages }) => {
        turn++;
        if (turn === 1) {
          return erroringSource("UND_ERR_BODY_TIMEOUT") as never;
        }
        // Second turn: the failed turn's partial assistant output must be in
        // the accumulated history the model now sees.
        turn2Messages = messages;
        return streamText({
          model: new MockLanguageModelV3({ doStream: async () => ({ stream: okStream() }) }),
          messages,
        });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "cae-source-error-cont" });
    try {
      await harness.sendMessage(userMessage("hi", "u-1"));
      await harness.sendMessage(userMessage("still there?", "u-2"));
      await waitFor(() => turn2Messages !== undefined);

      const assistantText = turn2Messages!
        .filter((m) => m.role === "assistant")
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : (m.content as Array<{ type: string; text?: string }>)
                .filter((p) => p.type === "text")
                .map((p) => p.text ?? "")
                .join("")
        )
        .join("");
      expect(assistantText).toContain("partial answer");
    } finally {
      await harness.close();
    }
  });
});

describe("chat.createSession turn.complete() — source-stream failure", () => {
  it("accumulates the partial before rethrowing so the caller can persist it", async () => {
    let caughtError: unknown;
    let uiMessagesAfterError: UIMessage[] = [];

    const agent = chat.customAgent({
      id: "createSession.source-stream-error",
      run: async (payload) => {
        const session = chat.createSession(payload, {
          signal: new AbortController().signal,
          idleTimeoutInSeconds: 2,
        });
        for await (const turn of session) {
          try {
            await turn.complete(erroringSource("UND_ERR_BODY_TIMEOUT") as never);
          } catch (err) {
            caughtError = err;
            // The partial must be accumulated so persistence from the session
            // state keeps it, rather than being lost on the rethrow.
            uiMessagesAfterError = [...turn.uiMessages];
            await turn.done();
          }
        }
      },
    });

    const harness = mockChatAgent(agent, { chatId: "cs-source-error" });
    try {
      await harness.sendMessage(userMessage("hi", "u-1"));
      await waitFor(() => caughtError !== undefined);

      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toBe("UND_ERR_BODY_TIMEOUT");

      const partial = uiMessagesAfterError.find((m) => m.role === "assistant");
      expect(partial).toBeDefined();
      expect(extractText(partial)).toBe("partial answer");
    } finally {
      await harness.close();
    }
  });
});
