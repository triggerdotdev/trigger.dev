import { startSpan } from "@internal/tracing";
import { assertExhaustive } from "@trigger.dev/core";
import { DequeuedMessage, MachineResources, RetryOptions } from "@trigger.dev/core/v3";
import { getMaxDuration, sanitizeQueueName } from "@trigger.dev/core/v3/isomorphic";
import { PrismaClientOrTransaction } from "@trigger.dev/database";
import { getRunWithBackgroundWorkerTasks } from "../db/worker.js";
import { getMachinePreset } from "../machinePresets.js";
import { isDequeueableExecutionStatus } from "../statuses.js";
import { RunEngineOptions } from "../types.js";
import { ExecutionSnapshotSystem, getLatestExecutionSnapshot } from "./executionSnapshotSystem.js";
import { RunAttemptSystem } from "./runAttemptSystem.js";
import { SystemResources } from "./systems.js";
import { sendNotificationToWorker } from "../eventBus.js";
import { ReleaseConcurrencySystem } from "./releaseConcurrencySystem.js";

export type DequeueSystemOptions = {
  resources: SystemResources;
  machines: RunEngineOptions["machines"];
  executionSnapshotSystem: ExecutionSnapshotSystem;
  runAttemptSystem: RunAttemptSystem;
  releaseConcurrencySystem: ReleaseConcurrencySystem;
};

export class DequeueSystem {
  private readonly $: SystemResources;
  private readonly executionSnapshotSystem: ExecutionSnapshotSystem;
  private readonly runAttemptSystem: RunAttemptSystem;
  private readonly releaseConcurrencySystem: ReleaseConcurrencySystem;

  constructor(private readonly options: DequeueSystemOptions) {
    this.$ = options.resources;
    this.executionSnapshotSystem = options.executionSnapshotSystem;
    this.runAttemptSystem = options.runAttemptSystem;
    this.releaseConcurrencySystem = options.releaseConcurrencySystem;
  }

