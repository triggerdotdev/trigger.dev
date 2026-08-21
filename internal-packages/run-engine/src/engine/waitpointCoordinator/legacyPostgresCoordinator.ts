import type { RunStore } from "@internal/run-store";
import { tryCatch } from "@trigger.dev/core/v3";
import type { Logger } from "@trigger.dev/core/logger";
import type { PrismaClient } from "@trigger.dev/database";
import { boundedIn } from "@trigger.dev/database";
import { UnclassifiableWaitpointId } from "../errors.js";
import type {
  ClearRunBlockStateParams,
  CompleteParams,
  CompleteResult,
  RegisterBlocksLocklessParams,
  RegisterBlocksParams,
  RunBlockEdge,
  WaitpointCoordinator,
} from "./types.js";

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

  async readRunBlockState(runId: string): Promise<RunBlockEdge[]> {
    return this.runStore.findManyTaskRunWaitpoints(
      {
        where: { taskRunId: runId },
        select: {
          id: true,
          batchId: true,
          batchIndex: true,
          waitpoint: {
            select: { id: true, status: true, type: true, completedAfter: true },
          },
        },
      },
      this.prisma
    );
  }

  async registerBlocks({
    client,
    ...edge
  }: RegisterBlocksParams): Promise<{ pendingCount: number }> {
    await this.#writeBlockEdges(edge);

    // Check if the run is actually blocked using a separate query. The separate statement is the
    // point: under PostgreSQL READ COMMITTED each statement gets its own snapshot, so a
    // concurrent completion that commits between the edge write and this check is still seen.
    // It queries ALL requested ids, not just inserted ones: a row that already existed (ON
    // CONFLICT skipped the insert) but is still PENDING must still block. Pass the caller's
    // client so the re-read is read-your-writes on the owning PRIMARY, and pass the run id so
    // the router counts on the run's store instead of fanning out to both DBs.
    const pendingCount = await this.runStore.countPendingWaitpoints(
      edge.waitpointIds,
      client,
      edge.runId
    );

    return { pendingCount };
  }

  async registerBlocksLockless(params: RegisterBlocksLocklessParams): Promise<void> {
    await this.#writeBlockEdges(params);
  }

  async complete({ waitpointId, output }: CompleteParams): Promise<CompleteResult> {
    // Residency store-selection guard. complete arrives with only (waitpointId, output) — no run
    // id — so the owning run-ops store is selected by the waitpoint's own residency. In single-DB
    // this is the one store (no classification). An unclassifiable id throws loud — never
    // default-routes. The try wraps ONLY the resolve: widening it would swallow the
    // "Waitpoint not found" path that a single store relies on.
    let store: RunStore;
    try {
      store = await this.runStore.forWaitpointCompletion(waitpointId, { routeKind: "MANUAL" });
    } catch (error) {
      this.logger.error("completeWaitpoint: unclassifiable waitpointId", {
        waitpointId,
        error,
      });
      throw new UnclassifiableWaitpointId(waitpointId, { cause: error });
    }

    // 1. Complete the Waitpoint (if not completed)
    const [updateError, updateResult] = await tryCatch(
      store.updateManyWaitpoints({
        where: { id: waitpointId, status: "PENDING" },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          output: output?.value,
          outputType: output?.type,
          outputIsError: output?.isError,
        },
      })
    );

    if (updateError) {
      this.logger.error("completeWaitpoint: error updating waitpoint:", { updateError });
      throw updateError;
    }

    if (updateResult.count === 0) {
      this.logger.info("completeWaitpoint: attempted to complete a waitpoint that is not PENDING", {
        waitpointId,
      });
    }

    // Re-read the just-written row from the RESOLVED store's PRIMARY: the replica (findWaitpoint's
    // default) can miss it under lag → false "not found" → the parent hangs. Going back through
    // the router would re-resolve the store and change the routing, so use the handle.
    const waitpoint = await store.findWaitpointOnPrimary({
      where: { id: waitpointId },
    });

    if (!waitpoint) {
      this.logger.error("completeWaitpoint: waitpoint not found", { waitpointId });
      throw new Error("Waitpoint not found");
    }

    if (waitpoint.status !== "COMPLETED") {
      this.logger.error(`completeWaitpoint: waitpoint is not completed`, { waitpointId });
      throw new Error("Waitpoint not completed");
    }

    // 2. Find the TaskRuns blocked by this waitpoint. The edge (TaskRunWaitpoint) co-locates
    // with its RUN, not this token, so it can live on the OTHER run-ops DB: read via the router
    // (which fans the waitpointId lookup across both DBs) rather than the token's own `store`,
    // or a cross-DB blocked run is never found and hangs forever.
    const blockedRuns = await this.runStore.findManyTaskRunWaitpoints(
      {
        where: { waitpointId },
        select: { taskRunId: true, spanIdToComplete: true, createdAt: true },
      },
      this.prisma
    );

    return { waitpoint, blockedRuns };
  }

  /**
   * The edge write, shared by both register paths so they cannot drift.
   *
   * Routed by the owning run id so the edge co-resides with the run. Never pinned to a caller
   * transaction: that joined `Waitpoint` on the wrong DB, wrote 0 edges, and silently never
   * suspended the parent. The write is idempotent (ON CONFLICT DO NOTHING).
   */
  #writeBlockEdges({
    runId,
    waitpointIds,
    projectId,
    spanIdToComplete,
    batchId,
    batchIndex,
  }: RegisterBlocksLocklessParams): Promise<void> {
    return this.runStore.blockRunWithWaitpointEdges({
      runId,
      waitpointIds,
      projectId,
      spanIdToComplete,
      batchId,
      batchIndex,
    });
  }
}
