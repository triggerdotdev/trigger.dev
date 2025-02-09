import { env } from "~/env.server";
import { createRedisClient } from "~/redis.server";
import { GCRARateLimiter } from "./GCRARateLimiter.server";
import { singleton } from "~/utils/singleton";
import { logger } from "~/services/logger.server";

export const alertsRateLimiter = singleton("alertsRateLimiter", initializeAlertsRateLimiter);

function initializeAlertsRateLimiter() {
  const redis = createRedisClient("alerts:ratelimiter", {
    keyPrefix: "alerts:ratelimiter:",
    host: env.ALERT_RATE_LIMITER_REDIS_HOST,
    port: env.ALERT_RATE_LIMITER_REDIS_PORT,
    username: env.ALERT_RATE_LIMITER_REDIS_USERNAME,
    password: env.ALERT_RATE_LIMITER_REDIS_PASSWORD,
    tlsDisabled: env.ALERT_RATE_LIMITER_REDIS_TLS_DISABLED === "true",
    clusterMode: env.ALERT_RATE_LIMITER_REDIS_CLUSTER_MODE_ENABLED === "1",
  });

  logger.debug(`🚦 Initializing alerts rate limiter at host ${env.ALERT_RATE_LIMITER_REDIS_HOST}`, {
    emissionInterval: env.ALERT_RATE_LIMITER_EMISSION_INTERVAL,
    burstTolerance: env.ALERT_RATE_LIMITER_BURST_TOLERANCE,
  });

  return new GCRARateLimiter({
    redis,
    emissionInterval: env.ALERT_RATE_LIMITER_EMISSION_INTERVAL,
    burstTolerance: env.ALERT_RATE_LIMITER_BURST_TOLERANCE,
  });
}
