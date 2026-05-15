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
 *   - `MOLLIFIER_DRAINER_ENABLED !== "1"`  → early return. Unset defaults
 *     to `MOLLIFIER_ENABLED`, so single-container self-hosters still get
 *     the drainer for free with one flag. In multi-replica deployments,
 *     set this to "0" explicitly on every replica except the dedicated
 *     drainer service so the polling loop doesn't race across replicas.
 *   - `MOLLIFIER_ENABLED !== "1"`  → `getMollifierDrainer()` returns null
 *     and the bootstrap is a no-op. `MOLLIFIER_ENABLED` remains the
 *     master kill switch; the new flag only controls WHICH replicas
 *     run the drainer when the system is on.
 */
export function initMollifierDrainerWorker(): void {
  if (env.MOLLIFIER_DRAINER_ENABLED !== "1") {
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
