import { WATCH_REQUEST_MESSAGE_ID_PREFIX } from "./watch.js";

/**
 * Message ids for the records the agent appends to a chat outside a user's turn.
 *
 * A watch wake, the investigation a wake triggers, its forced closing card and an
 * investigation settlement are all stored with `role: "assistant"`, exactly like an
 * ordinary answer. Only the id tells them apart, so the shapes live here — written once,
 * read by both the writer (`watch-actions`) and the panel.
 */

export const WAKE_MESSAGE_ID_PREFIX = "wake:";
export const INVESTIGATE_MESSAGE_ID_PREFIX = "investigate:";
export const INVESTIGATION_SETTLEMENT_ID_PREFIX = "investigation-settlement:";
/** A forced close appends a second card under the investigation's own id. */
export const SETTLED_MESSAGE_ID_SUFFIX = ":settled";

export function wakeMessageId(actionId: string): string {
  return `${WAKE_MESSAGE_ID_PREFIX}${actionId}`;
}

export function investigateMessageId(actionId: string): string {
  return `${INVESTIGATE_MESSAGE_ID_PREFIX}${actionId}`;
}

export function settledMessageId(messageId: string): string {
  return `${messageId}${SETTLED_MESSAGE_ID_SUFFIX}`;
}

/**
 * The user-role message a wake or investigation turn answers. A watch action is an
 * edit to the conversation, and the turn that follows it needs something to answer,
 * so the action files the wake's facts (or the investigation brief) as a request under
 * a stable id. It is the agent asking itself, not the user typing, so the panel hides
 * it and it never counts against the message cap.
 */
export const WAKE_REQUEST_MESSAGE_ID_PREFIX = "wake-request:";
export const INVESTIGATE_REQUEST_MESSAGE_ID_PREFIX = "investigate-request:";

export function wakeRequestMessageId(actionId: string): string {
  return `${WAKE_REQUEST_MESSAGE_ID_PREFIX}${actionId}`;
}

export function investigateRequestMessageId(actionId: string): string {
  return `${INVESTIGATE_REQUEST_MESSAGE_ID_PREFIX}${actionId}`;
}

const AGENT_REQUEST_ID_PREFIXES = [
  WATCH_REQUEST_MESSAGE_ID_PREFIX,
  WAKE_REQUEST_MESSAGE_ID_PREFIX,
  INVESTIGATE_REQUEST_MESSAGE_ID_PREFIX,
];

/** The request a wake or investigation turn answers: the agent asking itself. */
export function isTurnRequestMessageId(id: string | undefined | null): boolean {
  return (
    typeof id === "string" &&
    (id.startsWith(WAKE_REQUEST_MESSAGE_ID_PREFIX) ||
      id.startsWith(INVESTIGATE_REQUEST_MESSAGE_ID_PREFIX))
  );
}

/**
 * A user-role message the user did not type: a watch consent record, or the request
 * a wake or investigation turn answers. Hidden by the panel, excluded from the message
 * cap, and never the exchange that names a chat.
 */
export function isAgentRequestMessageId(id: string | undefined | null): boolean {
  return typeof id === "string" && AGENT_REQUEST_ID_PREFIXES.some((p) => id.startsWith(p));
}

const TRAILING_RECORD_ID_PREFIXES = [
  WAKE_MESSAGE_ID_PREFIX,
  INVESTIGATE_MESSAGE_ID_PREFIX,
  INVESTIGATION_SETTLEMENT_ID_PREFIX,
];

/**
 * Whether a message is one of those records rather than a turn's own answer.
 *
 * Turn messages are keyed by the SDK's generated id, which never carries one of these
 * prefixes — so this stays false for every ordinary answer.
 */
export function isTrailingAgentRecord(id: string | undefined): boolean {
  return (
    typeof id === "string" && TRAILING_RECORD_ID_PREFIXES.some((prefix) => id.startsWith(prefix))
  );
}
