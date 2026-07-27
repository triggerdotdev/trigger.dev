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
  return sourceFromChunks(partialChunks, errorMessage);
}

function sourceFromChunks(chunks: unknown[], errorMessage: string) {
  return {
    toUIMessageStream() {
      let i = 0;
      return new ReadableStream({
        pull(controller) {
          if (i < chunks.length) {
            controller.enqueue(chunks[i++]);
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

      expect(evt.finishReason).toBe("error");
      expect(evt.error).toBeInstanceOf(Error);
      expect((evt.error as Error).message).toBe("UND_ERR_BODY_TIMEOUT");

      expect(evt.responseMessage).toBeDefined();
      expect(extractText(evt.responseMessage)).toBe("partial answer");

      const newAssistantText = (evt.newMessages as ModelMessage[])
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
      expect(newAssistantText).toBe("partial answer");

      expect((evt.newMessages as ModelMessage[]).some((m) => m.role === "user")).toBe(true);
      expect((evt.newUIMessages as UIMessage[]).some((m) => m.role === "user")).toBe(true);
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

  it("does not overwrite an already-committed enriched response when a post-response hook throws", async () => {
    const events: TurnCompleteEvent<unknown, UIMessage>[] = [];

    const okModel = (text: string) =>
      new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: text },
              { type: "text-end", id: "t1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: {
                    total: 5,
                    noCache: 5,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: { total: 5, text: 5, reasoning: undefined },
                },
              },
            ] as LanguageModelV3StreamPart[],
          }),
        }),
      });

    const agent = chat.agent({
      id: "chatAgent.post-commit-hook-throw",
      run: async ({ messages }) => {
        chat.response.write({ type: "data-marker", data: { kept: true } } as never);
        return streamText({ model: okModel("full response"), messages });
      },
      onTurnComplete: async (event) => {
        events.push(event);
        if (event.error == null) {
          throw new Error("hook boom after commit");
        }
      },
    });

    const harness = mockChatAgent(agent, { chatId: "cae-post-commit-throw" });
    try {
      await harness.sendMessage(userMessage("hi", "u-1"));
      await waitFor(() => events.some((e) => e.error != null));

      const errorEvent = events.find((e) => e.error != null)!;
      const assistant = (errorEvent.uiMessages as UIMessage[]).find((m) => m.role === "assistant");
      expect(assistant).toBeDefined();
      expect(
        (assistant!.parts as Array<{ type: string }>).some((p) => p.type === "data-marker")
      ).toBe(true);
      expect(extractText(assistant)).toBe("full response");
    } finally {
      await harness.close();
    }
  });

  it("does not clobber an existing message when a reconstructed fragment reuses its id", async () => {
    let turn = 0;
    let firstAssistantId: string | undefined;
    const events: TurnCompleteEvent<unknown, UIMessage>[] = [];

    const okModel = () =>
      new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "first answer" },
              { type: "text-end", id: "t1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: {
                    total: 5,
                    noCache: 5,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: { total: 5, text: 5, reasoning: undefined },
                },
              },
            ] as LanguageModelV3StreamPart[],
          }),
        }),
      });

    const collidingErroringSource = (id: string) => ({
      toUIMessageStream() {
        const chunks = [
          { type: "start", messageId: id },
          { type: "text-start", id: "t2" },
          { type: "text-delta", id: "t2", delta: "clobber" },
        ];
        let i = 0;
        return new ReadableStream({
          pull(controller) {
            if (i < chunks.length) controller.enqueue(chunks[i++]);
            else controller.error(new Error("UND_ERR_BODY_TIMEOUT"));
          },
        });
      },
    });

    const agent = chat.agent({
      id: "chatAgent.fragment-id-collision",
      run: async ({ messages }) => {
        turn++;
        if (turn === 1) {
          return streamText({ model: okModel(), messages });
        }
        return collidingErroringSource(firstAssistantId!) as never;
      },
      onTurnComplete: async (event) => {
        events.push(event);
        if (event.error == null && event.responseMessage) {
          firstAssistantId = event.responseMessage.id;
        }
      },
    });

    const harness = mockChatAgent(agent, { chatId: "cae-fragment-collision" });
    try {
      await harness.sendMessage(userMessage("hi", "u-1"));
      await waitFor(() => firstAssistantId !== undefined);
      await harness.sendMessage(userMessage("again", "u-2"));
      await waitFor(() => events.some((e) => e.error != null));

      const errorEvent = events.find((e) => e.error != null)!;
      const preserved = (errorEvent.uiMessages as UIMessage[]).find(
        (m) => m.id === firstAssistantId
      );
      expect(preserved).toBeDefined();
      expect(extractText(preserved)).toBe("first answer");
      expect(
        (errorEvent.uiMessages as UIMessage[]).some((m) => extractText(m).includes("clobber"))
      ).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("cleans dangling tool parts from the recovered partial while keeping its text", async () => {
    const turnCompletes: TurnCompleteEvent<unknown, UIMessage>[] = [];

    const agent = chat.agent({
      id: "chatAgent.error-partial-cleanup",
      run: async () =>
        sourceFromChunks(
          [
            { type: "start", messageId: "a-tool" },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "thinking" },
            { type: "text-end", id: "t1" },
            { type: "tool-input-start", toolCallId: "tc1", toolName: "search" },
            {
              type: "tool-input-available",
              toolCallId: "tc1",
              toolName: "search",
              input: { q: "x" },
            },
          ],
          "UND_ERR_BODY_TIMEOUT"
        ) as never,
      onTurnComplete: async (event) => {
        turnCompletes.push(event);
      },
    });

    const harness = mockChatAgent(agent, { chatId: "cae-partial-cleanup" });
    try {
      await harness.sendMessage(userMessage("hi", "u-1"));
      await waitFor(() => turnCompletes.length >= 1);

      const evt = turnCompletes[0]!;
      expect(evt.responseMessage).toBeDefined();
      const parts = evt.responseMessage!.parts as Array<{ type: string }>;
      expect(extractText(evt.responseMessage)).toBe("thinking");
      expect(parts.some((p) => p.type.startsWith("tool-"))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("folds queued response data parts into the recovered partial", async () => {
    const turnCompletes: TurnCompleteEvent<unknown, UIMessage>[] = [];

    const agent = chat.agent({
      id: "chatAgent.error-queued-parts",
      run: async () => {
        chat.response.write({ type: "data-marker", data: { kept: true } } as never);
        return erroringSource("UND_ERR_BODY_TIMEOUT") as never;
      },
      onTurnComplete: async (event) => {
        turnCompletes.push(event);
      },
    });

    const harness = mockChatAgent(agent, { chatId: "cae-error-queued-parts" });
    try {
      await harness.sendMessage(userMessage("hi", "u-1"));
      await waitFor(() => turnCompletes.length >= 1);

      const evt = turnCompletes[0]!;
      expect(evt.responseMessage).toBeDefined();
      const parts = evt.responseMessage!.parts as Array<{ type: string }>;
      expect(extractText(evt.responseMessage)).toBe("partial answer");
      expect(parts.some((p) => p.type === "data-marker")).toBe(true);
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
