import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import { resolveOpenedChat } from "./opened-chat";

const CHAT_ID = "chat_abc123";

const message: UIMessage = {
  id: "msg_1",
  role: "user",
  parts: [{ type: "text", text: "why did this run fail?" }],
};

// A tool call the stream died on: still `input-available`, no result part.
const unfinishedMessage: UIMessage = {
  id: "msg_2",
  role: "assistant",
  parts: [{ type: "tool-run_query", state: "input-available" } as never],
};

describe("resolveOpenedChat", () => {
  it("opens a chat that has messages", () => {
    const opened = resolveOpenedChat(CHAT_ID, { messages: [message], session: null });

    expect(opened).toEqual({
      kind: "chat",
      chatId: CHAT_ID,
      messages: [message],
      session: null,
      streaming: false,
    });
  });

  it("still opens a chat that exists but has no messages", () => {
    const opened = resolveOpenedChat(CHAT_ID, { messages: [], session: null });

    expect(opened.kind).toBe("chat");
    expect(opened).toEqual({
      kind: "chat",
      chatId: CHAT_ID,
      messages: [],
      session: null,
      streaming: false,
    });
  });

  it("treats a chat with no messages field the same way", () => {
    expect(resolveOpenedChat(CHAT_ID, {}).kind).toBe("chat");
  });

  it("reports a chat the server would not return as gone", () => {
    expect(resolveOpenedChat(CHAT_ID, undefined)).toEqual({ kind: "gone" });
  });

  it("carries the session through, dropping a null last event id", () => {
    const opened = resolveOpenedChat(CHAT_ID, {
      messages: [message],
      session: { publicAccessToken: "pat_1", lastEventId: null },
    });

    expect(opened).toMatchObject({ session: { publicAccessToken: "pat_1" } });
    expect(opened.kind === "chat" && opened.session?.lastEventId).toBeUndefined();
  });

  it("keeps a last event id when there is one", () => {
    const opened = resolveOpenedChat(CHAT_ID, {
      messages: [],
      session: { publicAccessToken: "pat_1", lastEventId: "evt_9" },
    });

    expect(opened).toMatchObject({ session: { publicAccessToken: "pat_1", lastEventId: "evt_9" } });
  });

  it("has no session when the token is missing", () => {
    expect(resolveOpenedChat(CHAT_ID, { messages: [message] })).toMatchObject({ session: null });
  });

  // The bug this guards: closing mid-turn and reopening must resume, not show a stalled turn.
  it("marks streaming when the fetched transcript still looks mid-turn", () => {
    const opened = resolveOpenedChat(CHAT_ID, {
      messages: [message, unfinishedMessage],
      session: { publicAccessToken: "pat_1", lastEventId: "evt_9" },
    });

    expect(opened).toMatchObject({ streaming: true });
  });

  it("is not streaming once the transcript settles", () => {
    const opened = resolveOpenedChat(CHAT_ID, {
      messages: [message],
      session: { publicAccessToken: "pat_1", lastEventId: "evt_9" },
    });

    expect(opened).toMatchObject({ streaming: false });
  });
});
