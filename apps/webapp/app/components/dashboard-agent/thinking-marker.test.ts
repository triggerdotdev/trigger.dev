import { describe, expect, it } from "vitest";
import { markerAfterActiveChat, markerAfterActivity, markerChatId } from "./thinking-marker";
import { TOOL_PENDING_DEADLINE_MS } from "./turn-deadlines";

describe("thinking marker", () => {
  it("marks the chat that is working and clears it when the turn settles", () => {
    const working = markerAfterActivity(null, "chat_1", "working", 0);
    expect(markerChatId(working, "chat_1", 0)).toBe("chat_1");
    expect(markerAfterActivity(working, "chat_1", null, 0)).toBe(null);
  });

  it("ignores a settled report from another chat", () => {
    const working = markerAfterActivity(null, "chat_1", "working", 0);
    const other = markerAfterActivity(working, "chat_2", null, 0);
    expect(markerChatId(other, "chat_2", 0)).toBe("chat_1");
  });

  it("keeps the marker when the chat closes mid-turn", () => {
    const working = markerAfterActivity(null, "chat_1", "working", 0);
    const closed = markerAfterActiveChat(working, undefined, 1_000);
    expect(markerChatId(closed, undefined, 1_000)).toBe("chat_1");
    expect(markerChatId(markerAfterActiveChat(working, "chat_2", 1_000), "chat_2", 1_000)).toBe(
      "chat_1"
    );
  });

  it("expires a closed marker once activity reports stop", () => {
    const working = markerAfterActivity(null, "chat_1", "working", 0);
    const closed = markerAfterActiveChat(working, undefined, 1_000);
    expect(markerChatId(closed, undefined, 1_000 + TOOL_PENDING_DEADLINE_MS)).toBe(null);
  });

  it("does not expire the marker while its chat is open", () => {
    const working = markerAfterActivity(null, "chat_1", "working", 0);
    expect(markerChatId(working, "chat_1", TOOL_PENDING_DEADLINE_MS * 10)).toBe("chat_1");
  });

  it("clears the marker when the chat is reopened and already settled", () => {
    const working = markerAfterActivity(null, "chat_1", "working", 0);
    const reopened = markerAfterActiveChat(working, "chat_1", 1_000);
    expect(markerAfterActivity(reopened, "chat_1", null, 1_000)).toBe(null);
  });

  it("extends the marker when the reopened chat is still streaming", () => {
    const working = markerAfterActivity(null, "chat_1", "working", 0);
    const closed = markerAfterActiveChat(working, undefined, 1_000);
    const streaming = markerAfterActivity(closed, "chat_1", "working", 5_000);
    expect(markerChatId(streaming, undefined, 1_000 + TOOL_PENDING_DEADLINE_MS)).toBe("chat_1");
  });
});
