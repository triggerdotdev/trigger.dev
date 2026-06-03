import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { signalsEmitter } from "~/services/signals.server";
import {
  getMollifierDrainer,
  MollifierConfigurationError,
} from "./mollifier/mollifierDrainer.server";
import { startMollifierDrainingGauge } from "./mollifier/mollifierDrainingGauge.server";

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
 *   - `TRIGGER_MOLLIFIER_DRAINER_ENABLED !== "1"`  → early return. Unset defaults
 *     to `TRIGGER_MOLLIFIER_ENABLED`, so single-container self-hosters still get
 *     the drainer for free with one flag. In multi-replica deployments,
 *     set this to "0" explicitly on every replica except the dedicated
 *     drainer service so the polling loop doesn't race across replicas.
 *   - `TRIGGER_MOLLIFIER_ENABLED !== "1"`  → `getMollifierDrainer()` returns null
 *     and the bootstrap is a no-op. `TRIGGER_MOLLIFIER_ENABLED` remains the
 *     master kill switch; the new flag only controls WHICH replicas
 *     run the drainer when the system is on.
 */
export function initMollifierDrainerWorker(
  opts: {
    // Test seams. Production callers pass nothing; the defaults read the
    // live env and resolve the live singleton. Tests inject overrides so
    // the misconfig-rethrow / transient-swallow branches can be driven
    // without manipulating module-level env state.
    isEnabled?: () => boolean;
    getDrainer?: typeof getMollifierDrainer;
  } = {},
): void {
  const isEnabled = opts.isEnabled ?? (() => env.TRIGGER_MOLLIFIER_DRAINER_ENABLED === "1");
  const getDrainer = opts.getDrainer ?? getMollifierDrainer;

  if (!isEnabled()) {
    return;
  }

  try {
    const drainer = getDrainer();
    if (drainer && !global.__mollifierShutdownRegistered__) {
      // `__mollifierShutdownRegistered__` guards against double-register
      // on dev hot-reloads (this bootstrap is called from
      // entry.server.tsx, which Remix dev re-evaluates on every change).
      // Same guard owns both the handler registration and the start()
      // call so the two never get out of sync.
      //
      // Registers through `signalsEmitter` (the webapp-wide singleton in
      // `~/services/signals.server`) rather than `process.once` directly:
      //  - matches the codebase convention (runsReplicationInstance,
      //    llmPricingRegistry, dynamicFlushScheduler etc. all listen on
      //    the same emitter);
      //  - `.on` (not `.once`) means a second SIGTERM still reaches us if
      //    the orchestrator delivers more than one signal before SIGKILL;
      //  - if SIGTERM lands in the gap between this listener attaching
      //    and `drainer.start()` below, the first invocation no-ops
      //    (stop() returns early because the drainer isn't running yet)
      //    but the listener stays attached for a subsequent signal,
      //    rather than being consumed by `once`.
      const stopDrainer = () => {
        drainer
          .stop({ timeoutMs: env.TRIGGER_MOLLIFIER_DRAIN_SHUTDOWN_TIMEOUT_MS })
          .catch((error) => {
            logger.error("Failed to stop mollifier drainer", { error });
          });
      };
      signalsEmitter.on("SIGTERM", stopDrainer);
      signalsEmitter.on("SIGINT", stopDrainer);
      global.__mollifierShutdownRegistered__ = true;
      drainer.start();
      // Spin up the observability-only gauge poller for the
      // `mollifier:draining` ZSET cardinality. Colocated with the
      // drainer because that's the loop creating the DRAINING entries
      // — same pod, same Redis client lifecycle. Idempotent + unref'd
      // so it's safe under dev hot-reload and doesn't block shutdown.
      startMollifierDrainingGauge();
    }
  } catch (error) {
    // Deterministic misconfig (shutdown-timeout vs GRACEFUL_SHUTDOWN_TIMEOUT,
    // missing buffer client) is a deploy-time mistake the operator must
    // see immediately — rethrow so the process crashes, health checks
    // fail, and the orchestrator rolls the deploy back. The drainer is currently
    // monitoring-only and the silent-fallback was tempting, but later phases
    // make the drainer the source of truth for diverted triggers, where a
    // silently-disabled drainer means data loss. Better to fail loud now
    // than retrofit later.
    //
    // We accept both `instanceof` and `error.name === ...` so Remix dev
    // hot-reload (where the consumer can hold a stale class reference)
    // still recognises the marker.
    if (
      error instanceof MollifierConfigurationError ||
      (error instanceof Error && error.name === "MollifierConfigurationError")
    ) {
      logger.error("Mollifier drainer misconfiguration — failing loud", {
        error: error.message,
      });
      throw error;
    }
    // Anything else (transient Redis blip, unexpected runtime error) is
    // logged but kept non-fatal — the rest of the webapp shouldn't go
    // down because the buffer's Redis cluster is briefly unreachable.
    logger.error("Failed to initialise mollifier drainer", { error });
  }
}
