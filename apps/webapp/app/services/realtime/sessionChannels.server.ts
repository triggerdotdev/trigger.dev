import type { RbacResource } from "@trigger.dev/rbac";

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

export function isSafeSessionExternalId(externalId: string): boolean {
  return !externalId.includes(SESSION_CHANNEL_SCOPE_INFIX);
}

/**
 * Build the authorization resource set for a named channel. For each candidate
 * session key (URL form, friendlyId, externalId) we authorize BOTH the
 * channel-folded id (`${key}:channels:${channel}`, matched by a narrow
 * channel-scoped token) and the bare session id (`${key}`, matched by a
 * session-wide token so it grants every channel). RBAC matches ids exactly, so
 * a channel token cannot match the bare session and vice versa.
 */
export function sessionChannelResources(channel: string, keys: Iterable<string>): RbacResource[] {
  const resources: RbacResource[] = [];
  for (const key of keys) {
    resources.push({ type: "sessions", id: `${key}:channels:${channel}` });
    resources.push({ type: "sessions", id: key });
  }
  return resources;
}
