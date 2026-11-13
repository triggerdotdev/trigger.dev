import { describe, expect, it } from "vitest";
import { chatIsUnread } from "./DashboardAgentHistory";

/**
 * A chat is unread when its transcript moved on after its owner last looked, such as an
 * answer that landed while the panel was closed.
 */
describe("chatIsUnread", () => {
  const chat = (over: Record<string, unknown> = {}) =>
    ({ id: "chat_1", title: "t", lastMessageAt: null, ...over }) as never;

  it("counts work that finished behind a closed panel", () => {
    expect(chatIsUnread(chat({ hasUnreadWork: true }))).toBe(true);
  });

  it("leaves a chat its owner has seen", () => {
    expect(chatIsUnread(chat())).toBe(false);
    expect(chatIsUnread(chat({ hasUnreadWork: false }))).toBe(false);
  });
});
