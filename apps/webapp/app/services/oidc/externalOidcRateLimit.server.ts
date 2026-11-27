import { Ratelimit } from "@upstash/ratelimit";
import type { RateLimiterRedisClient } from "~/services/rateLimiterCore.server";

const EXTERNAL_OIDC_RUN_REQUESTS_PER_MINUTE = 30;

export class ExternalOidcRateLimits {
  private readonly run: Ratelimit;

  constructor(redis: RateLimiterRedisClient) {
    this.run = new Ratelimit({
      redis,
      prefix: "ratelimit:external-oidc:run",
      limiter: Ratelimit.slidingWindow(EXTERNAL_OIDC_RUN_REQUESTS_PER_MINUTE, "1 m"),
      ephemeralCache: false,
      analytics: false,
      // Never allow signing because the limiter timed out.
      timeout: 0,
    });
  }

  async check(environmentId: string, runId: string): Promise<number | undefined> {
    const run = await this.run.limit(`{${environmentId}:${runId}}`);
    return run.success ? undefined : retryAfterSeconds(run.reset);
  }
}

function retryAfterSeconds(reset: number): number {
  return Math.max(1, Math.ceil((reset - Date.now()) / 1_000));
}
