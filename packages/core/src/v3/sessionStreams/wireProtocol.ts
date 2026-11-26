/**
 * Wire-format constants for records on `session.out` / `session.in`.
 *
 * Three kinds of records can appear on a Session stream:
 *
 * 1. **Data records** — JSON body shaped as `{data: <UIMessageChunk>, id:
 *    <partId>}`, no special headers. The substance of the conversation.
 *
 * 2. **Trigger control records** — empty body, `headers` carry `[
 *    ["trigger-control", <subtype>], ...]` plus any subtype-specific sibling
 *    headers (e.g. `public-access-token` on `turn-complete`). Routed to a
 *    consumer's `onControl` callback; never surfaced as data chunks.
 *
 * 3. **S2 command records** — opaque body, `headers` first entry has an
 *    empty name (only valid for S2-interpreted directives like `trim` and
 *    `fence`). Filtered out at the SSE parser; consumers never see them.
 *
 * See `docs/ai-chat/client-protocol.mdx#records-on-session-out` for the
 * customer-facing contract.
 */

/** Header name carrying the Trigger control subtype on control records. */
export const TRIGGER_CONTROL_HEADER = "trigger-control" as const;

/** Header name carrying the refreshed `publicAccessToken` on `turn-complete`. */
export const PUBLIC_ACCESS_TOKEN_HEADER = "public-access-token" as const;

/** Header name carrying the agent's last S2 event id on a handover bridge. */
export const SESSION_STATE_LAST_EVENT_ID_HEADER = "last-event-id" as const;

/**
 * Header on `turn-complete` records carrying the highest `session.in`
 * seq_num the agent committed to processing during this turn. Read on
 * the next worker boot to seed `.in`'s resume cursor — anything past
 * this seq is new and gets delivered; anything at-or-before was already
 * processed and is skipped. Decimal-string form of the seq_num.
 *
 * Omitted when no `.in` records have been consumed yet (first turn of a
 * fresh chat triggered via the wire payload).
 */
export const SESSION_IN_EVENT_ID_HEADER = "session-in-event-id" as const;

/**
 * Sibling of {@link SESSION_IN_EVENT_ID_HEADER}: the highest `.in` sequence this
 * run had actually consumed at the turn boundary, unclamped.
 *
 * The resume cursor is held back behind records still waiting to be handled, so
 * resuming from it necessarily re-delivers records that WERE handled. A message
 * re-delivered that way is the point. A control record re-delivered that way is
 * a bug: it applies a second time to whatever turn is live on the new run. On
 * boot this bound tells the run which control records it has already seen.
 */
export const SESSION_IN_CONSUMED_ID_HEADER = "session-in-consumed-id" as const;

/**
 * Header marking a session as closed. Carried by the `session-closed` control
 * record, and also stamped on a `turn-complete` record when the close was
 * decided before that turn ended — readers terminate their stream on
 * turn-complete, so that is the last moment a live client can be told.
 */
export const SESSION_CLOSED_HEADER = "session-closed" as const;

/**
 * Header on `turn-start` records: the `.in` seq of the message the turn
 * answers (a comma-separated list of seqs on `turn-join` records). Readers compare it with the seq their own append returned to tell
 * their turn from someone else's without waiting for the turn's boundary.
 * Omitted when the turn answers no `.in` message (one started from the run's
 * start payload, such as a head start), which is no reader's own turn.
 */
export const TURN_START_IN_SEQ_HEADER = "turn-start-in-seq" as const;

/**
 * Header on `turn-join` records: the `id` of the `data-pending-message-injected`
 * chunk the agent writes for the messages the record names. Written only when
 * that chunk is ordered with the step's other chunks (the turn's output goes out
 * through the agent's managed response); a reader taking the rest of the turn
 * starts right after it. Absent when it isn't (the output is piped on its own,
 * as with `chat.pipe`, and the chunk can land after the step it should precede),
 * or when the agent injects nothing: the reader then starts at the next
 * `start-step`.
 */
export const TURN_JOIN_INJECTION_ID_HEADER = "turn-join-injection-id" as const;

/**
 * Header on `session-closed` records carrying the reason the session was
 * closed, as supplied to `chat.close({ reason })` / `sessions.close()`.
 * Omitted when no reason was given.
 */
export const SESSION_CLOSED_REASON_HEADER = "session-closed-reason" as const;

export const TRIGGER_CONTROL_SUBTYPE = {
  TURN_COMPLETE: "turn-complete",
  UPGRADE_REQUIRED: "upgrade-required",
  SESSION_CLOSED: "session-closed",
  PENDING_VERSION: "pending-version",
} as const;

export type TriggerControlSubtype =
  (typeof TRIGGER_CONTROL_SUBTYPE)[keyof typeof TRIGGER_CONTROL_SUBTYPE];

/**
 * Control records that say whose turn the records around them belong to. Kept
 * apart from {@link TRIGGER_CONTROL_SUBTYPE} so its public union type doesn't
 * widen: code that switches over `TriggerControlSubtype` exhaustively keeps
 * compiling. Readers that don't know these skip them like any other control
 * record.
 */
export const TRIGGER_TURN_MARKER_SUBTYPE = {
  /**
   * First record of a turn on `.out`: marks whose turn the records up to the
   * next `turn-complete` belong to (see {@link TURN_START_IN_SEQ_HEADER}).
   */
  TURN_START: "turn-start",
  /**
   * Written mid-turn when pending (steering) messages are folded into the turn
   * that is running: the records that follow also answer those messages. Names
   * them in {@link TURN_START_IN_SEQ_HEADER} as a comma-separated list of `.in`
   * seqs.
   */
  TURN_JOIN: "turn-join",
} as const;

/** Read a single header value by name. Returns the first match. */
export function headerValue(
  headers: ReadonlyArray<readonly [string, string]> | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  for (const entry of headers) {
    if (entry?.[0] === name) return entry[1];
  }
  return undefined;
}

/**
 * Return the Trigger control subtype carried by a record's headers, if any.
 * Returns `undefined` for data records and S2 command records.
 */
export function controlSubtype(
  headers: ReadonlyArray<readonly [string, string]> | undefined
): string | undefined {
  return headerValue(headers, TRIGGER_CONTROL_HEADER);
}

/**
 * Is this record an S2 command record? Detected via the empty-name first
 * header, which S2 permits only for command records (trim/fence).
 */
export function isS2CommandRecord(
  headers: ReadonlyArray<readonly [string, string]> | undefined
): boolean {
  return headers?.[0]?.[0] === "";
}

/** Event payload delivered to a Session-stream `onControl` callback. */
export type ControlEvent = {
  /** Subtype value from the `trigger-control` header (e.g. `turn-complete`). */
  subtype: string;
  /** All headers on the underlying record. Read additional metadata here. */
  headers: ReadonlyArray<readonly [string, string]>;
  /** S2 sequence number of the control record. */
  seqNum: number;
  /** S2 arrival timestamp of the control record (ms since epoch). */
  timestamp: number;
};
