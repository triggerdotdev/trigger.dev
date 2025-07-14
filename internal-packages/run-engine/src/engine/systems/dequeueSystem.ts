import { startSpan } from "@internal/tracing";
import { assertExhaustive } from "@trigger.dev/core";
import { DequeuedMessage, RetryOptions } from "@trigger.dev/core/v3";
import { getMaxDuration } from "@trigger.dev/core/v3/isomorphic";
import { PrismaClientOrTransaction } from "@trigger.dev/database";
import { getRunWithBackgroundWorkerTasks } from "../db/worker.js";
import { sendNotificationToWorker } from "../eventBus.js";
import { getMachinePreset } from "../machinePresets.js";
import { isDequeueableExecutionStatus } from "../statuses.js";
import { RunEngineOptions } from "../types.js";
import { ExecutionSnapshotSystem, getLatestExecutionSnapshot } from "./executionSnapshotSystem.js";
import { ReleaseConcurrencySystem } from "./releaseConcurrencySystem.js";
import { RunAttemptSystem } from "./runAttemptSystem.js";
import { SystemResources } from "./systems.js";
import { WaitpointSystem } from "./waitpointSystem.js";

export type DequeueSystemOptions = {
  resources: SystemResources;
  machines: RunEngineOptions["machines"];
  executionSnapshotSystem: ExecutionSnapshotSystem;
  runAttemptSystem: RunAttemptSystem;
  releaseConcurrencySystem: ReleaseConcurrencySystem;
  waitpointSystem: WaitpointSystem;
};

export class DequeueSystem {
  private readonly $: SystemResources;
  private readonly executionSnapshotSystem: ExecutionSnapshotSystem;
  private readonly runAttemptSystem: RunAttemptSystem;
  private readonly releaseConcurrencySystem: ReleaseConcurrencySystem;
  private readonly waitpointSystem: WaitpointSystem;

  constructor(private readonly options: DequeueSystemOptions) {
    this.$ = options.resources;
    this.executionSnapshotSystem = options.executionSnapshotSystem;
    this.runAttemptSystem = options.runAttemptSystem;
    this.releaseConcurrencySystem = options.releaseConcurrencySystem;
    this.waitpointSystem = options.waitpointSystem;
  }

