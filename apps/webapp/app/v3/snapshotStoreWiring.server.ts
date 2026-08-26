import { SnapshotOrphanSweeper } from "@internal/run-store";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { signalsEmitter } from "~/services/signals.server";
import { engine } from "./runEngine.server";
import { runStoreWithoutSnapshotDecorator } from "./runStore.server";
import { buildSnapshotSweepRunner } from "./snapshotSweepRunner.server";
import { setSnapshotRepairEnqueuer, setSnapshotSweepRunner } from "./snapshotStoreBindings.server";
import {
  getSnapshotSweepClient,
  quitSnapshotStoreClients,
  registerSnapshotStoreQuit,
} from "./snapshotStoreInstance.server";

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
    // Its own connection, so a scan of every master can never stall a transition append.
    client: sweepClient,
    // The undecorated router: rule 2 asks Postgres whether a run row exists, and must never be
    // able to ask Redis whether Redis is an orphan.
    runStore: runStoreWithoutSnapshotDecorator,
    completedTtlMs: env.RUN_ENGINE_SNAPSHOT_STORE_COMPLETED_TTL_MS,
    orphanAgeMs: env.RUN_ENGINE_SNAPSHOT_STORE_ORPHAN_AGE_MS,
    confirmOrphanAfterMs: env.RUN_ENGINE_SNAPSHOT_STORE_CONFIRM_ORPHAN_AFTER_MS,
  });

  setSnapshotSweepRunner(
    buildSnapshotSweepRunner({
      client: sweepClient,
      sweep: async ({ deadline, signal }) => ({ ...(await sweeper.sweep({ deadline, signal })) }),
      lockTtlMs: env.RUN_ENGINE_SNAPSHOT_STORE_GC_SWEEP_BUDGET_MS + 3_600_000,
    })
  );

  registerSnapshotStoreQuit(() => sweeper.quit());

  // Close the sweeper and all three connections on the way out, the same way the other Redis-backed
  // singletons do. `quitSnapshotStoreClients` is async and the signals emitter swallows listener
  // rejections, so discard the promise explicitly rather than handing it a floating one. The caller
  // wraps this function in `singleton`, so the listeners are registered once per process.
  const onShutdown = (): void => {
    void quitSnapshotStoreClients();
  };
  signalsEmitter.on("SIGTERM", onShutdown);
  signalsEmitter.on("SIGINT", onShutdown);

  logger.info("snapshot store wiring registered");
  return true;
}
