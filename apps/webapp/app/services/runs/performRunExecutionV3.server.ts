import {
  ApiEventLog,
  AutoYieldMetadata,
  ConnectionAuth,
  RunJobAutoYieldWithCompletedTaskExecutionError,
  RunJobBody,
  RunJobError,
  RunJobInvalidPayloadError,
  RunJobResumeWithParallelTask,
  RunJobResumeWithTask,
  RunJobRetryWithTask,
  RunJobSuccess,
  RunJobUnresolvedAuthError,
  RunSourceContext,
  RunSourceContextSchema,
  supportsFeature,
} from "@trigger.dev/core";
import { BloomFilter } from "@trigger.dev/core-backend";
import { ConcurrencyLimitGroup, Job, JobRun, JobVersion } from "@trigger.dev/database";
import { generateErrorMessage } from "zod-error";
import { eventRecordToApiJson } from "~/api.server";
import {
  MAX_JOB_RUN_EXECUTION_COUNT,
  MAX_RUN_CHUNK_EXECUTION_LIMIT,
  MAX_RUN_YIELDED_EXECUTIONS,
  RUN_CHUNK_EXECUTION_BUFFER,
} from "~/consts";
import { $transaction, PrismaClient, PrismaClientOrTransaction, prisma } from "~/db.server";
import { env } from "~/env.server";
import { detectResponseIsTimeout } from "~/models/endpoint.server";
import { isRunCompleted } from "~/models/jobRun.server";
import { resolveRunConnections } from "~/models/runConnection.server";
import { prepareTasksForCaching, prepareTasksForCachingLegacy } from "~/models/task.server";
import { CompleteRunTaskService } from "~/routes/api.v1.runs.$runId.tasks.$id.complete/CompleteRunTaskService.server";
import { formatError } from "~/utils/formatErrors.server";
import { safeJsonZodParse } from "~/utils/json";
import { marqsv2 } from "~/v3/marqs/v2.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { EndpointApi } from "../endpointApi.server";
import { createExecutionEvent } from "../executions/createExecutionEvent.server";
import { logger } from "../logger.server";
import { executionRateLimiter } from "../runExecutionRateLimiter.server";
import { ResumeTaskService } from "../tasks/resumeTask.server";
import { executionWorker, workerQueue } from "../worker.server";
import { forceYieldCoordinator } from "./forceYieldCoordinator.server";
import { ResumeRunService } from "./resumeRun.server";

type FoundRun = NonNullable<Awaited<ReturnType<typeof findRun>>>;
type FoundTask = NonNullable<Awaited<ReturnType<typeof getCompletedTasksForRun>>>[number];

// We need to limit the cached tasks to not be too large >3.5MB when serialized
const TOTAL_CACHED_TASK_BYTE_LIMIT = 3500000;

export type PerformRunExecutionV3Input = {
  id: string;
  reason: "PREPROCESS" | "EXECUTE_JOB";

  /**
   * @deprecated This is no longer used
   */
  isRetry: boolean;

  /**
   * @deprecated Resuming tasks now goes through ResumeTaskService, this is included here for backwards compatibility
   */
  resumeTaskId?: string;

  /**
   * Specifies whether this should be the last attempt to execute the run. If so, we can't retry the run in case of a failure.
   */
  lastAttempt: boolean;
};

export type RunExecutionPriority = "initial" | "resume";

export class PerformRunExecutionV3Service {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(input: PerformRunExecutionV3Input, driftInMs: number = 0) {
    logger.debug("PerformRunExecutionV3Service.call", { input, driftInMs });

    if (Array.isArray(input.id)) {
      logger.error("PerformRunExecutionV3Service.call: input.id is an array", { input });

      throw new Error("input.id must be a string");
    }

    const run = await findRun(this.#prismaClient, input.id);

    if (!run) {
      return;
    }

    await this.#executeJob(run, input, driftInMs);
  }