  /**
   * Gets a fairly selected run from the specified worker queue, returning the information required to run it.
   * @param consumerId: The consumer that is pulling, allows multiple consumers to pull from the same queue
   * @param workerQueue: The worker queue to pull from, can be an individual environment (for dev)
   * @returns
   */
  async dequeueFromWorkerQueue({
    consumerId,
    workerQueue,
    backgroundWorkerId,
    workerId,
    runnerId,
    tx,
  }: {
    consumerId: string;
    workerQueue: string;
    backgroundWorkerId?: string;
    workerId?: string;
    runnerId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<DequeuedMessage | undefined> {
    const prisma = tx ?? this.$.prisma;

    return startSpan(
      this.$.tracer,
      "dequeueFromWorkerQueue",
      async (span) => {
        //gets multiple runs from the queue
        const message = await this.$.runQueue.dequeueMessageFromWorkerQueue(
          consumerId,
          workerQueue
        );
        if (!message) {
          return;
        }

        const orgId = message.message.orgId;
        const runId = message.messageId;

        span.setAttribute("runId", runId);

        //lock the run so nothing else can modify it
        try {
          const dequeuedRun = await this.$.runLock.lock(
            "dequeueFromWorkerQueue",
            [runId],
            async () => {
              const snapshot = await getLatestExecutionSnapshot(prisma, runId);

              if (!isDequeueableExecutionStatus(snapshot.executionStatus)) {
                // If it's pending executing it will be picked up by the stalled system if there's an issue
                if (snapshot.executionStatus === "PENDING_EXECUTING") {
                  this.$.logger.error(
                    "RunEngine.dequeueFromMasterQueue(): Run is already PENDING_EXECUTING, removing from queue",
                    {
                      runId,
                      orgId,
                    }
                  );
                  // remove the run from the queue
                  await this.$.runQueue.acknowledgeMessage(orgId, runId);
                  return;
                }

                //create a failed snapshot
                await this.executionSnapshotSystem.createExecutionSnapshot(prisma, {
                  run: {
                    id: snapshot.runId,
                    status: snapshot.runStatus,
                  },
                  snapshot: {
                    executionStatus: snapshot.executionStatus,
                    description:
                      "Tried to dequeue a run that is not in a valid state to be dequeued.",
                  },
                  previousSnapshotId: snapshot.id,
                  environmentId: snapshot.environmentId,
                  environmentType: snapshot.environmentType,
                  projectId: snapshot.projectId,
                  organizationId: snapshot.organizationId,
                  checkpointId: snapshot.checkpointId ?? undefined,
                  completedWaitpoints: snapshot.completedWaitpoints,
                  error: `Tried to dequeue a run that is not in a valid state to be dequeued.`,
                  workerId,
                  runnerId,
                });

                //todo is there a way to recover this, so the run can be retried?
                //for example should we update the status to a dequeuable status and nack it?
                //then at least it has a chance of succeeding and we have the error log above
                await this.runAttemptSystem.systemFailure({
                  runId,
                  error: {
                    type: "INTERNAL_ERROR",
                    code: "TASK_DEQUEUED_INVALID_STATE",
                    message: `Task was in the ${snapshot.executionStatus} state when it was dequeued for execution.`,
                  },
                  tx: prisma,
                });
                this.$.logger.error(
                  `RunEngine.dequeueFromWorkerQueue(): Run is not in a valid state to be dequeued: ${runId}\n ${snapshot.id}:${snapshot.executionStatus}`
                );

                return;
              }

              if (snapshot.executionStatus === "QUEUED_EXECUTING") {
                const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(
                  prisma,
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
                    completedWaitpoints: snapshot.completedWaitpoints.map((waitpoint) => ({
                      id: waitpoint.id,
                      index: waitpoint.index,
                    })),
                  }
                );

                await sendNotificationToWorker({
                  runId,
                  snapshot: newSnapshot,
                  eventBus: this.$.eventBus,
                });

                return;
              }

              const result = await getRunWithBackgroundWorkerTasks(
                prisma,
                runId,
                backgroundWorkerId
              );

              if (!result.success) {
                switch (result.code) {
                  case "NO_RUN": {
                    //this should not happen, the run is unrecoverable so we'll ack it
                    this.$.logger.error("RunEngine.dequeueFromWorkerQueue(): No run found", {
                      runId,
                      latestSnapshot: snapshot.id,
                    });
                    await this.$.runQueue.acknowledgeMessage(orgId, runId);
                    return;
                  }
                  case "RUN_ENVIRONMENT_ARCHIVED": {
                    //this happens if the preview branch was archived
                    this.$.logger.warn(
                      "RunEngine.dequeueFromWorkerQueue(): Run environment archived",
                      {
                        runId,
                        latestSnapshot: snapshot.id,
                        result,
                      }
                    );
                    await this.$.runQueue.acknowledgeMessage(orgId, runId);
                    return;
                  }
                  case "NO_WORKER":
                  case "TASK_NEVER_REGISTERED":
                  case "QUEUE_NOT_FOUND":
                  case "TASK_NOT_IN_LATEST": {
                    this.$.logger.warn(`RunEngine.dequeueFromWorkerQueue(): ${result.code}`, {
                      runId,
                      latestSnapshot: snapshot.id,
                      result,
                    });

                    //not deployed yet, so we'll wait for the deploy
                    await this.#pendingVersion({
                      orgId,
                      runId,
                      reason: result.message,
                      statusReason: result.code,
                      tx: prisma,
                    });
                    return;
                  }
                  case "BACKGROUND_WORKER_MISMATCH": {
                    this.$.logger.warn(
                      "RunEngine.dequeueFromWorkerQueue(): Background worker mismatch",
                      {
                        runId,
                        latestSnapshot: snapshot.id,
                        result,
                      }
                    );

                    //worker mismatch so put it back in the queue
                    await this.$.runQueue.nackMessage({ orgId, messageId: runId });

                    return;
                  }
                  default: {
                    assertExhaustive(result);
                  }
                }
              }

              //check for a valid deployment if it's not a development environment
              if (result.run.runtimeEnvironment.type !== "DEVELOPMENT") {
                if (!result.deployment || !result.deployment.imageReference) {
                  this.$.logger.warn("RunEngine.dequeueFromWorkerQueue(): No deployment found", {
                    runId,
                    latestSnapshot: snapshot.id,
                    result,
                  });
                  //not deployed yet, so we'll wait for the deploy
                  await this.#pendingVersion({
                    orgId,
                    runId,
                    reason: "No deployment or deployment image reference found for deployed run",
                    statusReason: "NO_DEPLOYMENT",
                    tx: prisma,
                  });

                  return;
                }
              }

              const machinePreset = getMachinePreset({
                machines: this.options.machines.machines,
                defaultMachine: this.options.machines.defaultMachine,
                config: result.task.machineConfig ?? {},
                run: result.run,
              });

              // Check max attempts that can optionally be set when triggering a run
              let maxAttempts: number | null | undefined = result.run.maxAttempts;

              // If it's not set, we'll grab it from the task's retry config
              if (!maxAttempts) {
                const retryConfig = result.task.retryConfig;

                this.$.logger.debug(
                  "RunEngine.dequeueFromWorkerQueue(): maxAttempts not set, using task's retry config",
                  {
                    runId,
                    task: result.task.id,
                    rawRetryConfig: retryConfig,
                  }
                );

                const parsedConfig = RetryOptions.nullable().safeParse(retryConfig);

                if (!parsedConfig.success) {
                  this.$.logger.error("RunEngine.dequeueFromWorkerQueue(): Invalid retry config", {
                    runId,
                    task: result.task.id,
                    rawRetryConfig: retryConfig,
                  });
                }

                maxAttempts = parsedConfig.data?.maxAttempts;
              }
              //update the run
              const lockedAt = new Date();
              const startedAt = result.run.startedAt ?? lockedAt;
              const maxDurationInSeconds = getMaxDuration(
                result.run.maxDurationInSeconds,
                result.task.maxDurationInSeconds
              );

              const lockedTaskRun = await prisma.taskRun.update({
                where: {
                  id: runId,
                },
                data: {
                  lockedAt,
                  lockedById: result.task.id,
                  lockedToVersionId: result.worker.id,
                  lockedQueueId: result.queue.id,
                  lockedQueueReleaseConcurrencyOnWaitpoint:
                    this.waitpointSystem.shouldReleaseConcurrencyOnWaitpointForQueue(result.queue),
                  startedAt,
                  baseCostInCents: this.options.machines.baseCostInCents,
                  machinePreset: machinePreset.name,
                  taskVersion: result.worker.version,
                  sdkVersion: result.worker.sdkVersion,
                  cliVersion: result.worker.cliVersion,
                  maxDurationInSeconds,
                  maxAttempts: maxAttempts ?? undefined,
                },
                include: {
                  runtimeEnvironment: true,
                  tags: true,
                },
              });

              this.$.eventBus.emit("runLocked", {
                time: new Date(),
                run: {
                  id: runId,
                  status: lockedTaskRun.status,
                  lockedAt,
                  lockedById: result.task.id,
                  lockedToVersionId: result.worker.id,
                  lockedQueueId: result.queue.id,
                  startedAt,
                  baseCostInCents: this.options.machines.baseCostInCents,
                  machinePreset: machinePreset.name,
                  taskVersion: result.worker.version,
                  sdkVersion: result.worker.sdkVersion,
                  cliVersion: result.worker.cliVersion,
                  maxDurationInSeconds: lockedTaskRun.maxDurationInSeconds ?? undefined,
                  maxAttempts: lockedTaskRun.maxAttempts ?? undefined,
                  updatedAt: lockedTaskRun.updatedAt,
                  createdAt: lockedTaskRun.createdAt,
                },
                organization: {
                  id: orgId,
                },
                project: {
                  id: lockedTaskRun.projectId,
                },
                environment: {
                  id: lockedTaskRun.runtimeEnvironmentId,
                },
              });

              if (!lockedTaskRun) {
                this.$.logger.error("RunEngine.dequeueFromWorkerQueue(): Failed to lock task run", {
                  taskRun: result.run.id,
                  taskIdentifier: result.run.taskIdentifier,
                  deployment: result.deployment?.id,
                  worker: result.worker.id,
                  task: result.task.id,
                  runId,
                });

                await this.$.runQueue.acknowledgeMessage(orgId, runId);

                return;
              }

              const currentAttemptNumber = lockedTaskRun.attemptNumber ?? 0;
              const nextAttemptNumber = currentAttemptNumber + 1;

              const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(
                prisma,
                {
                  run: {
                    id: runId,
                    status: snapshot.runStatus,
                    attemptNumber: lockedTaskRun.attemptNumber,
                  },
                  snapshot: {
                    executionStatus: "PENDING_EXECUTING",
                    description: "Run was dequeued for execution",
                  },
                  previousSnapshotId: snapshot.id,
                  environmentId: snapshot.environmentId,
                  environmentType: snapshot.environmentType,
                  projectId: snapshot.projectId,
                  organizationId: snapshot.organizationId,
                  checkpointId: snapshot.checkpointId ?? undefined,
                  batchId: snapshot.batchId ?? undefined,
                  completedWaitpoints: snapshot.completedWaitpoints,
                  workerId,
                  runnerId,
                }
              );

              return {
                version: "1" as const,
                dequeuedAt: new Date(),
                snapshot: {
                  id: newSnapshot.id,
                  friendlyId: newSnapshot.friendlyId,
                  executionStatus: newSnapshot.executionStatus,
                  description: newSnapshot.description,
                  createdAt: newSnapshot.createdAt,
                },
                image: result.deployment?.imageReference ?? undefined,
                checkpoint: newSnapshot.checkpoint ?? undefined,
                completedWaitpoints: snapshot.completedWaitpoints,
                backgroundWorker: {
                  id: result.worker.id,
                  friendlyId: result.worker.friendlyId,
                  version: result.worker.version,
                },
                deployment: {
                  id: result.deployment?.id,
                  friendlyId: result.deployment?.friendlyId,
                  imagePlatform: result.deployment?.imagePlatform,
                },
                run: {
                  id: lockedTaskRun.id,
                  friendlyId: lockedTaskRun.friendlyId,
                  isTest: lockedTaskRun.isTest,
                  machine: machinePreset,
                  attemptNumber: nextAttemptNumber,
                  // Keeping this for backwards compatibility, but really this should be called workerQueue
                  masterQueue: lockedTaskRun.workerQueue,
                  traceContext: lockedTaskRun.traceContext as Record<string, unknown>,
                },
                environment: {
                  id: lockedTaskRun.runtimeEnvironment.id,
                  type: lockedTaskRun.runtimeEnvironment.type,
                },
                organization: {
                  id: orgId,
                },
                project: {
                  id: lockedTaskRun.projectId,
                },
              } satisfies DequeuedMessage;
            }
          );

          return dequeuedRun;
        } catch (error) {
          this.$.logger.error(
            "RunEngine.dequeueFromWorkerQueue(): Thrown error while preparing run to be run",
            {
              error,
              runId,
            }
          );

          const run = await prisma.taskRun.findFirst({
            where: { id: runId },
            include: {
              runtimeEnvironment: true,
            },
          });

          if (!run) {
            //this isn't ideal because we're not creating a snapshot… but we can't do much else
            this.$.logger.error(
              "RunEngine.dequeueFromWorkerQueue(): Thrown error, then run not found. Nacking.",
              {
                runId,
                orgId,
              }
            );
            await this.$.runQueue.nackMessage({ orgId, messageId: runId });

            return;
          }

          //this is an unknown error, we'll reattempt (with auto-backoff and eventually DLQ)
          const gotRequeued = await this.runAttemptSystem.tryNackAndRequeue({
            run,
            environment: run.runtimeEnvironment,
            orgId,
            projectId: run.runtimeEnvironment.projectId,
            error: {
              type: "INTERNAL_ERROR",
              code: "TASK_RUN_DEQUEUED_MAX_RETRIES",
              message: `We tried to dequeue the run the maximum number of times but it wouldn't start executing`,
            },
            tx: prisma,
          });

          if (!gotRequeued) {
            this.$.logger.error("RunEngine.dequeueFromWorkerQueue(): Failed to requeue run", {
              runId,
              orgId,
            });
          }
        }

