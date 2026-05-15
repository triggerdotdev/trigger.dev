import { MollifierBuffer } from "@trigger.dev/redis-worker";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";

// DI seam type for consumers (e.g. triggerTask.server.ts) that need a
// nullable buffer accessor at construction time.
export type MollifierGetBuffer = () => MollifierBuffer | null;

function initializeMollifierBuffer(): MollifierBuffer {
  logger.debug("Initializing mollifier buffer", {
    host: env.MOLLIFIER_REDIS_HOST,
  });

  return new MollifierBuffer({
    redisOptions: {
      keyPrefix: "",
      host: env.MOLLIFIER_REDIS_HOST,
      port: env.MOLLIFIER_REDIS_PORT,
      username: env.MOLLIFIER_REDIS_USERNAME,
      password: env.MOLLIFIER_REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.MOLLIFIER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    entryTtlSeconds: env.MOLLIFIER_ENTRY_TTL_S,
  });
}

export function getMollifierBuffer(): MollifierBuffer | null {
  if (env.MOLLIFIER_ENABLED !== "1") return null;
  return singleton("mollifierBuffer", initializeMollifierBuffer);
}
