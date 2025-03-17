import {
  PrismaClient,
  PrismaClientOrTransaction,
  RuntimeEnvironmentType,
  TaskRun,
} from "@trigger.dev/database";
import { Logger } from "@trigger.dev/core/logger";
import { startSpan, Tracer } from "@internal/tracing";
import {
  executionResultFromSnapshot,
  ExecutionSnapshotSystem,
  getLatestExecutionSnapshot,
} from "./executionSnapshotSystem.js";
import {
  CompleteRunAttemptResult,
  ExecutionResult,
  TaskRunError,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  TaskRunInternalError,
  TaskRunSuccessfulExecutionResult,
} from "@trigger.dev/core/v3/schemas";
import { RunLocker } from "../locking.js";
import { EventBus, sendNotificationToWorker } from "../eventBus.js";
import { ServiceValidationError } from "../index.js";
import { retryOutcomeFromCompletion } from "../retrying.js";
import { RunQueue } from "../../run-queue/index.js";
import { isExecuting } from "../statuses.js";
import { EngineWorker } from "../types.js";
import { runStatusFromError } from "../errors.js";
import { BatchSystem } from "./batchSystem.js";
import { WaitpointSystem } from "./waitpointSystem.js";

export type RunAttemptSystemOptions = {
  prisma: PrismaClient;
  logger: Logger;
  tracer: Tracer;
  runLock: RunLocker;
  eventBus: EventBus;
  runQueue: RunQueue;
  worker: EngineWorker;
  executionSnapshotSystem: ExecutionSnapshotSystem;
  batchSystem: BatchSystem;
  waitpointSystem: WaitpointSystem;
  retryWarmStartThresholdMs?: number;
};

export class RunAttemptSystem {
  private readonly prisma: PrismaClient;
  private readonly logger: Logger;
  private readonly tracer: Tracer;
  private readonly runLock: RunLocker;
  private readonly eventBus: EventBus;
  private readonly runQueue: RunQueue;
  private readonly worker: EngineWorker;
  private readonly executionSnapshotSystem: ExecutionSnapshotSystem;
  private readonly batchSystem: BatchSystem;
  private readonly waitpointSystem: WaitpointSystem;

  constructor(private readonly options: RunAttemptSystemOptions) {
    this.prisma = options.prisma;
    this.logger = options.logger;
    this.tracer = options.tracer;
    this.runLock = options.runLock;
    this.eventBus = options.eventBus;
    this.runQueue = options.runQueue;
    this.worker = options.worker;
    this.executionSnapshotSystem = options.executionSnapshotSystem;
    this.batchSystem = options.batchSystem;
    this.waitpointSystem = options.waitpointSystem;
  }

  public async completeRunAttempt({
    runId,
    snapshotId,
    completion,
    workerId,
    runnerId,
  }: {
    runId: string;
    snapshotId: string;
    completion: TaskRunExecutionResult;
    workerId?: string;
    runnerId?: string;
  }): Promise<CompleteRunAttemptResult> {
    if (completion.metadata) {
      this.eventBus.emit("runMetadataUpdated", {
        time: new Date(),
        run: {
          id: runId,
          metadata: completion.metadata,
        },
      });
    }

    switch (completion.ok) {
      case true: {
        return this.attemptSucceeded({
          runId,
          snapshotId,
          completion,
          tx: this.prisma,
          workerId,
          runnerId,
        });
      }
      case false: {
        return this.attemptFailed({
          runId,
          snapshotId,
          completion,
          tx: this.prisma,
          workerId,
          runnerId,
        });
      }
    }
  }

