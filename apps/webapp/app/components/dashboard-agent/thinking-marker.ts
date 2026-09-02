import type { TurnActivity } from "./DashboardAgentMessages";
import { TOOL_PENDING_DEADLINE_MS } from "./turn-deadlines";

// Which chat the history list shows as busy. Only the mounted chat reports.

export type ThinkingMarker = { chatId: string; expiresAt: number };

export function markerAfterActivity(
  previous: ThinkingMarker | null,
  chatId: string,
  activity: TurnActivity | null,
  now: number
): ThinkingMarker | null {
  if (activity !== null) return { chatId, expiresAt: now + TOOL_PENDING_DEADLINE_MS };
  return previous?.chatId === chatId ? null : previous;
}

// A streaming chat unmounts on a switch without reporting null — the turn carries on
// server-side — so the marker stays and runs on the deadline from the moment it detaches.
export function markerAfterActiveChat(
  previous: ThinkingMarker | null,
  activeChatId: string | undefined,
  now: number
): ThinkingMarker | null {
  if (previous === null || previous.chatId === activeChatId) return previous;
  return { chatId: previous.chatId, expiresAt: now + TOOL_PENDING_DEADLINE_MS };
}

// The mounted chat's status is live truth, so only a detached marker can expire.
export function markerChatId(
  marker: ThinkingMarker | null,
  activeChatId: string | undefined,
  now: number
): string | null {
  if (marker === null) return null;
  if (marker.chatId === activeChatId) return marker.chatId;
  return marker.expiresAt > now ? marker.chatId : null;
}
