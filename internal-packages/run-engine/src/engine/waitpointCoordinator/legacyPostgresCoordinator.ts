import type { RunStore } from "@internal/run-store";
import type { Logger } from "@trigger.dev/core/logger";
import type { PrismaClient } from "@trigger.dev/database";
import { boundedIn } from "@trigger.dev/database";
import type { ClearRunBlockStateParams, WaitpointCoordinator } from "./types.js";

export type LegacyPostgresWaitpointCoordinatorOptions = {
  runStore: RunStore;
  prisma: PrismaClient;
  logger: Logger;
};

/**
 * Waitpoint coordination against Postgres, through the run-ops store.
 *
 * Dependencies are deliberately narrow: no run lock, no worker, no event bus.
 * That makes "this owns waitpoint state only" structural rather than a convention.
 */
export class LegacyPostgresWaitpointCoordinator implements WaitpointCoordinator {
  private readonly runStore: RunStore;
  private readonly prisma: PrismaClient;
  private readonly logger: Logger;

  constructor(options: LegacyPostgresWaitpointCoordinatorOptions) {
    this.runStore = options.runStore;
    this.prisma = options.prisma;
    this.logger = options.logger;
  }

  async clearRunBlockState({
    runId,
    edgeIds,
    tx,
  }: ClearRunBlockStateParams): Promise<{ count: number }> {
    if (edgeIds) {
      // Bounded delete of named edges, on the unblock path. No tx: that path is not inside a
      // caller transaction, and boundedIn caps the id-list arity for Prisma.
      return this.runStore.deleteManyTaskRunWaitpoints({
        where: {
          taskRunId: runId,
          id: { in: boundedIn(edgeIds) },
        },
      });
    }

    // A run's edges co-locate with the run (the edge write routes by runId), so the router routes
    // this taskRunId-keyed delete to the run's store rather than fanning out. The caller's `tx` is
    // passed through: a routing store strips it, and a single store joins it.
    return this.runStore.deleteManyTaskRunWaitpoints({ where: { taskRunId: runId } }, tx);
  }
}
