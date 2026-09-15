import { describe, expect, it } from "vitest";
import { chatSessionsOption } from "./DashboardAgentChat";
import { resolveOpenedChat } from "./opened-chat";

const CHAT_ID = "chat_abc123";

// A tool call the stream died on: still `input-available`, no result part.
const unfinishedMessage = {
  id: "msg_2",
  role: "assistant",
  parts: [{ type: "tool-run_query", state: "input-available" }],
};

describe("the transport's sessions option, built from a real resolveOpenedChat result", () => {
  it("marks isStreaming when the reopened chat's transcript still looks mid-turn", () => {
    const opened = resolveOpenedChat(CHAT_ID, {
      messages: [unfinishedMessage],
      session: { publicAccessToken: "pat_1", lastEventId: "evt_9" },
    });
    if (opened.kind !== "chat") throw new Error("expected a chat");

    const sessions = chatSessionsOption(CHAT_ID, opened.session, opened.streaming);

    expect(sessions?.[CHAT_ID]?.isStreaming).toBe(true);
  });

  it("does not mark isStreaming once the transcript has settled", () => {
    const settledMessage = { id: "msg_1", role: "user", parts: [{ type: "text", text: "hi" }] };
    const opened = resolveOpenedChat(CHAT_ID, {
      messages: [settledMessage],
      session: { publicAccessToken: "pat_1", lastEventId: "evt_9" },
    });
    if (opened.kind !== "chat") throw new Error("expected a chat");

    const sessions = chatSessionsOption(CHAT_ID, opened.session, opened.streaming);

    expect(sessions?.[CHAT_ID]?.isStreaming).toBe(false);
  });

  it("omits the session entirely when there is none to resume", () => {
    expect(chatSessionsOption(CHAT_ID, null, true)).toBeUndefined();
  });
});
