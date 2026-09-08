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
