// Builds the snapshot-store decorator over a real PostgresRunStore, for injection through the
// engine's `store` option — the seam runStoreInjectability.test.ts already proves.
//
// The point of injecting it is that the engine suites keep their own assertions: the same flows,
// the same expectations, a different store underneath.
import {
  PostgresRunStore,
  RedisSnapshotStore,
  TaskRunExecutionSnapshotStore,
  type SnapshotFaultInjector,
  type SnapshotRepairEnqueuer,
  type SnapshotStoreMode,
} from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import type { RedisOptions } from "@internal/redis";

const COMPLETED_TTL_MS = 72 * 60 * 60 * 1000;

export type DecoratedStoreHarness = {
  store: TaskRunExecutionSnapshotStore;
  redis: RedisSnapshotStore;
  /** Every read the decorator served, and which store answered it. */
  reads: { method: string; source: "redis" | "postgres" }[];
  /** Every append outcome, keyed by the write site that produced it. */
  writes: { site: string; outcome: string }[];
  /** Runs handed to the repair job because their append was lost. */
  repairs: { runId: string; snapshotId: string; executionStatus: string }[];
  quit(): Promise<void>;
};

export function buildDecoratedStore(opts: {
  prisma: PrismaClient;
  redisOptions: RedisOptions;
  mode: SnapshotStoreMode;
  faults?: SnapshotFaultInjector;
  onAppendFailure?: SnapshotRepairEnqueuer;
}): DecoratedStoreHarness {
  const redis = new RedisSnapshotStore({
    redisOptions: opts.redisOptions,
    completedTtlMs: COMPLETED_TTL_MS,
  });

  const reads: DecoratedStoreHarness["reads"] = [];
  const writes: DecoratedStoreHarness["writes"] = [];
  const repairs: DecoratedStoreHarness["repairs"] = [];

  const store = new TaskRunExecutionSnapshotStore(
    new PostgresRunStore({ prisma: opts.prisma as never, readOnlyPrisma: opts.prisma as never }),
    {
      store: redis,
      mode: opts.mode,
      ...(opts.faults && { faults: opts.faults }),
      onAppendFailure: async (args) => {
        repairs.push(args);
        await opts.onAppendFailure?.(args);
      },
      metrics: {
        recordWrite: (site, outcome) => writes.push({ site, outcome }),
        recordAppendFailed: () => {},
        recordRead: (method, source) => reads.push({ method, source }),
      },
    }
  );

  return {
    store,
    redis,
    reads,
    writes,
    repairs,
    quit: () => redis.quit(),
  };
}
