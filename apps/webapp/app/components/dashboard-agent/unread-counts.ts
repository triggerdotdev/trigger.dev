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

/**
 * The work count the launcher's dot shows, given what the poll just reported. A chat open in
 * the panel is being read right now, so it is not work anyone is waiting on.
 *
 * Both inputs have to be read at poll time rather than captured when the poll started: the
 * panel opens and closes without restarting it.
 */
export function unreadWorkForDot(params: {
  reported: number | undefined;
  panelOpen: boolean;
  visibleChatId: string | null;
}): number {
  const onScreen = params.panelOpen && params.visibleChatId !== null ? 1 : 0;
  return Math.max(0, (params.reported ?? 0) - onScreen);
}

/**
 * The count the dot settles on the moment the panel closes. While the panel is open the poll
 * subtracts the chat on screen, and it only corrects itself a tick later — up to a minute of a
 * dark dot over work nobody has seen. The panel's own count is taken off the chat list it has
 * already marked read, so it settles the closing edge without waiting. `null` is a panel that
 * closed before its list loaded, which leaves the shown count alone.
 */
export function unreadWorkOnPanelClose(params: {
  shown: number;
  panelCount: number | null;
}): number {
  return params.panelCount ?? params.shown;
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