  static async enqueue(
    run: JobRun & {
      version: JobVersion & {
        environment: AuthenticatedEnvironment;
        concurrencyLimitGroup?: ConcurrencyLimitGroup | null;
      };
      job: Job;
    },
    priority: RunExecutionPriority,
    tx: PrismaClientOrTransaction,
    options: {
      runAt?: Date;
      skipRetrying?: boolean;
    } = {}
  ) {
    if (marqsv2 && run.version.environment.organization.v2MarqsEnabled) {
      let queue = `job/${run.job.slug}`;

      if (run.version.concurrencyLimitGroup) {
        queue = `group/${run.version.concurrencyLimitGroup.name}`;
      }

      const runAt =
        priority === "initial" ? options.runAt ?? new Date() : run.startedAt ?? run.createdAt;

      await marqsv2.enqueueMessage(
        run.version.environment,
        queue,
        run.id,
        { runId: run.id, attempt: 1 },
        undefined,
        runAt.getTime()
      );
    } else {
      return await executionWorker.enqueue(
        "performRunExecutionV3",
        {
          id: run.id,
          reason: "EXECUTE_JOB",
        },
        {
          tx,
          runAt: options.runAt,
          jobKey: `job_run:EXECUTE_JOB:${run.id}`,
          maxAttempts: options.skipRetrying ? env.DEFAULT_DEV_ENV_EXECUTION_ATTEMPTS : undefined,
          flags: executionRateLimiter?.flagsForRun(run, run.version) ?? [],
          priority: priority === "initial" ? 0 : -1,
        }
      );
    }
  }

  static async dequeue(run: JobRun, tx: PrismaClientOrTransaction) {
    await executionWorker.dequeue(`job_run:EXECUTE_JOB:${run.id}`, {
      tx,
    });

    await marqsv2?.acknowledgeMessage(run.id);
  }

  async #executeJob(run: FoundRun, input: PerformRunExecutionV3Input, driftInMs: number = 0) {
    try {
      if (isRunCompleted(run.status)) {
        return;
      }

      if (!run.organization.runsEnabled) {
        return await this.#failRunExecution(this.#prismaClient, run, {
          message: `Unable to execute run.`,
        });
      }

