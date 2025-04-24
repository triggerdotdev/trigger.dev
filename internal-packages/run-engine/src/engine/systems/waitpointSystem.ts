import { timeoutError, tryCatch } from "@trigger.dev/core/v3";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import {
  $transaction,
  Prisma,
  PrismaClientOrTransaction,
  TaskRunExecutionSnapshot,
  TaskRunExecutionStatus,
  Waitpoint,
} from "@trigger.dev/database";
import { nanoid } from "nanoid";
import { sendNotificationToWorker } from "../eventBus.js";
import { isExecuting } from "../statuses.js";
import { EnqueueSystem } from "./enqueueSystem.js";
import { ExecutionSnapshotSystem, getLatestExecutionSnapshot } from "./executionSnapshotSystem.js";
import { SystemResources } from "./systems.js";
import { ReleaseConcurrencySystem } from "./releaseConcurrencySystem.js";

export type WaitpointSystemOptions = {
  resources: SystemResources;
  executionSnapshotSystem: ExecutionSnapshotSystem;
  enqueueSystem: EnqueueSystem;
  releaseConcurrencySystem: ReleaseConcurrencySystem;
};

export class WaitpointSystem {
  private readonly $: SystemResources;
  private readonly executionSnapshotSystem: ExecutionSnapshotSystem;
  private readonly releaseConcurrencySystem: ReleaseConcurrencySystem;
  private readonly enqueueSystem: EnqueueSystem;

  constructor(private readonly options: WaitpointSystemOptions) {
    this.$ = options.resources;
    this.executionSnapshotSystem = options.executionSnapshotSystem;
    this.enqueueSystem = options.enqueueSystem;
    this.releaseConcurrencySystem = options.releaseConcurrencySystem;
  }

  public async clearBlockingWaitpoints({
    runId,
    tx,
  }: {
    runId: string;
    tx?: PrismaClientOrTransaction;
  }) {
    const prisma = tx ?? this.$.prisma;
    const deleted = await prisma.taskRunWaitpoint.deleteMany({
      where: {
        taskRunId: runId,
      },
    });

    return deleted.count;
  }

  /** This completes a waitpoint and updates all entries so the run isn't blocked,
   * if they're no longer blocked. This doesn't suffer from race conditions. */
  async completeWaitpoint({
    id,
    output,
  }: {
    id: string;
    output?: {
      value: string;
      type?: string;
      isError: boolean;
    };
  }): Promise<Waitpoint> {
    // 1. Find the TaskRuns blocked by this waitpoint
    const affectedTaskRuns = await this.$.prisma.taskRunWaitpoint.findMany({
      where: { waitpointId: id },
      select: { taskRunId: true, spanIdToComplete: true, createdAt: true },
    });

    if (affectedTaskRuns.length === 0) {
      this.$.logger.debug(`completeWaitpoint: No TaskRunWaitpoints found for waitpoint`, {
        waitpointId: id,
      });
    }

    let [waitpointError, waitpoint] = await tryCatch(
      this.$.prisma.waitpoint.update({
        where: { id, status: "PENDING" },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          output: output?.value,
          outputType: output?.type,
          outputIsError: output?.isError,
        },
      })
    );

    if (waitpointError) {
      if (
        waitpointError instanceof Prisma.PrismaClientKnownRequestError &&
        waitpointError.code === "P2025"
      ) {
        waitpoint = await this.$.prisma.waitpoint.findFirst({
          where: { id },
        });
      } else {
        this.$.logger.log("completeWaitpoint: error updating waitpoint:", { waitpointError });
        throw waitpointError;
      }
    }

    if (!waitpoint) {
      throw new Error(`Waitpoint ${id} not found`);
    }

    //schedule trying to continue the runs
    for (const run of affectedTaskRuns) {
      await this.$.worker.enqueue({
        //this will debounce the call
        id: `continueRunIfUnblocked:${run.taskRunId}`,
        job: "continueRunIfUnblocked",
        payload: { runId: run.taskRunId },
        //50ms in the future
        availableAt: new Date(Date.now() + 50),
      });

      // emit an event to complete associated cached runs
      if (run.spanIdToComplete) {
        this.$.eventBus.emit("cachedRunCompleted", {
          time: new Date(),
          span: {
            id: run.spanIdToComplete,
            createdAt: run.createdAt,
          },
          blockedRunId: run.taskRunId,
          hasError: output?.isError ?? false,
        });
      }
    }

