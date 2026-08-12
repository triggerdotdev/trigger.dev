import { describe, expect, it } from "vitest";
import { chatIsUnread } from "./DashboardAgentHistory";

/**
 * A chat is unread when its transcript moved on after its owner last looked — whether that
 * was a watch waking it or an answer that landed while the panel was closed. Both raise the
 * dot and the highlight; only a wake also raises a toast.
 */
describe("chatIsUnread", () => {
  const chat = (over: Record<string, unknown> = {}) =>
    ({ id: "chat_1", title: "t", lastMessageAt: null, ...over }) as never;

  it("counts work that finished behind a closed panel", () => {
    expect(chatIsUnread(chat({ hasUnreadWork: true }))).toBe(true);
  });

  it("still counts a watch wake", () => {
    expect(chatIsUnread(chat({ hasUnreadWake: true }))).toBe(true);
  });

  it("leaves a chat its owner has seen", () => {
    expect(chatIsUnread(chat())).toBe(false);
    expect(chatIsUnread(chat({ hasUnreadWake: false, hasUnreadWork: false }))).toBe(false);
  });
});
