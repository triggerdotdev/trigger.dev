import { timeoutError } from "@trigger.dev/core/v3";
import type { ShardKey } from "@trigger.dev/core/v3/isomorphic";
import { boundedIn } from "@trigger.dev/database";
import type {
  PrismaClientOrTransaction,
  TaskRun,
  TaskRunExecutionSnapshot,
  TaskRunExecutionStatus,
  Waitpoint,
} from "@trigger.dev/database";
import { assertNever } from "assert-never";
import { WaitpointCompletionGuardArmedError } from "../errors.js";
import { buildCompletedWaitpointRecords } from "./completedWaitpointResolver.js";
import { resolveCompletedWaitpointRecords } from "./completedWaitpointRecordAdapter.js";
import { sendNotificationToWorker } from "../eventBus.js";
import { isFinalRunStatus } from "../statuses.js";
import { LegacyPostgresWaitpointCoordinator } from "../waitpointCoordinator/legacyPostgresCoordinator.js";
import {
  RoutingWaitpointCoordinator,
  type RoutingWaitpointCoordinatorMintPolicy,
  type WaitpointRunKey,
} from "../waitpointCoordinator/routingCoordinator.js";
import type { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import type {
  CompleteParams,
  RegisterBlocksParams,
  RunBlockEdge,
  WaitpointCoordinator,
} from "../waitpointCoordinator/types.js";
import type { EnqueueSystem } from "./enqueueSystem.js";
import type { ExecutionSnapshotSystem } from "./executionSnapshotSystem.js";
import {
  getLatestExecutionSnapshot,
  isExpiredSnapshotOfFinishedRun,
} from "./executionSnapshotSystem.js";
import type { SystemResources } from "./systems.js";
import {
  hasStoreWaitpoints,
  snapshotRouteFromSnapshot,
  type CompletedWaitpointRecord,
} from "@internal/run-store";

export type WaitpointSystemOptions = {
  waitpointStoreEnabled?: (
    organizationId: string,
    organizationFlags?: unknown
  ) => boolean | Promise<boolean>;
  resources: SystemResources;
  executionSnapshotSystem: ExecutionSnapshotSystem;
  enqueueSystem: EnqueueSystem;
  /** Grace before an unacked completion guard fires. Defaults to 30s. */
  completionGuardDelayMs?: number;
  /**
   * Dark routing/mint-selection wiring. Omitted in production today: with no `store` the routing
   * coordinator is a 1:1 legacy passthrough — no MemoryDB client, no store calls, no `wp:v1` keys —
   * and every mint stays legacy. A later ticket supplies a store coordinator and a real mint policy
   * to activate MemoryDB minting per organization.
   */
  waitpointRouting?: {
    store?: WaitpointCoordinator;
    mintPolicy?: RoutingWaitpointCoordinatorMintPolicy;
    /**
     * Optional run-state reader override. By default the owning run's internal waitpointsOnStore
     * annotation decides after the organization's flag permits store access.
     */
    mightHaveStoreBlockers?: (runKey: WaitpointRunKey) => boolean | Promise<boolean>;
  };
  /**
   * Reads store-format waitpoint records for a redis-primary resume. Undefined keeps the resolver
   * Postgres-only, the only reachable state until store-format minting is wired.
   */
  waitpointStore?: Pick<WaitpointStoreCoordinator, "readCompletedRecords">;
};

const DEFAULT_COMPLETION_GUARD_DELAY_MS = 30_000;

type WaitpointContinuationWaitpoint = Pick<Waitpoint, "id" | "type" | "completedAfter" | "status">;

export type WaitpointContinuationResult =
  | {
      status: "unblocked";
      waitpoints: Array<WaitpointContinuationWaitpoint>;
    }
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "blocked";
      waitpoints: Array<WaitpointContinuationWaitpoint>;
    };

export class WaitpointSystem {
  private readonly $: SystemResources;
  private readonly executionSnapshotSystem: ExecutionSnapshotSystem;
  private readonly enqueueSystem: EnqueueSystem;
  private readonly coordinator: WaitpointCoordinator;
  private readonly legacyCoordinator: WaitpointCoordinator;
  private readonly completionGuardDelayMs: number;
  readonly #waitpointStore?: Pick<WaitpointStoreCoordinator, "readCompletedRecords">;