      if (!run.endpoint.url) {
        return await this.#failRunExecution(this.#prismaClient, run, {
          message: `Endpoint has no URL set`,
        });
      }

      if (run.version.status === "DISABLED") {
        return await this.#failRunExecution(
          this.#prismaClient,
          run,
          {
            message: `Job version ${run.version.version} is disabled, aborting run.`,
          },
          "ABORTED"
        );
      }

      // If the execution duration is greater than the maximum execution time, we need to fail the run
      if (run.executionDuration >= run.organization.maximumExecutionTimePerRunInMs) {
        await this.#failRunExecution(
          this.#prismaClient,
          run,
          {
            message: `Execution timed out after ${
              run.organization.maximumExecutionTimePerRunInMs / 1000
            } seconds`,
          },
          "TIMED_OUT",
          0
        );
        return;
      }

      if (run.executionCount >= MAX_JOB_RUN_EXECUTION_COUNT) {
        await this.#failRunExecution(
          this.#prismaClient,
          run,
          {
            message: `Execution timed out after ${run.executionCount} executions`,
          },
          "TIMED_OUT",
          0
        );
        return;
      }

      const client = new EndpointApi(run.environment.apiKey, run.endpoint.url);
      const event = eventRecordToApiJson(run.event);

      const startedAt = new Date();

      const connections = await resolveRunConnections(run.runConnections);

      if (!connections.success) {
        return this.#failRunExecution(this.#prismaClient, run, {
          message: `Could not resolve all connections for run ${run.id}. This should not happen`,
        });
      }

      const taskCount = await getTaskCountForRun(this.#prismaClient, run.id);
      const tasks = await getCompletedTasksForRun(this.#prismaClient, run.id);

      const sourceContext = RunSourceContextSchema.safeParse(run.event.sourceContext);

      const executionBody = await this.#createExecutionBody(
        run,
        tasks,
        startedAt,
        false,
        connections.auth,
        event,
        sourceContext.success ? sourceContext.data : undefined
      );

      await this.#prismaClient.jobRun.update({
        where: {
          id: run.id,
        },
        data: {
          status: "EXECUTING",
        },
      });

      await createExecutionEvent({
        eventType: "start",
        eventTime: new Date(),
        drift: driftInMs,
        organizationId: run.organizationId,
        environmentId: run.environmentId,
        projectId: run.projectId,
        jobId: run.jobId,
        runId: run.id,
        concurrencyLimitGroupId: run.version.concurrencyLimitGroupId,
      });

      forceYieldCoordinator.registerRun(run.id);

      // TODO: add the ability to abort the execution from any server using Redis pub/sub
      const { response, parser, errorParser, headersParser, durationInMs } =
        await client.executeJobRequest(
          executionBody,
          run.environment.type === "DEVELOPMENT" ? 60_000 * 5 : undefined
        );

      await createExecutionEvent({
        eventType: "finish",
        eventTime: new Date(),
        drift: 0,
        organizationId: run.organizationId,
        environmentId: run.environmentId,
        projectId: run.projectId,
        jobId: run.jobId,
        runId: run.id,
        concurrencyLimitGroupId: run.version.concurrencyLimitGroupId,
      });

      forceYieldCoordinator.deregisterRun(run.id);

      if (marqsv2 && run.organization.v2MarqsEnabled) {
        await marqsv2.acknowledgeMessage(run.id);
      }

      //if the run has been canceled while it's being executed, we shouldn't do anything more
      const updatedRun = await this.#prismaClient.jobRun.findUnique({
        select: {
          status: true,
        },
        where: {
          id: run.id,
        },
      });
      if (!updatedRun || updatedRun.status === "CANCELED") {
        return;
      }

      if (!response) {
        return await this.#failRunExecutionWithRetry(
          run,
          input.lastAttempt,
          {
            message: `Connection could not be established to the endpoint (${run.endpoint.url})`,
          },
          durationInMs
        );
      }

      // Update the endpoint version if it has changed
      const rawHeaders = Object.fromEntries(response.headers.entries());
      const headers = headersParser.safeParse(rawHeaders);

      if (
        headers.success &&
        headers.data["trigger-version"] &&
        headers.data["trigger-version"] !== run.endpoint.version
      ) {
        await this.#prismaClient.endpoint.update({
          where: {
            id: run.endpoint.id,
          },
          data: {
            version: headers.data["trigger-version"],
          },
        });
      }

      if (headers.success && headers.data["x-trigger-run-metadata"] && !run.internal) {
        logger.debug("Endpoint responded with run metadata", {
          metadata: headers.data["x-trigger-run-metadata"],
        });

        if (
          headers.data["x-trigger-run-metadata"].successSubscription &&
          !run.subscriptions.some((s) => s.event === "SUCCESS")
        ) {
          await this.#prismaClient.jobRunSubscription.upsert({
            where: {
              runId_recipient_event: {
                runId: run.id,
                recipient: run.endpoint.id,
                event: "SUCCESS",
              },
            },
            create: {
              runId: run.id,
              recipient: run.endpoint.id,
              recipientMethod: "ENDPOINT",
              event: "SUCCESS",
              status: "ACTIVE",
            },
            update: {},
          });
        }

        if (
          headers.data["x-trigger-run-metadata"].failedSubscription &&
          !run.subscriptions.some((s) => s.event === "FAILURE")
        ) {
          await this.#prismaClient.jobRunSubscription.upsert({
            where: {
              runId_recipient_event: {
                runId: run.id,
                recipient: run.endpoint.id,
                event: "FAILURE",
              },
            },
            create: {
              runId: run.id,
              recipient: run.endpoint.id,
              recipientMethod: "ENDPOINT",
              event: "FAILURE",
              status: "ACTIVE",
            },
            update: {},
          });
        }
      }

      const rawBody = await response.text();

      if (!response.ok) {
        logger.debug("Endpoint responded with non-200 status code", {
          status: response.status,
          runId: run.id,
          endpoint: run.endpoint.url,
          headers: rawHeaders,
          rawBody,
        });

        const errorBody = safeJsonZodParse(errorParser, rawBody);

        if (errorBody && errorBody.success) {
          // Only retry if the error isn't a 4xx
          if (response.status >= 400 && response.status <= 499) {
            return await this.#failRunExecution(this.#prismaClient, run, errorBody.data);
          } else {
            return await this.#failRunExecutionWithRetry(
              run,
              input.lastAttempt,
              errorBody.data,
              durationInMs
            );
          }
        }

        // Only retry if the error isn't a 4xx
        if (response.status >= 400 && response.status <= 499 && response.status !== 408) {
          return await this.#failRunExecution(
            this.#prismaClient,
            run,
            {
              message: `Endpoint responded with ${response.status} status code`,
            },
            "FAILURE",
            durationInMs
          );
        } else {
          // If the error is a timeout, we should mark this execution as succeeded (by not throwing an error) and enqueue a new execution
          if (detectResponseIsTimeout(rawBody, response)) {
            return await this.#resumeRunExecutionAfterTimeout(
              this.#prismaClient,
              run,
              input,
              durationInMs,
              taskCount
            );
          } else {
            return await this.#failRunExecutionWithRetry(
              run,
              input.lastAttempt,
              {
                message: `Endpoint responded with ${response.status} status code`,
              },
              durationInMs
            );
          }
        }
      }

      const safeBody = safeJsonZodParse(parser, rawBody);

      if (!safeBody) {
        return await this.#failRunExecution(
          this.#prismaClient,
          run,
          {
            message: "Endpoint responded with invalid JSON",
          },
          "FAILURE",
          durationInMs
        );
      }

      if (!safeBody.success) {
        return await this.#failRunExecution(
          this.#prismaClient,
          run,
          {
            message: generateErrorMessage(safeBody.error.issues),
          },
          "FAILURE",
          durationInMs
        );
      }

      const status = safeBody.data.status;

      logger.debug("Endpoint responded with status", {
        status,
        data: safeBody.data,
      });

      switch (status) {
        case "SUCCESS": {
          await this.#completeRunWithSuccess(run, safeBody.data, durationInMs);

          break;
        }
        case "RESUME_WITH_TASK": {
          await this.#resumeRunWithTask(run, safeBody.data, durationInMs);

          break;
        }
        case "ERROR": {
          await this.#failRunWithError(run, safeBody.data, durationInMs);

          break;
        }
        case "RETRY_WITH_TASK": {
          await this.#retryRunWithTask(run, safeBody.data, durationInMs);

          break;
        }
        case "CANCELED": {
          break;
        }
        case "UNRESOLVED_AUTH_ERROR": {
          await this.#failRunWithUnresolvedAuthError(run, safeBody.data, durationInMs);

          break;
        }
        case "INVALID_PAYLOAD": {
          await this.#failRunWithInvalidPayloadError(run, safeBody.data, durationInMs);

          break;
        }
        case "YIELD_EXECUTION": {
          await this.#resumeYieldedRun(run, safeBody.data.key, durationInMs);
          break;
        }
        case "AUTO_YIELD_EXECUTION": {
          await this.#resumeAutoYieldedRun(run, safeBody.data, durationInMs);
          break;
        }
        case "AUTO_YIELD_EXECUTION_WITH_COMPLETED_TASK": {
          await this.#resumeAutoYieldedRunWithCompletedTask(run, safeBody.data, durationInMs);
          break;
        }
        case "AUTO_YIELD_RATE_LIMIT": {
          await this.#rescheduleRun(run, safeBody.data.reset, durationInMs);
          break;
        }
        case "RESUME_WITH_PARALLEL_TASK": {
          await this.#resumeParallelRunWithTask(run, safeBody.data, durationInMs);

          break;
        }
        default: {
          const _exhaustiveCheck: never = status;
          throw new Error(`Non-exhaustive match for value: ${status}`);
        }
      }
    } finally {
      forceYieldCoordinator.deregisterRun(run.id);
    }
  }

  async #createExecutionBody(
    run: FoundRun,
    tasks: FoundTask[],
    startedAt: Date,
    isRetry: boolean,
    connections: Record<string, ConnectionAuth>,
    event: ApiEventLog,
    source?: RunSourceContext
  ): Promise<RunJobBody> {
    if (supportsFeature("lazyLoadedCachedTasks", run.endpoint.version)) {
      const preparedTasks = prepareTasksForCaching(tasks, TOTAL_CACHED_TASK_BYTE_LIMIT);

      return {
        event,
        job: {
          id: run.version.job.slug,
          version: run.version.version,
        },
        run: {
          id: run.id,
          isTest: run.isTest,
          startedAt,
          isRetry,
        },
        environment: {
          id: run.environment.id,
          slug: run.environment.slug,
          type: run.environment.type,
        },
        organization: {
          id: run.organization.id,
          slug: run.organization.slug,
          title: run.organization.title,
        },
        project: {
          id: run.project.id,
          slug: run.project.slug,
          name: run.project.name,
        },
        account: run.externalAccount
          ? {
              id: run.externalAccount.identifier,
              metadata: run.externalAccount.metadata,
            }
          : undefined,
        connections,
        source,
        tasks: preparedTasks.tasks,
        cachedTaskCursor: preparedTasks.cursor,
        noopTasksSet: prepareNoOpTasksBloomFilter(tasks),
        yieldedExecutions: run.yieldedExecutions,
        runChunkExecutionLimit: run.endpoint.runChunkExecutionLimit - RUN_CHUNK_EXECUTION_BUFFER,
        autoYieldConfig: {
          startTaskThreshold: run.endpoint.startTaskThreshold,
          beforeExecuteTaskThreshold: run.endpoint.beforeExecuteTaskThreshold,
          beforeCompleteTaskThreshold: run.endpoint.beforeCompleteTaskThreshold,
          afterCompleteTaskThreshold: run.endpoint.afterCompleteTaskThreshold,
        },
      };
    }

    const preparedTasks = prepareTasksForCachingLegacy(tasks, TOTAL_CACHED_TASK_BYTE_LIMIT);

    return {
      event,
      job: {
        id: run.version.job.slug,
        version: run.version.version,
      },
      run: {
        id: run.id,
        isTest: run.isTest,
        startedAt,
        isRetry,
      },
      environment: {
        id: run.environment.id,
        slug: run.environment.slug,
        type: run.environment.type,
      },
      organization: {
        id: run.organization.id,
        slug: run.organization.slug,
        title: run.organization.title,
      },
      project: {
        id: run.project.id,
        slug: run.project.slug,
        name: run.project.name,
      },
      account: run.externalAccount
        ? {
            id: run.externalAccount.identifier,
            metadata: run.externalAccount.metadata,
          }
        : undefined,
      connections,
      source,
      tasks: preparedTasks.tasks,
    };
  }

  async #completeRunWithSuccess(run: FoundRun, data: RunJobSuccess, durationInMs: number) {
    await $transaction(this.#prismaClient, async (tx) => {
      await tx.jobRun.update({
        where: { id: run.id },
        data: {
          completedAt: new Date(),
          status: "SUCCESS",
          output: data.output ?? undefined,
          executionDuration: {
            increment: durationInMs,
          },
          executionCount: {
            increment: 1,
          },
        },
      });

      await workerQueue.enqueue(
        "deliverRunSubscriptions",
        {
          id: run.id,
        },
        { tx }
      );
    });
  }

  async #resumeRunWithTask(
    run: FoundRun,
    data: RunJobResumeWithTask,
    durationInMs: number,
    executionCountIncrement: number = 1
  ) {
    return await $transaction(this.#prismaClient, async (tx) => {
      await tx.jobRun.update({
        where: { id: run.id },
        data: {
          status: "WAITING_TO_CONTINUE",
          executionDuration: {
            increment: durationInMs,
          },
          executionCount: {
            increment: executionCountIncrement,
          },
        },
      });

      if (data.task.outputProperties) {
        await tx.task.update({
          where: {
            id: data.task.id,
          },
          data: {
            outputProperties: data.task.outputProperties,
          },
        });
      }

      // If the task has an operation, then the next performRunExecution will occur
      // when that operation has finished
      // Tasks with callbacks enabled will also get processed separately, i.e. when
      // they time out, or on valid requests to their callbackUrl
      if (!data.task.operation && !data.task.callbackUrl) {
        await ResumeTaskService.enqueue(data.task.id, data.task.delayUntil ?? undefined, tx);
      }
    });
  }

  async #resumeParallelRunWithTask(
    run: FoundRun,
    data: RunJobResumeWithParallelTask,
    durationInMs: number
  ) {
    await this.#prismaClient.jobRun.update({
      where: { id: run.id },
      data: {
        executionDuration: {
          increment: durationInMs,
        },
        executionCount: {
          increment: 1,
        },
        forceYieldImmediately: false,
      },
    });

    if (data.task.outputProperties) {
      await this.#prismaClient.task.update({
        where: {
          id: data.task.id,
        },
        data: {
          outputProperties: data.task.outputProperties,
        },
      });
    }

    for (const childError of data.childErrors) {
      switch (childError.status) {
        case "AUTO_YIELD_EXECUTION": {
          await this.#resumeAutoYieldedRun(run, childError, 0, 0);

          break;
        }
        case "AUTO_YIELD_EXECUTION_WITH_COMPLETED_TASK": {
          await this.#resumeAutoYieldedRunWithCompletedTask(run, childError, 0, 0);

          break;
        }
        case "AUTO_YIELD_RATE_LIMIT": {
          await this.#rescheduleRun(run, childError.reset, durationInMs);
          break;
        }
        case "CANCELED": {
          break;
        }
        case "ERROR": {
          return await this.#failRunExecution(
            this.#prismaClient,
            run,
            childError.error ?? undefined,
            "FAILURE",
            durationInMs
          );
        }
        case "INVALID_PAYLOAD": {
          return await this.#failRunExecution(
            this.#prismaClient,
            run,
            childError.errors,
            "INVALID_PAYLOAD",
            durationInMs
          );
        }
        case "RESUME_WITH_TASK": {
          await this.#resumeRunWithTask(run, childError, 0, 0);

          break;
        }
        case "RETRY_WITH_TASK": {
          await this.#retryRunWithTask(run, childError, 0, 0);

          break;
        }
        case "UNRESOLVED_AUTH_ERROR": {
          return await this.#failRunExecution(
            this.#prismaClient,
            run,
            childError.issues,
            "UNRESOLVED_AUTH",
            durationInMs
          );
        }
        case "YIELD_EXECUTION": {
          await this.#resumeYieldedRun(run, childError.key, 0, 0);

          break;
        }
      }
    }
  }

  async #failRunWithError(execution: FoundRun, data: RunJobError, durationInMs: number) {
    return await $transaction(this.#prismaClient, async (tx) => {
      if (data.task) {
        await tx.task.update({
          where: {
            id: data.task.id,
          },
          data: {
            status: "ERRORED",
            completedAt: new Date(),
            output: data.error ?? undefined,
          },
        });
      }

      await this.#failRunExecution(tx, execution, data.error ?? undefined, "FAILURE", durationInMs);
    });
  }

  async #failRunWithUnresolvedAuthError(
    execution: FoundRun,
    data: RunJobUnresolvedAuthError,
    durationInMs: number
  ) {
    return await $transaction(this.#prismaClient, async (tx) => {
      await this.#failRunExecution(tx, execution, data.issues, "UNRESOLVED_AUTH", durationInMs);
    });
  }

  async #failRunWithInvalidPayloadError(
    execution: FoundRun,
    data: RunJobInvalidPayloadError,
    durationInMs: number
  ) {
    return await $transaction(this.#prismaClient, async (tx) => {
      await this.#failRunExecution(tx, execution, data.errors, "INVALID_PAYLOAD", durationInMs);
    });
  }

  async #resumeYieldedRun(
    run: FoundRun,
    key: string,
    durationInMs: number,
    executionCount: number = 1
  ) {
    await $transaction(this.#prismaClient, async (tx) => {
      if (run.yieldedExecutions.length + 1 > MAX_RUN_YIELDED_EXECUTIONS) {
        return await this.#failRunExecution(
          tx,
          run,
          {
            message: `Run has yielded too many times, the maximum is ${MAX_RUN_YIELDED_EXECUTIONS}`,
          },
          "FAILURE",
          durationInMs
        );
      }

      await tx.jobRun.update({
        where: {
          id: run.id,
        },
        data: {
          status: "WAITING_TO_EXECUTE",
          executionDuration: {
            increment: durationInMs,
          },
          executionCount: {
            increment: executionCount,
          },
          yieldedExecutions: {
            push: key,
          },
          forceYieldImmediately: false,
        },
        select: {
          yieldedExecutions: true,
          executionCount: true,
        },
      });

      await ResumeRunService.enqueue(run, tx);
    });
  }

  async #rescheduleRun(
    run: FoundRun,
    reset: number,
    durationInMs: number,
    executionCount: number = 1
  ) {
    await $transaction(this.#prismaClient, async (tx) => {
      await tx.jobRun.update({
        where: {
          id: run.id,
        },
        data: {
          status: "WAITING_TO_EXECUTE",
          executionDuration: {
            increment: durationInMs,
          },
          executionCount: {
            increment: executionCount,
          },
          forceYieldImmediately: false,
        },
        select: {
          executionCount: true,
        },
      });

      await ResumeRunService.enqueue(run, tx, new Date(reset));
    });
  }

  async #resumeAutoYieldedRunWithCompletedTask(
    run: FoundRun,
    data: RunJobAutoYieldWithCompletedTaskExecutionError,
    durationInMs: number,
    executionCount: number = 1
  ) {
    await $transaction(this.#prismaClient, async (tx) => {
      const service = new CompleteRunTaskService(tx);

      const task = await service.call(run.environment, run.id, data.id, {
        properties: data.properties,
        output: data.output ? (JSON.parse(data.output) as any) : undefined,
      });

      if (!task || task.status === "ERRORED") {
        return await this.#failRunExecution(
          tx,
          run,
          {
            message: task ? `Task '${task.name}' failed to complete` : "Task failed to complete",
          },
          "FAILURE",
          durationInMs
        );
      }

      await tx.jobRun.update({
        where: {
          id: run.id,
        },
        data: {
          executionDuration: {
            increment: durationInMs,
          },
          executionCount: {
            increment: executionCount,
          },
          autoYieldExecution: {
            create: [
              {
                location: data.data.location,
                timeRemaining: data.data.timeRemaining,
                timeElapsed: data.data.timeElapsed,
                limit: data.data.limit ?? 0,
              },
            ],
          },
          forceYieldImmediately: false,
          status: "WAITING_TO_EXECUTE",
        },
        select: {
          executionCount: true,
        },
      });

      await ResumeRunService.enqueue(run, tx);
    });
  }

  async #resumeAutoYieldedRun(
    run: FoundRun,
    data: AutoYieldMetadata,
    durationInMs: number,
    executionCount: number = 1
  ) {
    await $transaction(this.#prismaClient, async (tx) => {
      await tx.jobRun.update({
        where: {
          id: run.id,
        },
        data: {
          status: "WAITING_TO_EXECUTE",
          executionDuration: {
            increment: durationInMs,
          },
          executionCount: {
            increment: executionCount,
          },
          autoYieldExecution: {
            create: [
              {
                location: data.location,
                timeRemaining: data.timeRemaining,
                timeElapsed: data.timeElapsed,
                limit: data.limit ?? 0,
              },
            ],
          },
          forceYieldImmediately: false,
        },
        select: {
          executionCount: true,
        },
      });

      await ResumeRunService.enqueue(run, tx);
    });
  }

  async #retryRunWithTask(
    run: FoundRun,
    data: RunJobRetryWithTask,
    durationInMs: number,
    executionCount: number = 1
  ) {
    return await $transaction(this.#prismaClient, async (tx) => {
      // We need to check for an existing task attempt
      const existingAttempt = await tx.taskAttempt.findFirst({
        where: {
          taskId: data.task.id,
          status: "PENDING",
        },
        orderBy: {
          number: "desc",
        },
      });

      if (existingAttempt) {
        await tx.taskAttempt.update({
          where: {
            id: existingAttempt.id,
          },
          data: {
            status: "ERRORED",
            error: formatError(data.error),
          },
        });
      }

      // We need to create a new task attempt
      await tx.taskAttempt.create({
        data: {
          taskId: data.task.id,
          number: existingAttempt ? existingAttempt.number + 1 : 1,
          status: "PENDING",
          runAt: data.retryAt,
        },
      });

      await tx.task.update({
        where: {
          id: data.task.id,
        },
        data: {
          status: "WAITING",
          run: {
            update: {
              status: "WAITING_TO_CONTINUE",
              executionDuration: {
                increment: durationInMs,
              },
              executionCount: {
                increment: executionCount,
              },
            },
          },
        },
      });

      await ResumeTaskService.enqueue(data.task.id, data.retryAt, tx);
    });
  }

  async #resumeRunExecutionAfterTimeout(
    prisma: PrismaClientOrTransaction,
    run: FoundRun,
    input: PerformRunExecutionV3Input,
    durationInMs: number,
    existingTaskCount: number
  ) {
    await $transaction(prisma, async (tx) => {
      const executionDuration = run.executionDuration + durationInMs;

      // If the execution duration is greater than the maximum execution time, we need to fail the run
      if (executionDuration >= run.organization.maximumExecutionTimePerRunInMs) {
        await this.#failRunExecution(
          tx,
          run,
          {
            message: `Execution timed out after ${
              run.organization.maximumExecutionTimePerRunInMs / 1000
            } seconds`,
          },
          "TIMED_OUT",
          durationInMs
        );
        return;
      }

      const newTaskCount = await getTaskCountForRun(tx, run.id);

      if (newTaskCount === existingTaskCount) {
        const latestTask = await tx.task.findFirst({
          select: {
            id: true,
            name: true,
            status: true,
            displayKey: true,
          },
          where: {
            runId: run.id,
            status: "RUNNING",
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 1,
        });

        const cause =
          latestTask?.status === "RUNNING"
            ? `This is likely caused by task "${
                latestTask.displayKey ?? latestTask.name
              }" execution exceeding the function timeout`
            : "This is likely caused by executing code outside of a task that exceeded the function timeout";

        await this.#failRunExecution(
          tx,
          run,
          {
            message: `Function timeout detected in ${
              durationInMs / 1000.0
            }s without any task creation. This is unexpected behavior and could lead to an infinite execution error because the run will never finish. ${cause}`,
          },
          "TIMED_OUT",
          durationInMs
        );
        return;
      }

      await tx.jobRun.update({
        where: {
          id: run.id,
        },
        data: {
          executionDuration: {
            increment: durationInMs,
          },
          executionCount: {
            increment: 1,
          },
          endpoint: {
            update: {
              // Never allow the execution limit to be less than 10 seconds or more than MAX_RUN_CHUNK_EXECUTION_LIMIT
              runChunkExecutionLimit: Math.min(
                Math.max(durationInMs, 10000),
                MAX_RUN_CHUNK_EXECUTION_LIMIT
              ),
            },
          },
          forceYieldImmediately: false,
          status: "WAITING_TO_EXECUTE",
        },
      });

      // The run has timed out, so we need to enqueue a new execution
      await ResumeRunService.enqueue(run, tx);
    });
  }

  async #failRunExecutionWithRetry(
    run: FoundRun,
    lastAttempt: boolean,
    output: Record<string, any>,
    durationInMs: number = 0
  ): Promise<void> {
    if (lastAttempt) {
      return await this.#failRunExecution(this.#prismaClient, run, output);
    }

    const updatedJob = await this.#prismaClient.jobRun.update({
      where: { id: run.id },
      data: {
        status: "WAITING_TO_EXECUTE",
        executionFailureCount: {
          increment: 1,
        },
      },
    });

    if (updatedJob.executionFailureCount >= 10) {
      return await this.#failRunExecution(this.#prismaClient, run, output);
    }

    // Use the job.executionFailureCount to determine how long to wait before retrying, using an exponential backoff
    const runAt = new Date(Date.now() + Math.pow(1.5, updatedJob.executionFailureCount) * 500); // 500ms, 750ms, 1125ms, 1687ms, 2531ms, 3796ms, 5694ms, 8541ms, 12812ms, 19218ms

    await ResumeRunService.enqueue(run, this.#prismaClient, runAt);
  }

  async #failRunExecution(
    prisma: PrismaClientOrTransaction,
    run: FoundRun,
    output: Record<string, any>,
    status: "FAILURE" | "ABORTED" | "TIMED_OUT" | "UNRESOLVED_AUTH" | "INVALID_PAYLOAD" = "FAILURE",
    durationInMs: number = 0
  ): Promise<void> {
    await $transaction(prisma, async (tx) => {
      // If the execution is an EXECUTE_JOB reason, we need to fail the run
      await tx.jobRun.update({
        where: { id: run.id },
        data: {
          completedAt: new Date(),
          status,
          output,
          executionDuration: {
            increment: durationInMs,
          },
          executionCount: {
            increment: 1,
          },
          tasks: {
            updateMany: {
              where: {
                status: {
                  in: ["WAITING", "RUNNING", "PENDING"],
                },
              },
              data: {
                status: status === "TIMED_OUT" ? "CANCELED" : "ERRORED",
                completedAt: new Date(),
              },
            },
          },
          forceYieldImmediately: false,
        },
      });

      await workerQueue.enqueue(
        "deliverRunSubscriptions",
        {
          id: run.id,
        },
        { tx }
      );
    });
  }
}

