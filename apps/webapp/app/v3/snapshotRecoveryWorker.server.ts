import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  PENDING_PARTITION_COUNT,
  RecoverySweeper,
  type RecoveryMetrics,
  type RecoveryOutcome,
  type RecoverySweeperOptions,
} from "@internal/run-store";
import { Counter, Gauge, Histogram, type Registry, type RegistryContentType } from "prom-client";
import { env } from "~/env.server";
import { metricsRegister } from "~/metrics.server";
import { logger } from "~/services/logger.server";
import { signalsEmitter } from "~/services/signals.server";
import { singleton } from "~/utils/singleton";
import { snapshotStoreRuntime } from "./runStore.server";

declare global {
  // eslint-disable-next-line no-var
  var __snapshotRecoveryShutdownRegistered__: boolean | undefined;
}

type SnapshotRecoveryRuntime = {
  recovery: () => {
    worker: RecoverySweeperOptions["worker"];
    pendingIndex: RecoverySweeperOptions["pendingIndex"];
    store: {
      acquireOrRenewRecoveryLease(owner: string, ttlMs: number): Promise<boolean>;
      releaseRecoveryLease(owner: string): Promise<void>;
    };
    ready: () => Promise<void>;
  };
};

// Outlives the gap between ticks so the holder keeps the lease, and bounds takeover after a crash.
const MIN_LEASE_TTL_MS = 60_000;
// Only the lease holder reads the pending streams and delivery is per group, so every replica of the
// recovery role shares one consumer name instead of adding 256 consumers per process start.
const RECOVERY_CONSUMER = "sweeper";
// How long shutdown waits for the lease release before giving up (the lease then expires on its TTL).
const RELEASE_TIMEOUT_MS = 2_000;

/**
 * Bootstraps the snapshot recovery sweep: drives the run-store `RecoverySweeper` over every pending
 * partition so units left pending by an interrupted transition resolve without run activity. Reuses
 * the snapshot store runtime's worker, pending index and client. Same two-step lifecycle as
 * `mollifierDrainerWorker.server.ts`: register shutdown handlers, then start the interval.
 *
 * Gating order: no snapshot store runtime → return; `RUN_ENGINE_SNAPSHOT_RECOVERY_SWEEP_ENABLED !==
 * "1"` → return. Each tick takes the single fleet lease (renewed mid-tick every quarter TTL), so several
 * enabled replicas never scan at once; shutdown awaits its release so a successor's next tick takes it.
 */
