/**
 * What the launcher's dot counts.
 *
 * The counts are derived from the chat list rather than nudged up and down as chats are
 * opened: a decrement fires once per read effect and once per cleanup, and again on every
 * revisit, none of which the server ever hears about. Reading a chat settles it in the list,
 * and the list is what the dot counts — so the same chat read twice counts once.
 */

type UnreadChat = { id: string; hasUnreadWake?: boolean; hasUnreadWork?: boolean };

/**
 * The chat the panel has on screen. `leaving` is the read effect's cleanup: it runs after the
 * panel has already let go, so restoring the id there would keep hiding that chat's wakes.
 */
export function nextVisibleChat(chatId: string, options: { leaving: boolean }): string | null {
  return options.leaving ? null : chatId;
}

/** Opening a chat settles everything unseen in it, not just the wake. */
export function markChatListRead<T extends UnreadChat>(chats: T[], chatId: string): T[] {
  return chats.map((chat) =>
    chat.id === chatId ? { ...chat, hasUnreadWake: false, hasUnreadWork: false } : chat
  );
}

/** How many chats still hold work their owner hasn't seen. */
export function unreadWorkCount(chats: UnreadChat[]): number {
  return chats.filter((chat) => chat.hasUnreadWork).length;
}
