import { WebhookDeliveryId } from "@trigger.dev/core/v3/isomorphic";

/**
 * Compute the `createdAt` span covering a set of webhook delivery friendlyIds, for partition-pruning a
 * lookup by id on the RANGE-partitioned `WebhookDelivery` table.
 *
 * Each v1 id is time-encoded (see `WebhookDeliveryId`) with the same timestamp the engine stores as the
 * row's `createdAt`, so the returned `[gte, lte]` covers every row in the set exactly. Returns
 * `undefined` when the set is empty or contains any legacy (non-time-encoded) id: in that case the
 * caller must not add a `createdAt` predicate, since a bound derived from only the decodable ids would
 * wrongly exclude the legacy rows.
 *
 * Single pass, no intermediate arrays and no `Math.min(...spread)` (which is O(n) to build the argument
 * list and can overflow the call stack for large inputs).
 */
export function deliveryIdsCreatedAtBounds(
  friendlyIds: string[]
): { gte: Date; lte: Date } | undefined {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const friendlyId of friendlyIds) {
    const timestamp = WebhookDeliveryId.parseTimestamp(friendlyId);
    if (!timestamp) return undefined;
    const ms = timestamp.getTime();
    if (ms < min) min = ms;
    if (ms > max) max = ms;
  }

  if (min === Number.POSITIVE_INFINITY) return undefined;
  return { gte: new Date(min), lte: new Date(max) };
}
