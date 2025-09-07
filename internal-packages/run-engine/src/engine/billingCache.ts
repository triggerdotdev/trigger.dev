import {
  createCache,
  DefaultStatefulContext,
  MemoryStore,
  Namespace,
  Ok,
  RedisCacheStore,
  type UnkeyCache,
  type CacheError,
  type Result,
} from "@internal/cache";
import type { RedisOptions } from "@internal/redis";
import type { Logger } from "@trigger.dev/core/logger";
import type { RunEngineOptions } from "./types.js";

// Cache TTLs for billing information - shorter than other caches since billing can change
const BILLING_FRESH_TTL = 60000 * 5; // 5 minutes
const BILLING_STALE_TTL = 60000 * 10; // 10 minutes

export type BillingPlan = {
  isPaying: boolean;
  type: "free" | "paid" | "enterprise";
};

export type BillingCacheOptions = {
  billingOptions?: RunEngineOptions["billing"];
  redisOptions: RedisOptions;
  logger: Logger;
};

export class BillingCache {
  private readonly cache: UnkeyCache<{
    currentPlan: BillingPlan;
  }>;
  private readonly logger: Logger;
  private readonly billingOptions?: RunEngineOptions["billing"];

  constructor(options: BillingCacheOptions) {
    this.logger = options.logger;
    this.billingOptions = options.billingOptions;

    // Initialize cache
    const ctx = new DefaultStatefulContext();
    const memory = new MemoryStore({ persistentMap: new Map() });
    const redisCacheStore = new RedisCacheStore({
      name: "billing-cache",
      connection: {
        ...options.redisOptions,
        keyPrefix: "engine:billing:cache:",
      },
      useModernCacheKeyBuilder: true,
    });

    this.cache = createCache({
      currentPlan: new Namespace<BillingPlan>(ctx, {
        stores: [memory, redisCacheStore],
        fresh: BILLING_FRESH_TTL,
        stale: BILLING_STALE_TTL,
      }),
    });
  }

  /**
   * Gets the current billing plan for an organization
   * Returns a Result that allows the caller to handle errors and missing values
   */
  async getCurrentPlan(orgId: string): Promise<Result<BillingPlan | undefined, CacheError>> {
    if (!this.billingOptions?.getCurrentPlan) {
      // Return a successful result with default free plan
      return Ok({ isPaying: false, type: "free" });
    }

    return await this.cache.currentPlan.swr(orgId, async () => {
      // This is safe because options can't change at runtime
      const planResult = await this.billingOptions!.getCurrentPlan(orgId);
      return { isPaying: planResult.isPaying, type: planResult.type };
    });
  }

  /**
   * Invalidates the billing cache for an organization when their plan changes
   * Runs in background and handles all errors internally
   */
  invalidate(orgId: string): void {
    this.cache.currentPlan.remove(orgId).catch((error) => {
      this.logger.warn("Failed to invalidate billing cache", {
        orgId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
