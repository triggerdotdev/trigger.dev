import { Ratelimit } from "@upstash/ratelimit";
import type { NextFunction, Request, Response } from "express";
import { env } from "~/env.server";
import { createRedisRateLimitClient, RateLimiter } from "~/services/rateLimiter.server";
import { extractClientIp } from "~/utils/extractClientIp.server";
import { singleton } from "~/utils/singleton";
import { logger } from "./logger.server";

const OTLP_PATH = /^\/otel\//i;

function getOtlpIpRateLimiter() {
  return singleton(
    "otlpIpRateLimiter",
    () =>
      new RateLimiter({
        redisClient: createRedisRateLimitClient({
          port: env.RATE_LIMIT_REDIS_PORT,
          host: env.RATE_LIMIT_REDIS_HOST,
          username: env.RATE_LIMIT_REDIS_USERNAME,
          password: env.RATE_LIMIT_REDIS_PASSWORD,
          tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
          clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
        }),
        keyPrefix: "otlp:ip",
        limiter: Ratelimit.slidingWindow(
          env.OTLP_RATE_LIMIT_MAX,
          env.OTLP_RATE_LIMIT_WINDOW as Parameters<typeof Ratelimit.slidingWindow>[1]
        ),
        logSuccess: false,
        logFailure: true,
      })
  );
}

/**
 * Per-IP rate limiter for the OTLP ingestion endpoints (`/otel/*`).
 *
 * These endpoints are currently unauthenticated (see SEC-98), so the source IP
 * is the only identity available to key on. This bounds unauthenticated
 * request rates and is NOT a substitute for authenticating the
 * endpoints. It fails open (allows the request) whenever the source cannot be
 * identified or the limiter backend errors, so a limiter outage never drops
 * legitimate telemetry.
 *
 * Opt-in (disabled unless `OTLP_RATE_LIMIT_ENABLED=1`). Because it keys on the
 * source IP, two preconditions must hold before enabling it, or it can drop
 * legitimate telemetry:
 *
 * 1. Each client must present a distinct IP. Where many clients share one
 *    egress IP (e.g. behind NAT or a shared proxy) their traffic collapses
 *    into a single bucket and can be throttled together. Size
 *    `OTLP_RATE_LIMIT_MAX` for the aggregate volume of a shared source, not a
 *    single client.
 * 2. The IP must be trustworthy. `extractClientIp` takes the last
 *    `X-Forwarded-For` hop, which is only spoof-resistant behind a proxy that
 *    appends the real client IP. Without such a proxy the value is
 *    client-controlled and the per-IP bound is bypassable.
 */
export async function otlpRateLimiter(req: Request, res: Response, next: NextFunction) {
  if (env.OTLP_RATE_LIMIT_ENABLED !== "1") {
    return next();
  }

  if (req.method.toUpperCase() === "OPTIONS" || !OTLP_PATH.test(req.path)) {
    return next();
  }

  const xff = req.headers["x-forwarded-for"];
  const ip = extractClientIp(Array.isArray(xff) ? xff.join(",") : (xff ?? null)) ?? req.ip;

  if (!ip) {
    // Fail open: without a source we cannot fairly rate limit.
    return next();
  }

  try {
    const { success, reset } = await getOtlpIpRateLimiter().limit(ip);

    if (!success) {
      const retryAfterSeconds = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
      res.setHeader("Retry-After", retryAfterSeconds.toString());
      res.status(429).send("Too Many Requests");
      return;
    }
  } catch (error) {
    // Fail open: a rate-limiter backend outage must not drop telemetry.
    logger.warn("otlpRateLimiter: limiter error, allowing request", { error });
  }

  return next();
}
