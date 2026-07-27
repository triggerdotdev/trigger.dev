import { createRedisClient, type RedisClient, type RedisWithClusterOptions } from "~/redis.server";
import { logger } from "~/services/logger.server";

export type BatchStreamGrantsOptions = {
  redis: RedisWithClusterOptions;
  /** How many phase 2 requests a created batch is allowed. */
  attempts: number;
  /** How long the grant survives, matching how long a batch may legitimately be sealing. */
  ttlMs: number;
};

const KEY_PREFIX = "batch-stream-grant:";

/**
 * Admission for phase 2 of the 2-phase batch API.
 *
 * Phase 1 (`POST /api/v3/batches`) already passes its own batch rate limiter, which fixes
 * the batch's `expectedCount` and blocks the parent run on the batch's waitpoint. Phase 2
 * (`POST /api/v3/batches/:id/items`) is the only thing that can seal that batch, so having
 * the general API limiter reject it strands the batch and the parent with it.
 *
 * Phase 1 therefore mints a bounded grant, and phase 2 spends it to bypass the general
 * limiter. Admission stays a single decision made in phase 1, but the bypass is capped at
 * `attempts` requests per batch rather than being unconditional.
 */
export class BatchStreamGrants {
  private readonly redis: RedisClient;

  constructor(private readonly options: BatchStreamGrantsOptions) {
    this.redis = createRedisClient("batchStreamGrants", options.redis);
    this.#registerCommands();
  }

  /**
   * Grant a newly created batch its phase 2 budget. Never throws: a batch that fails to get
   * a grant still works, it just falls back to the general rate limiter for streaming.
   */
  async mint(batchId: string): Promise<void> {
    try {
      await this.redis.set(this.#key(batchId), this.options.attempts, "PX", this.options.ttlMs);
    } catch (error) {
      logger.warn("BatchStreamGrants: failed to mint grant", {
        batchId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Consume one phase 2 request from the batch's grant.
   *
   * Returns false when there is no grant, when the budget is spent, or when Redis is
   * unreachable, so the caller falls back to the general rate limiter rather than opening
   * an unbounded bypass.
   */
  async spend(batchId: string): Promise<boolean> {
    try {
      // @ts-expect-error - Custom command defined via defineCommand
      const remaining = (await this.redis.spendBatchStreamGrant(this.#key(batchId))) as number;

      return remaining >= 0;
    } catch (error) {
      logger.warn("BatchStreamGrants: failed to spend grant", {
        batchId,
        error: error instanceof Error ? error.message : String(error),
      });

      return false;
    }
  }

  async quit(): Promise<void> {
    await this.redis.quit();
  }

  #key(batchId: string): string {
    return `${KEY_PREFIX}${batchId}`;
  }

  #registerCommands(): void {
    this.redis.defineCommand("spendBatchStreamGrant", {
      numberOfKeys: 1,
      lua: `
local remaining = tonumber(redis.call('GET', KEYS[1]))

if not remaining or remaining <= 0 then
  return -1
end

return redis.call('DECR', KEYS[1])
      `,
    });
  }
}
