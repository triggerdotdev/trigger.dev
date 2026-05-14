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

// Latch so we log the degraded-config warning exactly once per process
// instead of on every `getMollifierBuffer()` call (which is per-trigger).
let degradedConfigLogged = false;

export function getMollifierBuffer(): MollifierBuffer | null {
  if (env.MOLLIFIER_ENABLED !== "1") return null;
  // Fail safe, not loud: if MOLLIFIER_ENABLED was flipped on without
  // setting `MOLLIFIER_REDIS_HOST`, degrade the mollifier to disabled
  // rather than crash-looping the pod (or — worse — sharing the main
  // engine Redis). One warn log per process is enough for operators to
  // spot the misconfig without drowning logs in repeats.
  if (!env.MOLLIFIER_REDIS_HOST) {
    if (!degradedConfigLogged) {
      logger.warn(
        "mollifier.degraded_config: MOLLIFIER_ENABLED=1 but MOLLIFIER_REDIS_HOST is unset — treating as disabled until configured",
      );
      degradedConfigLogged = true;
    }
    return null;
  }
  return singleton("mollifierBuffer", initializeMollifierBuffer);
}
