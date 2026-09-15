import { Ratelimit } from "@upstash/ratelimit";
import { env } from "~/env.server";
import { createRedisRateLimitClient, RateLimiter } from "~/services/rateLimiter.server";
import { singleton } from "~/utils/singleton";

/**
 * Rate limiting for organization invite sends (API create + dashboard
 * resend). Each sent invite is an email to an arbitrary address, so a
 * member with manage:members could otherwise mass-mail Trigger.dev-branded
 * invites. Limits are per-organization (the blast radius is the org's
 * brand) and per-inviter (spreads a burst across collaborators sharing an
 * org).
 *
 * Sized against the 50-emails-per-request body cap: the per-minute windows
 * pass a few bulk imports but stop a scripted loop; the daily org cap
 * (500 = 10 bulk imports) leaves headroom for onboarding batches while
 * bounding a day of abuse.
 */
export class InviteRateLimitError extends Error {
  public readonly retryAfter: number;

  constructor(retryAfter: number) {
    super("Invite rate limit exceeded.");
    this.retryAfter = retryAfter;
  }
}

function getRedisClient() {
  return createRedisRateLimitClient({
    port: env.RATE_LIMIT_REDIS_PORT,
    host: env.RATE_LIMIT_REDIS_HOST,
    username: env.RATE_LIMIT_REDIS_USERNAME,
    password: env.RATE_LIMIT_REDIS_PASSWORD,
    tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
    clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
  });
}

const inviteOrgPerMinuteRateLimiter = singleton(
  "inviteOrgPerMinuteRateLimiter",
  () =>
    new RateLimiter({
      redisClient: getRedisClient(),
      keyPrefix: "invites:org",
      limiter: Ratelimit.slidingWindow(100, "1 m"), // 100 invite emails / min / org
      logSuccess: false,
      logFailure: true,
    })
);

const inviteOrgDailyRateLimiter = singleton(
  "inviteOrgDailyRateLimiter",
  () =>
    new RateLimiter({
      redisClient: getRedisClient(),
      keyPrefix: "invites:org:daily",
      limiter: Ratelimit.slidingWindow(500, "1 d"), // 500 invite emails / day / org
      logSuccess: false,
      logFailure: true,
    })
);

const inviteInviterRateLimiter = singleton(
  "inviteInviterRateLimiter",
  () =>
    new RateLimiter({
      redisClient: getRedisClient(),
      keyPrefix: "invites:inviter",
      limiter: Ratelimit.slidingWindow(60, "1 m"), // 60 invite emails / min / inviter
      logSuccess: false,
      logFailure: true,
    })
);

/**
 * Check whether `count` invite emails can be sent on behalf of
 * `organizationId` by `inviterId`. All windows are charged `count` so a
 * single 50-email request counts as 50 sends, not 1 request.
 * @throws {InviteRateLimitError} If any limit is exceeded
 */
export async function checkInviteRateLimit(
  organizationId: string,
  inviterId: string,
  count: number
): Promise<void> {
  const results = await Promise.all([
    inviteOrgPerMinuteRateLimiter.limit(organizationId, count),
    inviteOrgDailyRateLimiter.limit(organizationId, count),
    inviteInviterRateLimiter.limit(inviterId, count),
  ]);

  for (const result of results) {
    if (!result.success) {
      const retryAfter = Math.max(0, new Date(result.reset).getTime() - Date.now());
      throw new InviteRateLimitError(retryAfter);
    }
  }
}
