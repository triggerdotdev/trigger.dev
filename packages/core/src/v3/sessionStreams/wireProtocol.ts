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

export const TRIGGER_CONTROL_SUBTYPE = {
  TURN_COMPLETE: "turn-complete",
  UPGRADE_REQUIRED: "upgrade-required",
} as const;

export type TriggerControlSubtype =
  (typeof TRIGGER_CONTROL_SUBTYPE)[keyof typeof TRIGGER_CONTROL_SUBTYPE];

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
