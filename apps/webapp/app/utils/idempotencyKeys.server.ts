import { createHash } from "node:crypto";
import type { RbacAbility } from "@trigger.dev/plugins";

export function resolveRunWaitpointIdempotencyKey(
  key: string | undefined,
  runId: string,
  ability: RbacAbility
): string | undefined {
  if (
    !key ||
    (ability.can("write", { type: "waitpoints" }) && ability.can("read", { type: "waitpoints" }))
  ) {
    return key;
  }
  // Environment-wide keys could otherwise attach a scoped run to another run's waitpoint.
  return `run:${createHash("sha256")
    .update(JSON.stringify([runId, key]))
    .digest("hex")}`;
}

/**
 * Resolve the TTL for an idempotency key.
 *
 * The TTL format is a string like "5m", "1h", "7d"
 *
 * @param ttl The TTL string
 * @returns The date when the key will expire
 * @throws If the TTL string is invalid
 */
export function resolveIdempotencyKeyTTL(ttl: string | undefined | null): Date | undefined {
  if (!ttl) {
    return undefined;
  }

  const match = ttl.match(/^(\d+)([smhd])$/);

  if (!match) {
    return;
  }

  const [, value, unit] = match;

  const now = new Date();

  switch (unit) {
    case "s":
      now.setSeconds(now.getSeconds() + parseInt(value, 10));
      break;
    case "m":
      now.setMinutes(now.getMinutes() + parseInt(value, 10));
      break;
    case "h":
      now.setHours(now.getHours() + parseInt(value, 10));
      break;
    case "d":
      now.setDate(now.getDate() + parseInt(value, 10));
      break;
  }

  return now;
}
