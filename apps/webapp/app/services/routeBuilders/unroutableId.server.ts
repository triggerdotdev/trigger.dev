import { json } from "@remix-run/server-runtime";
import { UnknownShardKey } from "@internal/run-store";

/**
 * An id naming a shard the topology has no store for cannot be routed, so a read cannot locate
 * the row: that is a 404, and matches what an absent gen-1 or cuid id already returns. It must
 * not be a 500 — `resolveShard` is pure id-shape, so any base32hex core plus `[a-z0-9]` plus "2"
 * parses as gen-2, which lets any caller induce a 5xx, and a 5xx on a read trips canary rollbacks.
 *
 * The router still throws. Callers log it before returning this, so a genuine misconfiguration —
 * a shard key dropped from a config that is meant to be append-only — still alarms.
 */
export function unroutableIdResponse(error: unknown): Response | undefined {
  // Explicitly NOT retryable: an id naming an unconfigured shard is not a transient miss, and
  // no number of retries makes a topology grow a store.
  return error instanceof UnknownShardKey
    ? json({ error: "Not Found" }, { status: 404, headers: { "x-should-retry": "false" } })
    : undefined;
}