export function initSnapshotRecoveryWorker(
  opts: {
    // Test seams; production callers pass nothing.
    getRuntime?: () => SnapshotRecoveryRuntime | undefined;
    isEnabled?: () => boolean;
    intervalMs?: number;
    register?: Registry<RegistryContentType>;
  } = {}
): void {
  const getRuntime = opts.getRuntime ?? (() => snapshotStoreRuntime);
  const isEnabled =
    opts.isEnabled ?? (() => env.RUN_ENGINE_SNAPSHOT_RECOVERY_SWEEP_ENABLED === "1");

  const runtime = getRuntime();
  if (!runtime) {
    return;
  }
  if (!isEnabled()) {
    return;
  }
  // Remix dev re-evaluates entry.server.tsx; one guard owns both registration and start.
  if (global.__snapshotRecoveryShutdownRegistered__) {
    return;
  }

  try {
    const intervalMs = opts.intervalMs ?? env.RUN_ENGINE_SNAPSHOT_RECOVERY_SWEEP_INTERVAL_MS;
    const leaseTtlMs = Math.max(2 * intervalMs, MIN_LEASE_TTL_MS);
    const consumer = RECOVERY_CONSUMER;
    // The lease owner stays unique per process: it is what serialises the readers.
    const leaseOwner = `${hostname()}:${process.pid}:${randomUUID()}`;
    const { worker, pendingIndex, store, ready } = runtime.recovery();
    // A metrics sink makes the sweeper read each partition's depth/age summary (two extra Redis reads
    // per partition per tick), so the pending gauges cost what the sweep cost before it skipped them.
    const metrics = opts.register
      ? createRecoveryMetrics(opts.register)
      : singleton("snapshotRecoveryMetrics", () => createRecoveryMetrics(metricsRegister));

    let partitionErrors: Array<{ partition: number; error: unknown }> = [];
    const sweeper = new RecoverySweeper({
      worker,
      pendingIndex,
      consumer,
      metrics,
      leaseTtlMs,
      acquireTick: async () => {
        await ready();
        return store.acquireOrRenewRecoveryLease(leaseOwner, leaseTtlMs);
      },
      releaseTick: () => store.releaseRecoveryLease(leaseOwner),
      onPartitionError: (partition, error) => {
        partitionErrors.push({ partition, error });
      },
    });

    const runTick = () => {
      sweeper.tick().then(
        (result) => {
          if (result.skipped) {
            logger.debug("Snapshot recovery sweep tick skipped");
            return;
          }
          const errors = partitionErrors;
          partitionErrors = [];
          if (errors.length > 0) {
            logger.warn("Snapshot recovery sweep partitions failed", {
              failedPartitions: errors.length,
              firstPartition: errors[0].partition,
              error: errors[0].error,
            });
          }
          logger.debug("Snapshot recovery sweep tick", {
            outcomes: countOutcomes(result.outcomes),
            failedPartitions: errors.length,
          });
        },
        (error) => {
          partitionErrors = [];
          logger.warn("Snapshot recovery sweep tick failed", { error });
        }
      );
    };

    let timer: ReturnType<typeof setInterval> | undefined;
    // Returns once the lease is released (or the timeout passes), so a successor is not left waiting
    // out the TTL after a fast exit. The signals emitter ignores the returned promise; it never rejects.
    const stopSweeper = async (): Promise<void> => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), RELEASE_TIMEOUT_MS);
        timeout.unref?.();
      });
      const result = await Promise.race([sweeper.stop(), timedOut]);
      clearTimeout(timeout);
      if (result === "timeout") {
        logger.warn("Snapshot recovery lease release timed out on shutdown", {
          timeoutMs: RELEASE_TIMEOUT_MS,
        });
      }
    };
    signalsEmitter.on("SIGTERM", stopSweeper);
    signalsEmitter.on("SIGINT", stopSweeper);
    global.__snapshotRecoveryShutdownRegistered__ = true;

    timer = setInterval(runTick, intervalMs);
    timer.unref?.();

    logger.info("Snapshot recovery sweep started", {
      intervalMs,
      partitionCount: PENDING_PARTITION_COUNT,
      leaseTtlMs,
      consumer,
    });
  } catch (error) {
    // Non-fatal: resolvePending still resolves runs as they are touched.
    logger.error("Failed to initialise snapshot recovery sweep", { error });
  }
}

/**
 * The recovery sweep's prom sink, beside the `snapshot_store_*` family on the same registry. Aggregate
 * and org-free: outcome kinds are a fixed set, everything else is unlabelled.
 */
function createRecoveryMetrics(register: Registry<RegistryContentType>): RecoveryMetrics {
  const registers = [register];
  const outcomes = new Counter({
    name: "snapshot_store_recovery_outcome_total",
    help: "Snapshot recovery sweep outcomes per pending unit.",
    labelNames: ["kind"],
    registers,
  });
  const routeUnavailable = new Counter({
    name: "snapshot_store_recovery_route_unavailable_total",
    help: "Pending units retried because their owning primary had no route.",
    registers,
  });
  const sweepLatency = new Histogram({
    name: "snapshot_store_recovery_sweep_seconds",
    help: "Snapshot recovery sweep tick duration.",
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60],
    registers,
  });
  const pendingCount = new Gauge({
    name: "snapshot_store_recovery_pending_count",
    help: "Unresolved prepared units across every pending partition, set by the lease holder each tick.",
    registers,
  });
  const oldestPendingAge = new Gauge({
    name: "snapshot_store_recovery_oldest_pending_age_seconds",
    help: "Age of the oldest unresolved prepared unit, set by the lease holder each tick.",
    registers,
  });
  return {
    recordOutcome: (kind) => outcomes.inc({ kind }),
    recordRouteUnavailable: () => routeUnavailable.inc(),
    recordSweepLatency: (ms) => sweepLatency.observe(ms / 1000),
    recordPending: (oldestAgeMs, count) => {
      oldestPendingAge.set(oldestAgeMs / 1000);
      pendingCount.set(count);
    },
  };
}

function countOutcomes(
  outcomes: RecoveryOutcome[]
): Partial<Record<RecoveryOutcome["kind"], number>> {
  const counts: Partial<Record<RecoveryOutcome["kind"], number>> = {};
  for (const outcome of outcomes) {
    counts[outcome.kind] = (counts[outcome.kind] ?? 0) + 1;
  }
  return counts;
}
