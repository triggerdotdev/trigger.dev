import type { Redis } from "@internal/redis";
import type { RunQueueKeyProducer } from "../types.js";

/**
 * Rewrites the ckIndex ZSET scores so the unmodified CK-dequeue Lua serves
 * CK-queues in a discipline's order. The Lua picks lowest-score-first among
 * members with score <= now, so we assign the highest-priority CK the smallest
 * score. All scores are placed just below `now` in descending priority, so they
 * stay eligible (<= now) and strictly order-preserving.
 *
 * `order` is the CK-queue members (ckIndex member form, i.e. no keyPrefix),
 * highest priority first.
 */
export async function rescoreCkIndex(
  redis: Redis,
  keys: RunQueueKeyProducer,
  baseQueue: string,
  order: string[],
  now: number
): Promise<void> {
  if (order.length === 0) return;
  const ckIndexKey = keys.ckIndexKeyFromQueue(baseQueue);
  const args: (string | number)[] = [];
  for (let i = 0; i < order.length; i++) {
    // smallest score for the best (i=0), all < now
    args.push(now - (order.length - i), order[i]);
  }
  await redis.zadd(ckIndexKey, ...args);
}
