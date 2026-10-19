import { WebhookDeliveryId } from "@trigger.dev/core/v3/isomorphic";

/**
 * Single-pass min/max over a set of `createdAt` timestamps (unix ms), returned as a Prisma
 * `{ gte, lte }` range for partition-pruning the RANGE-partitioned `WebhookDelivery` table.
 *
 * Avoids `Math.min(...spread)` / `Math.max(...spread)`: the spread builds an O(n) argument list and
 * throws "Maximum call stack size exceeded" once the array is large (~1e5+ elements). Returns
 * `undefined` for an empty set, so the caller adds no `createdAt` predicate.
 */
export function createdAtMsBounds(msValues: number[]): { gte: Date; lte: Date } | undefined {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const ms of msValues) {
    if (ms < min) min = ms;
    if (ms > max) max = ms;
  }

  if (min === Number.POSITIVE_INFINITY) return undefined;
  return { gte: new Date(min), lte: new Date(max) };
}

/**
 * Compute the `createdAt` span covering a set of webhook delivery friendlyIds, for partition-pruning
 * a lookup by id on the RANGE-partitioned `WebhookDelivery` table.
 *
 * A delivery id body is `base32hex(big-endian ms timestamp then random bytes)`, and base32hex is
 * order-preserving, so lexical id order equals chronological order. The earliest and latest
 * timestamps therefore sit at the lexical extremes, and we recover the span by decoding only those
 * two ids instead of all N. The embedded timestamp equals the row's `createdAt`, so `[gte, lte]`
 * covers every row in the set exactly.
 *
 * Returns `undefined` for an empty set, or if an extreme id fails to decode, so the caller adds no
 * `createdAt` predicate and the lookup stays correct (just unpruned).
 */
export function deliveryIdsCreatedAtBounds(
  friendlyIds: string[]
): { gte: Date; lte: Date } | undefined {
  if (friendlyIds.length === 0) return undefined;

  let minBody = WebhookDeliveryId.toId(friendlyIds[0]!);
  let maxBody = minBody;
  for (let i = 1; i < friendlyIds.length; i++) {
    const body = WebhookDeliveryId.toId(friendlyIds[i]!);
    if (body < minBody) minBody = body;
    if (body > maxBody) maxBody = body;
  }

  const gte = WebhookDeliveryId.parseTimestamp(minBody);
  const lte = WebhookDeliveryId.parseTimestamp(maxBody);
  if (!gte || !lte) return undefined;

  return { gte, lte };
}

/** The oldest `createdAt` an org with this retention can still see. */
export function retentionFloor(retentionDays: number, now = Date.now()): Date {
  return new Date(now - retentionDays * 86_400_000);
}

/**
 * The retention classes a set of delivery ids were minted in, for partition-pruning a lookup on the
 * LIST-partitioned `WebhookDelivery` table. Returns `undefined` if any id carries no class (a v1
 * id), so the caller adds no `retentionDays` predicate and the lookup stays correct.
 */
export function deliveryIdsRetentionDays(friendlyIds: string[]): number[] | undefined {
  const days = new Set<number>();
  for (const friendlyId of friendlyIds) {
    const retentionDays = WebhookDeliveryId.parseRetentionDays(friendlyId);
    if (retentionDays === undefined) return undefined;
    days.add(retentionDays);
  }
  return [...days];
}
