import type { Redis } from "@internal/redis";
import type { RunQueueKeyProducer } from "../types.js";

/**
 * Reads the concurrency-key index for a base queue. `ckIndexKey` is a ZSET whose
 * members are CK-queue names (the queue key WITHOUT the redis keyPrefix, since
 * the dequeue Lua re-prepends the prefix) scored by each CK-queue's head-message
 * timestamp. This is the structure the per-CK dequeue picks from.
 */

export type ActiveCk = {
  /** the ckIndex member: CK-queue key without the redis keyPrefix */
  ckQueue: string;
  concurrencyKey: string;
  headScore: number;
};

export class CkReader {
  constructor(
    private readonly redis: Redis,
    private readonly keys: RunQueueKeyProducer,
    private readonly keyPrefix: string
  ) {}

  async readActiveCks(baseQueue: string): Promise<ActiveCk[]> {
    const ckIndexKey = this.keys.ckIndexKeyFromQueue(baseQueue);
    const raw = await this.redis.zrange(ckIndexKey, 0, -1, "WITHSCORES");

    const out: ActiveCk[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const ckQueue = raw[i];
      const headScore = Number(raw[i + 1]);
      // Members are stored without the keyPrefix; descriptorFromQueue parses the
      // structural key, which does not include the prefix.
      const descriptor = this.keys.descriptorFromQueue(ckQueue);
      out.push({
        ckQueue,
        concurrencyKey: descriptor.concurrencyKey ?? "__none__",
        headScore,
      });
    }
    return out;
  }
}
