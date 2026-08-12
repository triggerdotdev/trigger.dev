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

/**
 * The list as the panel renders it. The chat on screen settles alongside the ones just read:
 * the server's lastReadAt still trails the turn that just landed in it, so a refresh would
 * otherwise mark the chat its owner is reading right now as unread.
 */
export function settleReadChats<T extends UnreadChat>(
  chats: T[],
  read: Set<string>,
  visibleChatId: string | null
): T[] {
  return chats.map((chat) =>
    read.has(chat.id) || chat.id === visibleChatId
      ? { ...chat, hasUnreadWake: false, hasUnreadWork: false }
      : chat
  );
}

/**
 * How many chats still hold work their owner hasn't seen. The chat on screen is being read
 * right now, so a turn landing in it is not work anyone is waiting on — every count of this,
 * here and on the server, leaves it out, so none of them has to be corrected afterwards.
 */
export function unreadWorkCount(chats: UnreadChat[], visibleChatId?: string | null): number {
  return chats.filter((chat) => chat.hasUnreadWork && chat.id !== visibleChatId).length;
}
