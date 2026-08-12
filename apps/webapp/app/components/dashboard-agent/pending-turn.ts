/**
 * Which chat this tab is still waiting on. A turn started here can finish after the panel
 * closes — the case the launcher dot exists for — so the wake poll has to keep running until
 * the answer has been seen. The panel reports turn activity while it is mounted; closing it
 * reports nothing, which is what leaves the latch set.
 */

/** `active` is true while a turn is running in `chatId`, false once it is not. */
export function nextPendingTurnChatId(
  current: string | null,
  event: { chatId: string; active: boolean }
): string | null {
  if (event.active) return event.chatId;
  // Only the chat we are waiting on clears the latch; another chat going quiet says nothing
  // about this one.
  return current === event.chatId ? null : current;
}
