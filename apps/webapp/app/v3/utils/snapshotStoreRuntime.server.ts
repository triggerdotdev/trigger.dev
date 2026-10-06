import { createCompletedWaitpointResolver } from "@internal/run-engine";
import {
  PendingIndex,
  PendingRecoveryWorker,
  RouteUnavailableError,
  TaskRunExecutionSnapshotStore,
  type CompletedWaitpointResolver,
  type PostgresCommitStatus,
  type RunStore,
  type SnapshotDecoratorMetrics,
} from "@internal/run-store";
import type { createSnapshotConnection } from "./snapshotStoreConnection.server";
import type { createSnapshotRolloutResolver } from "./snapshotStoreRollout.server";

/** Construction-time leaf decoration. No import-time boot wait, client or background role. */
export function createSnapshotStoreRuntime(options: {
  connection: ReturnType<typeof createSnapshotConnection>;
  rollout: ReturnType<typeof createSnapshotRolloutResolver>;
  getRunStore: () => RunStore;
  metrics?: SnapshotDecoratorMetrics;
}) {
  const leaves = new Map<string, RunStore>();
  let recovery: PendingRecoveryWorker | undefined;
  let completedWaitpoints: CompletedWaitpointResolver | undefined;

  function primary(route: string) {
    const leaf = leaves.get(route);
    if (!leaf) throw new RouteUnavailableError(route);
    return leaf.primaryReadClient;
  }

  function recoveryWorker() {
    return (recovery ??= new PendingRecoveryWorker({
      store: options.connection.getStore(),
      pendingIndex: new PendingIndex(options.connection.getClient()),
      checkPostgresCommit: async (xid, route) => {
        const rows = await primary(route).$queryRawUnsafe<Array<{ status: PostgresCommitStatus }>>(
          "SELECT pg_xact_status($1::xid8) AS status",
          xid
        );
        return rows[0]?.status ?? null;
      },
      commitProbeExists: async (snapshotId, route) => {
        const rows = await primary(route).$queryRawUnsafe<unknown[]>(
          'SELECT 1 FROM "TaskRunExecutionSnapshot" WHERE id = $1',
          snapshotId
        );
        return rows.length > 0;
      },
      quarantine: async (unit, reason, raw) => {
        await options.connection.getStore().quarantinePreparedUnit(unit, reason, raw);
      },
    }));
  }

  return {
    decorate(leaf: RunStore, route: string): RunStore {
      if (leaves.has(route)) throw new Error(`Duplicate snapshot primary route: ${route}`);
      leaves.set(route, leaf);
      return new TaskRunExecutionSnapshotStore(leaf, {
        store: options.connection.getStore,
        mode: "dual-write",
        resolveDial: options.rollout.resolveDial,
        logicalRunStoreRoute: route,
        resolvePrimaryReadClient: () => leaf.primaryReadClient,
        resolvePending: async (runId, recoveryOptions) => {
          await options.connection.ready();
          await recoveryWorker().resolveEntry({ id: "", fields: { runId } }, recoveryOptions);
        },
        resolveCompletedWaitpoints: (args) => {
          completedWaitpoints ??= createCompletedWaitpointResolver(options.getRunStore());
          return completedWaitpoints(args);
        },
        metrics: options.metrics,
      });
    },
  };
}
