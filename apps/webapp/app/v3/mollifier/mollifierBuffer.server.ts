import { MollifierBuffer } from "@trigger.dev/redis-worker";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";

// DI seam type for consumers (e.g. triggerTask.server.ts) that need a
// nullable buffer accessor at construction time.
export type MollifierGetBuffer = () => MollifierBuffer | null;

function initializeMollifierBuffer(): MollifierBuffer {
  logger.debug("Initializing mollifier buffer", {
    host: env.TRIGGER_MOLLIFIER_REDIS_HOST,
  });

  return new MollifierBuffer({
    redisOptions: {
      keyPrefix: "",
      host: env.TRIGGER_MOLLIFIER_REDIS_HOST,
      port: env.TRIGGER_MOLLIFIER_REDIS_PORT,
      username: env.TRIGGER_MOLLIFIER_REDIS_USERNAME,
      password: env.TRIGGER_MOLLIFIER_REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.TRIGGER_MOLLIFIER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    ackGraceTtlSeconds: env.TRIGGER_MOLLIFIER_ACK_GRACE_TTL_SECONDS,
    maxRetriesPerRequest: env.TRIGGER_MOLLIFIER_REDIS_MAX_RETRIES_PER_REQUEST,
    reconnectStepMs: env.TRIGGER_MOLLIFIER_REDIS_RECONNECT_STEP_MS,
    reconnectMaxMs: env.TRIGGER_MOLLIFIER_REDIS_RECONNECT_MAX_MS,
  });
}

export function getMollifierBuffer(): MollifierBuffer | null {
  if (env.TRIGGER_MOLLIFIER_ENABLED !== "1") return null;
  return singleton("mollifierBuffer", initializeMollifierBuffer);
}

// A claim-only buffer for the pre-gate idempotency claim when the mollifier
// itself is disabled. The mollifier Redis may be unprovisioned in deployments
// that don't run the mollifier, so this points at the general webapp Redis.
// Only the claim methods (claimIdempotency / readClaim / publishClaim /
// releaseClaim) are exercised; they live under the distinct `mollifier:claim:*`
// namespace and carry their own short TTLs, so sharing the general Redis is safe.
function initializeIdempotencyClaimBuffer(): MollifierBuffer {
  logger.debug("Initializing standalone idempotency-claim buffer", {
    host: env.REDIS_HOST,
  });

  return new MollifierBuffer({
    redisOptions: {
      keyPrefix: "",
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
  });
}

// Resolve the buffer backing the pre-gate idempotency claim. When the
// mollifier is enabled, reuse its buffer so claims share the mollifier's Redis.
// Otherwise return a claim-only buffer on the general Redis: a `runTableV2`
// cutover org needs the claim to serialise concurrent same-key triggers that
// would otherwise straddle the flag flip into different physical tables (cuid
// -> TaskRun, ksuid -> task_run_v2), whose per-table unique constraints can't
// see each other. Returns null only when the general Redis host is
// unconfigured, in which case the claim falls open (no coordination) exactly
// as before.
export function getIdempotencyClaimBuffer(): MollifierBuffer | null {
  const mollifier = getMollifierBuffer();
  if (mollifier) return mollifier;
  if (!env.REDIS_HOST) return null;
  return singleton("idempotencyClaimBuffer", initializeIdempotencyClaimBuffer);
}
