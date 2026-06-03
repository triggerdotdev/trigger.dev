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
