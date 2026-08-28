import type { RbacResource } from "@trigger.dev/rbac";

/**
 * Channel names are both a URL path segment and an S2 stream-name segment, and
 * they fold into the RBAC resource id as `${key}:channels:${channel}` — so a
 * `/` would break addressing and a `:` would break scope parsing. Constrain to
 * a safe, bounded alphabet.
 */
export const SESSION_CHANNEL_NAME_REGEX = /^[A-Za-z0-9._-]{1,128}$/;

export function isValidSessionChannelName(channel: string): boolean {
  return SESSION_CHANNEL_NAME_REGEX.test(channel);
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
