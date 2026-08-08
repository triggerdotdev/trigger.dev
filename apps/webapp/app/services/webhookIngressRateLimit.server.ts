import { Ratelimit } from "@upstash/ratelimit";
import { env } from "~/env.server";
import { RateLimiter, type Duration } from "./rateLimiter.server";

// Per-opaqueId fixed-window limiter for the unauthenticated webhook ingress
// route. apiRateLimiter/engineRateLimiter only match /api and /engine and key
// off the auth header, so they never see this request; this is the real
// protection (the per-IP limiter in server.ts is coarse).
export const webhookIngressRateLimiter = new RateLimiter({
  keyPrefix: "webhook-ingress",
  limiter: Ratelimit.fixedWindow(
    env.WEBHOOK_INGRESS_RATE_LIMIT_TOKENS,
    env.WEBHOOK_INGRESS_RATE_LIMIT_WINDOW as Duration
  ),
  logFailure: true,
});