        return;
      },
      {
        attributes: { consumerId, workerQueue },
      }
    );
  }

  async #pendingVersion({
    orgId,
    runId,
    workerId,
    runnerId,
    reason,
    statusReason,
    tx,
  }: {
    orgId: string;
    runId: string;
    statusReason: string;
    workerId?: string;
    runnerId?: string;
    reason?: string;
    tx?: PrismaClientOrTransaction;
  }) {
    const prisma = tx ?? this.$.prisma;

    this.$.logger.debug("RunEngine.dequeueFromWorkerQueue(): Pending version", {
      runId,
      reason,
      statusReason,
    });

    return this.$.runLock.lock("pendingVersion", [runId], async () => {
      this.$.logger.debug("RunEngine.dequeueFromWorkerQueue(): Pending version lock acquired", {
        runId,
        reason,
        statusReason,
      });

      //mark run as waiting for deploy
      const run = await prisma.taskRun.update({
        where: { id: runId },
        data: {
          status: "PENDING_VERSION",
          statusReason,
        },
        select: {
          id: true,
          status: true,
          attemptNumber: true,
          updatedAt: true,
          createdAt: true,
          runtimeEnvironment: {
            select: {
              id: true,
              type: true,
              projectId: true,
              project: { select: { id: true, organizationId: true } },
            },
          },
        },
      });

      this.$.logger.debug("RunEngine.dequeueFromWorkerQueue(): Pending version", {
        runId,
        run,
      });

      await this.executionSnapshotSystem.createExecutionSnapshot(prisma, {
        run,
        snapshot: {
          executionStatus: "RUN_CREATED",
          description:
            reason ?? "The run doesn't have a background worker, so we're going to ack it for now.",
        },
        environmentId: run.runtimeEnvironment.id,
        environmentType: run.runtimeEnvironment.type,
        projectId: run.runtimeEnvironment.projectId,
        organizationId: run.runtimeEnvironment.project.organizationId,
        workerId,
        runnerId,
      });

      //we ack because when it's deployed it will be requeued
      await this.$.runQueue.acknowledgeMessage(orgId, runId);

      this.$.eventBus.emit("runStatusChanged", {
        time: new Date(),
        run: {
          id: runId,
          status: run.status,
          updatedAt: run.updatedAt,
          createdAt: run.createdAt,
        },
        organization: {
          id: run.runtimeEnvironment.project.organizationId,
        },
        project: {
          id: run.runtimeEnvironment.projectId,
        },
        environment: {
          id: run.runtimeEnvironment.id,
        },
      });
    });
  }
}
