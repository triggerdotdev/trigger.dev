import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { chat, memoryTranscriptStorage } from "../src/v3/ai.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function userMessage(text: string, id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function model(reply = "ack") {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: reply },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ] satisfies LanguageModelV3StreamPart[],
      }),
    }),
  });
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

describe("chat.agent({ storage })", () => {
  it("persists through the configured storage and reads it back with createLoadTranscriptAction", async () => {
    const storage = memoryTranscriptStorage();
    const agent = chat.agent({
      id: "storage-option",
      storage,
      run: async ({ messages, signal }) =>
        streamText({ model: model(), messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "storage-option" });
    try {
      await harness.sendMessage(userMessage("hello", "u1"));
      await harness.sendMessage(userMessage("again", "u2"));
      await waitFor(() => storage.changesets.length === 2, "two saves");

      expect(harness.getSnapshot()).toBeUndefined();

      const loadTranscript = chat.createLoadTranscriptAction(storage, { limit: 3 });
      const page = await loadTranscript({ chatId: "storage-option" });
      expect(page.messages.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
      expect(page.messages[1]!.id).toBe("u2");
      expect(page.nextCursor).toBe(page.messages[0]!.id);
      expect(page.cursors?.lastOutEventId).toBeDefined();

      const rest = await loadTranscript({ chatId: "storage-option", before: page.nextCursor });
      expect(rest.messages.map((m) => m.id)).toEqual(["u1"]);
      expect(rest.nextCursor).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it("refuses hydrateMessages together with storage", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      chat.agent({
        id: "storage-option-both",
        storage: memoryTranscriptStorage(),
        hydrateMessages: async () => [],
        run: async ({ messages, signal }) =>
          streamText({ model: model(), messages, abortSignal: signal }),
      })
    ).toThrow(/hydrateMessages/);
    vi.restoreAllMocks();
  });

  it("requires a chatId on the load action", async () => {
    const loadTranscript = chat.createLoadTranscriptAction(memoryTranscriptStorage());
    await expect(loadTranscript({ chatId: "" })).rejects.toThrow(/chatId/);
  });
});
