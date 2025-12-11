import type { BillingCache } from "../billingCache.js";
import { startSpan } from "@internal/tracing";
import { assertExhaustive } from "@trigger.dev/core";
import { DequeuedMessage, RetryOptions } from "@trigger.dev/core/v3";
import { placementTag } from "@trigger.dev/core/v3/serverOnly";
import { getMaxDuration } from "@trigger.dev/core/v3/isomorphic";
import {
  BackgroundWorker,
  BackgroundWorkerTask,
  Prisma,
  PrismaClientOrTransaction,
  TaskQueue,
  WorkerDeployment,
} from "@trigger.dev/database";
import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";

import { sendNotificationToWorker } from "../eventBus.js";
import { getMachinePreset } from "../machinePresets.js";
import { isDequeueableExecutionStatus, isExecuting } from "../statuses.js";
import { RunEngineOptions } from "../types.js";
import { ExecutionSnapshotSystem, getLatestExecutionSnapshot } from "./executionSnapshotSystem.js";
import { RunAttemptSystem } from "./runAttemptSystem.js";
import { SystemResources } from "./systems.js";

export type DequeueSystemOptions = {
  resources: SystemResources;
  machines: RunEngineOptions["machines"];
  executionSnapshotSystem: ExecutionSnapshotSystem;
  runAttemptSystem: RunAttemptSystem;
  billingCache: BillingCache;
};

type RunWithMininimalEnvironment = Prisma.TaskRunGetPayload<{
  include: {
    runtimeEnvironment: {
      select: {
        id: true;
        type: true;
      };
    };
  };
}>;

type RunWithBackgroundWorkerTasksResult =
  | {
      success: false;
      code: "NO_RUN";
      message: string;
    }
  | {
      success: false;
      code:
        | "NO_WORKER"
        | "TASK_NOT_IN_LATEST"
        | "TASK_NEVER_REGISTERED"
        | "BACKGROUND_WORKER_MISMATCH"
        | "QUEUE_NOT_FOUND"
        | "RUN_ENVIRONMENT_ARCHIVED";
      message: string;
      run: RunWithMininimalEnvironment;
    }
  | {
      success: false;
      code: "BACKGROUND_WORKER_MISMATCH";
      message: string;
      backgroundWorker: {
        expected: string;
        received: string;
      };
      run: RunWithMininimalEnvironment;
    }
  | {
      success: true;
      run: RunWithMininimalEnvironment;
      worker: BackgroundWorker;
      task: BackgroundWorkerTask;
      queue: TaskQueue;
      deployment: WorkerDeployment | null;
    };

type WorkerDeploymentWithWorkerTasks = {
  worker: BackgroundWorker;
  tasks: BackgroundWorkerTask[];
  queues: TaskQueue[];
  deployment: WorkerDeployment | null;
};

export class DequeueSystem {
  private readonly $: SystemResources;
  private readonly executionSnapshotSystem: ExecutionSnapshotSystem;
  private readonly runAttemptSystem: RunAttemptSystem;