function prepareNoOpTasksBloomFilter(possibleTasks: FoundTask[]): string {
  const tasks = possibleTasks.filter((task) => task.status === "COMPLETED" && task.noop);

  const filter = new BloomFilter(BloomFilter.NOOP_TASK_SET_SIZE);

  for (const task of tasks) {
    filter.add(task.idempotencyKey);
  }

  return filter.serialize();
}

async function getTaskCountForRun(prisma: PrismaClientOrTransaction, runId: string) {
  return await prisma.task.count({
    where: {
      runId,
    },
  });
}

async function getCompletedTasksForRun(prisma: PrismaClientOrTransaction, runId: string) {
  return await prisma.task.findMany({
    where: {
      runId,
      status: "COMPLETED",
    },
    select: {
      id: true,
      idempotencyKey: true,
      status: true,
      noop: true,
      output: true,
      outputIsUndefined: true,
      parentId: true,
    },
    orderBy: {
      id: "asc",
    },
  });
}

async function findRun(prisma: PrismaClientOrTransaction, id: string) {
  return await prisma.jobRun.findUnique({
    where: { id },
    include: {
      environment: {
        include: {
          project: true,
          organization: true,
        },
      },
      endpoint: true,
      organization: true,
      project: true,
      externalAccount: true,
      runConnections: {
        include: {
          integration: true,
          connection: {
            include: {
              dataReference: true,
            },
          },
        },
      },
      event: true,
      version: {
        include: {
          job: true,
          organization: true,
        },
      },
      subscriptions: {
        where: {
          recipientMethod: "ENDPOINT",
        },
      },
    },
  });
}
