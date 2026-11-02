import { Ratelimit } from "@upstash/ratelimit";
import type { RateLimiterRedisClient } from "~/services/rateLimiterCore.server";

const EXTERNAL_OIDC_RUN_REQUESTS_PER_MINUTE = 30;
const EXTERNAL_OIDC_ENV_REQUESTS_PER_MINUTE = 2_000;

export class ExternalOidcRateLimits {
  private readonly run: Ratelimit;
  private readonly environment: Ratelimit;

  constructor(redis: RateLimiterRedisClient) {
    const create = (scope: string, requests: number) =>
      new Ratelimit({
        redis,
        prefix: `ratelimit:external-oidc:${scope}`,
        limiter: Ratelimit.slidingWindow(requests, "1 m"),
        ephemeralCache: false,
        analytics: false,
        // Never allow signing because the limiter timed out.
        timeout: 0,
      });
    this.run = create("run", EXTERNAL_OIDC_RUN_REQUESTS_PER_MINUTE);
    this.environment = create("environment", EXTERNAL_OIDC_ENV_REQUESTS_PER_MINUTE);
  }

  async check(environmentId: string, runId: string): Promise<number | undefined> {
    // Keep both sliding-window Redis keys in one cluster slot.
    const run = await this.run.limit(`{${environmentId}:${runId}}`);
    // A throttled run must not consume the shared allowance of sibling runs.
    if (!run.success) return retryAfterSeconds(run.reset);
    const environment = await this.environment.limit(`{${environmentId}}`);
    return environment.success ? undefined : retryAfterSeconds(environment.reset);
  }
}

function retryAfterSeconds(reset: number): number {
  return Math.max(1, Math.ceil((reset - Date.now()) / 1_000));
}
