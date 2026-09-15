/**
 * The panel's watch card, as a pure state machine.
 *
 * A card is configured against the chat that is open at the time and submitted against
 * whatever chat is open when `Start watching` is pressed, so it cannot outlive its chat:
 * every chat change abandons it, request id and all. The request id is what makes a retry
 * repair the same pair of server records instead of writing a second pair, so it is held
 * across a failure and dropped with the card.
 */
import type { WatchDraft } from "@internal/dashboard-agent-contracts";

export type WatchCardState = {
  draft: WatchDraft | null;
  requestId: string | undefined;
  pending: boolean;
  error: string | null;
};

export const NO_WATCH_CARD: WatchCardState = {
  draft: null,
  requestId: undefined,
  pending: false,
  error: null,
};

export type WatchCardEvent =
  | { type: "open"; draft: WatchDraft; requestId: string }
  | { type: "edit"; draft: WatchDraft }
  | { type: "submitting"; requestId: string }
  | { type: "failed"; error: string }
  | { type: "submitted" }
  | { type: "dismissed" }
  | { type: "chat-changed" };

export function watchCardReducer(state: WatchCardState, event: WatchCardEvent): WatchCardState {
  switch (event.type) {
    case "open":
      return { draft: event.draft, requestId: event.requestId, pending: false, error: null };
    case "edit":
      return state.draft ? { ...state, draft: event.draft } : state;
    case "submitting":
      return {
        ...state,
        requestId: state.requestId ?? event.requestId,
        pending: true,
        error: null,
      };
    case "failed":
      return { ...state, pending: false, error: event.error };
    case "submitted":
    case "dismissed":
    case "chat-changed":
      return NO_WATCH_CARD;
  }
}
