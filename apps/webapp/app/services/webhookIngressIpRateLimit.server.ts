import type { RequestHandler } from "express";
import { Ratelimit } from "@upstash/ratelimit";
import { env } from "~/env.server";
import { RateLimiter, type Duration } from "./rateLimiter.server";

const ipLimiter = new RateLimiter({
  keyPrefix: "webhook-ingress-ip",
  limiter: Ratelimit.fixedWindow(
    env.WEBHOOK_INGRESS_IP_RATE_LIMIT_TOKENS,
    env.WEBHOOK_INGRESS_IP_RATE_LIMIT_WINDOW as Duration
  ),
});

// Coarse per-IP gate mounted in server.ts ahead of the Remix handler. The
// per-opaqueId limiter (webhookIngressRateLimit.server) is the real protection.
export const webhookIngressIpRateLimiter: RequestHandler = async (req, res, next) => {
  if (!req.path.startsWith("/webhooks/v1/ingest/")) return next();
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
  const { success } = await ipLimiter.limit(ip);
  if (!success) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }
  next();
};