  constructor(private readonly options: WaitpointSystemOptions) {
    this.$ = options.resources;
    this.executionSnapshotSystem = options.executionSnapshotSystem;
    this.enqueueSystem = options.enqueueSystem;
    this.#waitpointStore = options.waitpointStore;
    this.completionGuardDelayMs =
      options.completionGuardDelayMs ?? DEFAULT_COMPLETION_GUARD_DELAY_MS;
    const legacyCoordinator = new LegacyPostgresWaitpointCoordinator({
      // A getter, so a `setRunStore` swap (a test seam) also reaches the coordinator.
      runStore: () => this.$.runStore,
      prisma: this.$.prisma,
      logger: this.$.logger,
    });
    this.legacyCoordinator = legacyCoordinator;
    // Dark by default: with no store coordinator the router delegates every operation to Postgres and
    // never consults the mint policy, so production behaves exactly as before.
    this.coordinator = options.waitpointRouting?.store
      ? new RoutingWaitpointCoordinator({
          legacy: legacyCoordinator,
          store: options.waitpointRouting?.store,
          isStoreEnabled: async (organizationId) =>
            organizationId !== undefined &&
            (await options.waitpointStoreEnabled?.(organizationId)) === true,
          mintPolicy: {
            ...options.waitpointRouting?.mintPolicy,
            // The router has already checked this mint operation's organization flag.
            resolveMintMode:
              options.waitpointRouting?.mintPolicy?.resolveMintMode ?? (() => "redis"),
            isCapabilityReady:
              options.waitpointRouting?.mintPolicy?.isCapabilityReady ?? (() => false),
          },
          mightHaveStoreBlockers:
            options.waitpointRouting?.mightHaveStoreBlockers ??
            (async ({ runId }) => {
              const run = await this.$.runStore.findRunOnPrimary(
                { id: runId },
                { select: { annotations: true } }
              );
              // Missing runs stay conservative for delayed cleanup; never use a replica here.
              return run ? hasStoreWaitpoints(run.annotations) : true;
            }),
        })
      : legacyCoordinator;
  }

  public async clearBlockingWaitpoints({
    runId,
    organizationId,
    tx,
  }: {
    runId: string;
    // The run's org, so the router can skip MemoryDB for a run whose org could not hold store edges.
    // Undefined keeps legacy routing without discovering an organization.
    organizationId?: string;
    tx?: PrismaClientOrTransaction;
  }) {
    const deleted = await this.coordinator.clearRunBlockState({ runId, organizationId, tx });

    return deleted.count;
  }

  /** Completes a waitpoint and schedules a continue for each run it blocked. Safe under races. */
  async completeWaitpoint({
    id,
    output,
    armGuard = false,
    organizationId,
  }: {
    id: string;
    output?: {
      value: string;
      type?: string;
      isError: boolean;
    };
    /** Arms the write-ahead completion guard first. The guard's replay passes false. */
    armGuard?: boolean;
    /**
     * The waitpoint's organization, from the completing caller's context. A waitpoint is environment-
     * scoped and every blocking run is resolved within its own environment (see the wait routes), so a
     * waitpoint cannot block runs across organizations — this one org is carried onto each blocked run's
     * `continueRunIfUnblocked` so the delayed continuation routes MemoryDB by the run's org rather than
     * an unknown one, without any per-edge lookup. Undefined (a caller without it, or an old guard
     * replay) retains the original legacy route, including its error behavior.
     */
    organizationId?: string;
  }): Promise<Waitpoint> {
    // Keep this pre-check outside guard scheduling and its error handling. The router owns its
    // mutation gate, so an armed call checks again after the durable guard has been persisted.
    const storeRoutingEnabled =
      this.coordinator instanceof RoutingWaitpointCoordinator &&
      (await this.coordinator.isStoreRoutingEnabled(organizationId));

    // Armed before the first mutation, so a committed completion always has a durable watcher. An
    // arm failure is not wrapped, so the caller cannot mistake it for one the guard will replay.
    if (armGuard) {
      await this.#scheduleCompletionGuard(id, output);
    }

    // From here the guard owns eventual completion. A failure is wrapped as
    // WaitpointCompletionGuardArmedError, so the API can return success and let the guard replay.
    try {
      const params: CompleteParams = { waitpointId: id, output };
      if (storeRoutingEnabled) params.organizationId = organizationId;
      const { waitpoint, blockedRuns } = await (
        storeRoutingEnabled ? this.coordinator : this.legacyCoordinator
      ).complete(params);

      if (blockedRuns.length === 0) {
        this.$.logger.debug(`completeWaitpoint: no TaskRunWaitpoints found for waitpoint`, {
          waitpointId: id,
        });
      }

      for (const run of blockedRuns) {
        const jobId = `continueRunIfUnblocked:${run.taskRunId}`;
        const availableAt = new Date(Date.now() + 50);

        this.$.logger.debug(`completeWaitpoint: enqueueing continueRunIfUnblocked`, {
          waitpointId: id,
          runId: run.taskRunId,
          jobId,
          availableAt,
        });

        await this.$.worker.enqueue({
          // The fixed job id debounces repeat enqueues.
          id: jobId,
          job: "continueRunIfUnblocked",
          // Carry the completion's org (== every blocked run's org; see the doc on this method) so the
          // delayed continuation can route MemoryDB when enabled. Disabled/unwired jobs retain
          // the original runId-only payload.
          payload: storeRoutingEnabled
            ? { runId: run.taskRunId, organizationId }
            : { runId: run.taskRunId },
          availableAt,
        });

        if (run.spanIdToComplete) {
          this.$.eventBus.emit("cachedRunCompleted", {
            time: new Date(),
            span: {
              id: run.spanIdToComplete,
              createdAt: run.createdAt,
            },
            blockedRunId: run.taskRunId,
            hasError: output?.isError ?? false,
            cachedRunId: waitpoint.completedByTaskRunId ?? undefined,
          });
        }
      }

      // Ack only after the commit and the fanout. If the process dies first, the guard replays.
      if (armGuard) {
        await this.#ackCompletionGuard(id);
      }

      return waitpoint;
    } catch (error) {
      if (armGuard) {
        throw new WaitpointCompletionGuardArmedError(id, { cause: error });
      }
      throw error;
    }
  }

