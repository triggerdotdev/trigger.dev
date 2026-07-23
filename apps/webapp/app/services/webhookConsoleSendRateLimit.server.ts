import { Ratelimit } from "@upstash/ratelimit";
import { RateLimiter, type Duration } from "./rateLimiter.server";

/**
 * Per-user limiter for the authenticated webhook console test-send. The console injects deliveries
 * in-process (not through the public ingress), so it does NOT ride the per-opaqueId ingress limiter;
 * this keeps a single user's testing from flooding the engine + task queue, keyed by user id.
 */
export const webhookConsoleSendRateLimiter = new RateLimiter({
  keyPrefix: "webhook-console-send",
  limiter: Ratelimit.fixedWindow(30, "60 s" as Duration),
  logSuccess: false,
  logFailure: true,
});
