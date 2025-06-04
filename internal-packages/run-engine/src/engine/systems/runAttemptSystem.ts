import { startSpan } from "@internal/tracing";
import {
  CompleteRunAttemptResult,
  ExecutionResult,
  GitMeta,
  StartRunAttemptResult,
  TaskRunError,
  TaskRunExecution,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  TaskRunInternalError,
  TaskRunSuccessfulExecutionResult,
} from "@trigger.dev/core/v3/schemas";
import { parsePacket } from "@trigger.dev/core/v3/utils/ioSerialization";
import {
  $transaction,
  PrismaClientOrTransaction,
  RuntimeEnvironmentType,
  TaskRun,
} from "@trigger.dev/database";
import { MAX_TASK_RUN_ATTEMPTS } from "../consts.js";
import { runStatusFromError, ServiceValidationError } from "../errors.js";
import { sendNotificationToWorker } from "../eventBus.js";
import { getMachinePreset } from "../machinePresets.js";
import { retryOutcomeFromCompletion } from "../retrying.js";
import { isExecuting, isInitialState } from "../statuses.js";
import { RunEngineOptions } from "../types.js";
import { BatchSystem } from "./batchSystem.js";
import { DelayedRunSystem } from "./delayedRunSystem.js";
import {
  executionResultFromSnapshot,
  ExecutionSnapshotSystem,
  getLatestExecutionSnapshot,
} from "./executionSnapshotSystem.js";
import { ReleaseConcurrencySystem } from "./releaseConcurrencySystem.js";
import { SystemResources } from "./systems.js";
import { WaitpointSystem } from "./waitpointSystem.js";

export type RunAttemptSystemOptions = {
  resources: SystemResources;
  executionSnapshotSystem: ExecutionSnapshotSystem;
  batchSystem: BatchSystem;
  waitpointSystem: WaitpointSystem;
  delayedRunSystem: DelayedRunSystem;
  releaseConcurrencySystem: ReleaseConcurrencySystem;
  retryWarmStartThresholdMs?: number;
  machines: RunEngineOptions["machines"];
};

export class RunAttemptSystem {
  private readonly $: SystemResources;
  private readonly executionSnapshotSystem: ExecutionSnapshotSystem;
  private readonly batchSystem: BatchSystem;
  private readonly waitpointSystem: WaitpointSystem;
  private readonly delayedRunSystem: DelayedRunSystem;
  private readonly releaseConcurrencySystem: ReleaseConcurrencySystem;

  constructor(private readonly options: RunAttemptSystemOptions) {
    this.$ = options.resources;
    this.executionSnapshotSystem = options.executionSnapshotSystem;
    this.batchSystem = options.batchSystem;
    this.waitpointSystem = options.waitpointSystem;
    this.delayedRunSystem = options.delayedRunSystem;
    this.releaseConcurrencySystem = options.releaseConcurrencySystem;
  }