  #completionGuardId(waitpointId: string): string {
    return `ensureWaitpointCompleted:${waitpointId}`;
  }

  // enqueueOnce keeps the first writer's output. The delay gives the inline path time to ack. The
  // status-guarded update fixes the winning output, so a replay never overwrites it.
  async #scheduleCompletionGuard(
    waitpointId: string,
    output?: { value: string; type?: string; isError: boolean }
  ): Promise<void> {
    await this.$.worker.enqueueOnce({
      id: this.#completionGuardId(waitpointId),
      job: "ensureWaitpointCompleted",
      payload: { waitpointId, output },
      availableAt: new Date(Date.now() + this.completionGuardDelayMs),
    });
  }

  async #ackCompletionGuard(waitpointId: string): Promise<void> {
    await this.$.worker.ack(this.#completionGuardId(waitpointId));
  }

  /**
   * Completion guard redelivery: replays the completion and fanout when the inline path died after
   * arming. The status-guarded update and the debounced continue make the replay idempotent. The
   * worker retries this job until it succeeds.
   */
  public async ensureWaitpointCompleted({
    waitpointId,
    output,
  }: {
    waitpointId: string;
    output?: { value: string; type?: string; isError: boolean };
  }): Promise<void> {
    await this.completeWaitpoint({ id: waitpointId, output, armGuard: false });
  }

  /**
   * Creates a DATETIME waitpoint that completes at `completedAfter`. With an `idempotencyKey`, an
   * existing waitpoint is returned.
   */
  async createDateTimeWaitpoint({
    runId,
    projectId,
    environmentId,
    completedAfter,
    idempotencyKey,
    idempotencyKeyExpiresAt,
  }: {
    runId?: string;
    projectId: string;
    environmentId: string;
    completedAfter: Date;
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: Date;
  }) {
    const result = await this.coordinator.createDateTimeWaitpoint({
      runId,
      projectId,
      environmentId,
      completedAfter,
      idempotencyKey,
      idempotencyKeyExpiresAt,
    });

    if (result.kind === "cached") {
      return { waitpoint: result.waitpoint, isCached: true };
    }

    await this.$.worker.enqueue({
      id: `finishWaitpoint.${result.waitpoint.id}`,
      job: "finishWaitpoint",
      payload: { waitpointId: result.waitpoint.id },
      availableAt: completedAfter,
    });

    return { waitpoint: result.waitpoint, isCached: false };
  }

  /** Creates a MANUAL waitpoint. With an `idempotencyKey`, an existing waitpoint is returned. */
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
  }: {
    runId?: string;
    environmentId: string;
    projectId: string;
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: Date;
    timeout?: Date;
    tags?: string[];
    // Standalone token only (no `runId`): the env's mint residency, so the token does not default
    // to LEGACY by its cuid id shape. Ignored when `runId` is set.
    standaloneResidency?: "NEW" | "LEGACY";
    standaloneShardKey?: ShardKey;
  }): Promise<{ waitpoint: Waitpoint; isCached: boolean }> {
    const result = await this.coordinator.createManualWaitpoint({
      runId,
      environmentId,
      projectId,
      idempotencyKey,
      idempotencyKeyExpiresAt,
      timeout,
      tags,
      standaloneResidency,
      standaloneShardKey,
    });

    if (result.kind === "cached") {
      return { waitpoint: result.waitpoint, isCached: true };
    }

    if (timeout) {
      await this.$.worker.enqueue({
        id: `finishWaitpoint.${result.waitpoint.id}`,
        job: "finishWaitpoint",
        payload: {
          waitpointId: result.waitpoint.id,
          error: JSON.stringify(timeoutError(timeout)),
        },
        availableAt: timeout,
      });
    }

    return { waitpoint: result.waitpoint, isCached: false };
  }

  /**
   * Blocks a run until the waitpoints complete.
   *
   * The edge write is routed by run id to the run's store. Pinning it to the caller's control-plane
   * tx would join `Waitpoint` on the wrong DB and write 0 edges, so the parent never suspends. The
   * edge write is idempotent, so a retry after a crash before the snapshot write is safe.
   *
   * The pending check is a separate statement on purpose: under READ COMMITTED it sees a completion
   * that commits after the edge write. It checks every requested id, because an existing edge to a
   * PENDING waitpoint must still block.
   */
  async blockRunWithWaitpoint({
    runId,
    waitpoints,
    projectId,
    organizationId,
    timeout,
    spanIdToComplete,
    batch,
    workerId,
    runnerId,
    expectedEnvironmentId,
    tx,
  }: {
    runId: string;
    waitpoints: string | string[];
    projectId: string;
    organizationId: string;
    timeout?: Date;
    spanIdToComplete?: string;
    batch?: { id: string; index?: number };
    workerId?: string;
    runnerId?: string;
    // An environment the run MUST belong to. When set, the run's snapshot read is scoped to it, so a
    // run from another org/project/env yields no snapshot and throws (404) BEFORE any edge is
    // registered — the cross-org registration guard for the public token-wait route. The run's
    // snapshots are all in its own environment, so a snapshot found under this id proves membership.
    expectedEnvironmentId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<TaskRunExecutionSnapshot> {
    const prisma = tx ?? this.$.prisma;

    await this.$.raceSimulationSystem.waitForRacepoint({ runId });

    let $waitpoints = typeof waitpoints === "string" ? [waitpoints] : waitpoints;

    return await this.$.runLock.lock("blockRunWithWaitpoint", [runId], async () => {
      // Scoped to expectedEnvironmentId when the caller supplied one: a foreign run has no snapshot in
      // that env, so this throws before registerBlocks and no cross-org edge is written.
      let snapshot: TaskRunExecutionSnapshot = await getLatestExecutionSnapshot(
        prisma,
        runId,
        this.$.runStore,
        expectedEnvironmentId,
        organizationId
      );

      // Two statements, in this order: see the READ COMMITTED note on the method.
      const params: RegisterBlocksParams = {
        runId,
        waitpointIds: $waitpoints,
        projectId,
        spanIdToComplete,
        batchId: batch?.id,
        batchIndex: batch?.index,
        client: prisma,
      };
      if (this.coordinator instanceof RoutingWaitpointCoordinator) {
        params.organizationId = organizationId;
      }
      const { pendingCount, storeRoutingEnabled } = await this.coordinator.registerBlocks(params);

      const isRunBlocked = pendingCount > 0;

      let newStatus: TaskRunExecutionStatus = "SUSPENDED";
      if (
        snapshot.executionStatus === "EXECUTING" ||
        snapshot.executionStatus === "EXECUTING_WITH_WAITPOINTS"
      ) {
        newStatus = "EXECUTING_WITH_WAITPOINTS";
      }

      if (newStatus !== snapshot.executionStatus) {
        snapshot = await this.executionSnapshotSystem.createExecutionSnapshot(prisma, {
          run: {
            id: snapshot.runId,
            status: snapshot.runStatus,
            attemptNumber: snapshot.attemptNumber,
          },
          snapshot: {
            executionStatus: newStatus,
            description: "Run was blocked by a waitpoint.",
          },
          previousSnapshotId: snapshot.id,
          previousSnapshot: snapshot,
          snapshotRoute: snapshotRouteFromSnapshot(snapshot),
          environmentId: snapshot.environmentId,
          environmentType: snapshot.environmentType,
          projectId: snapshot.projectId,
          organizationId,
          // Never carry over the previous snapshot's batchId.
          batchId: batch?.id,
          workerId,
          runnerId,
        });

        // Tell the worker now, so it can suspend the run.
        await sendNotificationToWorker({ runId, snapshot, eventBus: this.$.eventBus });
      }

      if (timeout) {
        for (const waitpoint of $waitpoints) {
          await this.$.worker.enqueue({
            id: `finishWaitpoint.${waitpoint}`,
            job: "finishWaitpoint",
            payload: {
              waitpointId: waitpoint,
              error: JSON.stringify(timeoutError(timeout)),
            },
            availableAt: timeout,
          });
        }
      }

      if (!isRunBlocked) {
        await this.$.worker.enqueue({
          // The fixed job id debounces rapid repeat blocks.
          id: `continueRunIfUnblocked:${runId}`,
          job: "continueRunIfUnblocked",
          payload: storeRoutingEnabled ? { runId, organizationId } : { runId: runId },
          availableAt: new Date(Date.now() + 50),
        });
      }

      return snapshot;
    });
  }

  /**
   * blockRunWithWaitpoint without the run lock, for batch items. blockRunWithCreatedBatch has
   * already moved the parent to EXECUTING_WITH_WAITPOINTS, and a per-item lock causes
   * LockAcquisitionTimeoutError on large batches. Writes only the idempotent edges and timeouts.
   */
  async blockRunWithWaitpointLockless({
    runId,
    waitpoints,
    projectId,
    timeout,
    spanIdToComplete,
    batch,
  }: {
    runId: string;
    waitpoints: string | string[];
    projectId: string;
    timeout?: Date;
    spanIdToComplete?: string;
    batch: { id: string; index?: number };
  }): Promise<void> {
    const $waitpoints = typeof waitpoints === "string" ? [waitpoints] : waitpoints;

    await this.coordinator.registerBlocksLockless({
      runId,
      waitpointIds: $waitpoints,
      projectId,
      spanIdToComplete,
      batchId: batch.id,
      batchIndex: batch.index,
    });

    if (timeout) {
      for (const waitpoint of $waitpoints) {
        await this.$.worker.enqueue({
          id: `finishWaitpoint.${waitpoint}`,
          job: "finishWaitpoint",
          payload: {
            waitpointId: waitpoint,
            error: JSON.stringify(timeoutError(timeout)),
          },
          availableAt: timeout,
        });
      }
    }
  }

  /**
   * For a pre-failed child run: blocks the parent so it receives the error output, then completes
   * the waitpoint.
   */
  async blockRunAndCompleteWaitpoint({
    runId,
    waitpointId,
    output,
    projectId,
    organizationId,
    batch,
  }: {
    runId: string;
    waitpointId: string;
    output: { value: string; type?: string; isError: boolean };
    projectId: string;
    organizationId: string;
    batch?: { id: string; index?: number };
  }): Promise<void> {
    await this.blockRunWithWaitpoint({
      runId,
      waitpoints: waitpointId,
      projectId,
      organizationId,
      batch,
    });

    await this.completeWaitpoint({
      id: waitpointId,
      output,
      organizationId,
    });
  }

  public async continueRunIfUnblocked({
    runId,
    organizationId,
  }: {
    runId: string;
    // The blocked run's org, carried independently of the route: the common delayed-completion enqueue
    // has no route but does know the org, so this keeps run-keyed routing from querying MemoryDB for
    // every legacy run. Undefined (old payload / no org) keeps the legacy route.
    organizationId?: string;
  }): Promise<WaitpointContinuationResult> {
    this.$.logger.debug(`continueRunIfUnblocked: start`, {
      runId,
    });

    await this.$.raceSimulationSystem.waitForRacepoint({ runId });

    // Use the explicitly carried org for the flag check. Without it, keep the legacy route
    // without discovering an organisation or consulting MemoryDB.
    const routingOrganizationId = organizationId;

    return await this.$.runLock.lock("continueRunIfUnblocked", [runId], async () => {
      // 1. Get the any blocking waitpoints, routed by the run's org.
      const storeRoutingEnabled =
        this.coordinator instanceof RoutingWaitpointCoordinator &&
        (await this.coordinator.isStoreRoutingEnabled(routingOrganizationId));
      const blockingWaitpoints = storeRoutingEnabled
        ? await this.coordinator.readRunBlockState(runId, {
            organizationId: routingOrganizationId,
          })
        : await this.legacyCoordinator.readRunBlockState(runId);

      if (blockingWaitpoints.some((w) => w.waitpoint.status !== "COMPLETED")) {
        this.$.logger.debug(`continueRunIfUnblocked: blocking waitpoints still exist`, {
          runId,
          blockingWaitpointCount: blockingWaitpoints.length,
        });

        return {
          status: "blocked",
          waitpoints: blockingWaitpoints.map((w) => w.waitpoint),
        };
      }

      // The environment comes from the control-plane resolver, so there is no cross-provider join.
      const run = await this.$.runStore.findRun(
        {
          id: runId,
        },
        this.$.prisma
      );

      if (!run) {
        this.$.logger.error(`continueRunIfUnblocked: run not found`, {
          runId,
        });
        throw new Error(`continueRunIfUnblocked: run not found: ${runId}`);
      }

      const env = await this.$.controlPlaneResolver.resolveEnv(run.runtimeEnvironmentId);

      if (!env) {
        this.$.logger.error(`continueRunIfUnblocked: environment not found`, {
          runId,
          runtimeEnvironmentId: run.runtimeEnvironmentId,
        });
        throw new Error(
          `continueRunIfUnblocked: environment not found: ${run.runtimeEnvironmentId}`
        );
      }

      let snapshot: Awaited<ReturnType<typeof getLatestExecutionSnapshot>>;
      try {
        snapshot = await getLatestExecutionSnapshot(
          this.$.prisma,
          runId,
          this.$.runStore,
          undefined,
          env.organizationId
        );
      } catch (error) {
        if (!isExpiredSnapshotOfFinishedRun(error, run.status)) {
          throw error;
        }
        this.$.logger.warn("continueRunIfUnblocked: snapshot state expired, run already finished", {
          runId,
        });
        return {
          status: "skipped",
          reason: "run is finished",
        };
      }

      switch (snapshot.executionStatus) {
        case "RUN_CREATED": {
          this.$.logger.info(`continueRunIfUnblocked: run is run created, skipping`, {
            runId,
            snapshotId: snapshot.id,
            executionStatus: snapshot.executionStatus,
          });

          return {
            status: "skipped",
            reason: "run is already executing",
          };
        }
        case "DELAYED": {
          this.$.logger.debug(`continueRunIfUnblocked: run is delayed, skipping`, {
            runId,
            snapshotId: snapshot.id,
            executionStatus: snapshot.executionStatus,
          });

          return {
            status: "skipped",
            reason: "run is delayed",
          };
        }
        case "QUEUED": {
          this.$.logger.info(`continueRunIfUnblocked: run is queued, skipping`, {
            runId,
            snapshotId: snapshot.id,
            executionStatus: snapshot.executionStatus,
          });

          return {
            status: "skipped",
            reason: "run is already queued",
          };
        }
        case "PENDING_EXECUTING": {
          this.$.logger.info(`continueRunIfUnblocked: run is pending executing, skipping`, {
            runId,
            snapshotId: snapshot.id,
            executionStatus: snapshot.executionStatus,
          });

          return {
            status: "skipped",
            reason: "run is already pending executing",
          };
        }
        case "QUEUED_EXECUTING": {
          this.$.logger.info(`continueRunIfUnblocked: run is already queued executing, skipping`, {
            runId,
            snapshotId: snapshot.id,
            executionStatus: snapshot.executionStatus,
          });

          return {
            status: "skipped",
            reason: "run is already queued executing",
          };
        }
        case "EXECUTING": {
          this.$.logger.info(`continueRunIfUnblocked: run is already executing, skipping`, {
            runId,
            snapshotId: snapshot.id,
            executionStatus: snapshot.executionStatus,
          });

          return {
            status: "skipped",
            reason: "run is already executing",
          };
        }
        case "PENDING_CANCEL":
        case "FINISHED": {
          this.$.logger.debug(`continueRunIfUnblocked: run is finished, skipping`, {
            runId,
            snapshotId: snapshot.id,
            executionStatus: snapshot.executionStatus,
          });
          return {
            status: "skipped",
            reason: "run is finished",
          };
        }
        case "EXECUTING_WITH_WAITPOINTS": {
          const resolveCompletedWaitpointRecords = await this.#completedWaitpointRecordsResolver(
            runId,
            snapshot,
            blockingWaitpoints
          );
          const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(
            this.$.prisma,
            {
              run: {
                id: runId,
                status: snapshot.runStatus,
                attemptNumber: snapshot.attemptNumber,
              },
              snapshot: {
                executionStatus: "EXECUTING",
                description: "Run was continued, whilst still executing.",
              },
              previousSnapshotId: snapshot.id,
              previousSnapshot: snapshot,
              snapshotRoute: snapshotRouteFromSnapshot(snapshot),
              environmentId: snapshot.environmentId,
              environmentType: snapshot.environmentType,
              projectId: snapshot.projectId,
              organizationId: snapshot.organizationId,
              batchId: this.#resumeBatchId(runId, snapshot.batchId, blockingWaitpoints),
              completedWaitpoints: blockingWaitpoints.map((b) => ({
                id: b.waitpoint.id,
                index: b.batchIndex ?? undefined,
              })),
              resolveCompletedWaitpointRecords,
            }
          );

          this.$.logger.debug(
            `continueRunIfUnblocked: run was still executing, sending notification`,
            {
              runId,
              snapshotId: snapshot.id,
              snapshotExecutionStatus: snapshot.executionStatus,
              newSnapshotId: newSnapshot.id,
              newSnapshotExecutionStatus: newSnapshot.executionStatus,
            }
          );

          await sendNotificationToWorker({
            runId,
            snapshot: newSnapshot,
            eventBus: this.$.eventBus,
          });

          break;
        }
        case "SUSPENDED": {
          if (!snapshot.checkpointId || !snapshot.checkpoint) {
            // Cancel clears the checkpoint of a run canceled mid-suspend: nothing to resume.
            if (snapshot.runStatus === "CANCELED") {
              this.$.logger.warn(
                `continueRunIfUnblocked: run was canceled while suspended, skipping`,
                {
                  runId,
                  snapshotId: snapshot.id,
                  executionStatus: snapshot.executionStatus,
                  runStatus: snapshot.runStatus,
                }
              );
              return {
                status: "skipped",
                reason: "run was canceled while suspended",
              };
            }

            this.$.logger.error(`continueRunIfUnblocked: run is suspended, but has no checkpoint`, {
              runId,
              snapshotId: snapshot.id,
              executionStatus: snapshot.executionStatus,
              runStatus: snapshot.runStatus,
            });
            throw new Error(
              `continueRunIfUnblocked: run is suspended, but has no checkpoint: ${runId}`
            );
          }

          // Re-enqueue with the original timestamp, so waiting runs dequeue before new runs.
          const resolveCompletedWaitpointRecords = await this.#completedWaitpointRecordsResolver(
            runId,
            snapshot,
            blockingWaitpoints
          );
          const newSnapshot = await this.enqueueSystem.enqueueRun({
            run,
            env,
            previousSnapshotId: snapshot.id,
            previousSnapshot: snapshot,
            snapshotRoute: snapshotRouteFromSnapshot(snapshot),
            snapshot: {
              status: "QUEUED",
              description: "Run was QUEUED, because all waitpoints are completed",
            },
            batchId: this.#resumeBatchId(runId, snapshot.batchId, blockingWaitpoints),
            completedWaitpoints: blockingWaitpoints.map((b) => ({
              id: b.waitpoint.id,
              index: b.batchIndex ?? undefined,
            })),
            resolveCompletedWaitpointRecords,
            checkpoint: snapshot.checkpoint,
          });

          this.$.logger.debug(`continueRunIfUnblocked: run goes to QUEUED`, {
            runId,
            snapshotId: snapshot.id,
            snapshotExecutionStatus: snapshot.executionStatus,
            newSnapshotId: newSnapshot.id,
            newSnapshotExecutionStatus: newSnapshot.executionStatus,
          });

          break;
        }
        default: {
          assertNever(snapshot.executionStatus);
        }
      }

      if (blockingWaitpoints.length > 0) {
        await this.coordinator.clearRunBlockState({
          runId,
          organizationId: routingOrganizationId,
          edgeIds: blockingWaitpoints.map((b) => b.id),
        });

        this.$.logger.debug(`continueRunIfUnblocked: removed blocking waitpoints`, {
          runId,
          blockingWaitpointCount: blockingWaitpoints.length,
        });
      }

      return {
        status: "unblocked",
        waitpoints: blockingWaitpoints.map((w) => w.waitpoint),
      };
    });
  }

  // A retried batch create can block an already-waiting run, leaving the snapshot on the first batch.
  // Child results carry their real batch on the edge, and the SDK matches results by it.
  #resumeBatchId(
    runId: string,
    snapshotBatchId: string | null,
    blockingWaitpoints: RunBlockEdge[]
  ): string | undefined {
    const childBatchIds: string[] = [];
    for (const edge of blockingWaitpoints) {
      // Only child-result edges carry a batchIndex. A batch's own waitpoint edge doesn't, and
      // counting it would add the abandoned batch from a retried create.
      if (edge.batchIndex !== null && edge.batchId && !childBatchIds.includes(edge.batchId)) {
        childBatchIds.push(edge.batchId);
      }
    }

    if (childBatchIds.length === 1) {
      const childBatchId = childBatchIds[0];
      if (childBatchId !== snapshotBatchId) {
        this.$.logger.warn("continueRunIfUnblocked: resuming with the child results' batch", {
          runId,
          snapshotBatchId,
          batchId: childBatchId,
        });
      }
      return childBatchId;
    }

    if (childBatchIds.length > 1) {
      this.$.logger.warn("continueRunIfUnblocked: child results belong to more than one batch", {
        runId,
        snapshotBatchId,
        batchIds: childBatchIds,
      });
    }

    return snapshotBatchId ?? undefined;
  }

  // A redis-primary cycle is built inside the owning Postgres transaction. Fetching its records
  // there waits for a second pooled connection, and concurrent resumes can exhaust the pool. So a
  // redis-primary resume fetches them here, before the transaction opens. Otherwise the thunk stays
  // lazy, and the store calls it only for a redis-primary write, never for postgres or mirrored.
  async #completedWaitpointRecordsResolver(
    runId: string,
    snapshot: { organizationId: string; metadata?: unknown },
    blockingWaitpoints: { waitpoint: { id: string } }[]
  ): Promise<() => Promise<CompletedWaitpointRecord[]>> {
    if (
      blockingWaitpoints.length > 0 &&
      snapshotRouteFromSnapshot(snapshot).residency === "redis-primary"
    ) {
      const records = await this.resolveResumeCompletedWaitpointRecords(
        runId,
        blockingWaitpoints,
        snapshot.organizationId
      );
      return async () => records;
    }
    return () =>
      this.resolveResumeCompletedWaitpointRecords(
        runId,
        blockingWaitpoints,
        snapshot.organizationId
      );
  }

  // Full records for a redis-primary cycle: the blocking edges carry only a 4-field pick. See
  // #completedWaitpointRecordsResolver for when it runs. The adapter path reads only COMPLETED
  // legacy rows, so a stray PENDING row is never described as a completion. TS-private so a test
  // can call it.
  private async resolveResumeCompletedWaitpointRecords(
    runId: string,
    blockingWaitpoints: { waitpoint: { id: string } }[],
    organizationId?: string
  ) {
    // Without a store, or for a disabled org, read Postgres only and do not classify ids.
    const organizationEnabled =
      this.#waitpointStore !== undefined &&
      organizationId !== undefined &&
      (await this.options.waitpointStoreEnabled?.(organizationId)) === true;
    if (!organizationEnabled) {
      const rows = await this.$.runStore.findManyWaitpoints(
        { where: { id: { in: boundedIn(blockingWaitpoints.map((b) => b.waitpoint.id)) } } },
        this.$.prisma,
        runId
      );
      return buildCompletedWaitpointRecords(rows);
    }
    return resolveCompletedWaitpointRecords({
      requestedIds: blockingWaitpoints.map((b) => b.waitpoint.id),
      legacyReader: async (ids) =>
        buildCompletedWaitpointRecords(
          await this.$.runStore.findManyWaitpoints(
            { where: { id: { in: boundedIn(ids) }, status: "COMPLETED" } },
            this.$.prisma,
            runId
          )
        ),
      storeReader: this.#waitpointStore
        ? (ids) => this.#waitpointStore!.readCompletedRecords(ids)
        : undefined,
    });
  }

  public buildRunAssociatedWaitpoint({
    projectId,
    environmentId,
    anchorRunId,
  }: {
    projectId: string;
    environmentId: string;
    anchorRunId: string;
  }) {
    return this.coordinator.mintAssociatedWaitpointData({
      projectId,
      environmentId,
      anchorRunId,
    });
  }

  /** Undefined for a success with no output, or for a run that is not final. */
  public buildWaitpointOutputFromRun(
    run: Pick<TaskRun, "status" | "output" | "outputType" | "error">
  ): { value: string; type?: string; isError: boolean } | undefined {
    if (run.status === "COMPLETED_SUCCESSFULLY") {
      if (run.output == null) {
        return undefined;
      }
      return {
        value: run.output,
        type: run.outputType ?? undefined,
        isError: false,
      };
    }
    if (isFinalRunStatus(run.status)) {
      return {
        value: JSON.stringify(run.error ?? {}),
        isError: true,
      };
    }
    return undefined;
  }

  /**
   * Returns the run's waitpoint, creating it for a late triggerAndWait caller on a run created
   * without one. If the run already finished, the new waitpoint is completed with its output.
   */
  public async getOrCreateRunWaitpoint({
    runId,
    projectId,
    environmentId,
  }: {
    runId: string;
    projectId: string;
    environmentId: string;
  }): Promise<Waitpoint> {
    const run = await this.$.runStore.findRun(
      { id: runId },
      { include: { associatedWaitpoint: true } },
      this.$.prisma
    );

    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    if (run.associatedWaitpoint) {
      return run.associatedWaitpoint;
    }

    // Create under the run lock to prevent a race.
    return this.$.runLock.lock("getOrCreateRunWaitpoint", [runId], async () => {
      const prisma = this.$.prisma;

      const runAfterLock = await this.$.runStore.findRun(
        { id: runId },
        { include: { associatedWaitpoint: true } },
        prisma
      );

      if (!runAfterLock) {
        throw new Error(`Run not found: ${runId}`);
      }

      if (runAfterLock.associatedWaitpoint) {
        return runAfterLock.associatedWaitpoint;
      }

      // Decide from the latest snapshot, not the TaskRun status.
      let runFinished: boolean;
      try {
        const snapshot = await getLatestExecutionSnapshot(
          prisma,
          runId,
          this.$.runStore,
          undefined,
          runAfterLock.organizationId ?? undefined
        );
        runFinished = snapshot.executionStatus === "FINISHED";
      } catch (error) {
        if (!isExpiredSnapshotOfFinishedRun(error, runAfterLock.status)) {
          throw error;
        }
        this.$.logger.warn("getOrCreateRunWaitpoint: snapshot state expired, using final run row", {
          runId,
        });
        runFinished = true;
      }

      // Creates and links the waitpoint atomically.
      const waitpointData = this.buildRunAssociatedWaitpoint({
        projectId,
        environmentId,
        anchorRunId: runId,
      });

      const waitpoint = await this.coordinator.createAssociatedWaitpoint({
        runId,
        data: waitpointData,
      });

      if (runFinished) {
        const output = this.buildWaitpointOutputFromRun(runAfterLock);
        const completed = await this.completeWaitpoint({
          id: waitpoint.id,
          output,
          organizationId: runAfterLock.organizationId ?? undefined,
        });
        return completed;
      }

      return waitpoint;
    });
  }
}
