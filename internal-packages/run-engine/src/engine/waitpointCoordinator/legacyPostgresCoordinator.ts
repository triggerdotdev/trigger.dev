import type { RunStore } from "@internal/run-store";
import { tryCatch } from "@trigger.dev/core/v3";
import {
  mintWaitpointIdFor,
  mintWaitpointIdForShard,
  UnclassifiableRunId,
} from "@trigger.dev/core/v3/isomorphic";
import type { Logger } from "@trigger.dev/core/logger";
import type { PrismaClient, Waitpoint } from "@trigger.dev/database";
import { boundedIn, Prisma } from "@trigger.dev/database";
import { nanoid } from "nanoid";
import { UnclassifiableWaitpointId } from "../errors.js";
import type {
  AssociatedWaitpointData,
  ClearRunBlockStateParams,
  CompleteParams,
  CompleteResult,
  CreateDateTimeWaitpointParams,
  CreateManualWaitpointParams,
  CreateWaitpointResult,
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
      // Only a genuine id-classification failure should become UnclassifiableWaitpointId.
      // forWaitpointCompletion also probes the DB to resolve the owning store, so a transient
      // database/infra error (e.g. can't reach the database) can surface here too. Those MUST
      // bubble up unchanged so they keep their original type, retryability, and error grouping
      // instead of being mislabelled as an unclassifiable id.
      if (error instanceof UnclassifiableRunId) {
        this.logger.error("completeWaitpoint: unclassifiable waitpointId", {
          waitpointId,
          error,
        });
        throw new UnclassifiableWaitpointId(waitpointId, { cause: error });
      }

      this.logger.error("completeWaitpoint: error resolving waitpoint store", {
        waitpointId,
        error,
      });
      throw error;
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

  async createDateTimeWaitpoint({
    runId,
    projectId,
    environmentId,
    completedAfter,
    idempotencyKey,
    idempotencyKeyExpiresAt,
  }: CreateDateTimeWaitpointParams): Promise<CreateWaitpointResult> {
    // Co-location invariant: a DATETIME wait waitpoint lives on the same run-ops DB as the run that
    // blocks on it (so the block edge's local `Waitpoint` join resolves and completion/resume stay
    // local). The minted waitpoint id is always a cuid, so without `coLocateWithRunId` the upsert
    // would always route to LEGACY and a run-ops run on NEW would hang. The (env,idempotencyKey) dedup
    // is within the owning run/tree (co-resident on one DB), so the dedup probe + rotation target the
    // SAME store. With no run id (a standalone token has no owning run yet) the lookup falls back to
    // a cross-DB NEW-then-LEGACY scan and the upsert routes by id-shape. Always routed through the
    // run store (never a caller tx) so it can never bypass residency onto the wrong DB.
    const colocate = runId ? { coLocateWithRunId: runId } : undefined;
    const existingWaitpoint = idempotencyKey
      ? await this.runStore.findWaitpoint(
          {
            where: {
              environmentId,
              idempotencyKey,
            },
          },
          undefined,
          colocate
        )
      : undefined;

    if (existingWaitpoint) {
      if (
        existingWaitpoint.idempotencyKeyExpiresAt &&
        new Date() > existingWaitpoint.idempotencyKeyExpiresAt
      ) {
        //the idempotency key has expired
        //remove the waitpoint idempotencyKey
        const rotateArgs = {
          where: {
            id: existingWaitpoint.id,
          },
          data: {
            idempotencyKey: nanoid(24),
            inactiveIdempotencyKey: existingWaitpoint.idempotencyKey,
          },
        };
        await this.runStore.updateWaitpoint(rotateArgs, undefined, colocate);

        //let it fall through to create a new waitpoint
      } else {
        return { kind: "cached", waitpoint: existingWaitpoint };
      }
    }

    // The two `nanoid(24)` calls below are deliberately separate and produce DIFFERENT values:
    // the upsert `where` key must not match the `create` key, or a guaranteed-miss upsert becomes
    // a possible update. Do not hoist either to a shared constant.
    const upsertArgs = {
      where: {
        environmentId_idempotencyKey: {
          environmentId,
          idempotencyKey: idempotencyKey ?? nanoid(24),
        },
      },
      create: {
        ...mintWaitpointIdFor(runId),
        type: "DATETIME" as const,
        idempotencyKey: idempotencyKey ?? nanoid(24),
        idempotencyKeyExpiresAt,
        userProvidedIdempotencyKey: !!idempotencyKey,
        environmentId,
        projectId,
        completedAfter,
      },
      update: {},
    };
    const waitpoint = await this.runStore.upsertWaitpoint(upsertArgs, undefined, colocate);

    return { kind: "created", waitpoint };
  }

  async createManualWaitpoint({
    runId,
    environmentId,
    projectId,
    idempotencyKey,
    idempotencyKeyExpiresAt,
    timeout,
    tags,
    standaloneResidency,
    standaloneShardKey,
  }: CreateManualWaitpointParams): Promise<CreateWaitpointResult> {
    // Co-location invariant (see createDateTimeWaitpoint): when a `runId` is supplied the waitpoint
    // co-locates with that run's DB and the (env,idempotencyKey) dedup is per-run (co-resident). A
    // standalone token (api.v1.waitpoints.tokens.ts) passes no run id — it is created without an
    // owner, blocked later by whichever run waits on it (possibly cross-DB, resolved by the
    // run-co-resident block edge + completion fan-out). With no owner it reads the env mint kind via
    // `standaloneResidency` so a minted-new env keeps its tokens on NEW; unset, it routes by id-shape. No tx here.
    // A gen-2 standalone token carries its shard in its own id, so it passes no residency hint.
    const standaloneShard = runId ? undefined : standaloneShardKey;
    const isGen2Standalone =
      standaloneShard !== undefined && standaloneShard !== "new" && standaloneShard !== "legacy";
    const colocate = runId
      ? { coLocateWithRunId: runId }
      : isGen2Standalone
        ? undefined
        : standaloneResidency
          ? { residency: standaloneResidency }
          : undefined;
    const existingWaitpoint = idempotencyKey
      ? await this.runStore.findWaitpoint(
          {
            where: {
              environmentId,
              idempotencyKey,
            },
          },
          undefined,
          colocate
        )
      : undefined;

    if (existingWaitpoint) {
      if (
        existingWaitpoint.idempotencyKeyExpiresAt &&
        new Date() > existingWaitpoint.idempotencyKeyExpiresAt
      ) {
        //the idempotency key has expired
        //remove the waitpoint idempotencyKey
        await this.runStore.updateWaitpoint(
          {
            where: {
              id: existingWaitpoint.id,
            },
            data: {
              idempotencyKey: nanoid(24),
              inactiveIdempotencyKey: existingWaitpoint.idempotencyKey,
            },
          },
          undefined,
          colocate
        );

        //let it fall through to create a new waitpoint
      } else {
        return { kind: "cached", waitpoint: existingWaitpoint };
      }
    }

    const maxRetries = 5;
    let attempts = 0;

    while (attempts < maxRetries) {
      try {
        // As in createDateTimeWaitpoint, the two `nanoid(24)` calls are deliberately separate and
        // differ. Both are re-evaluated per attempt, so a retry after a conflict tries a fresh
        // key. The anchor does not change, so every attempt stays on the same shard.
        const waitpoint = await this.runStore.upsertWaitpoint(
          {
            where: {
              environmentId_idempotencyKey: {
                environmentId,
                idempotencyKey: idempotencyKey ?? nanoid(24),
              },
            },
            create: {
              ...(standaloneShard !== undefined
                ? mintWaitpointIdForShard(standaloneShard)
                : mintWaitpointIdFor(runId)),
              type: "MANUAL",
              idempotencyKey: idempotencyKey ?? nanoid(24),
              idempotencyKeyExpiresAt,
              userProvidedIdempotencyKey: !!idempotencyKey,
              environmentId,
              projectId,
              completedAfter: timeout,
              tags,
            },
            update: {},
          },
          undefined,
          colocate
        );

        return { kind: "created", waitpoint };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          // Handle unique constraint violation (conflict)
          attempts++;
          if (attempts >= maxRetries) {
            throw new Error(
              `Failed to create waitpoint after ${maxRetries} attempts due to conflicts.`
            );
          }
        } else {
          throw error; // Re-throw other errors
        }
      }
    }

    throw new Error(`Failed to create waitpoint after ${maxRetries} attempts due to conflicts.`);
  }

  mintAssociatedWaitpointData({
    projectId,
    environmentId,
    anchorRunId,
  }: {
    projectId: string;
    environmentId: string;
    anchorRunId: string;
  }): AssociatedWaitpointData {
    return {
      ...mintWaitpointIdFor(anchorRunId),
      type: "RUN" as const,
      status: "PENDING" as const,
      idempotencyKey: nanoid(24),
      userProvidedIdempotencyKey: false,
      projectId,
      environmentId,
    };
  }

  async createAssociatedWaitpoint({
    runId,
    data,
  }: {
    runId: string;
    data: AssociatedWaitpointData;
  }): Promise<Waitpoint> {
    // RUN-type within-tree waitpoint that belongs to runId; routes by owning run id.
    return this.runStore.createWaitpoint({
      data: {
        ...data,
        completedByTaskRunId: runId,
      },
    });
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