  constructor(private readonly options: DequeueSystemOptions) {
    this.$ = options.resources;
    this.executionSnapshotSystem = options.executionSnapshotSystem;
    this.runAttemptSystem = options.runAttemptSystem;
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
    blockingPop,
    blockingPopTimeoutSeconds,
  }: {
    consumerId: string;
    workerQueue: string;
    backgroundWorkerId?: string;
    workerId?: string;
    runnerId?: string;
    tx?: PrismaClientOrTransaction;
    blockingPop?: boolean;
    blockingPopTimeoutSeconds?: number;
  }): Promise<DequeuedMessage | undefined> {
    const prisma = tx ?? this.$.prisma;

    return startSpan(
      this.$.tracer,
      "dequeueFromWorkerQueue",
      async (span) => {
        //gets multiple runs from the queue
        const message = await this.$.runQueue.dequeueMessageFromWorkerQueue(
          consumerId,
          workerQueue,
          {
            blockingPop,
            blockingPopTimeoutSeconds,
          }
        );
        if (!message) {
          return;
        }

        const orgId = message.message.orgId;
        const runId = message.messageId;

        this.$.logger.info("DequeueSystem.dequeueFromWorkerQueue dequeued message", {
          runId,
          orgId,
          environmentId: message.message.environmentId,
          environmentType: message.message.environmentType,
          workerQueueLength: message.workerQueueLength ?? 0,
          workerQueue,
        });

        span.setAttribute("run_id", runId);
        span.setAttribute("org_id", orgId);
        span.setAttribute("environment_id", message.message.environmentId);
        span.setAttribute("environment_type", message.message.environmentType);
        span.setAttribute("worker_queue_length", message.workerQueueLength ?? 0);
        span.setAttribute("consumer_id", consumerId);
        span.setAttribute("worker_queue", workerQueue);
        span.setAttribute("blocking_pop", blockingPop ?? true);

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

                if (isExecuting(snapshot.executionStatus)) {
                  this.$.logger.error(
                    `RunEngine.dequeueFromWorkerQueue(): Run is not in a valid state to be dequeued`,
                    {
                      runId,
                      snapshotId: snapshot.id,
                      executionStatus: snapshot.executionStatus,
                    }
                  );
                } else {
                  this.$.logger.warn(
                    `RunEngine.dequeueFromWorkerQueue(): Run is in an expected not valid state to be dequeued`,
                    {
                      runId,
                      snapshotId: snapshot.id,
                      executionStatus: snapshot.executionStatus,
                    }
                  );
                }

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

              const result = await this.#getRunWithBackgroundWorkerTasks(
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
              const lockedRetryConfig = result.run.lockedRetryConfig
                ? undefined
                : result.task.retryConfig;

              const lockedTaskRun = await prisma.taskRun.update({
                where: {
                  id: runId,
                },
                data: {
                  lockedAt,
                  lockedById: result.task.id,
                  lockedToVersionId: result.worker.id,
                  lockedQueueId: result.queue.id,
                  lockedRetryConfig: lockedRetryConfig ?? undefined,
                  status: "DEQUEUED",
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

              // Get billing information if available, with fallback to TaskRun.planType
              const billingResult = await this.options.billingCache.getCurrentPlan(orgId);

              let isPaying: boolean;
              if (billingResult.err || !billingResult.val) {
                // Fallback to stored planType on TaskRun if billing cache fails or returns no value
                this.$.logger.warn(
                  "Billing cache failed or returned no value, falling back to TaskRun.planType",
                  {
                    orgId,
                    runId,
                    error:
                      billingResult.err instanceof Error
                        ? billingResult.err.message
                        : String(billingResult.err),
                    currentPlan: billingResult.val,
                  }
                );

                isPaying = (lockedTaskRun.planType ?? "free") !== "free";
              } else {
                isPaying = billingResult.val.isPaying;
              }

              const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(
                prisma,
                {
                  run: {
                    id: runId,
                    status: lockedTaskRun.status,
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
                workerQueueLength: message.workerQueueLength,
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
                  id: result.deployment?.id ?? "",
                  friendlyId: result.deployment?.friendlyId ?? "",
                  version: result.deployment?.version ?? "",
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
                placementTags: [placementTag("paid", isPaying ? "true" : "false")],
              } satisfies DequeuedMessage;
            },
            {
              run_id: runId,
              org_id: orgId,
              environment_id: message.message.environmentId,
              environment_type: message.message.environmentType,
              worker_queue_length: message.workerQueueLength ?? 0,
              consumer_id: consumerId,
              worker_queue: workerQueue,
              blocking_pop: blockingPop ?? true,
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

  async #getRunWithBackgroundWorkerTasks(
    prisma: PrismaClientOrTransaction,
    runId: string,
    backgroundWorkerId?: string
  ): Promise<RunWithBackgroundWorkerTasksResult> {
    return startSpan(this.$.tracer, "getRunWithBackgroundWorkerTasks", async (span) => {
      span.setAttribute("run_id", runId);

      const run = await prisma.taskRun.findFirst({
        where: {
          id: runId,
        },
        include: {
          runtimeEnvironment: {
            select: {
              id: true,
              type: true,
              archivedAt: true,
            },
          },
          lockedToVersion: {
            include: {
              deployment: true,
              tasks: true,
            },
          },
        },
      });

      if (!run) {
        span.setAttribute("result", "NO_RUN");
        return {
          success: false as const,
          code: "NO_RUN",
          message: `No run found with id: ${runId}`,
        };
      }

      span.setAttribute("environment_type", run.runtimeEnvironment.type);

      if (run.runtimeEnvironment.archivedAt) {
        span.setAttribute("result", "RUN_ENVIRONMENT_ARCHIVED");
        return {
          success: false as const,
          code: "RUN_ENVIRONMENT_ARCHIVED",
          message: `Run is on an archived environment: ${run.id}`,
          run,
        };
      }

      const workerId = run.lockedToVersionId ?? backgroundWorkerId;

      //get the relevant BackgroundWorker with tasks and deployment (if not DEV)
      let workerWithTasks: WorkerDeploymentWithWorkerTasks | null = null;

      if (run.runtimeEnvironment.type === "DEVELOPMENT") {
        workerWithTasks = workerId
          ? await this.#getWorkerById(prisma, workerId)
          : await this.#getMostRecentWorker(prisma, run.runtimeEnvironmentId);
      } else {
        workerWithTasks = workerId
          ? await this.#getWorkerDeploymentFromWorker(prisma, workerId)
          : await this.#getManagedWorkerFromCurrentlyPromotedDeployment(
              prisma,
              run.runtimeEnvironmentId
            );
      }

      if (!workerWithTasks) {
        span.setAttribute("result", "NO_WORKER");
        return {
          success: false as const,
          code: "NO_WORKER",
          message: `No worker found for run: ${run.id}`,
          run,
        };
      }

      if (backgroundWorkerId) {
        if (backgroundWorkerId !== workerWithTasks.worker.id) {
          span.setAttribute("result", "BACKGROUND_WORKER_MISMATCH");
          return {
            success: false as const,
            code: "BACKGROUND_WORKER_MISMATCH",
            message: `Background worker mismatch for run: ${run.id}`,
            backgroundWorker: {
              expected: backgroundWorkerId,
              received: workerWithTasks.worker.id,
            },
            run,
          };
        }
      }

      const backgroundTask = workerWithTasks.tasks.find((task) => task.slug === run.taskIdentifier);

      if (!backgroundTask) {
        const nonCurrentTask = await prisma.backgroundWorkerTask.findFirst({
          where: {
            slug: run.taskIdentifier,
            projectId: run.projectId,
            runtimeEnvironmentId: run.runtimeEnvironmentId,
          },
          include: {
            worker: true,
          },
          orderBy: {
            createdAt: "desc",
          },
        });

        if (nonCurrentTask) {
          span.setAttribute("result", "TASK_NOT_IN_LATEST");
          return {
            success: false as const,
            code: "TASK_NOT_IN_LATEST",
            message: `Task not found in latest version: ${run.taskIdentifier}. Found in ${nonCurrentTask.worker.version}`,
            run,
          };
        } else {
          span.setAttribute("result", "TASK_NEVER_REGISTERED");
          return {
            success: false as const,
            code: "TASK_NEVER_REGISTERED",
            message: `Task has never been registered (in dev or deployed): ${run.taskIdentifier}`,
            run,
          };
        }
      }

      const queue = workerWithTasks.queues.find((queue) =>
        run.lockedQueueId ? queue.id === run.lockedQueueId : queue.name === run.queue
      );

      if (!queue) {
        span.setAttribute("result", "QUEUE_NOT_FOUND");
        return {
          success: false as const,
          code: "QUEUE_NOT_FOUND",
          message: `Queue not found for run: ${run.id}`,
          run,
        };
      }

      span.setAttribute("result", "SUCCESS");

      return {
        success: true as const,
        run,
        worker: workerWithTasks.worker,
        task: backgroundTask,
        queue,
        deployment: workerWithTasks.deployment,
      };
    });
  }

  async #getWorkerDeploymentFromWorker(
    prisma: PrismaClientOrTransaction,
    workerId: string
  ): Promise<WorkerDeploymentWithWorkerTasks | null> {
    return startSpan(this.$.tracer, "getWorkerDeploymentFromWorker", async (span) => {
      const worker = await prisma.backgroundWorker.findFirst({
        where: {
          id: workerId,
        },
        include: {
          deployment: true,
          tasks: true,
          queues: true,
        },
      });

      if (!worker) {
        span.setAttribute("result", "NOT_FOUND");
        return null;
      }

      span.setAttribute("result", "SUCCESS");

      return {
        worker,
        tasks: worker.tasks,
        queues: worker.queues,
        deployment: worker.deployment,
      };
    });
  }

  async #getMostRecentWorker(
    prisma: PrismaClientOrTransaction,
    environmentId: string
  ): Promise<WorkerDeploymentWithWorkerTasks | null> {
    return startSpan(this.$.tracer, "getMostRecentWorker", async (span) => {
      const worker = await prisma.backgroundWorker.findFirst({
        where: {
          runtimeEnvironmentId: environmentId,
        },
        include: {
          tasks: true,
          queues: true,
        },
        orderBy: {
          id: "desc",
        },
      });

      if (!worker) {
        span.setAttribute("result", "NOT_FOUND");
        return null;
      }

      span.setAttribute("result", "SUCCESS");

      return { worker, tasks: worker.tasks, queues: worker.queues, deployment: null };
    });
  }

  async #getWorkerById(
    prisma: PrismaClientOrTransaction,
    workerId: string
  ): Promise<WorkerDeploymentWithWorkerTasks | null> {
    return startSpan(this.$.tracer, "getWorkerById", async (span) => {
      const worker = await prisma.backgroundWorker.findFirst({
        where: {
          id: workerId,
        },
        include: {
          deployment: true,
          tasks: true,
          queues: true,
        },
        orderBy: {
          id: "desc",
        },
      });

      if (!worker) {
        span.setAttribute("result", "NOT_FOUND");
        return null;
      }

      span.setAttribute("result", "SUCCESS");

      return {
        worker,
        tasks: worker.tasks,
        queues: worker.queues,
        deployment: worker.deployment,
      };
    });
  }

  async #getManagedWorkerFromCurrentlyPromotedDeployment(
    prisma: PrismaClientOrTransaction,
    environmentId: string
  ): Promise<WorkerDeploymentWithWorkerTasks | null> {
    return startSpan(
      this.$.tracer,
      "getManagedWorkerFromCurrentlyPromotedDeployment",
      async (span) => {
        const promotion = await prisma.workerDeploymentPromotion.findFirst({
          where: {
            environmentId,
            label: CURRENT_DEPLOYMENT_LABEL,
          },
          include: {
            deployment: {
              include: {
                worker: {
                  include: {
                    tasks: true,
                    queues: true,
                  },
                },
              },
            },
          },
        });

        if (!promotion || !promotion.deployment.worker) {
          span.setAttribute("result", "NO_PROMOTION_OR_WORKER");
          return null;
        }

        if (promotion.deployment.type === "MANAGED") {
          // This is a run engine v2 deployment, so return it
          span.setAttribute("result", "SUCCESS_CURRENT_MANAGED");

          return {
            worker: promotion.deployment.worker,
            tasks: promotion.deployment.worker.tasks,
            queues: promotion.deployment.worker.queues,
            deployment: promotion.deployment,
          };
        }

        // We need to get the latest run engine v2 deployment
        const latestV2Deployment = await prisma.workerDeployment.findFirst({
          where: {
            environmentId,
            type: "MANAGED",
          },
          orderBy: {
            id: "desc",
          },
          include: {
            worker: {
              include: {
                tasks: true,
                queues: true,
              },
            },
          },
        });

        if (!latestV2Deployment?.worker) {
          span.setAttribute("result", "NO_V2_DEPLOYMENT");
          return null;
        }

        span.setAttribute("result", "SUCCESS_LATEST_V2");

        return {
          worker: latestV2Deployment.worker,
          tasks: latestV2Deployment.worker.tasks,
          queues: latestV2Deployment.worker.queues,
          deployment: latestV2Deployment,
        };
      }
    );
  }
}
