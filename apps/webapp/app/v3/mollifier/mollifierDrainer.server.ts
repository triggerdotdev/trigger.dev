import { MollifierDrainer } from "@trigger.dev/redis-worker";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { engine as runEngine } from "~/v3/runEngine.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { getMollifierBuffer } from "./mollifierBuffer.server";
import {
  createDrainerHandler,
  isRetryablePgError,
} from "./mollifierDrainerHandler.server";
import type { MollifierSnapshot } from "./mollifierSnapshot.server";

function initializeMollifierDrainer(): MollifierDrainer<MollifierSnapshot> {
  const buffer = getMollifierBuffer();
  if (!buffer) {
    // Unreachable in normal config: getMollifierDrainer() gates on the
    // same env flag as getMollifierBuffer(). If we hit this, fail loud
    // — the operator has set MOLLIFIER_ENABLED=1 on a worker pod but
    // the buffer can't initialise (e.g. MOLLIFIER_REDIS_HOST resolves
    // to nothing). Crashing surfaces the misconfig immediately rather
    // than silently leaving entries un-drained.
    throw new Error("MollifierDrainer initialised without a buffer — env vars inconsistent");
  }

  // Validate BEFORE start() so a misconfigured shutdown timeout fails
  // loud at module-load time and the singleton is never cached. If start()
  // ran first and the throw propagated out, the loop would already be
  // polling with no SIGTERM handler registered by the caller — exactly
  // the failure mode the validation is supposed to prevent.
  //
  // The SIGTERM handler in worker.server.ts is sync fire-and-forget:
  // `drainer.stop({ timeoutMs })` returns a promise that keeps the event
  // loop alive, but in cluster mode the primary runs its own
  // GRACEFUL_SHUTDOWN_TIMEOUT and will call `process.exit(0)`
  // independently. If the drainer's deadline exceeds the primary's, the
  // drainer is cut off mid-wait — "log a warning on timeout" turns into
  // "hard exit with no log". 1s margin gives the primary room to finish
  // its own teardown after the drainer settles.
  const shutdownMarginMs = 1_000;
  if (
    env.MOLLIFIER_DRAIN_SHUTDOWN_TIMEOUT_MS >=
    env.GRACEFUL_SHUTDOWN_TIMEOUT - shutdownMarginMs
  ) {
    throw new Error(
      `MOLLIFIER_DRAIN_SHUTDOWN_TIMEOUT_MS (${env.MOLLIFIER_DRAIN_SHUTDOWN_TIMEOUT_MS}) must be at least ${shutdownMarginMs}ms below GRACEFUL_SHUTDOWN_TIMEOUT (${env.GRACEFUL_SHUTDOWN_TIMEOUT}); otherwise the primary's hard exit shadows the drainer's deadline.`,
    );
  }

  logger.debug("Initializing mollifier drainer", {
    concurrency: env.MOLLIFIER_DRAIN_CONCURRENCY,
    maxAttempts: env.MOLLIFIER_DRAIN_MAX_ATTEMPTS,
  });

  const drainer = new MollifierDrainer<MollifierSnapshot>({
    buffer,
    handler: createDrainerHandler({ engine: runEngine, prisma }),
    concurrency: env.MOLLIFIER_DRAIN_CONCURRENCY,
    maxAttempts: env.MOLLIFIER_DRAIN_MAX_ATTEMPTS,
    maxOrgsPerTick: env.MOLLIFIER_DRAIN_MAX_ORGS_PER_TICK,
    isRetryable: isRetryablePgError,
  });

  return drainer;
}

// Returns a configured-but-stopped drainer. Callers MUST register their
// SIGTERM / SIGINT shutdown handlers before invoking `drainer.start()` —
// see `apps/webapp/app/services/worker.server.ts`. Starting inside the
// singleton factory would put the polling loop ahead of handler
// registration, leaving a narrow window where a SIGTERM landing between
// `start()` and `process.once("SIGTERM", ...)` would skip the graceful
// stop. The split is intentional.
export function getMollifierDrainer(): MollifierDrainer<MollifierSnapshot> | null {
  if (env.MOLLIFIER_ENABLED !== "1") return null;
  return singleton("mollifierDrainer", initializeMollifierDrainer);
}
