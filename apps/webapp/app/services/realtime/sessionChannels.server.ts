import type { RbacResource } from "@trigger.dev/rbac";

export type SessionStreamIo = "out" | "in";

/**
 * Channel names are both a URL path segment and an S2 stream-name segment, and
 * they fold into the RBAC resource id as `${key}:channels:${channel}`, so a
 * `/` would break addressing and a `:` would break scope parsing. Constrain to
 * a safe, bounded alphabet.
 */
export const SESSION_CHANNEL_NAME_REGEX = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The infix the channel-scope fold uses in the RBAC resource id
 * (`${key}:channels:${channel}`). A session externalId is used verbatim as a
 * resource key, so an externalId containing this infix could equal a
 * channel-scoped token's folded id and collide with it. Reject it at session
 * creation so a bare session key can never look like a folded channel key.
 */
export const SESSION_CHANNEL_SCOPE_INFIX = ":channels:";

/**
 * The direction fold appends `:out` / `:in` to a session key (or to a folded
 * channel key), so `read:sessions:{key}:out` matches only that key's `.out`
 * stream. An externalId ending in one of these suffixes would collide with a
 * direction-scoped token's folded id the same way the channel infix would.
 */
const SESSION_IO_SCOPE_SUFFIX_REGEX = /:(?:out|in)$/;

/**
 * Session creation rejects externalIds that look like a folded id, but rows created before a
 * fold existed may still carry one. The resource builders below skip such a key entirely: a
 * bare id equal to some other session's folded id must never be authorized by that other
 * session's narrowed token. The row stays reachable through its friendlyId (always in the key
 * set) and through type-level or wildcard scopes.
 */
export function isSafeSessionExternalId(externalId: string): boolean {
  return (
    !externalId.includes(SESSION_CHANNEL_SCOPE_INFIX) &&
    !SESSION_IO_SCOPE_SUFFIX_REGEX.test(externalId)
  );
}

/**
 * Build the authorization resource set for a session's default stream. For
 * each candidate session key (URL form, friendlyId, externalId) we authorize
 * BOTH the bare session id (`${key}`, matched by a session-wide token) and the
 * direction-folded id (`${key}:${io}`, matched by a token narrowed to that one
 * direction). RBAC matches ids exactly, so a `{key}:out` token cannot match
 * the bare session or the `.in` stream.
 */
export function sessionStreamResources(
  io: SessionStreamIo,
  keys: Iterable<string>
): RbacResource[] {
  const resources: RbacResource[] = [];
  for (const key of keys) {
    if (!isSafeSessionExternalId(key)) continue;
    resources.push({ type: "sessions", id: key });
    resources.push({ type: "sessions", id: `${key}:${io}` });
  }
  return resources;
}

/**
 * Build the authorization resource set for a named channel. For each candidate
 * session key (URL form, friendlyId, externalId) we authorize the bare session
 * id (`${key}`, a session-wide token grants every channel), the channel-folded
 * id (`${key}:channels:${channel}`, a channel-scoped token) and, when `io` is
 * given, the direction-folded channel id (`${key}:channels:${channel}:${io}`).
 * RBAC matches ids exactly, so a channel token cannot match the bare session
 * and vice versa.
 */
export function sessionChannelResources(
  channel: string,
  keys: Iterable<string>,
  io?: SessionStreamIo
): RbacResource[] {
  const resources: RbacResource[] = [];
  for (const key of keys) {
    if (!isSafeSessionExternalId(key)) continue;
    const channelKey = `${key}${SESSION_CHANNEL_SCOPE_INFIX}${channel}`;
    resources.push({ type: "sessions", id: channelKey });
    if (io) resources.push({ type: "sessions", id: `${channelKey}:${io}` });
    resources.push({ type: "sessions", id: key });
  }
  return resources;
}
