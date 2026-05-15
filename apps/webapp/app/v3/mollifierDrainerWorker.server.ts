import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { getMollifierDrainer } from "./mollifier/mollifierDrainer.server";

declare global {
  // eslint-disable-next-line no-var
  var __mollifierShutdownRegistered__: boolean | undefined;
}

/**
 * Bootstraps the mollifier drainer.
 *
 * Two-step lifecycle:
 *   1. Construct the drainer via the gated singleton in
 *      `mollifierDrainer.server.ts`. That factory validates the
 *      shutdown-timeout reconciliation against `GRACEFUL_SHUTDOWN_TIMEOUT`
 *      and throws BEFORE returning if it's misconfigured; the returned
 *      drainer is configured-but-stopped.
 *   2. Register SIGTERM/SIGINT shutdown handlers, then call
 *      `drainer.start()`. Doing this in the bootstrap (and not in the
 *      factory) guarantees a signal landing during boot can never find
 *      the polling loop running without a graceful-stop path.
 *
 * The drainer is intentionally NOT wired through `~/services/worker.server`
 * — that file is the legacy ZodWorker / graphile-worker setup. The
 * mollifier drainer is a custom polling loop over `MollifierBuffer`, not
 * a graphile-worker job, so it gets its own lifecycle file alongside the
 * redis-worker workers (`commonWorker`, `alertsWorker`,
 * `batchTriggerWorker`).
 *
 * Gating order:
 *   - `WORKER_ENABLED !== "true"`  → early return (API-only replicas
 *     still produce into the buffer via the trigger hot path; only worker
 *     replicas drain it, otherwise every replica races for the same
 *     entries).
 *   - `MOLLIFIER_ENABLED !== "1"`  → `getMollifierDrainer()` returns null
 *     and the bootstrap is a no-op.
 */
export function initMollifierDrainerWorker(): void {
  if (env.WORKER_ENABLED !== "true") {
    return;
  }

  try {
    const drainer = getMollifierDrainer();
    if (drainer && !global.__mollifierShutdownRegistered__) {
      // `__mollifierShutdownRegistered__` guards against double-register
      // on dev hot-reloads (this bootstrap is called from
      // entry.server.tsx, which Remix dev re-evaluates on every change).
      // Same guard owns both the handler registration and the start()
      // call so the two never get out of sync.
      const stopDrainer = () => {
        drainer
          .stop({ timeoutMs: env.MOLLIFIER_DRAIN_SHUTDOWN_TIMEOUT_MS })
          .catch((error) => {
            logger.error("Failed to stop mollifier drainer", { error });
          });
      };
      process.once("SIGTERM", stopDrainer);
      process.once("SIGINT", stopDrainer);
      global.__mollifierShutdownRegistered__ = true;
      drainer.start();
    }
  } catch (error) {
    logger.error("Failed to initialise mollifier drainer", { error });
  }
}
