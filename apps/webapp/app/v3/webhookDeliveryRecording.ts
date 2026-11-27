import { WebhookDeliveryId } from "@trigger.dev/core/v3/isomorphic";

/** How long after a delivery id is minted its row can still be on the way to the database. */
const RECORDING_WINDOW_MS = 60_000;

/**
 * True for a delivery that isn't in the database yet but was minted moments ago. A delivery's id
 * is handed out before its row is written (a replay answers with the new id as soon as the
 * delivery is queued), so for a short while a real delivery can't be found. The id carries its
 * mint time, which tells that apart from a delivery that aged out or never existed.
 */
export function isDeliveryStillBeingRecorded(deliveryFriendlyId: string, now: Date): boolean {
  const mintedAt = WebhookDeliveryId.parseTimestamp(deliveryFriendlyId);
  if (!mintedAt) return false;
  const age = now.getTime() - mintedAt.getTime();
  return age >= 0 && age < RECORDING_WINDOW_MS;
}
