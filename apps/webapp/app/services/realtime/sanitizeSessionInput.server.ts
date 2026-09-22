/**
 * Strip a client-forged `actionSource: "webhook"` from a session `.in` append part.
 *
 * Only the hosted webhook ingress may claim webhook trust, and it appends server-side rather than
 * through the client append route. A client with session write access could otherwise send a record
 * carrying `actionSource: "webhook"`, which the run loop uses to skip action-schema validation. We
 * downgrade it here (delete the field) so the record is validated as a normal client action.
 *
 * The part is always parsed rather than string-matched: JSON allows the property name to be spelled
 * with escapes (`"action\u0053ource"`), which a substring check misses and `JSON.parse` canonicalizes
 * to the same key the runtime reads. A part that does not parse is passed through unchanged; the
 * runtime rejects it as malformed.
 */
export function stripClientWebhookActionSource(part: string): string {
  let record: unknown;
  try {
    record = JSON.parse(part);
  } catch {
    return part;
  }
  if (!record || typeof record !== "object") return part;

  const payload = (record as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") return part;
  if (!Object.hasOwn(payload, "actionSource")) return part;

  if ((payload as { actionSource?: unknown }).actionSource === "webhook") {
    delete (payload as { actionSource?: unknown }).actionSource;
    return JSON.stringify(record);
  }

  return part;
}
