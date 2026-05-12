import { MollifierDrainer } from "@trigger.dev/redis-worker";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { getMollifierBuffer } from "./mollifierBuffer.server";

function initializeMollifierDrainer(): MollifierDrainer {
  const buffer = getMollifierBuffer();
  if (!buffer) {
    // Should be unreachable: getMollifierDrainer() guards on the same env flag as getMollifierBuffer().
    throw new Error("MollifierDrainer initialised without a buffer — env vars inconsistent");
  }

  logger.debug("Initializing mollifier drainer", {
    concurrency: env.MOLLIFIER_DRAIN_CONCURRENCY,
    maxAttempts: env.MOLLIFIER_DRAIN_MAX_ATTEMPTS,
  });

  const drainer = new MollifierDrainer({
    buffer,
    handler: async () => {
      throw new Error("MollifierDrainer phase 1: no handler wired");
    },
    concurrency: env.MOLLIFIER_DRAIN_CONCURRENCY,
    maxAttempts: env.MOLLIFIER_DRAIN_MAX_ATTEMPTS,
    isRetryable: () => false,
  });

  drainer.start();
  return drainer;
}

export function getMollifierDrainer(): MollifierDrainer | null {
  if (env.MOLLIFIER_ENABLED !== "1") return null;
  return singleton("mollifierDrainer", initializeMollifierDrainer);
}