  public async startRunAttempt({
    runId,
    snapshotId,
    workerId,
    runnerId,
    isWarmStart,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    workerId?: string;
    runnerId?: string;
    isWarmStart?: boolean;
    tx?: PrismaClientOrTransaction;
  }): Promise<StartRunAttemptResult> {
    const prisma = tx ?? this.$.prisma;

    return startSpan(
      this.$.tracer,
      "startRunAttempt",
      async (span) => {
        return this.$.runLock.lock("startRunAttempt", [runId], 5000, async () => {
          const latestSnapshot = await getLatestExecutionSnapshot(prisma, runId);

          if (latestSnapshot.id !== snapshotId) {
            //if there is a big delay between the snapshot and the attempt, the snapshot might have changed
            //we just want to log because elsewhere it should have been put back into a state where it can be attempted
            this.$.logger.warn(
              "RunEngine.createRunAttempt(): snapshot has changed since the attempt was created, ignoring."
            );
            throw new ServiceValidationError("Snapshot changed", 409);
          }

          const environment = await this.#getAuthenticatedEnvironmentFromRun(runId, prisma);
          if (!environment) {
            throw new ServiceValidationError("Environment not found", 404);
          }

          const taskRun = await prisma.taskRun.findFirst({
            where: {
              id: runId,
            },
            include: {
              tags: true,
              lockedBy: {
                include: {
                  worker: {
                    select: {
                      id: true,
                      version: true,
                      sdkVersion: true,
                      cliVersion: true,
                      supportsLazyAttempts: true,
                    },
                  },
                },
              },
              batchItems: {
                include: {
                  batchTaskRun: true,
                },
              },
            },
          });

          this.$.logger.debug("Creating a task run attempt", { taskRun });

          if (!taskRun) {
            throw new ServiceValidationError("Task run not found", 404);
          }

          span.setAttribute("projectId", taskRun.projectId);
          span.setAttribute("environmentId", taskRun.runtimeEnvironmentId);
          span.setAttribute("taskRunId", taskRun.id);
          span.setAttribute("taskRunFriendlyId", taskRun.friendlyId);

          if (taskRun.status === "CANCELED") {
            throw new ServiceValidationError("Task run is cancelled", 400);
          }

          if (!taskRun.lockedBy) {
            throw new ServiceValidationError("Task run is not locked", 400);
          }

          const queue = await prisma.taskQueue.findFirst({
            where: {
              runtimeEnvironmentId: environment.id,
              name: taskRun.queue,
            },
          });

          if (!queue) {
            throw new ServiceValidationError("Queue not found", 404);
          }

          //increment the attempt number (start at 1)
          const nextAttemptNumber = (taskRun.attemptNumber ?? 0) + 1;

          if (nextAttemptNumber > MAX_TASK_RUN_ATTEMPTS) {
            await this.attemptFailed({
              runId: taskRun.id,
              snapshotId,
              completion: {
                ok: false,
                id: taskRun.id,
                error: {
                  type: "INTERNAL_ERROR",
                  code: "TASK_RUN_CRASHED",
                  message: "Max attempts reached.",
                },
              },
              tx: prisma,
            });
            throw new ServiceValidationError("Max attempts reached", 400);
          }

          const result = await $transaction(
            prisma,
            async (tx) => {
              const run = await tx.taskRun.update({
                where: {
                  id: taskRun.id,
                },
                data: {
                  status: "EXECUTING",
                  attemptNumber: nextAttemptNumber,
                  executedAt: taskRun.attemptNumber === null ? new Date() : undefined,
                },
                include: {
                  tags: true,
                  lockedBy: {
                    include: { worker: true },
                  },
                },
              });

              const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(tx, {
                run,
                snapshot: {
                  executionStatus: "EXECUTING",
                  description: `Attempt created, starting execution${
                    isWarmStart ? " (warm start)" : ""
                  }`,
                },
                previousSnapshotId: latestSnapshot.id,
                environmentId: latestSnapshot.environmentId,
                environmentType: latestSnapshot.environmentType,
                projectId: latestSnapshot.projectId,
                organizationId: latestSnapshot.organizationId,
                batchId: latestSnapshot.batchId ?? undefined,
                completedWaitpoints: latestSnapshot.completedWaitpoints,
                workerId,
                runnerId,
              });

              if (taskRun.ttl) {
                //don't expire the run, it's going to execute
                await this.$.worker.ack(`expireRun:${taskRun.id}`);
              }

              return { run, snapshot: newSnapshot };
            },
            (error) => {
              this.$.logger.error("RunEngine.createRunAttempt(): prisma.$transaction error", {
                code: error.code,
                meta: error.meta,
                stack: error.stack,
                message: error.message,
                name: error.name,
              });
              throw new ServiceValidationError(
                "Failed to update task run and execution snapshot",
                500
              );
            }
          );

          if (!result) {
            this.$.logger.error("RunEngine.createRunAttempt(): failed to create task run attempt", {
              runId: taskRun.id,
              nextAttemptNumber,
            });
            throw new ServiceValidationError("Failed to create task run attempt", 500);
          }

          const { run, snapshot } = result;

          this.$.eventBus.emit("runAttemptStarted", {
            time: new Date(),
            run: {
              id: run.id,
              status: run.status,
              createdAt: run.createdAt,
              updatedAt: run.updatedAt,
              attemptNumber: nextAttemptNumber,
              baseCostInCents: run.baseCostInCents,
              executedAt: run.executedAt ?? undefined,
            },
            organization: {
              id: environment.organization.id,
            },
            project: {
              id: environment.project.id,
            },
            environment: {
              id: environment.id,
            },
          });

          const machinePreset = getMachinePreset({
            machines: this.options.machines.machines,
            defaultMachine: this.options.machines.defaultMachine,
            config: taskRun.lockedBy.machineConfig ?? {},
            run: taskRun,
          });

          const metadata = await parsePacket({
            data: taskRun.metadata ?? undefined,
            dataType: taskRun.metadataType,
          });

          let git: GitMeta | undefined = undefined;
          if (environment.git) {
            const parsed = GitMeta.safeParse(environment.git);
            if (parsed.success) {
              git = parsed.data;
            }
          }

          const execution: TaskRunExecution = {
            task: {
              id: run.lockedBy!.slug,
              filePath: run.lockedBy!.filePath,
              exportName: run.lockedBy!.exportName ?? undefined,
            },
            attempt: {
              number: nextAttemptNumber,
              startedAt: latestSnapshot.updatedAt,
              /** @deprecated */
              id: "deprecated",
              /** @deprecated */
              backgroundWorkerId: "deprecated",
              /** @deprecated */
              backgroundWorkerTaskId: "deprecated",
              /** @deprecated */
              status: "deprecated",
            },
            run: {
              id: run.friendlyId,
              payload: run.payload,
              payloadType: run.payloadType,
              createdAt: run.createdAt,
              tags: run.tags.map((tag) => tag.name),
              isTest: run.isTest,
              idempotencyKey: run.idempotencyKey ?? undefined,
              startedAt: run.startedAt ?? run.createdAt,
              maxAttempts: run.maxAttempts ?? undefined,
              version: run.lockedBy!.worker.version,
              metadata,
              maxDuration: run.maxDurationInSeconds ?? undefined,
              /** @deprecated */
              context: undefined,
              /** @deprecated */
              durationMs: run.usageDurationMs,
              /** @deprecated */
              costInCents: run.costInCents,
              /** @deprecated */
              baseCostInCents: run.baseCostInCents,
              traceContext: run.traceContext as Record<string, string | undefined>,
              priority: run.priorityMs === 0 ? undefined : run.priorityMs / 1_000,
            },
            queue: {
              id: queue.friendlyId,
              name: queue.name,
            },
            environment: {
              id: environment.id,
              slug: environment.slug,
              type: environment.type,
              branchName: environment.branchName ?? undefined,
              git,
            },
            organization: {
              id: environment.organization.id,
              slug: environment.organization.slug,
              name: environment.organization.title,
            },
            project: {
              id: environment.project.id,
              ref: environment.project.externalRef,
              slug: environment.project.slug,
              name: environment.project.name,
            },
            batch:
              taskRun.batchItems[0] && taskRun.batchItems[0].batchTaskRun
                ? { id: taskRun.batchItems[0].batchTaskRun.friendlyId }
                : undefined,
            machine: machinePreset,
          };

          return { run, snapshot, execution };
        });
      },
      {
        attributes: { runId, snapshotId },
      }
    );
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
      this.$.eventBus.emit("runMetadataUpdated", {
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
          tx: this.$.prisma,
          workerId,
          runnerId,
        });
      }
      case false: {
        return this.attemptFailed({
          runId,
          snapshotId,
          completion,
          tx: this.$.prisma,
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
    const prisma = tx ?? this.$.prisma;

    return startSpan(
      this.$.tracer,
      "#completeRunAttemptSuccess",
      async (span) => {
        return this.$.runLock.lock("attemptSucceeded", [runId], 5_000, async (signal) => {
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
                  projectId: latestSnapshot.projectId,
                  organizationId: latestSnapshot.organizationId,
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
              updatedAt: true,
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
              usageDurationMs: true,
              costInCents: true,
              runtimeEnvironmentId: true,
              projectId: true,
            },
          });
          const newSnapshot = await getLatestExecutionSnapshot(prisma, runId);

          await this.$.runQueue.acknowledgeMessage(run.project.organizationId, runId);

          // We need to manually emit this as we created the final snapshot as part of the task run update
          this.$.eventBus.emit("executionSnapshotCreated", {
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

          this.$.eventBus.emit("runSucceeded", {
            time: completedAt,
            run: {
              id: runId,
              status: run.status,
              spanId: run.spanId,
              output: completion.output,
              outputType: completion.outputType,
              createdAt: run.createdAt,
              completedAt: run.completedAt,
              taskEventStore: run.taskEventStore,
              usageDurationMs: run.usageDurationMs,
              costInCents: run.costInCents,
              updatedAt: run.updatedAt,
              attemptNumber: run.attemptNumber ?? 1,
            },
            organization: {
              id: run.project.organizationId,
            },
            project: {
              id: run.projectId,
            },
            environment: {
              id: run.runtimeEnvironmentId,
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
    const prisma = this.$.prisma;

    return startSpan(
      this.$.tracer,
      "completeRunAttemptFailure",
      async (span) => {
        return this.$.runLock.lock("attemptFailed", [runId], 5_000, async (signal) => {
          const latestSnapshot = await getLatestExecutionSnapshot(prisma, runId);

          if (latestSnapshot.id !== snapshotId) {
            throw new ServiceValidationError("Snapshot ID doesn't match the latest snapshot", 400);
          }

          span.setAttribute("completionStatus", completion.ok);

          //remove waitpoints blocking the run
          const deletedCount = await this.waitpointSystem.clearBlockingWaitpoints({ runId, tx });
          if (deletedCount > 0) {
            this.$.logger.debug("Cleared blocking waitpoints", { runId, deletedCount });
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
                updatedAt: true,
              },
            });

            if (!minimalRun) {
              throw new ServiceValidationError("Run not found", 404);
            }

            this.$.eventBus.emit("runAttemptFailed", {
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
                updatedAt: minimalRun.updatedAt,
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
                this.$.eventBus.emit("runAttemptFailed", {
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
                    updatedAt: run.updatedAt,
                  },
                });
              }

              this.$.eventBus.emit("runRetryScheduled", {
                time: failedAt,
                run: {
                  id: run.id,
                  status: run.status,
                  friendlyId: run.friendlyId,
                  attemptNumber: nextAttemptNumber,
                  queue: run.queue,
                  taskIdentifier: run.taskIdentifier,
                  traceContext: run.traceContext as Record<string, string | undefined>,
                  baseCostInCents: run.baseCostInCents,
                  spanId: run.spanId,
                  nextMachineAfterOOM: retryResult.machine,
                  updatedAt: run.updatedAt,
                  error: completion.error,
                  createdAt: run.createdAt,
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
                  projectId: run.runtimeEnvironment.project.id,
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
                    executionStatus: "EXECUTING",
                    description: "Attempt failed with a short delay, starting a new attempt",
                  },
                  previousSnapshotId: latestSnapshot.id,
                  environmentId: latestSnapshot.environmentId,
                  environmentType: latestSnapshot.environmentType,
                  projectId: latestSnapshot.projectId,
                  organizationId: latestSnapshot.organizationId,
                  workerId,
                  runnerId,
                }
              );

              //the worker can fetch the latest snapshot and should create a new attempt
              await sendNotificationToWorker({
                runId,
                snapshot: newSnapshot,
                eventBus: this.$.eventBus,
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
    const prisma = tx ?? this.$.prisma;

    return startSpan(
      this.$.tracer,
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
    projectId,
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
    projectId: string;
    timestamp?: number;
    error: TaskRunInternalError;
    workerId?: string;
    runnerId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<{ wasRequeued: boolean } & ExecutionResult> {
    const prisma = tx ?? this.$.prisma;

    return await this.$.runLock.lock("tryNackAndRequeue", [run.id], 5000, async (signal) => {
      //we nack the message, this allows another work to pick up the run
      const gotRequeued = await this.$.runQueue.nackMessage({
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
        projectId: projectId,
        organizationId: orgId,
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
          createdAt: newSnapshot.createdAt,
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
    const prisma = tx ?? this.$.prisma;
    reason = reason ?? "Cancelled by user";

    return startSpan(this.$.tracer, "cancelRun", async (span) => {
      return this.$.runLock.lock("cancelRun", [runId], 5_000, async (signal) => {
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
            eventBus: this.$.eventBus,
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
            delayUntil: true,
            updatedAt: true,
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

        //if the run is delayed and hasn't started yet, we need to prevent it being added to the queue in future
        if (isInitialState(latestSnapshot.executionStatus) && run.delayUntil) {
          await this.delayedRunSystem.preventDelayedRunFromBeingEnqueued({ runId });
        }

        //remove it from the queue and release concurrency
        await this.$.runQueue.acknowledgeMessage(run.runtimeEnvironment.organizationId, runId, {
          removeFromWorkerQueue: true,
        });

        await this.releaseConcurrencySystem.refillTokensForSnapshot(latestSnapshot);

        //if executing, we need to message the worker to cancel the run and put it into `PENDING_CANCEL` status
        if (isExecuting(latestSnapshot.executionStatus)) {
          const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(prisma, {
            run,
            snapshot: {
              executionStatus: "PENDING_CANCEL",
              description: "Run was cancelled",
            },
            previousSnapshotId: latestSnapshot.id,
            environmentId: latestSnapshot.environmentId,
            environmentType: latestSnapshot.environmentType,
            projectId: latestSnapshot.projectId,
            organizationId: latestSnapshot.organizationId,
            workerId,
            runnerId,
          });

          //the worker needs to be notified so it can kill the run and complete the attempt
          await sendNotificationToWorker({
            runId,
            snapshot: newSnapshot,
            eventBus: this.$.eventBus,
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
          previousSnapshotId: latestSnapshot.id,
          environmentId: latestSnapshot.environmentId,
          environmentType: latestSnapshot.environmentType,
          projectId: latestSnapshot.projectId,
          organizationId: latestSnapshot.organizationId,
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

        this.$.eventBus.emit("runCancelled", {
          time: new Date(),
          run: {
            id: run.id,
            status: run.status,
            friendlyId: run.friendlyId,
            spanId: run.spanId,
            taskEventStore: run.taskEventStore,
            createdAt: run.createdAt,
            completedAt: run.completedAt,
            error,
            updatedAt: run.updatedAt,
            attemptNumber: run.attemptNumber ?? 1,
          },
          organization: {
            id: latestSnapshot.organizationId,
          },
          project: {
            id: latestSnapshot.projectId,
          },
          environment: {
            id: latestSnapshot.environmentId,
          },
        });

        //schedule the cancellation of all the child runs
        //it will call this function for each child,
        //which will recursively cancel all children if they need to be
        if (run.childRuns.length > 0) {
          for (const childRun of run.childRuns) {
            await this.$.worker.enqueue({
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
    const prisma = this.$.prisma;

    return startSpan(this.$.tracer, "permanentlyFailRun", async (span) => {
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
          updatedAt: true,
          usageDurationMs: true,
          costInCents: true,
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
              project: {
                select: {
                  id: true,
                  organizationId: true,
                },
              },
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
        previousSnapshotId: snapshotId,
        environmentId: run.runtimeEnvironment.id,
        environmentType: run.runtimeEnvironment.type,
        projectId: run.runtimeEnvironment.project.id,
        organizationId: run.runtimeEnvironment.project.organizationId,
        workerId,
        runnerId,
      });

      if (!run.associatedWaitpoint) {
        throw new ServiceValidationError("No associated waitpoint found", 400);
      }

      await this.$.runQueue.acknowledgeMessage(run.runtimeEnvironment.organizationId, runId, {
        removeFromWorkerQueue: true,
      });

      await this.waitpointSystem.completeWaitpoint({
        id: run.associatedWaitpoint.id,
        output: { value: JSON.stringify(error), isError: true },
      });

      this.$.eventBus.emit("runFailed", {
        time: failedAt,
        run: {
          id: runId,
          status: run.status,
          spanId: run.spanId,
          error,
          taskEventStore: run.taskEventStore,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
          updatedAt: run.updatedAt,
          attemptNumber: run.attemptNumber ?? 1,
          usageDurationMs: run.usageDurationMs,
          costInCents: run.costInCents,
        },
        organization: {
          id: run.runtimeEnvironment.project.organizationId,
        },
        project: {
          id: run.runtimeEnvironment.project.id,
        },
        environment: {
          id: run.runtimeEnvironment.id,
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
    await this.$.worker.ack(`heartbeatSnapshot.${id}`);
  }

  async #getAuthenticatedEnvironmentFromRun(runId: string, tx?: PrismaClientOrTransaction) {
    const prisma = tx ?? this.$.prisma;
    const taskRun = await prisma.taskRun.findFirst({
      where: {
        id: runId,
      },
      include: {
        runtimeEnvironment: {
          include: {
            organization: true,
            project: true,
          },
        },
      },
    });

    if (!taskRun) {
      return;
    }

    return taskRun?.runtimeEnvironment;
  }
}