  /**
   * Gets a fairly selected run from the specified master queue, returning the information required to run it.
   * @param consumerId: The consumer that is pulling, allows multiple consumers to pull from the same queue
   * @param masterQueue: The shared queue to pull from, can be an individual environment (for dev)
   * @returns
   */
  async dequeueFromMasterQueue({
    consumerId,
    masterQueue,
    maxRunCount,
    maxResources,
    backgroundWorkerId,
    workerId,
    runnerId,
    tx,
  }: {
    consumerId: string;
    masterQueue: string;
    maxRunCount: number;
    maxResources?: MachineResources;
    backgroundWorkerId?: string;
    workerId?: string;
    runnerId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<DequeuedMessage[]> {
    const prisma = tx ?? this.$.prisma;

    return startSpan(
      this.$.tracer,
      "dequeueFromMasterQueue",
      async (span) => {
        //gets multiple runs from the queue
        const messages = await this.$.runQueue.dequeueMessageFromMasterQueue(
          consumerId,
          masterQueue,
          maxRunCount
        );
        if (messages.length === 0) {
          return [];
        }

        //we can't send more than the max resources
        const consumedResources: MachineResources = {
          cpu: 0,
          memory: 0,
        };

        const dequeuedRuns: DequeuedMessage[] = [];

        for (const message of messages) {
          const orgId = message.message.orgId;
          const runId = message.messageId;

          span.setAttribute("runId", runId);

          //lock the run so nothing else can modify it
          try {
            const dequeuedRun = await this.$.runLock.lock([runId], 5000, async (signal) => {
              const snapshot = await getLatestExecutionSnapshot(prisma, runId);

              if (!isDequeueableExecutionStatus(snapshot.executionStatus)) {
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
                  `RunEngine.dequeueFromMasterQueue(): Run is not in a valid state to be dequeued: ${runId}\n ${snapshot.id}:${snapshot.executionStatus}`
                );
                return null;
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

                if (snapshot.previousSnapshotId) {
                  await this.releaseConcurrencySystem.refillTokensForSnapshot(
                    snapshot.previousSnapshotId
                  );
                }

                await sendNotificationToWorker({
                  runId,
                  snapshot: newSnapshot,
                  eventBus: this.$.eventBus,
                });

                return null;
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
                    this.$.logger.error("RunEngine.dequeueFromMasterQueue(): No run found", {
                      runId,
                      latestSnapshot: snapshot.id,
                    });
                    await this.$.runQueue.acknowledgeMessage(orgId, runId);
                    return null;
                  }
                  case "NO_WORKER":
                  case "TASK_NEVER_REGISTERED":
                  case "QUEUE_NOT_FOUND":
                  case "TASK_NOT_IN_LATEST": {
                    this.$.logger.warn(`RunEngine.dequeueFromMasterQueue(): ${result.code}`, {
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
                    return null;
                  }
                  case "BACKGROUND_WORKER_MISMATCH": {
                    this.$.logger.warn(
                      "RunEngine.dequeueFromMasterQueue(): Background worker mismatch",
                      {
                        runId,
                        latestSnapshot: snapshot.id,
                        result,
                      }
                    );

                    //worker mismatch so put it back in the queue
                    await this.$.runQueue.nackMessage({ orgId, messageId: runId });

                    return null;
                  }
                  default: {
                    assertExhaustive(result);
                  }
                }
              }

              //check for a valid deployment if it's not a development environment
              if (result.run.runtimeEnvironment.type !== "DEVELOPMENT") {
                if (!result.deployment || !result.deployment.imageReference) {
                  this.$.logger.warn("RunEngine.dequeueFromMasterQueue(): No deployment found", {
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

                  return null;
                }
              }

              const machinePreset = getMachinePreset({
                machines: this.options.machines.machines,
                defaultMachine: this.options.machines.defaultMachine,
                config: result.task.machineConfig ?? {},
                run: result.run,
              });

              //increment the consumed resources
              consumedResources.cpu += machinePreset.cpu;
              consumedResources.memory += machinePreset.memory;

              //are we under the limit?
              if (maxResources) {
                if (
                  consumedResources.cpu > maxResources.cpu ||
                  consumedResources.memory > maxResources.memory
                ) {
                  this.$.logger.debug(
                    "RunEngine.dequeueFromMasterQueue(): Consumed resources over limit, nacking",
                    {
                      runId,
                      consumedResources,
                      maxResources,
                    }
                  );

                  //put it back in the queue where it was
                  await this.$.runQueue.nackMessage({
                    orgId,
                    messageId: runId,
                    incrementAttemptCount: false,
                    retryAt: result.run.createdAt.getTime() - result.run.priorityMs,
                  });
                  return null;
                }
              }

              // Check max attempts that can optionally be set when triggering a run
              let maxAttempts: number | null | undefined = result.run.maxAttempts;

              // If it's not set, we'll grab it from the task's retry config
              if (!maxAttempts) {
                const retryConfig = result.task.retryConfig;

                this.$.logger.debug(
                  "RunEngine.dequeueFromMasterQueue(): maxAttempts not set, using task's retry config",
                  {
                    runId,
                    task: result.task.id,
                    rawRetryConfig: retryConfig,
                  }
                );

                const parsedConfig = RetryOptions.nullable().safeParse(retryConfig);

                if (!parsedConfig.success) {
                  this.$.logger.error("RunEngine.dequeueFromMasterQueue(): Invalid retry config", {
                    runId,
                    task: result.task.id,
                    rawRetryConfig: retryConfig,
                  });
                }

                maxAttempts = parsedConfig.data?.maxAttempts;
              }
              //update the run
              const lockedTaskRun = await prisma.taskRun.update({
                where: {
                  id: runId,
                },
                data: {
                  lockedAt: new Date(),
                  lockedById: result.task.id,
                  lockedToVersionId: result.worker.id,
                  lockedQueueId: result.queue.id,
                  startedAt: result.run.startedAt ?? new Date(),
                  baseCostInCents: this.options.machines.baseCostInCents,
                  machinePreset: machinePreset.name,
                  taskVersion: result.worker.version,
                  sdkVersion: result.worker.sdkVersion,
                  cliVersion: result.worker.cliVersion,
                  maxDurationInSeconds: getMaxDuration(
                    result.run.maxDurationInSeconds,
                    result.task.maxDurationInSeconds
                  ),
                  maxAttempts: maxAttempts ?? undefined,
                },
                include: {
                  runtimeEnvironment: true,
                  tags: true,
                },
              });

              if (!lockedTaskRun) {
                this.$.logger.error("RunEngine.dequeueFromMasterQueue(): Failed to lock task run", {
                  taskRun: result.run.id,
                  taskIdentifier: result.run.taskIdentifier,
                  deployment: result.deployment?.id,
                  worker: result.worker.id,
                  task: result.task.id,
                  runId,
                });

                await this.$.runQueue.acknowledgeMessage(orgId, runId);
                return null;
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
                },
                run: {
                  id: lockedTaskRun.id,
                  friendlyId: lockedTaskRun.friendlyId,
                  isTest: lockedTaskRun.isTest,
                  machine: machinePreset,
                  attemptNumber: nextAttemptNumber,
                  masterQueue: lockedTaskRun.masterQueue,
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
            });

            if (dequeuedRun !== null) {
              dequeuedRuns.push(dequeuedRun);
            }
          } catch (error) {
            this.$.logger.error(
              "RunEngine.dequeueFromMasterQueue(): Thrown error while preparing run to be run",
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
                "RunEngine.dequeueFromMasterQueue(): Thrown error, then run not found. Nacking.",
                {
                  runId,
                  orgId,
                }
              );
              await this.$.runQueue.nackMessage({ orgId, messageId: runId });
              continue;
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
            //we don't need this, but it makes it clear we're in a loop here
            continue;
          }
        }

        return dequeuedRuns;
      },
      {
        attributes: { consumerId, masterQueue },
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

    return startSpan(
      this.$.tracer,
      "#pendingVersion",
      async (span) => {
        return this.$.runLock.lock([runId], 5_000, async (signal) => {
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

          this.$.logger.debug("RunEngine.dequeueFromMasterQueue(): Pending version", {
            runId,
            run,
          });

          await this.executionSnapshotSystem.createExecutionSnapshot(prisma, {
            run,
            snapshot: {
              executionStatus: "RUN_CREATED",
              description:
                reason ??
                "The run doesn't have a background worker, so we're going to ack it for now.",
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
        });
      },
      {
        attributes: {
          runId,
        },
      }
    );
  }
}
