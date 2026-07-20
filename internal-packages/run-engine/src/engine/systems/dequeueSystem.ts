import { startSpan } from "@internal/tracing";
import { assertExhaustive, tryCatch } from "@trigger.dev/core";
import type { DequeuedMessage } from "@trigger.dev/core/v3";
import { RetryOptions, RunAnnotations } from "@trigger.dev/core/v3";
import { generateInternalId, getMaxDuration, SnapshotId } from "@trigger.dev/core/v3/isomorphic";
import { placementTag } from "@trigger.dev/core/v3/serverOnly";
import type {
  BackgroundWorker,
  BackgroundWorkerTask,
  Prisma,
  PrismaClientOrTransaction,
  RuntimeEnvironmentType,
  TaskQueue,
  WorkerDeployment,
} from "@trigger.dev/database";
import type { BillingCache } from "../billingCache.js";

import { sendNotificationToWorker } from "../eventBus.js";
import { getMachinePreset } from "../machinePresets.js";
import { isDequeueableExecutionStatus, isExecuting } from "../statuses.js";
import type { RunEngineOptions } from "../types.js";
import type { ExecutionSnapshotSystem } from "./executionSnapshotSystem.js";
import { getLatestExecutionSnapshot } from "./executionSnapshotSystem.js";
import type { RunAttemptSystem } from "./runAttemptSystem.js";
import type { SystemResources } from "./systems.js";

export type DequeueSystemOptions = {
  resources: SystemResources;
  machines: RunEngineOptions["machines"];
  executionSnapshotSystem: ExecutionSnapshotSystem;
  runAttemptSystem: RunAttemptSystem;
  billingCache: BillingCache;
};

// Run-ops scalars the dequeue path reads off the run row. The environment half (type,
// archivedAt) is resolved separately via the controlPlaneResolver so the run-ops DB can
// split without a cross-provider join.
const dequeueRunSelect = {
  id: true,
  taskIdentifier: true,
  lockedToVersionId: true,
  lockedQueueId: true,
  queue: true,
  projectId: true,
  runtimeEnvironmentId: true,
  maxAttempts: true,
  startedAt: true,
  maxDurationInSeconds: true,
  lockedRetryConfig: true,
  attemptNumber: true,
  machinePreset: true,
} satisfies Prisma.TaskRunSelect;