  public async attemptSucceeded({
    runId,
    snapshotId,
    completion,
    tx,
    workerId,
    runnerId,
  }: {
    runId: string;
    snapshotId: string;
    completion: TaskRunSuccessfulExecutionResult;
    tx: PrismaClientOrTransaction;
    workerId?: string;
    runnerId?: string;
  }): Promise<CompleteRunAttemptResult> {
    const prisma = tx ?? this.prisma;

    return startSpan(
      this.tracer,
      "#completeRunAttemptSuccess",
      async (span) => {
        return this.runLock.lock([runId], 5_000, async (signal) => {
          const latestSnapshot = await getLatestExecutionSnapshot(prisma, runId);

          if (latestSnapshot.id !== snapshotId) {
            throw new ServiceValidationError("Snapshot ID doesn't match the latest snapshot", 400);
          }

          span.setAttribute("completionStatus", completion.ok);

          const completedAt = new Date();

          const run = await prisma.taskRun.update({
            where: { id: runId },
            data: {
              status: "COMPLETED_SUCCESSFULLY",
              completedAt,
              output: completion.output,
              outputType: completion.outputType,
              executionSnapshots: {
                create: {
                  executionStatus: "FINISHED",
                  description: "Task completed successfully",
                  runStatus: "COMPLETED_SUCCESSFULLY",
                  attemptNumber: latestSnapshot.attemptNumber,
                  environmentId: latestSnapshot.environmentId,
                  environmentType: latestSnapshot.environmentType,
                  workerId,
                  runnerId,
                },
              },
            },
            select: {
              id: true,
              friendlyId: true,
              status: true,
              attemptNumber: true,
              spanId: true,
              associatedWaitpoint: {
                select: {
                  id: true,
                },
              },
              project: {
                select: {
                  organizationId: true,
                },
              },
              batchId: true,
              createdAt: true,
              completedAt: true,
              taskEventStore: true,
              parentTaskRunId: true,
            },
          });
          const newSnapshot = await getLatestExecutionSnapshot(prisma, runId);

          await this.runQueue.acknowledgeMessage(run.project.organizationId, runId);

          // We need to manually emit this as we created the final snapshot as part of the task run update
          this.eventBus.emit("executionSnapshotCreated", {
            time: newSnapshot.createdAt,
            run: {
              id: newSnapshot.runId,
            },
            snapshot: {
              ...newSnapshot,
              completedWaitpointIds: newSnapshot.completedWaitpoints.map((wp) => wp.id),
            },
          });

          if (!run.associatedWaitpoint) {
            throw new ServiceValidationError("No associated waitpoint found", 400);
          }

          await this.waitpointSystem.completeWaitpoint({
            id: run.associatedWaitpoint.id,
            output: completion.output
              ? { value: completion.output, type: completion.outputType, isError: false }
              : undefined,
          });

          this.eventBus.emit("runSucceeded", {
            time: completedAt,
            run: {
              id: runId,
              spanId: run.spanId,
              output: completion.output,
              outputType: completion.outputType,
              createdAt: run.createdAt,
              completedAt: run.completedAt,
              taskEventStore: run.taskEventStore,
            },
          });

          await this.#finalizeRun(run);

          return {
            attemptStatus: "RUN_FINISHED",
            snapshot: newSnapshot,
            run,
          };
        });
      },
      {
        attributes: { runId, snapshotId },
      }
    );
  }