    return waitpoint;
  }

  /**
   * This creates a DATETIME waitpoint, that will be completed automatically when the specified date is reached.
   * If you pass an `idempotencyKey`, the waitpoint will be created only if it doesn't already exist.
   */
  async createDateTimeWaitpoint({
    projectId,
    environmentId,
    completedAfter,
    idempotencyKey,
    idempotencyKeyExpiresAt,
    tx,
  }: {
    projectId: string;
    environmentId: string;
    completedAfter: Date;
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: Date;
    tx?: PrismaClientOrTransaction;
  }) {
    const prisma = tx ?? this.$.prisma;

    const existingWaitpoint = idempotencyKey
      ? await prisma.waitpoint.findFirst({
          where: {
            environmentId,
            idempotencyKey,
          },
        })
      : undefined;

    if (existingWaitpoint) {
      if (
        existingWaitpoint.idempotencyKeyExpiresAt &&
        new Date() > existingWaitpoint.idempotencyKeyExpiresAt
      ) {
        //the idempotency key has expired
        //remove the waitpoint idempotencyKey
        await prisma.waitpoint.update({
          where: {
            id: existingWaitpoint.id,
          },
          data: {
            idempotencyKey: nanoid(24),
            inactiveIdempotencyKey: existingWaitpoint.idempotencyKey,
          },
        });

        //let it fall through to create a new waitpoint
      } else {
        return { waitpoint: existingWaitpoint, isCached: true };
      }
    }

    const waitpoint = await prisma.waitpoint.upsert({
      where: {
        environmentId_idempotencyKey: {
          environmentId,
          idempotencyKey: idempotencyKey ?? nanoid(24),
        },
      },
      create: {
        ...WaitpointId.generate(),
        type: "DATETIME",
        idempotencyKey: idempotencyKey ?? nanoid(24),
        idempotencyKeyExpiresAt,
        userProvidedIdempotencyKey: !!idempotencyKey,
        environmentId,
        projectId,
        completedAfter,
      },
      update: {},
    });

    await this.$.worker.enqueue({
      id: `finishWaitpoint.${waitpoint.id}`,
      job: "finishWaitpoint",
      payload: { waitpointId: waitpoint.id },
      availableAt: completedAfter,
    });

    return { waitpoint, isCached: false };
  }

  /** This creates a MANUAL waitpoint, that can be explicitly completed (or failed).
   * If you pass an `idempotencyKey` and it already exists, it will return the existing waitpoint.
   */
  async createManualWaitpoint({
    environmentId,
    projectId,
    idempotencyKey,
    idempotencyKeyExpiresAt,
    timeout,
    tags,
  }: {
    environmentId: string;
    projectId: string;
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: Date;
    timeout?: Date;
    tags?: string[];
  }): Promise<{ waitpoint: Waitpoint; isCached: boolean }> {
    const existingWaitpoint = idempotencyKey
      ? await this.$.prisma.waitpoint.findFirst({
          where: {
            environmentId,
            idempotencyKey,
          },
        })
      : undefined;

    if (existingWaitpoint) {
      if (
        existingWaitpoint.idempotencyKeyExpiresAt &&
        new Date() > existingWaitpoint.idempotencyKeyExpiresAt
      ) {
        //the idempotency key has expired
        //remove the waitpoint idempotencyKey
        await this.$.prisma.waitpoint.update({
          where: {
            id: existingWaitpoint.id,
          },
          data: {
            idempotencyKey: nanoid(24),
            inactiveIdempotencyKey: existingWaitpoint.idempotencyKey,
          },
        });

        //let it fall through to create a new waitpoint
      } else {
        return { waitpoint: existingWaitpoint, isCached: true };
      }
    }

    const maxRetries = 5;
    let attempts = 0;

    while (attempts < maxRetries) {
      try {
        const waitpoint = await this.$.prisma.waitpoint.upsert({
          where: {
            environmentId_idempotencyKey: {
              environmentId,
              idempotencyKey: idempotencyKey ?? nanoid(24),
            },
          },
          create: {
            ...WaitpointId.generate(),
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
        });

        //schedule the timeout
        if (timeout) {
          await this.$.worker.enqueue({
            id: `finishWaitpoint.${waitpoint.id}`,
            job: "finishWaitpoint",
            payload: {
              waitpointId: waitpoint.id,
              error: JSON.stringify(timeoutError(timeout)),
            },
            availableAt: timeout,
          });
        }

        return { waitpoint, isCached: false };
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

  /**
   * Prevents a run from continuing until the waitpoint is completed.
   */
  async blockRunWithWaitpoint({
    runId,
    waitpoints,
    projectId,
    releaseConcurrency,
    timeout,
    spanIdToComplete,
    batch,
    workerId,
    runnerId,
    tx,
  }: {
    runId: string;
    waitpoints: string | string[];
    projectId: string;
    releaseConcurrency?: boolean;
    timeout?: Date;
    spanIdToComplete?: string;
    batch?: { id: string; index?: number };
    workerId?: string;
    runnerId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<TaskRunExecutionSnapshot> {
    const prisma = tx ?? this.$.prisma;

    let $waitpoints = typeof waitpoints === "string" ? [waitpoints] : waitpoints;

    return await this.$.runLock.lock("blockRunWithWaitpoint", [runId], 5000, async () => {
      let snapshot: TaskRunExecutionSnapshot = await getLatestExecutionSnapshot(prisma, runId);

      //block the run with the waitpoints, returning how many waitpoints are pending
      const insert = await prisma.$queryRaw<{ pending_count: BigInt }[]>`
        WITH inserted AS (
          INSERT INTO "TaskRunWaitpoint" ("id", "taskRunId", "waitpointId", "projectId", "createdAt", "updatedAt", "spanIdToComplete", "batchId", "batchIndex")
          SELECT
            gen_random_uuid(),
            ${runId},
            w.id,
            ${projectId},
            NOW(),
            NOW(),
            ${spanIdToComplete ?? null},
            ${batch?.id ?? null},
            ${batch?.index ?? null}
          FROM "Waitpoint" w
          WHERE w.id IN (${Prisma.join($waitpoints)})
          ON CONFLICT DO NOTHING
          RETURNING "waitpointId"
        ),
        connected_runs AS (
          INSERT INTO "_WaitpointRunConnections" ("A", "B")
          SELECT ${runId}, w.id
          FROM "Waitpoint" w
          WHERE w.id IN (${Prisma.join($waitpoints)})
          ON CONFLICT DO NOTHING
        )
        SELECT COUNT(*) as pending_count
        FROM inserted i
        JOIN "Waitpoint" w ON w.id = i."waitpointId"
        WHERE w.status = 'PENDING';`;

      const isRunBlocked = Number(insert.at(0)?.pending_count ?? 0) > 0;

      let newStatus: TaskRunExecutionStatus = "SUSPENDED";
      if (
        snapshot.executionStatus === "EXECUTING" ||
        snapshot.executionStatus === "EXECUTING_WITH_WAITPOINTS"
      ) {
        newStatus = "EXECUTING_WITH_WAITPOINTS";
      }

      //if the state has changed, create a new snapshot
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
            metadata: {
              releaseConcurrency,
            },
          },
          previousSnapshotId: snapshot.id,
          environmentId: snapshot.environmentId,
          environmentType: snapshot.environmentType,
          projectId: snapshot.projectId,
          organizationId: snapshot.organizationId,
          // Do NOT carry over the batchId from the previous snapshot
          batchId: batch?.id,
          workerId,
          runnerId,
        });

        // Let the worker know immediately, so it can suspend the run
        await sendNotificationToWorker({ runId, snapshot, eventBus: this.$.eventBus });

        if (isRunBlocked) {
          //release concurrency
          await this.releaseConcurrencySystem.releaseConcurrencyForSnapshot(snapshot);
        }
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

      //no pending waitpoint, schedule unblocking the run
      //debounce if we're rapidly adding waitpoints
      if (!isRunBlocked) {
        await this.$.worker.enqueue({
          //this will debounce the call
          id: `continueRunIfUnblocked:${runId}`,
          job: "continueRunIfUnblocked",
          payload: { runId: runId },
          //in the near future
          availableAt: new Date(Date.now() + 50),
        });
      }

      return snapshot;
    });
  }

  public async continueRunIfUnblocked({ runId }: { runId: string }) {
    // 1. Get the any blocking waitpoints
    const blockingWaitpoints = await this.$.prisma.taskRunWaitpoint.findMany({
      where: { taskRunId: runId },
      select: {
        batchId: true,
        batchIndex: true,
        waitpoint: {
          select: { id: true, status: true },
        },
      },
    });

    // 2. There are blockers still, so do nothing
    if (blockingWaitpoints.some((w) => w.waitpoint.status !== "COMPLETED")) {
      return;
    }

    // 3. Get the run with environment
    const run = await this.$.prisma.taskRun.findFirst({
      where: {
        id: runId,
      },
      include: {
        runtimeEnvironment: {
          select: {
            id: true,
            type: true,
            maximumConcurrencyLimit: true,
            project: { select: { id: true } },
            organization: { select: { id: true } },
          },
        },
      },
    });

    if (!run) {
      throw new Error(`#continueRunIfUnblocked: run not found: ${runId}`);
    }

    //4. Continue the run whether it's executing or not
    await this.$.runLock.lock("continueRunIfUnblocked", [runId], 5000, async () => {
      const snapshot = await getLatestExecutionSnapshot(this.$.prisma, runId);

      //run is still executing, send a message to the worker
      if (isExecuting(snapshot.executionStatus)) {
        const result = await this.$.runQueue.reacquireConcurrency(
          run.runtimeEnvironment.organization.id,
          runId
        );

        if (result) {
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
              environmentId: snapshot.environmentId,
              environmentType: snapshot.environmentType,
              projectId: snapshot.projectId,
              organizationId: snapshot.organizationId,
              batchId: snapshot.batchId ?? undefined,
              completedWaitpoints: blockingWaitpoints.map((b) => ({
                id: b.waitpoint.id,
                index: b.batchIndex ?? undefined,
              })),
            }
          );

          await this.releaseConcurrencySystem.refillTokensForSnapshot(snapshot);

          await sendNotificationToWorker({
            runId,
            snapshot: newSnapshot,
            eventBus: this.$.eventBus,
          });
        } else {
          // Because we cannot reacquire the concurrency, we need to enqueue the run again
          // and because the run is still executing, we need to set the status to QUEUED_EXECUTING
          await this.enqueueSystem.enqueueRun({
            run,
            env: run.runtimeEnvironment,
            snapshot: {
              status: "QUEUED_EXECUTING",
              description: "Run can continue, but is waiting for concurrency",
            },
            previousSnapshotId: snapshot.id,
            batchId: snapshot.batchId ?? undefined,
            completedWaitpoints: blockingWaitpoints.map((b) => ({
              id: b.waitpoint.id,
              index: b.batchIndex ?? undefined,
            })),
          });
        }
      } else {
        if (snapshot.executionStatus !== "RUN_CREATED" && !snapshot.checkpointId) {
          // TODO: We're screwed, should probably fail the run immediately
          throw new Error(`#continueRunIfUnblocked: run has no checkpoint: ${run.id}`);
        }

        //put it back in the queue, with the original timestamp (w/ priority)
        //this prioritizes dequeuing waiting runs over new runs
        await this.enqueueSystem.enqueueRun({
          run,
          env: run.runtimeEnvironment,
          snapshot: {
            description: "Run was QUEUED, because all waitpoints are completed",
          },
          batchId: snapshot.batchId ?? undefined,
          completedWaitpoints: blockingWaitpoints.map((b) => ({
            id: b.waitpoint.id,
            index: b.batchIndex ?? undefined,
          })),
          checkpointId: snapshot.checkpointId ?? undefined,
        });
      }
    });

    //5. Remove the blocking waitpoints
    await this.$.prisma.taskRunWaitpoint.deleteMany({
      where: {
        taskRunId: runId,
      },
    });
  }

  public async createRunAssociatedWaitpoint(
    tx: PrismaClientOrTransaction,
    {
      projectId,
      environmentId,
      completedByTaskRunId,
    }: { projectId: string; environmentId: string; completedByTaskRunId: string }
  ) {
    return tx.waitpoint.create({
      data: {
        ...WaitpointId.generate(),
        type: "RUN",
        status: "PENDING",
        idempotencyKey: nanoid(24),
        userProvidedIdempotencyKey: false,
        projectId,
        environmentId,
        completedByTaskRunId,
      },
    });
  }
}
