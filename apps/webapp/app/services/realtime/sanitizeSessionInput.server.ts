/**
 * Strip the fields only the hosted webhook ingress may set from a session `.in` append part.
 *
 * The ingress appends server-side, never through a client append route. A client with session write
 * access could otherwise send a record carrying `actionSource: "webhook"`, which the run loop uses to
 * skip action-schema validation, or a `channelEvent`, which the run loop treats as a verified provider
 * delivery and hands to the channel connector. We delete both, so an action is validated as a normal
 * client action and a message is a normal client message.
 *
 * The part is always parsed rather than string-matched: JSON allows a property name to be spelled
 * with escapes (`"action\u0053ource"`), which a substring check misses and `JSON.parse` canonicalizes
 * to the same key the runtime reads. A part that does not parse is passed through unchanged; the
 * runtime rejects it as malformed.
 */
export function stripClientIngressFields(part: string): string {
  let record: unknown;
  try {
    record = JSON.parse(part);
  } catch {
    return part;
  }
  if (!record || typeof record !== "object") return part;

  const payload = (record as { payload?: unknown }).payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return part;

  const forgedWebhookAction =
    Object.hasOwn(payload, "actionSource") && payload.actionSource === "webhook";
  const forgedChannelEvent = Object.hasOwn(payload, "channelEvent");
  if (!forgedWebhookAction && !forgedChannelEvent) return part;

  if (forgedWebhookAction) delete payload.actionSource;
  if (forgedChannelEvent) delete payload.channelEvent;
  return JSON.stringify(record);
}