  public async attemptFailed({
    runId,
    snapshotId,
    workerId,
    runnerId,
    completion,
    forceRequeue,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    workerId?: string;
    runnerId?: string;
    completion: TaskRunFailedExecutionResult;
    forceRequeue?: boolean;
    tx: PrismaClientOrTransaction;
  }): Promise<CompleteRunAttemptResult> {
    const prisma = this.prisma;

    return startSpan(
      this.tracer,
      "completeRunAttemptFailure",
      async (span) => {
        return this.runLock.lock([runId], 5_000, async (signal) => {
          const latestSnapshot = await getLatestExecutionSnapshot(prisma, runId);

          if (latestSnapshot.id !== snapshotId) {
            throw new ServiceValidationError("Snapshot ID doesn't match the latest snapshot", 400);
          }

          span.setAttribute("completionStatus", completion.ok);

          //remove waitpoints blocking the run
          const deletedCount = await this.waitpointSystem.clearBlockingWaitpoints({ runId, tx });
          if (deletedCount > 0) {
            this.logger.debug("Cleared blocking waitpoints", { runId, deletedCount });
          }

          const failedAt = new Date();

          const retryResult = await retryOutcomeFromCompletion(prisma, {
            runId,
            error: completion.error,
            retryUsingQueue: forceRequeue ?? false,
            retrySettings: completion.retry,
            attemptNumber: latestSnapshot.attemptNumber,
          });

          // Force requeue means it was crashed so the attempt span needs to be closed
          if (forceRequeue) {
            const minimalRun = await prisma.taskRun.findFirst({
              where: {
                id: runId,
              },
              select: {
                status: true,
                spanId: true,
                maxAttempts: true,
                runtimeEnvironment: {
                  select: {
                    organizationId: true,
                  },
                },
                taskEventStore: true,
                createdAt: true,
                completedAt: true,
              },
            });

            if (!minimalRun) {
              throw new ServiceValidationError("Run not found", 404);
            }

            this.eventBus.emit("runAttemptFailed", {
              time: failedAt,
              run: {
                id: runId,
                status: minimalRun.status,
                spanId: minimalRun.spanId,
                error: completion.error,
                attemptNumber: latestSnapshot.attemptNumber ?? 0,
                createdAt: minimalRun.createdAt,
                completedAt: minimalRun.completedAt,
                taskEventStore: minimalRun.taskEventStore,
              },
            });
          }

          switch (retryResult.outcome) {
            case "cancel_run": {
              const result = await this.cancelRun({
                runId,
                completedAt: failedAt,
                reason: retryResult.reason,
                finalizeRun: true,
                tx: prisma,
              });
              return {
                attemptStatus:
                  result.snapshot.executionStatus === "PENDING_CANCEL"
                    ? "RUN_PENDING_CANCEL"
                    : "RUN_FINISHED",
                ...result,
              };
            }
            case "fail_run": {
              return await this.#permanentlyFailRun({
                runId,
                snapshotId,
                failedAt,
                error: retryResult.sanitizedError,
                workerId,
                runnerId,
              });
            }
            case "retry": {
              const retryAt = new Date(retryResult.settings.timestamp);

              const run = await prisma.taskRun.update({
                where: {
                  id: runId,
                },
                data: {
                  status: "RETRYING_AFTER_FAILURE",
                  machinePreset: retryResult.machine,
                },
                include: {
                  runtimeEnvironment: {
                    include: {
                      project: true,
                      organization: true,
                      orgMember: true,
                    },
                  },
                },
              });

              const nextAttemptNumber =
                latestSnapshot.attemptNumber === null ? 1 : latestSnapshot.attemptNumber + 1;

              if (retryResult.wasOOMError) {
                this.eventBus.emit("runAttemptFailed", {
                  time: failedAt,
                  run: {
                    id: runId,
                    status: run.status,
                    spanId: run.spanId,
                    error: completion.error,
                    attemptNumber: latestSnapshot.attemptNumber ?? 0,
                    createdAt: run.createdAt,
                    completedAt: run.completedAt,
                    taskEventStore: run.taskEventStore,
                  },
                });
              }

              this.eventBus.emit("runRetryScheduled", {
                time: failedAt,
                run: {
                  id: run.id,
                  friendlyId: run.friendlyId,
                  attemptNumber: nextAttemptNumber,
                  queue: run.queue,
                  taskIdentifier: run.taskIdentifier,
                  traceContext: run.traceContext as Record<string, string | undefined>,
                  baseCostInCents: run.baseCostInCents,
                  spanId: run.spanId,
                },
                organization: {
                  id: run.runtimeEnvironment.organizationId,
                },
                environment: run.runtimeEnvironment,
                retryAt,
              });

              //if it's a long delay and we support checkpointing, put it back in the queue
              if (
                forceRequeue ||
                retryResult.method === "queue" ||
                (this.options.retryWarmStartThresholdMs !== undefined &&
                  retryResult.settings.delay >= this.options.retryWarmStartThresholdMs)
              ) {
                //we nack the message, requeuing it for later
                const nackResult = await this.tryNackAndRequeue({
                  run,
                  environment: run.runtimeEnvironment,
                  orgId: run.runtimeEnvironment.organizationId,
                  timestamp: retryAt.getTime(),
                  error: {
                    type: "INTERNAL_ERROR",
                    code: "TASK_RUN_DEQUEUED_MAX_RETRIES",
                    message: `We tried to dequeue the run the maximum number of times but it wouldn't start executing`,
                  },
                  tx: prisma,
                });

                if (!nackResult.wasRequeued) {
                  return {
                    attemptStatus: "RUN_FINISHED",
                    ...nackResult,
                  };
                } else {
                  return { attemptStatus: "RETRY_QUEUED", ...nackResult };
                }
              }

              //it will continue running because the retry delay is short
              const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(
                prisma,
                {
                  run,
                  snapshot: {
                    executionStatus: "PENDING_EXECUTING",
                    description: "Attempt failed with a short delay, starting a new attempt",
                  },
                  environmentId: latestSnapshot.environmentId,
                  environmentType: latestSnapshot.environmentType,
                  workerId,
                  runnerId,
                }
              );

              //the worker can fetch the latest snapshot and should create a new attempt
              await sendNotificationToWorker({
                runId,
                snapshot: newSnapshot,
                eventBus: this.eventBus,
              });

              return {
                attemptStatus: "RETRY_IMMEDIATELY",
                ...executionResultFromSnapshot(newSnapshot),
              };
            }
          }
        });
      },
      {
        attributes: { runId, snapshotId },
      }
    );
  }

  public async systemFailure({
    runId,
    error,
    tx,
  }: {
    runId: string;
    error: TaskRunInternalError;
    tx?: PrismaClientOrTransaction;
  }): Promise<CompleteRunAttemptResult> {
    const prisma = tx ?? this.prisma;

    return startSpan(
      this.tracer,
      "systemFailure",
      async (span) => {
        const latestSnapshot = await getLatestExecutionSnapshot(prisma, runId);

        //already finished
        if (latestSnapshot.executionStatus === "FINISHED") {
          //todo check run is in the correct state
          return {
            attemptStatus: "RUN_FINISHED",
            snapshot: latestSnapshot,
            run: {
              id: runId,
              friendlyId: latestSnapshot.runFriendlyId,
              status: latestSnapshot.runStatus,
              attemptNumber: latestSnapshot.attemptNumber,
            },
          };
        }

        const result = await this.attemptFailed({
          runId,
          snapshotId: latestSnapshot.id,
          completion: {
            ok: false,
            id: runId,
            error,
          },
          tx: prisma,
        });

        return result;
      },
      {
        attributes: {
          runId,
        },
      }
    );
  }

  public async tryNackAndRequeue({
    run,
    environment,
    orgId,
    timestamp,
    error,
    workerId,
    runnerId,
    tx,
  }: {
    run: TaskRun;
    environment: {
      id: string;
      type: RuntimeEnvironmentType;
    };
    orgId: string;
    timestamp?: number;
    error: TaskRunInternalError;
    workerId?: string;
    runnerId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<{ wasRequeued: boolean } & ExecutionResult> {
    const prisma = tx ?? this.prisma;

    return await this.runLock.lock([run.id], 5000, async (signal) => {
      //we nack the message, this allows another work to pick up the run
      const gotRequeued = await this.runQueue.nackMessage({
        orgId,
        messageId: run.id,
        retryAt: timestamp,
      });

      if (!gotRequeued) {
        const result = await this.systemFailure({
          runId: run.id,
          error,
          tx: prisma,
        });
        return { wasRequeued: false, ...result };
      }

      const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(prisma, {
        run: run,
        snapshot: {
          executionStatus: "QUEUED",
          description: "Requeued the run after a failure",
        },
        environmentId: environment.id,
        environmentType: environment.type,
        workerId,
        runnerId,
      });

      return {
        wasRequeued: true,
        snapshot: {
          id: newSnapshot.id,
          friendlyId: newSnapshot.friendlyId,
          executionStatus: newSnapshot.executionStatus,
          description: newSnapshot.description,
        },
        run: {
          id: newSnapshot.runId,
          friendlyId: newSnapshot.runFriendlyId,
          status: newSnapshot.runStatus,
          attemptNumber: newSnapshot.attemptNumber,
        },
      };
    });
  }

  /**
  Call this to cancel a run.
  If the run is in-progress it will change it's state to PENDING_CANCEL and notify the worker.
  If the run is not in-progress it will finish it.
  You can pass `finalizeRun` in if you know it's no longer running, e.g. the worker has messaged to say it's done.
  */
  async cancelRun({
    runId,
    workerId,
    runnerId,
    completedAt,
    reason,
    finalizeRun,
    tx,
  }: {
    runId: string;
    workerId?: string;
    runnerId?: string;
    completedAt?: Date;
    reason?: string;
    finalizeRun?: boolean;
    tx?: PrismaClientOrTransaction;
  }): Promise<ExecutionResult> {
    const prisma = tx ?? this.prisma;
    reason = reason ?? "Cancelled by user";

    return startSpan(this.tracer, "cancelRun", async (span) => {
      return this.runLock.lock([runId], 5_000, async (signal) => {
        const latestSnapshot = await getLatestExecutionSnapshot(prisma, runId);

        //already finished, do nothing
        if (latestSnapshot.executionStatus === "FINISHED") {
          return executionResultFromSnapshot(latestSnapshot);
        }

        //is pending cancellation and we're not finalizing, alert the worker again
        if (latestSnapshot.executionStatus === "PENDING_CANCEL" && !finalizeRun) {
          await sendNotificationToWorker({
            runId,
            snapshot: latestSnapshot,
            eventBus: this.eventBus,
          });
          return executionResultFromSnapshot(latestSnapshot);
        }

        //set the run to cancelled immediately
        const error: TaskRunError = {
          type: "STRING_ERROR",
          raw: reason,
        };

        const run = await prisma.taskRun.update({
          where: { id: runId },
          data: {
            status: "CANCELED",
            completedAt: finalizeRun ? completedAt ?? new Date() : completedAt,
            error,
          },
          select: {
            id: true,
            friendlyId: true,
            status: true,
            attemptNumber: true,
            spanId: true,
            batchId: true,
            createdAt: true,
            completedAt: true,
            taskEventStore: true,
            parentTaskRunId: true,
            runtimeEnvironment: {
              select: {
                organizationId: true,
              },
            },
            associatedWaitpoint: {
              select: {
                id: true,
              },
            },
            childRuns: {
              select: {
                id: true,
              },
            },
          },
        });

        //remove it from the queue and release concurrency
        await this.runQueue.acknowledgeMessage(run.runtimeEnvironment.organizationId, runId);

        //if executing, we need to message the worker to cancel the run and put it into `PENDING_CANCEL` status
        if (isExecuting(latestSnapshot.executionStatus)) {
          const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(prisma, {
            run,
            snapshot: {
              executionStatus: "PENDING_CANCEL",
              description: "Run was cancelled",
            },
            environmentId: latestSnapshot.environmentId,
            environmentType: latestSnapshot.environmentType,
            workerId,
            runnerId,
          });

          //the worker needs to be notified so it can kill the run and complete the attempt
          await sendNotificationToWorker({
            runId,
            snapshot: newSnapshot,
            eventBus: this.eventBus,
          });
          return executionResultFromSnapshot(newSnapshot);
        }

        //not executing, so we will actually finish the run
        const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(prisma, {
          run,
          snapshot: {
            executionStatus: "FINISHED",
            description: "Run was cancelled, not finished",
          },
          environmentId: latestSnapshot.environmentId,
          environmentType: latestSnapshot.environmentType,
          workerId,
          runnerId,
        });

        if (!run.associatedWaitpoint) {
          throw new ServiceValidationError("No associated waitpoint found", 400);
        }

        //complete the waitpoint so the parent run can continue
        await this.waitpointSystem.completeWaitpoint({
          id: run.associatedWaitpoint.id,
          output: { value: JSON.stringify(error), isError: true },
        });

        this.eventBus.emit("runCancelled", {
          time: new Date(),
          run: {
            id: run.id,
            friendlyId: run.friendlyId,
            spanId: run.spanId,
            taskEventStore: run.taskEventStore,
            createdAt: run.createdAt,
            completedAt: run.completedAt,
            error,
          },
        });

        //schedule the cancellation of all the child runs
        //it will call this function for each child,
        //which will recursively cancel all children if they need to be
        if (run.childRuns.length > 0) {
          for (const childRun of run.childRuns) {
            await this.worker.enqueue({
              id: `cancelRun:${childRun.id}`,
              job: "cancelRun",
              payload: { runId: childRun.id, completedAt: run.completedAt ?? new Date(), reason },
            });
          }
        }

        return executionResultFromSnapshot(newSnapshot);
      });
    });
  }

  async #permanentlyFailRun({
    runId,
    snapshotId,
    failedAt,
    error,
    workerId,
    runnerId,
  }: {
    runId: string;
    snapshotId?: string;
    failedAt: Date;
    error: TaskRunError;
    workerId?: string;
    runnerId?: string;
  }): Promise<CompleteRunAttemptResult> {
    const prisma = this.prisma;

    return startSpan(this.tracer, "permanentlyFailRun", async (span) => {
      const status = runStatusFromError(error);

      //run permanently failed
      const run = await prisma.taskRun.update({
        where: {
          id: runId,
        },
        data: {
          status,
          completedAt: failedAt,
          error,
        },
        select: {
          id: true,
          friendlyId: true,
          status: true,
          attemptNumber: true,
          spanId: true,
          batchId: true,
          parentTaskRunId: true,
          associatedWaitpoint: {
            select: {
              id: true,
            },
          },
          runtimeEnvironment: {
            select: {
              id: true,
              type: true,
              organizationId: true,
            },
          },
          taskEventStore: true,
          createdAt: true,
          completedAt: true,
        },
      });

      const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(prisma, {
        run,
        snapshot: {
          executionStatus: "FINISHED",
          description: "Run failed",
        },
        environmentId: run.runtimeEnvironment.id,
        environmentType: run.runtimeEnvironment.type,
        workerId,
        runnerId,
      });

      if (!run.associatedWaitpoint) {
        throw new ServiceValidationError("No associated waitpoint found", 400);
      }

      await this.runQueue.acknowledgeMessage(run.runtimeEnvironment.organizationId, runId);

      await this.waitpointSystem.completeWaitpoint({
        id: run.associatedWaitpoint.id,
        output: { value: JSON.stringify(error), isError: true },
      });

      this.eventBus.emit("runFailed", {
        time: failedAt,
        run: {
          id: runId,
          status: run.status,
          spanId: run.spanId,
          error,
          taskEventStore: run.taskEventStore,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
        },
      });

      await this.#finalizeRun(run);

      return {
        attemptStatus: "RUN_FINISHED",
        snapshot: newSnapshot,
        run,
      };
    });
  }

  /*
   * Whether the run succeeds, fails, is cancelled… we need to run these operations
   */
  async #finalizeRun({ id, batchId }: { id: string; batchId: string | null }) {
    if (batchId) {
      await this.batchSystem.scheduleCompleteBatch({ batchId });
    }

    //cancel the heartbeats
    await this.worker.ack(`heartbeatSnapshot.${id}`);
  }
}
