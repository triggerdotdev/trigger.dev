import { SnapshotOrphanSweeper } from "@internal/run-store";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { engine } from "./runEngine.server";
import { runStoreWithoutSnapshotDecorator } from "./runStore.server";
import { buildSnapshotSweepRunner } from "./snapshotSweepRunner.server";
import { setSnapshotRepairEnqueuer, setSnapshotSweepRunner } from "./snapshotStoreBindings.server";
import { getSnapshotSweepClient } from "./snapshotStoreInstance.server";

/**
 * The third module: it imports both sides, so neither the run store nor the engine has to import
 * the other. Invoked from entry.server.tsx, beside the other boot registrations.
 */
export function registerSnapshotStoreWiring(): boolean {
  const sweepClient = getSnapshotSweepClient();

  if (!sweepClient) {
    return false;
  }

  setSnapshotRepairEnqueuer(async (args) => {
    await engine.enqueueSnapshotRepair(args);
  });

  const sweeper = new SnapshotOrphanSweeper({
    redisOptions: {
      keyPrefix: "engine:",
      host: env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST ?? undefined,
      port: env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_PORT ?? undefined,
      username: env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_USERNAME ?? undefined,
      password: env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_PASSWORD ?? undefined,
      ...(env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    // The undecorated router: rule 2 asks Postgres whether a run row exists, and must never be
    // able to ask Redis whether Redis is an orphan.
    runStore: runStoreWithoutSnapshotDecorator,
    completedTtlMs: env.RUN_ENGINE_SNAPSHOT_STORE_COMPLETED_TTL_MS,
    orphanAgeMs: env.RUN_ENGINE_SNAPSHOT_STORE_ORPHAN_AGE_MS,
  });

  setSnapshotSweepRunner(
    buildSnapshotSweepRunner({
      client: sweepClient,
      // The sweep does not yet accept a deadline, so the budget is not enforced inside a pass. The
      // fenced lock is what keeps two passes apart; its TTL covers the expected pass duration.
      sweep: async () => ({ ...(await sweeper.sweep()) }),
      lockTtlMs: env.RUN_ENGINE_SNAPSHOT_STORE_GC_SWEEP_BUDGET_MS + 3_600_000,
    })
  );

  logger.info("snapshot store wiring registered");
  return true;
}