type RunWithDequeueScalars = Prisma.TaskRunGetPayload<{ select: typeof dequeueRunSelect }>;

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
      run: RunWithDequeueScalars;
      environmentType: RuntimeEnvironmentType;
    }
  | {
      success: false;
      code: "BACKGROUND_WORKER_MISMATCH";
      message: string;
      backgroundWorker: {
        expected: string;
        received: string;
      };
      run: RunWithDequeueScalars;
      environmentType: RuntimeEnvironmentType;
    }
  | {
      success: true;
      run: RunWithDequeueScalars;
      environmentType: RuntimeEnvironmentType;
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
              const snapshot = await getLatestExecutionSnapshot(prisma, runId, this.$.runStore);

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
              if (result.environmentType !== "DEVELOPMENT") {
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

              // Pre-generate snapshot ID so we can construct the result without an extra read
              const snapshotId = generateInternalId();

              const lockedTaskRun = await this.$.runStore.lockRunToWorker(
                runId,
                {
                  lockedAt,
                  lockedById: result.task.id,
                  lockedToVersionId: result.worker.id,
                  lockedQueueId: result.queue.id,
                  lockedRetryConfig: lockedRetryConfig ?? undefined,
                  startedAt,
                  baseCostInCents: this.options.machines.baseCostInCents,
                  machinePreset: machinePreset.name,
                  taskVersion: result.worker.version,
                  sdkVersion: result.worker.sdkVersion,
                  cliVersion: result.worker.cliVersion,
                  maxDurationInSeconds,
                  maxAttempts: maxAttempts ?? undefined,
                  snapshot: {
                    id: snapshotId,
                    previousSnapshotId: snapshot.id,
                    attemptNumber: result.run.attemptNumber ?? undefined,
                    environmentId: snapshot.environmentId,
                    environmentType: snapshot.environmentType,
                    projectId: snapshot.projectId,
                    organizationId: snapshot.organizationId,
                    checkpointId: snapshot.checkpointId ?? undefined,
                    batchId: snapshot.batchId ?? undefined,
                    completedWaitpointIds: snapshot.completedWaitpoints.map((w) => w.id),
                    completedWaitpointOrder: snapshot.completedWaitpoints
                      .filter((c) => c.index !== undefined)
                      .sort((a, b) => a.index! - b.index!)
                      .map((w) => w.id),
                    workerId,
                    runnerId,
                  },
                },
                prisma
              );

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
                  runTags: lockedTaskRun.runTags,
                  batchId: lockedTaskRun.batchId,
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
              let hasPrivateLink: boolean | undefined;
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
                hasPrivateLink = billingResult.val.hasPrivateLink;
              }

              // Snapshot was created as part of the taskRun.update above (single transaction).
              // Construct the snapshot info from data we already have and handle side effects
              // (heartbeat + event) manually — no extra DB read needed.
              const snapshotCreatedAt = new Date();

              this.$.eventBus.emit("executionSnapshotCreated", {
                time: snapshotCreatedAt,
                run: {
                  id: runId,
                },
                snapshot: {
                  id: snapshotId,
                  executionStatus: "PENDING_EXECUTING",
                  description: "Run was dequeued for execution",
                  runStatus: "PENDING",
                  attemptNumber: result.run.attemptNumber ?? null,
                  checkpointId: snapshot.checkpointId ?? null,
                  workerId: workerId ?? null,
                  runnerId: runnerId ?? null,
                  isValid: true,
                  error: null,
                  completedWaitpointIds: snapshot.completedWaitpoints.map((wp) => wp.id),
                },
              });

              await this.executionSnapshotSystem.enqueueHeartbeatIfNeeded({
                id: snapshotId,
                runId,
                executionStatus: "PENDING_EXECUTING",
              });

              return {
                version: "1" as const,
                dequeuedAt: new Date(),
                workerQueueLength: message.workerQueueLength,
                snapshot: {
                  id: snapshotId,
                  friendlyId: SnapshotId.toFriendlyId(snapshotId),
                  executionStatus: "PENDING_EXECUTING" as const,
                  description: "Run was dequeued for execution",
                  createdAt: snapshotCreatedAt,
                },
                image: result.deployment?.imageReference ?? undefined,
                checkpoint: snapshot.checkpoint ?? undefined,
                completedWaitpoints: snapshot.completedWaitpoints,
                backgroundWorker: {
                  id: result.worker.id,
                  friendlyId: result.worker.friendlyId,
                  version: result.worker.version,
                  runtime: result.worker.runtime ?? undefined,
                },
                // TODO: use a discriminated union schema to differentiate between dequeued runs in dev and in deployed environments.
                // Would help make the typechecking stricter
                deployment: {
                  id: result.deployment?.id,
                  friendlyId: result.deployment?.friendlyId,
                  imagePlatform: result.deployment?.imagePlatform,
                },
                run: {
                  id: lockedTaskRun.id,
                  friendlyId: lockedTaskRun.friendlyId,
                  isTest: lockedTaskRun.isTest,
                  isReplay: !!lockedTaskRun.replayedFromTaskRunFriendlyId,
                  machine: machinePreset,
                  attemptNumber: nextAttemptNumber,
                  // Keeping this for backwards compatibility, but really this should be called workerQueue
                  masterQueue: lockedTaskRun.workerQueue,
                  traceContext: lockedTaskRun.traceContext as Record<string, unknown>,
                  annotations: RunAnnotations.safeParse(lockedTaskRun.annotations).data,
                },
                environment: {
                  id: lockedTaskRun.runtimeEnvironmentId,
                  type: result.environmentType,
                },
                organization: {
                  id: orgId,
                  hasPrivateLink,
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

          // Wrap the Prisma call with tryCatch - if DB is unavailable, we still want to nack via Redis
          const [findError, run] = await tryCatch(
            this.$.runStore.findRun(
              { id: runId },
              {
                select: {
                  id: true,
                  runtimeEnvironmentId: true,
                  projectId: true,
                },
              },
              prisma
            )
          );

          const env = run
            ? await this.$.controlPlaneResolver.resolveEnv(run.runtimeEnvironmentId)
            : null;

          // If DB is unavailable, run not found, or env not resolved, just nack directly via Redis
          if (findError || !run || !env) {
            this.$.logger.error(
              "RunEngine.dequeueFromWorkerQueue(): Failed to find run, nacking directly via Redis",
              {
                runId,
                orgId,
                findError,
              }
            );
            await this.$.runQueue.nackMessage({ orgId, messageId: runId });

            return;
          }

          //this is an unknown error, we'll reattempt (with auto-backoff and eventually DLQ)
          const gotRequeued = await this.runAttemptSystem.tryNackAndRequeue({
            run,
            environment: { id: env.id, type: env.type },
            orgId,
            projectId: run.projectId,
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
      const run = await this.$.runStore.parkPendingVersion(
        runId,
        {
          statusReason,
        },
        {
          select: {
            id: true,
            runtimeEnvironmentId: true,
            status: true,
            attemptNumber: true,
            updatedAt: true,
            createdAt: true,
            runTags: true,
            batchId: true,
          },
        },
        prisma
      );

      const env = await this.$.controlPlaneResolver.resolveEnv(run.runtimeEnvironmentId);

      if (!env) {
        this.$.logger.error("RunEngine.#pendingVersion(): environment not found", { runId });
        await this.$.runQueue.acknowledgeMessage(orgId, runId);
        return;
      }

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
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
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
          runTags: run.runTags,
          batchId: run.batchId,
        },
        organization: {
          id: env.organizationId,
        },
        project: {
          id: env.projectId,
        },
        environment: {
          id: env.id,
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

      // Read the run-ops scalars only; the control-plane env + worker version are resolved
      // separately so the run-ops DB can split without a cross-provider join.
      const run = await this.$.runStore.findRun(
        {
          id: runId,
        },
        {
          select: dequeueRunSelect,
        },
        prisma
      );

      if (!run) {
        span.setAttribute("result", "NO_RUN");
        return {
          success: false as const,
          code: "NO_RUN",
          message: `No run found with id: ${runId}`,
        };
      }

      const env = await this.$.controlPlaneResolver.resolveEnv(run.runtimeEnvironmentId);

      if (!env) {
        span.setAttribute("result", "NO_RUN");
        return {
          success: false as const,
          code: "NO_RUN",
          message: `No environment found for run: ${runId}`,
        };
      }

      span.setAttribute("environment_type", env.type);

      if (env.archivedAt) {
        span.setAttribute("result", "RUN_ENVIRONMENT_ARCHIVED");
        return {
          success: false as const,
          code: "RUN_ENVIRONMENT_ARCHIVED",
          message: `Run is on an archived environment: ${run.id}`,
          run,
          environmentType: env.type,
        };
      }

      const workerId = run.lockedToVersionId ?? backgroundWorkerId;

      //get the relevant BackgroundWorker with tasks and deployment (if not DEV)
      const workerWithTasks: WorkerDeploymentWithWorkerTasks | null =
        await this.$.controlPlaneResolver.resolveWorkerVersion({
          environmentId: run.runtimeEnvironmentId,
          type: env.type,
          workerId: workerId ?? undefined,
        });

      if (!workerWithTasks) {
        span.setAttribute("result", "NO_WORKER");
        return {
          success: false as const,
          code: "NO_WORKER",
          message: `No worker found for run: ${run.id}`,
          run,
          environmentType: env.type,
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
            environmentType: env.type,
          };
        }
      }

      const backgroundTask = workerWithTasks.tasks.find((task) => task.slug === run.taskIdentifier);

      if (!backgroundTask) {
        // Diagnostic-only disambiguation (off the hot path); left on `prisma` as the resolver
        // interface exposes only env + worker-version resolution.
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
            environmentType: env.type,
          };
        } else {
          span.setAttribute("result", "TASK_NEVER_REGISTERED");
          return {
            success: false as const,
            code: "TASK_NEVER_REGISTERED",
            message: `Task has never been registered (in dev or deployed): ${run.taskIdentifier}`,
            run,
            environmentType: env.type,
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
          environmentType: env.type,
        };
      }

      span.setAttribute("result", "SUCCESS");

      return {
        success: true as const,
        run,
        environmentType: env.type,
        worker: workerWithTasks.worker,
        task: backgroundTask,
        queue,
        deployment: workerWithTasks.deployment,
      };
    });
  }
}
