import type { TurnActivity } from "./DashboardAgentMessages";

// Which chat the history list shows as busy. Only the mounted chat reports.

export function markerAfterActivity(
  previous: string | null,
  chatId: string,
  activity: TurnActivity | null
): string | null {
  return activity !== null ? chatId : previous === chatId ? null : previous;
}

// A streaming chat unmounts on a switch without reporting null — the turn carries on
// server-side — so the marker is dropped once another chat (or the draft) is active.
export function markerAfterActiveChat(
  previous: string | null,
  activeChatId: string | undefined
): string | null {
  return previous === activeChatId ? previous : null;
}
