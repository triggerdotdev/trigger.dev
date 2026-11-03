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
  return sanitizeClientInPart(part).part;
}

/**
 * {@link stripClientIngressFields}, plus the record's `kind` read from the same parse, so a route can
 * refuse kinds only a server may append (see {@link isServerOnlySessionInKind}).
 */
export function sanitizeClientInPart(part: string): { part: string; kind: string | undefined } {
  let record: unknown;
  try {
    record = JSON.parse(part);
  } catch {
    return { part, kind: undefined };
  }
  if (!record || typeof record !== "object") return { part, kind: undefined };

  const rawKind = (record as { kind?: unknown }).kind;
  const kind = typeof rawKind === "string" ? rawKind : undefined;

  const payload = (record as { payload?: unknown }).payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return { part, kind };

  return { part: removeClientIngressFields(payload) ? JSON.stringify(record) : part, kind };
}

/**
 * `.in` record kinds only the customer's server sends: the head-start handover and its skip signal. The
 * agent takes the first one it receives as the warm first-turn response, tool calls included, so a
 * public access token must not be able to append one.
 */
export function isServerOnlySessionInKind(kind: string | undefined): boolean {
  return kind === "handover" || kind === "handover-skip";
}

export function stripClientIngressFieldsFromBasePayload<T extends Record<string, unknown>>(
  basePayload: T
): T {
  const copy = { ...basePayload };
  removeClientIngressFields(copy);
  return copy;
}

function removeClientIngressFields(payload: Record<string, unknown>): boolean {
  const forgedWebhookAction =
    Object.hasOwn(payload, "actionSource") && payload.actionSource === "webhook";
  const forgedChannelEvent = Object.hasOwn(payload, "channelEvent");
  if (forgedWebhookAction) delete payload.actionSource;
  if (forgedChannelEvent) delete payload.channelEvent;
  return forgedWebhookAction || forgedChannelEvent;
}
