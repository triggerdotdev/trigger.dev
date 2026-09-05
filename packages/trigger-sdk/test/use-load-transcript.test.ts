import { describe, expect, it } from "vitest";
import type { ChatSessionPersistedState } from "../src/v3/chat.js";
import { seedTranscriptCursor } from "../src/v3/chat-react.js";

function fakeTransport(initial?: ChatSessionPersistedState) {
  const sessions = new Map<string, ChatSessionPersistedState>();
  if (initial) sessions.set("chat-1", initial);
  const calls: Array<{ chatId: string; session: ChatSessionPersistedState }> = [];
  return {
    calls,
    sessions,
    getSession: (chatId: string) => sessions.get(chatId),
    setSession: (chatId: string, session: ChatSessionPersistedState) => {
      calls.push({ chatId, session });
      sessions.set(chatId, session);
    },
  };
}

describe("seedTranscriptCursor", () => {
  it("moves the transport's resume cursor to the transcript's lastOutEventId", () => {
    const transport = fakeTransport({
      publicAccessToken: "pat",
      lastEventId: "3",
      activeInputSeq: 2,
      isStreaming: false,
    });

    expect(seedTranscriptCursor(transport, "chat-1", { lastOutEventId: "42" })).toBe(true);
    expect(transport.calls).toEqual([
      {
        chatId: "chat-1",
        session: {
          publicAccessToken: "pat",
          lastEventId: "42",
          activeInputSeq: 2,
          isStreaming: false,
        },
      },
    ]);
  });

  it("does nothing when the transport does not know the session yet", () => {
    const transport = fakeTransport();
    expect(seedTranscriptCursor(transport, "chat-1", { lastOutEventId: "42" })).toBe(false);
    expect(transport.calls).toEqual([]);
  });

  it("does nothing when the transcript carries no cursor", () => {
    const transport = fakeTransport({ publicAccessToken: "pat", lastEventId: "3" });
    expect(seedTranscriptCursor(transport, "chat-1", undefined)).toBe(false);
    expect(seedTranscriptCursor(transport, "chat-1", { lastOutEventId: "" })).toBe(false);
    expect(transport.calls).toEqual([]);
    expect(transport.getSession("chat-1")?.lastEventId).toBe("3");
  });
});
