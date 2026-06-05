import type { Redis } from "ioredis";
import { z } from "zod";
import type { BackpressureSignalSource, BackpressureVerdict } from "./backpressureMonitor.js";

const VerdictSchema = z.object({
  engaged: z.boolean(),
  ts: z.number().optional(),
});

/** Reads the backpressure verdict from a Redis key written by the cluster-side aggregator. */
export class RedisBackpressureSignalSource implements BackpressureSignalSource {
  constructor(
    private readonly redis: Redis,
    private readonly key: string
  ) {}

  async read(): Promise<BackpressureVerdict | null> {
    const raw = await this.redis.get(this.key);
    if (raw === null) {
      return null;
    }

    // A malformed or wrong-shaped value is treated as unknown (null) so the
    // monitor fails open rather than acting on garbage.
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }

    const parsed = VerdictSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  }
}
