import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  markChatListRead,
  nextVisibleChat,
  settleReadChats,
  unreadWorkCount,
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
 * A turn landing in the chat on screen must not light the dot — and the chat is left out of the
 * count rather than subtracted off it afterwards, so a chat holding nothing is never subtracted.
 */
describe("the chat on screen", () => {
  it("is left out, however much work lands in it", () => {
    expect(unreadWorkCount(list(), "chat_a")).toBe(1);
  });

  it("takes nothing off the count when it holds no unseen work", () => {
    expect(unreadWorkCount(list(), "chat_c")).toBe(2);
  });

  it("counts every chat when there is none on screen", () => {
    expect(unreadWorkCount(list(), null)).toBe(2);
    expect(unreadWorkCount(list(), undefined)).toBe(2);
  });
});

/**
 * The list is refreshed after every turn, and the server's lastReadAt trails the turn that just
 * landed — so the chat being read has to settle on its own, not wait for the next read to land.
 */
describe("settleReadChats", () => {
  it("settles the chat on screen, however fresh the turn that just landed in it", () => {
    const settled = settleReadChats(list(), new Set(), "chat_a");
    expect(settled[0]).toEqual({ id: "chat_a", hasUnreadWake: false, hasUnreadWork: false });
    expect(settled.slice(1)).toEqual(list().slice(1));
  });

  it("settles the chats just read", () => {
    const settled = settleReadChats(list(), new Set(["chat_b"]), null);
    expect(settled[1]).toEqual({ id: "chat_b", hasUnreadWake: false, hasUnreadWork: false });
    expect(unreadWorkCount(settled)).toBe(1);
  });

  it("leaves every other chat exactly as the server reported it", () => {
    expect(settleReadChats(list(), new Set(), null)).toEqual(list());
  });
});

describe("what the panel and the layout actually do with it", () => {
  const panel = readFileSync(new URL("./DashboardAgentPanel.tsx", import.meta.url), "utf8");
  const layout = readFileSync(new URL("./DashboardAgent.tsx", import.meta.url), "utf8");

  it("reports the count from the list, and only from the list", () => {
    expect(panel).toContain("onUnreadWorkChange?.(unreadWorkCount(chats, active?.chatId));");
    expect(panel).not.toContain("settled.filter((chat) => chat.hasUnreadWork).length");
    expect(layout).not.toContain("setUnreadWork((count) => Math.max(0, count - 1))");
  });

  it("tells the read effect's cleanup that it is leaving", () => {
    expect(panel).toContain("onChatRead?.(chatId, { leaving: false });");
    expect(panel).toContain("onChatRead?.(chatId, { leaving: true });");
    expect(layout).toContain("visibleChat.current = nextVisibleChat(chatId, options);");
  });

  /**
   * Structural: the reload is memoised without `active`, so the chat on screen has to reach the
   * settle through a ref — the closure's copy is whatever it was when the reload was created.
   */
  it("settles the refreshed list against the chat on screen, read from a ref", () => {
    expect(panel).toContain("settleReadChats(chats, read, visibleChatId.current)");
    expect(panel).toContain("visibleChatId.current = nextVisibleChat(chatId, { leaving: false });");
    expect(panel).toContain("visibleChatId.current = nextVisibleChat(chatId, { leaving: true });");
  });

  /**
   * Structural: there is no DOM here to open a panel in. The poll runs for as long as this tab
   * is watching, so the chat on screen has to be read from a ref at request time — `open` in the
   * callback's closure is whatever it was when polling started.
   */
  it("names the chat on screen to the poll instead of correcting the count it gets back", () => {
    expect(layout).toContain("const onScreen = visibleChat.current;");
    expect(layout).toContain("setUnreadWork(Math.max(0, data.unreadWork ?? 0));");
    expect(layout).not.toContain("panelOpen.current");
  });

  it("re-seeds both counts when the environment changes under the layout", () => {
    expect(layout).toContain("seededEnvironment.current = environment.id;");
    expect(layout).toContain("setUnreadWakes(initialUnreadWakes);");
    expect(layout).toContain("setUnreadWork(initialUnreadWork);");
  });
});
