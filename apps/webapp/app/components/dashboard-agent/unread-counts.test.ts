import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  markChatListRead,
  nextVisibleChat,
  unreadWorkCount,
  unreadWorkForDot,
} from "./unread-counts";

const list = () => [
  { id: "chat_a", hasUnreadWake: true, hasUnreadWork: true },
  { id: "chat_b", hasUnreadWork: true },
  { id: "chat_c" },
];

/**
 * The dot counts chats, not visits. Reading a chat settles it in the list, and the list is
 * what the count is derived from — so one visit, or ten, subtracts the same one chat.
 */
describe("the work count is derived from the list", () => {
  it("counts every chat still holding unseen work", () => {
    expect(unreadWorkCount(list())).toBe(2);
  });

  it("subtracts a read chat once, however many times it is read", () => {
    const once = markChatListRead(list(), "chat_a");
    expect(unreadWorkCount(once)).toBe(1);
    // The read effect fires on entry and again on cleanup, and again on every revisit.
    const again = markChatListRead(markChatListRead(once, "chat_a"), "chat_a");
    expect(unreadWorkCount(again)).toBe(1);
  });

  it("reaches zero only when every chat has been read", () => {
    const all = ["chat_a", "chat_b", "chat_c"].reduce(markChatListRead, list());
    expect(unreadWorkCount(all)).toBe(0);
  });

  it("settles the wake alongside the work, so the row stops looking unread", () => {
    const read = markChatListRead(list(), "chat_a");
    expect(read[0]).toEqual({ id: "chat_a", hasUnreadWake: false, hasUnreadWork: false });
    // Every other chat is left exactly as it was.
    expect(read.slice(1)).toEqual(list().slice(1));
  });
});

/**
 * A wake in the chat on screen must not light the dot — but once the panel has let go of that
 * chat, its wakes have to reach the dot again.
 */
describe("nextVisibleChat", () => {
  it("holds the chat while it is on screen", () => {
    expect(nextVisibleChat("chat_a", { leaving: false })).toBe("chat_a");
  });

  it("lets go on the way out instead of restoring it", () => {
    expect(nextVisibleChat("chat_a", { leaving: true })).toBeNull();
  });
});

/**
 * The chat on screen is being read, so it isn't work waiting for anyone — but only while the
 * panel is actually open.
 */
describe("unreadWorkForDot", () => {
  it("subtracts the chat the panel is showing", () => {
    expect(unreadWorkForDot({ reported: 3, panelOpen: true, visibleChatId: "chat_a" })).toBe(2);
  });

  it("counts every chat when the panel is closed", () => {
    expect(unreadWorkForDot({ reported: 3, panelOpen: false, visibleChatId: "chat_a" })).toBe(3);
    expect(unreadWorkForDot({ reported: 3, panelOpen: true, visibleChatId: null })).toBe(3);
  });

  it("never reports a negative count, or one the poll didn't give", () => {
    expect(unreadWorkForDot({ reported: 0, panelOpen: true, visibleChatId: "chat_a" })).toBe(0);
    expect(unreadWorkForDot({ reported: undefined, panelOpen: false, visibleChatId: null })).toBe(
      0
    );
  });
});

describe("what the panel and the layout actually do with it", () => {
  const panel = readFileSync(new URL("./DashboardAgentPanel.tsx", import.meta.url), "utf8");
  const layout = readFileSync(new URL("./DashboardAgent.tsx", import.meta.url), "utf8");

  it("reports the count from the list, and only from the list", () => {
    expect(panel).toContain("onUnreadWorkChange?.(unreadWorkCount(chats));");
    expect(panel).not.toContain("settled.filter((chat) => chat.hasUnreadWork).length");
    expect(layout).not.toContain("setUnreadWork((count) => Math.max(0, count - 1))");
  });

  it("tells the read effect's cleanup that it is leaving", () => {
    expect(panel).toContain("onChatRead?.(chatId, { leaving: false });");
    expect(panel).toContain("onChatRead?.(chatId, { leaving: true });");
    expect(layout).toContain("visibleChat.current = nextVisibleChat(chatId, options);");
  });

  /**
   * The poll runs for as long as this tab is watching, so anything it reads about the panel has
   * to come from a ref. `open` is state: the callback would keep the value it had when polling
   * started, which is `false`, and the dot would go on counting the chat on screen.
   */
  it("reads the panel's state at poll time, not from the closure", () => {
    expect(layout).toContain("panelOpen: panelOpen.current,");
    expect(layout).not.toContain("open && visibleChat.current");
  });

  it("re-seeds both counts when the environment changes under the layout", () => {
    expect(layout).toContain("seededEnvironment.current = environment.id;");
    expect(layout).toContain("setUnreadWakes(initialUnreadWakes);");
    expect(layout).toContain("setUnreadWork(initialUnreadWork);");
  });
});
