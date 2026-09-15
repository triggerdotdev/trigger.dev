import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { streamText, tool, type UIMessage } from "ai";
import { z } from "zod";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { chat, memoryTranscriptStorage } from "../src/v3/ai.js";

/**
 * `onTurnComplete` may edit the history after a failed turn, the same way it can
 * after a successful one: a failure record the user should see on reload, or a
 * card the turn left open. The edit has to reach the accumulator and the
 * transcript save that follows the hook, on both paths.
 */

function erroringStream(): ReadableStream<LanguageModelV3StreamPart> {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "partial" },
  ];
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) return void c.enqueue(chunks[i++]!);
      c.error(new Error("UND_ERR_BODY_TIMEOUT"));
    },
  });
}

const userMessage = (text: string, id: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("a chat.history edit in onTurnComplete after a failed turn", () => {
  it("reaches the transcript the runtime saves", { timeout: 30_000 }, async () => {
    const storage = memoryTranscriptStorage();
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: erroringStream() }),
    });
    const failureId = "turn-error:0";

    const agent = chat.agent({
      id: "error-turn-history-edit",
      storage,
      onTurnComplete: async ({ uiMessages, finishReason }) => {
        if (finishReason !== "error") return;
        chat.history.set([
          ...uiMessages,
          {
            id: failureId,
            role: "assistant",
            parts: [{ type: "text", text: "That turn didn't finish." }],
          },
        ]);
      },
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "error-turn-history-edit" });
    try {
      await harness.sendMessage(userMessage("m1", "u-1"));
      await waitFor(
        () => storage.changesets.some((c) => c.changeset.reason === "turn-error"),
        "the failed turn's save"
      );

      const saved = storage.transcript("error-turn-history-edit");
      const ids = saved?.entries.map((entry) => entry.id) ?? [];
      expect(ids).toContain("u-1");
      expect(ids.at(-1)).toBe(failureId);
      expect(ids.filter((id) => id === failureId)).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it(
    "marks a partial the hook replaced under the same id as final",
    { timeout: 30_000 },
    async () => {
      const storage = memoryTranscriptStorage();
      const model = new MockLanguageModelV3({
        doStream: async () => ({ stream: erroringStream() }),
      });

      const agent = chat.agent({
        id: "error-turn-history-edit-replace",
        storage,
        onTurnComplete: async ({ uiMessages, responseMessage, finishReason }) => {
          if (finishReason !== "error" || !responseMessage) return;
          // Finish the cut-short answer in place, the way a hook closes an open card.
          chat.history.set(
            uiMessages.map((message) =>
              message.id === responseMessage.id
                ? {
                    ...message,
                    parts: [{ type: "text" as const, text: "partial, then finished." }],
                  }
                : message
            )
          );
        },
        run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
      });

      const harness = mockChatAgent(agent, { chatId: "error-turn-history-edit-replace" });
      try {
        await harness.sendMessage(userMessage("m1", "u-1"));
        await waitFor(
          () => storage.changesets.some((c) => c.changeset.reason === "turn-error"),
          "the failed turn's save"
        );

        const saved = storage.transcript("error-turn-history-edit-replace");
        const assistant = saved?.entries.find((entry) => entry.message.role === "assistant");
        expect(assistant).toBeDefined();
        expect(assistant!.final).toBe(true);
        expect((assistant!.message.parts[0] as { text: string }).text).toBe(
          "partial, then finished."
        );
      } finally {
        await harness.close();
      }
    }
  );

  it("keeps a cloned but unchanged partial non-final", { timeout: 30_000 }, async () => {
    const storage = memoryTranscriptStorage();
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: erroringStream() }),
    });

    const agent = chat.agent({
      id: "error-turn-history-edit-clone",
      storage,
      onTurnComplete: async ({ uiMessages, finishReason }) => {
        if (finishReason !== "error") return;
        // An immutable transform: every message is a new object with the same content.
        chat.history.set([
          ...uiMessages.map((message) => ({ ...message, parts: [...message.parts] })),
          { id: "note", role: "assistant", parts: [{ type: "text", text: "That turn failed." }] },
        ]);
      },
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "error-turn-history-edit-clone" });
    try {
      await harness.sendMessage(userMessage("m1", "u-1"));
      await waitFor(
        () => storage.changesets.some((c) => c.changeset.reason === "turn-error"),
        "the failed turn's save"
      );

      const saved = storage.transcript("error-turn-history-edit-clone");
      const partial = saved?.entries.find(
        (entry) => entry.message.role === "assistant" && entry.id !== "note"
      );
      expect(partial?.final).toBe(false);
      expect(saved?.entries.find((entry) => entry.id === "note")?.final).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it(
    "leaves the history untouched when the edit cannot be converted",
    { timeout: 30_000 },
    async () => {
      const storage = memoryTranscriptStorage();
      const model = new MockLanguageModelV3({
        doStream: async () => ({ stream: erroringStream() }),
      });

      const agent = chat.agent({
        id: "error-turn-history-edit-unconvertible",
        storage,
        tools: {
          boom: tool({
            description: "a tool whose model output cannot be produced",
            inputSchema: z.object({}),
            execute: async () => ({ ok: true }),
            toModelOutput: () => {
              throw new Error("toModelOutput exploded");
            },
          }),
        },
        onTurnComplete: async ({ uiMessages, finishReason }) => {
          if (finishReason !== "error") return;
          chat.history.set([
            ...uiMessages,
            {
              id: "bad",
              role: "assistant",
              parts: [
                {
                  type: "tool-boom",
                  toolCallId: "tc-1",
                  state: "output-available",
                  input: {},
                  output: { ok: true },
                } as never,
              ],
            },
          ]);
        },
        run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
      });

      const harness = mockChatAgent(agent, { chatId: "error-turn-history-edit-unconvertible" });
      try {
        await harness.sendMessage(userMessage("m1", "u-1"));
        await waitFor(
          () => storage.changesets.some((c) => c.changeset.reason === "turn-error"),
          "the failed turn's save"
        );

        // The edit was dropped whole: the save carries the history the stream left,
        // with the partial still marked partial, and nothing from the rejected edit.
        const saved = storage.transcript("error-turn-history-edit-unconvertible");
        const ids = saved?.entries.map((entry) => entry.id) ?? [];
        expect(ids).toContain("u-1");
        expect(ids).not.toContain("bad");
        const partial = saved?.entries.find((entry) => entry.message.role === "assistant");
        expect(partial?.final).toBe(false);
      } finally {
        await harness.close();
      }
    }
  );

  it("ignores an edit abandoned by an earlier hook that threw", { timeout: 30_000 }, async () => {
    const storage = memoryTranscriptStorage();
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: erroringStream() }),
    });
    let completes = 0;

    const agent = chat.agent({
      id: "error-turn-history-edit-stale",
      storage,
      onTurnStart: async () => {
        // Edit, then fail before the runtime reads the edit back.
        chat.history.slice(0, -1);
        throw new Error("onTurnStart failed after editing");
      },
      onTurnComplete: async () => {
        completes++;
      },
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "error-turn-history-edit-stale" });
    try {
      await harness.sendMessage(userMessage("m1", "u-1"));
      await waitFor(
        () => storage.changesets.some((c) => c.changeset.reason === "turn-error"),
        "the failed turn's save"
      );
      expect(completes).toBe(1);

      // The abandoned slice is not this hook's edit: the user's message survives.
      const saved = storage.transcript("error-turn-history-edit-stale");
      expect(saved?.entries.map((entry) => entry.id)).toContain("u-1");
    } finally {
      await harness.close();
    }
  });

  it(
    "discards an abandoned edit even without onTurnComplete, before the next turn",
    { timeout: 30_000 },
    async () => {
      const storage = memoryTranscriptStorage();
      // The first turn never reaches the model (its hook throws first), so every call
      // that does arrive answers normally.
      const model = new MockLanguageModelV3({
        doStream: async () => ({
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(c) {
              c.enqueue({ type: "text-start", id: "t2" });
              c.enqueue({ type: "text-delta", id: "t2", delta: "second answer" });
              c.enqueue({ type: "text-end", id: "t2" });
              c.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: {
                    total: 1,
                    noCache: 1,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: { total: 1, text: 1, reasoning: undefined },
                },
              });
              c.close();
            },
          }),
        }),
      });
      let starts = 0;

      const agent = chat.agent({
        id: "error-turn-history-edit-no-complete",
        storage,
        // No onTurnComplete at all.
        onTurnStart: async () => {
          if (starts++ === 0) {
            chat.history.slice(0, -1);
            throw new Error("onTurnStart failed after editing");
          }
        },
        run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
      });

      const harness = mockChatAgent(agent, { chatId: "error-turn-history-edit-no-complete" });
      try {
        await harness.sendMessage(userMessage("m1", "u-1"));
        await waitFor(
          () => storage.changesets.some((c) => c.changeset.reason === "turn-error"),
          "the failed turn's save"
        );
        expect(
          storage.transcript("error-turn-history-edit-no-complete")?.entries.map((e) => e.id)
        ).toContain("u-1");

        await harness.sendMessage(userMessage("m2", "u-2"));
        await waitFor(
          () => storage.changesets.some((c) => c.changeset.reason === "turn-complete"),
          "the second turn's save"
        );

        // The abandoned slice never applied: both questions are in the history.
        const ids =
          storage.transcript("error-turn-history-edit-no-complete")?.entries.map((e) => e.id) ?? [];
        expect(ids).toContain("u-1");
        expect(ids).toContain("u-2");
      } finally {
        await harness.close();
      }
    }
  );

  it("keeps an untouched partial non-final", { timeout: 30_000 }, async () => {
    const storage = memoryTranscriptStorage();
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: erroringStream() }),
    });

    const agent = chat.agent({
      id: "error-turn-history-edit-untouched",
      storage,
      onTurnComplete: async ({ uiMessages, finishReason }) => {
        if (finishReason !== "error") return;
        chat.history.set([
          ...uiMessages,
          { id: "note", role: "assistant", parts: [{ type: "text", text: "That turn failed." }] },
        ]);
      },
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "error-turn-history-edit-untouched" });
    try {
      await harness.sendMessage(userMessage("m1", "u-1"));
      await waitFor(
        () => storage.changesets.some((c) => c.changeset.reason === "turn-error"),
        "the failed turn's save"
      );

      const saved = storage.transcript("error-turn-history-edit-untouched");
      const partial = saved?.entries.find(
        (entry) => entry.message.role === "assistant" && entry.id !== "note"
      );
      expect(partial?.final).toBe(false);
      expect(saved?.entries.find((entry) => entry.id === "note")?.final).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
