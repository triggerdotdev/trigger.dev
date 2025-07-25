import {
  createCache,
  DefaultStatefulContext,
  MemoryStore,
  Namespace,
  RedisCacheStore,
  UnkeyCache,
} from "@internal/cache";
import { RedisOptions } from "@internal/redis";
import { startSpan } from "@internal/tracing";
import { tryCatch } from "@trigger.dev/core/utils";
import {
  CompleteRunAttemptResult,
  ExecutionResult,
  FlushedRunMetadata,
  GitMeta,
  MachinePreset,
  MachinePresetName,
  StartRunAttemptResult,
  TaskRunContext,
  TaskRunError,
  TaskRunExecution,
  TaskRunExecutionDeployment,
  TaskRunExecutionOrganization,
  TaskRunExecutionProject,
  TaskRunExecutionQueue,
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
import { getMachinePreset, machinePresetFromName } from "../machinePresets.js";
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
import { SystemResources } from "./systems.js";
import { WaitpointSystem } from "./waitpointSystem.js";
import { BatchId, RunId } from "@trigger.dev/core/v3/isomorphic";

export type RunAttemptSystemOptions = {
  resources: SystemResources;
  executionSnapshotSystem: ExecutionSnapshotSystem;
  batchSystem: BatchSystem;
  waitpointSystem: WaitpointSystem;
  delayedRunSystem: DelayedRunSystem;
  retryWarmStartThresholdMs?: number;
  machines: RunEngineOptions["machines"];
  redisOptions: RedisOptions;
};

type BackwardsCompatibleTaskRunExecution = Omit<TaskRunExecution, "task" | "attempt" | "run"> & {
  task: TaskRunExecution["task"] & {
    exportName: string | undefined;
  };
  attempt: TaskRunExecution["attempt"] & {
    id: string;
    backgroundWorkerId: string;
    backgroundWorkerTaskId: string;
    status: string;
  };
  run: TaskRunExecution["run"] & {
    context: undefined;
    durationMs: number;
    costInCents: number;
    baseCostInCents: number;
  };
};

const ORG_FRESH_TTL = 60000 * 60 * 24; // 1 day
const ORG_STALE_TTL = 60000 * 60 * 24 * 2; // 2 days
const PROJECT_FRESH_TTL = 60000 * 60 * 24; // 1 day
const PROJECT_STALE_TTL = 60000 * 60 * 24 * 2; // 2 days
const TASK_FRESH_TTL = 60000 * 60 * 24; // 1 day
const TASK_STALE_TTL = 60000 * 60 * 24 * 2; // 2 days
const MACHINE_PRESET_FRESH_TTL = 60000 * 60 * 24; // 1 day
const MACHINE_PRESET_STALE_TTL = 60000 * 60 * 24 * 2; // 2 days
const DEPLOYMENT_FRESH_TTL = 60000 * 60 * 24; // 1 day
const DEPLOYMENT_STALE_TTL = 60000 * 60 * 24 * 2; // 2 days
const QUEUE_FRESH_TTL = 60000 * 60; // 1 hour
const QUEUE_STALE_TTL = 60000 * 60 * 2; // 2 hours

export class RunAttemptSystem {
  private readonly $: SystemResources;
  private readonly executionSnapshotSystem: ExecutionSnapshotSystem;
  private readonly batchSystem: BatchSystem;
  private readonly waitpointSystem: WaitpointSystem;
  private readonly delayedRunSystem: DelayedRunSystem;
  private readonly cache: UnkeyCache<{
    tasks: BackwardsCompatibleTaskRunExecution["task"];
    machinePresets: MachinePreset;
    deployments: TaskRunExecutionDeployment;
    queues: TaskRunExecutionQueue;
    projects: TaskRunExecutionProject;
    orgs: TaskRunExecutionOrganization;
  }>;

  constructor(private readonly options: RunAttemptSystemOptions) {
    this.$ = options.resources;
    this.executionSnapshotSystem = options.executionSnapshotSystem;
    this.batchSystem = options.batchSystem;
    this.waitpointSystem = options.waitpointSystem;
    this.delayedRunSystem = options.delayedRunSystem;

    const ctx = new DefaultStatefulContext();
    // TODO: use an LRU cache for memory store
    const memory = new MemoryStore({ persistentMap: new Map() });
    const redisCacheStore = new RedisCacheStore({
      name: "run-attempt-system",
      connection: {
        ...options.redisOptions,
        keyPrefix: "engine:run-attempt-system:cache:",
      },
      useModernCacheKeyBuilder: true,
    });

    this.cache = createCache({
      orgs: new Namespace<TaskRunExecutionOrganization>(ctx, {
        stores: [memory, redisCacheStore],
        fresh: ORG_FRESH_TTL,
        stale: ORG_STALE_TTL,
      }),
      projects: new Namespace<TaskRunExecutionProject>(ctx, {
        stores: [memory, redisCacheStore],
        fresh: PROJECT_FRESH_TTL,
        stale: PROJECT_STALE_TTL,
      }),
      tasks: new Namespace<BackwardsCompatibleTaskRunExecution["task"]>(ctx, {
        stores: [memory, redisCacheStore],
        fresh: TASK_FRESH_TTL,
        stale: TASK_STALE_TTL,
      }),
      machinePresets: new Namespace<MachinePreset>(ctx, {
        stores: [memory, redisCacheStore],
        fresh: MACHINE_PRESET_FRESH_TTL,
        stale: MACHINE_PRESET_STALE_TTL,
      }),
      deployments: new Namespace<TaskRunExecutionDeployment>(ctx, {
        stores: [memory, redisCacheStore],
        fresh: DEPLOYMENT_FRESH_TTL,
        stale: DEPLOYMENT_STALE_TTL,
      }),
      queues: new Namespace<TaskRunExecutionQueue>(ctx, {
        stores: [memory, redisCacheStore],
        fresh: QUEUE_FRESH_TTL,
        stale: QUEUE_STALE_TTL,
      }),
    });
  }

  public async resolveTaskRunContext(runId: string): Promise<TaskRunContext> {
    const run = await this.$.prisma.taskRun.findFirst({
      where: {
        id: runId,
      },
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        executedAt: true,
        baseCostInCents: true,
        projectId: true,
        organizationId: true,
        friendlyId: true,
        lockedById: true,
        lockedQueueId: true,
        queue: true,
        attemptNumber: true,
        status: true,
        ttl: true,
        machinePreset: true,
        runTags: true,
        isTest: true,
        idempotencyKey: true,
        startedAt: true,
        maxAttempts: true,
        taskVersion: true,
        maxDurationInSeconds: true,
        usageDurationMs: true,
        costInCents: true,
        traceContext: true,
        priorityMs: true,
        taskIdentifier: true,
        runtimeEnvironment: {
          select: {
            id: true,
            slug: true,
            type: true,
            branchName: true,
            git: true,
            organizationId: true,
          },
        },
        parentTaskRunId: true,
        rootTaskRunId: true,
        batchId: true,
      },
    });

    if (!run) {
      throw new ServiceValidationError("Task run not found", 404);
    }

    const [task, queue, organization, project, machinePreset, deployment] = await Promise.all([
      run.lockedById
        ? this.#resolveTaskRunExecutionTask(run.lockedById)
        : Promise.resolve({
            id: run.taskIdentifier,
            filePath: "unknown",
          }),
      this.#resolveTaskRunExecutionQueue({
        runId,
        lockedQueueId: run.lockedQueueId ?? undefined,
        queueName: run.queue,
        runtimeEnvironmentId: run.runtimeEnvironment.id,
      }),
      this.#resolveTaskRunExecutionOrganization(run.runtimeEnvironment.organizationId),
      this.#resolveTaskRunExecutionProjectByRuntimeEnvironmentId(run.runtimeEnvironment.id),
      run.lockedById
        ? this.#resolveTaskRunExecutionMachinePreset(run.lockedById, run.machinePreset)
        : Promise.resolve(
            getMachinePreset({
              defaultMachine: this.options.machines.defaultMachine,
              machines: this.options.machines.machines,
              config: undefined,
              run,
            })
          ),
      run.lockedById
        ? this.#resolveTaskRunExecutionDeployment(run.lockedById)
        : Promise.resolve(undefined),
    ]);

    return {
      run: {
        id: run.friendlyId,
        tags: run.runTags,
        isTest: run.isTest,
        createdAt: run.createdAt,
        startedAt: run.startedAt ?? run.createdAt,
        idempotencyKey: run.idempotencyKey ?? undefined,
        maxAttempts: run.maxAttempts ?? undefined,
        version: run.taskVersion ?? "unknown",
        maxDuration: run.maxDurationInSeconds ?? undefined,
        priority: run.priorityMs === 0 ? undefined : run.priorityMs / 1_000,
        parentTaskRunId: run.parentTaskRunId ? RunId.toFriendlyId(run.parentTaskRunId) : undefined,
        rootTaskRunId: run.rootTaskRunId ? RunId.toFriendlyId(run.rootTaskRunId) : undefined,
      },
      attempt: {
        number: run.attemptNumber ?? 1,
        startedAt: run.startedAt ?? new Date(),
      },
      task,
      queue,
      organization,
      project,
      machine: machinePreset,
      deployment,
      environment: {
        id: run.runtimeEnvironment.id,
        slug: run.runtimeEnvironment.slug,
        type: run.runtimeEnvironment.type,
        branchName: run.runtimeEnvironment.branchName ?? undefined,
        git: safeParseGitMeta(run.runtimeEnvironment.git),
      },
      batch: run.batchId ? { id: BatchId.toFriendlyId(run.batchId) } : undefined,
    };
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
        return this.$.runLock.lock("startRunAttempt", [runId], async () => {
          const latestSnapshot = await getLatestExecutionSnapshot(prisma, runId);

          if (latestSnapshot.id !== snapshotId) {
            //if there is a big delay between the snapshot and the attempt, the snapshot might have changed
            //we just want to log because elsewhere it should have been put back into a state where it can be attempted
            this.$.logger.warn(
              "RunEngine.createRunAttempt(): snapshot has changed since the attempt was created, ignoring."
            );
            throw new ServiceValidationError("Snapshot changed", 409);
          }

          const taskRun = await prisma.taskRun.findFirst({
            where: {
              id: runId,
            },
            select: {
              id: true,
              friendlyId: true,
              attemptNumber: true,
              projectId: true,
              runtimeEnvironmentId: true,
              status: true,
              lockedById: true,
              ttl: true,
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

          if (!taskRun.lockedById) {
            throw new ServiceValidationError("Task run is not locked", 400);
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
                select: {
                  id: true,
                  createdAt: true,
                  updatedAt: true,
                  executedAt: true,
                  baseCostInCents: true,
                  projectId: true,
                  organizationId: true,
                  friendlyId: true,
                  lockedById: true,
                  lockedQueueId: true,
                  queue: true,
                  attemptNumber: true,
                  status: true,
                  ttl: true,
                  metadata: true,
                  metadataType: true,
                  machinePreset: true,
                  payload: true,
                  payloadType: true,
                  runTags: true,
                  isTest: true,
                  idempotencyKey: true,
                  startedAt: true,
                  maxAttempts: true,
                  taskVersion: true,
                  maxDurationInSeconds: true,
                  usageDurationMs: true,
                  costInCents: true,
                  traceContext: true,
                  priorityMs: true,
                  batchId: true,
                  runtimeEnvironment: {
                    select: {
                      id: true,
                      slug: true,
                      type: true,
                      branchName: true,
                      git: true,
                      organizationId: true,
                    },
                  },
                  parentTaskRunId: true,
                  rootTaskRunId: true,
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

              return { updatedRun: run, snapshot: newSnapshot };
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

          const { updatedRun, snapshot } = result;

          this.$.eventBus.emit("runAttemptStarted", {
            time: new Date(),
            run: {
              id: updatedRun.id,
              status: updatedRun.status,
              createdAt: updatedRun.createdAt,
              updatedAt: updatedRun.updatedAt,
              attemptNumber: nextAttemptNumber,
              baseCostInCents: updatedRun.baseCostInCents,
              executedAt: updatedRun.executedAt ?? undefined,
            },
            organization: {
              id: updatedRun.runtimeEnvironment.organizationId,
            },
            project: {
              id: updatedRun.projectId,
            },
            environment: {
              id: updatedRun.runtimeEnvironment.id,
            },
          });

          const environmentGit = safeParseGitMeta(updatedRun.runtimeEnvironment.git);

          const [metadata, task, queue, organization, project, machinePreset, deployment] =
            await Promise.all([
              parsePacket({
                data: updatedRun.metadata ?? undefined,
                dataType: updatedRun.metadataType,
              }),
              this.#resolveTaskRunExecutionTask(taskRun.lockedById),
              this.#resolveTaskRunExecutionQueue({
                runId,
                lockedQueueId: updatedRun.lockedQueueId ?? undefined,
                queueName: updatedRun.queue,
                runtimeEnvironmentId: updatedRun.runtimeEnvironment.id,
              }),
              this.#resolveTaskRunExecutionOrganization(
                updatedRun.runtimeEnvironment.organizationId
              ),
              this.#resolveTaskRunExecutionProjectByRuntimeEnvironmentId(
                updatedRun.runtimeEnvironment.id
              ),
              this.#resolveTaskRunExecutionMachinePreset(
                taskRun.lockedById,
                updatedRun.machinePreset
              ),
              this.#resolveTaskRunExecutionDeployment(taskRun.lockedById),
            ]);

          const execution: BackwardsCompatibleTaskRunExecution = {
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
              id: updatedRun.friendlyId,
              payload: updatedRun.payload,
              payloadType: updatedRun.payloadType,
              createdAt: updatedRun.createdAt,
              tags: updatedRun.runTags,
              isTest: updatedRun.isTest,
              idempotencyKey: updatedRun.idempotencyKey ?? undefined,
              startedAt: updatedRun.startedAt ?? updatedRun.createdAt,
              maxAttempts: updatedRun.maxAttempts ?? undefined,
              version: updatedRun.taskVersion ?? "unknown",
              metadata,
              maxDuration: updatedRun.maxDurationInSeconds ?? undefined,
              /** @deprecated */
              context: undefined,
              /** @deprecated */
              durationMs: updatedRun.usageDurationMs,
              /** @deprecated */
              costInCents: updatedRun.costInCents,
              /** @deprecated */
              baseCostInCents: updatedRun.baseCostInCents,
              traceContext: updatedRun.traceContext as Record<string, string | undefined>,
              priority: updatedRun.priorityMs === 0 ? undefined : updatedRun.priorityMs / 1_000,
              parentTaskRunId: updatedRun.parentTaskRunId
                ? RunId.toFriendlyId(updatedRun.parentTaskRunId)
                : undefined,
              rootTaskRunId: updatedRun.rootTaskRunId
                ? RunId.toFriendlyId(updatedRun.rootTaskRunId)
                : undefined,
            },
            task,
            queue,
            environment: {
              id: updatedRun.runtimeEnvironment.id,
              slug: updatedRun.runtimeEnvironment.slug,
              type: updatedRun.runtimeEnvironment.type,
              branchName: updatedRun.runtimeEnvironment.branchName ?? undefined,
              git: environmentGit,
            },
            organization,
            project,
            machine: machinePreset,
            deployment,
            batch: updatedRun.batchId
              ? {
                  id: BatchId.toFriendlyId(updatedRun.batchId),
                }
              : undefined,
          };

          return { run: updatedRun, snapshot, execution };
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
    await this.#notifyMetadataUpdated(runId, completion);

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
        return this.$.runLock.lock("attemptSucceeded", [runId], async () => {
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
        return this.$.runLock.lock("attemptFailed", [runId], async () => {
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

    return await this.$.runLock.lock("tryNackAndRequeue", [run.id], async () => {
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
    bulkActionId,
    tx,
  }: {
    runId: string;
    workerId?: string;
    runnerId?: string;
    completedAt?: Date;
    reason?: string;
    finalizeRun?: boolean;
    bulkActionId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<ExecutionResult & { alreadyFinished: boolean }> {
    const prisma = tx ?? this.$.prisma;
    reason = reason ?? "Cancelled by user";

    return startSpan(this.$.tracer, "cancelRun", async (span) => {
      return this.$.runLock.lock("cancelRun", [runId], async () => {
        const latestSnapshot = await getLatestExecutionSnapshot(prisma, runId);

        //already finished, do nothing
        if (latestSnapshot.executionStatus === "FINISHED") {
          if (bulkActionId) {
            await prisma.taskRun.update({
              where: { id: runId },
              data: {
                bulkActionGroupIds: {
                  push: bulkActionId,
                },
              },
            });
          }
          return {
            alreadyFinished: true,
            ...executionResultFromSnapshot(latestSnapshot),
          };
        }

        //is pending cancellation and we're not finalizing, alert the worker again
        if (latestSnapshot.executionStatus === "PENDING_CANCEL" && !finalizeRun) {
          await sendNotificationToWorker({
            runId,
            snapshot: latestSnapshot,
            eventBus: this.$.eventBus,
          });
          return {
            alreadyFinished: false,
            ...executionResultFromSnapshot(latestSnapshot),
          };
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
            bulkActionGroupIds: bulkActionId
              ? {
                  push: bulkActionId,
                }
              : undefined,
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
          return {
            alreadyFinished: false,
            ...executionResultFromSnapshot(newSnapshot),
          };
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

        await this.#finalizeRun(run);

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

        return {
          alreadyFinished: false,
          ...executionResultFromSnapshot(newSnapshot),
        };
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

  async #resolveTaskRunExecutionTask(
    backgroundWorkerTaskId: string
  ): Promise<BackwardsCompatibleTaskRunExecution["task"]> {
    const result = await this.cache.tasks.swr(backgroundWorkerTaskId, async () => {
      const task = await this.$.prisma.backgroundWorkerTask.findFirstOrThrow({
        where: {
          id: backgroundWorkerTaskId,
        },
        select: {
          id: true,
          slug: true,
          filePath: true,
          exportName: true,
        },
      });

      return {
        id: task.slug,
        filePath: task.filePath,
        exportName: task.exportName ?? undefined,
      };
    });

    if (result.err) {
      throw result.err;
    }

    if (!result.val) {
      throw new ServiceValidationError(
        `Could not resolve task execution data for task ${backgroundWorkerTaskId}`
      );
    }

    return result.val;
  }

  async #resolveTaskRunExecutionOrganization(
    organizationId: string
  ): Promise<TaskRunExecutionOrganization> {
    const result = await this.cache.orgs.swr(organizationId, async () => {
      const organization = await this.$.prisma.organization.findFirstOrThrow({
        where: { id: organizationId },
        select: {
          id: true,
          title: true,
          slug: true,
        },
      });

      return {
        id: organization.id,
        name: organization.title,
        slug: organization.slug,
      };
    });

    if (result.err) {
      throw result.err;
    }

    if (!result.val) {
      throw new ServiceValidationError(
        `Could not resolve organization data for organization ${organizationId}`
      );
    }

    return result.val;
  }

  async #resolveTaskRunExecutionProjectByRuntimeEnvironmentId(
    runtimeEnvironmentId: string
  ): Promise<TaskRunExecutionProject> {
    const result = await this.cache.projects.swr(runtimeEnvironmentId, async () => {
      const { project } = await this.$.prisma.runtimeEnvironment.findFirstOrThrow({
        where: { id: runtimeEnvironmentId },
        select: {
          id: true,
          project: {
            select: {
              id: true,
              name: true,
              slug: true,
              externalRef: true,
            },
          },
        },
      });

      return {
        id: project.id,
        name: project.name,
        slug: project.slug,
        ref: project.externalRef,
      };
    });

    if (result.err) {
      throw result.err;
    }

    if (!result.val) {
      throw new ServiceValidationError(
        `Could not resolve project data for project ${runtimeEnvironmentId}`
      );
    }

    return result.val;
  }

  async #resolveTaskRunExecutionMachinePreset(
    backgroundWorkerTaskId: string,
    runMachinePreset: string | null
  ): Promise<MachinePreset> {
    if (runMachinePreset) {
      return machinePresetFromName(
        this.options.machines.machines,
        runMachinePreset as MachinePresetName
      );
    }

    const result = await this.cache.machinePresets.swr(backgroundWorkerTaskId, async () => {
      const { machineConfig } = await this.$.prisma.backgroundWorkerTask.findFirstOrThrow({
        where: {
          id: backgroundWorkerTaskId,
        },
        select: {
          machineConfig: true,
        },
      });

      return getMachinePreset({
        machines: this.options.machines.machines,
        defaultMachine: this.options.machines.defaultMachine,
        config: machineConfig,
        run: { machinePreset: null },
      });
    });

    if (result.err) {
      throw result.err;
    }

    if (!result.val) {
      throw new ServiceValidationError(
        `Could not resolve machine preset for task ${backgroundWorkerTaskId}`
      );
    }

    return result.val;
  }

  async #resolveTaskRunExecutionQueue(params: {
    runId: string;
    lockedQueueId?: string;
    queueName: string;
    runtimeEnvironmentId: string;
  }): Promise<TaskRunExecutionQueue> {
    const result = await this.cache.queues.swr(params.runId, async () => {
      const queue = params.lockedQueueId
        ? await this.$.prisma.taskQueue.findFirst({
            where: {
              id: params.lockedQueueId,
            },
            select: {
              id: true,
              friendlyId: true,
              name: true,
            },
          })
        : await this.$.prisma.taskQueue.findFirst({
            where: {
              runtimeEnvironmentId: params.runtimeEnvironmentId,
              name: params.queueName,
            },
            select: {
              id: true,
              friendlyId: true,
              name: true,
            },
          });

      if (!queue) {
        throw new ServiceValidationError(
          `Could not resolve queue data for queue ${params.queueName}`,
          404
        );
      }

      return {
        id: queue.friendlyId,
        name: queue.name,
      };
    });

    if (result.err) {
      throw result.err;
    }

    if (!result.val) {
      throw new ServiceValidationError(
        `Could not resolve queue data for queue ${params.queueName}`,
        404
      );
    }

    return result.val;
  }

  async #resolveTaskRunExecutionDeployment(
    backgroundWorkerTaskId: string
  ): Promise<TaskRunExecutionDeployment | undefined> {
    const result = await this.cache.deployments.swr(backgroundWorkerTaskId, async () => {
      const { worker } = await this.$.prisma.backgroundWorkerTask.findFirstOrThrow({
        where: { id: backgroundWorkerTaskId },
        select: {
          worker: {
            select: {
              deployment: true,
            },
          },
        },
      });

      if (!worker.deployment) {
        return undefined;
      }

      return {
        id: worker.deployment.friendlyId,
        shortCode: worker.deployment.shortCode,
        version: worker.deployment.version,
        runtime: worker.deployment.runtime ?? "unknown",
        runtimeVersion: worker.deployment.runtimeVersion ?? "unknown",
        git: safeParseGitMeta(worker.deployment.git),
      };
    });

    if (result.err) {
      throw result.err;
    }

    return result.val;
  }

  async #notifyMetadataUpdated(runId: string, completion: TaskRunExecutionResult) {
    if (completion.metadata) {
      this.$.eventBus.emit("runMetadataUpdated", {
        time: new Date(),
        run: {
          id: runId,
          metadata: completion.metadata,
        },
      });

      return;
    }

    if (completion.flushedMetadata) {
      const [packetError, packet] = await tryCatch(parsePacket(completion.flushedMetadata));

      if (!packet) {
        return;
      }

      if (packetError) {
        this.$.logger.error("RunEngine.completeRunAttempt(): failed to parse flushed metadata", {
          runId,
          flushedMetadata: completion.flushedMetadata,
          error: packetError,
        });

        return;
      }

      const metadata = FlushedRunMetadata.safeParse(packet);

      if (!metadata.success) {
        this.$.logger.error("RunEngine.completeRunAttempt(): failed to parse flushed metadata", {
          runId,
          flushedMetadata: completion.flushedMetadata,
          error: metadata.error,
        });

        return;
      }

      this.$.eventBus.emit("runMetadataUpdated", {
        time: new Date(),
        run: {
          id: runId,
          metadata: metadata.data,
        },
      });
    }
  }
}

export function safeParseGitMeta(git: unknown): GitMeta | undefined {
  const parsed = GitMeta.safeParse(git);
  if (parsed.success) {
    return parsed.data;
  }
  return undefined;
}
